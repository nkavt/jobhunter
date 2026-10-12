import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSheetPath,
  resolveSheetPath,
  setupTracking,
  shortPath,
} from '../../src/commands/init/tracking-step.js';
import { readProfile, saveProfile } from '../../src/config/index.js';
import { createLocalSheet, inspectLocalSheet } from '../../src/tracker/index.js';
import { writeWorkbook } from '../../src/xlsx/index.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-12T09:30:00Z');

describe('init: tracking sheet', () => {
  const home = useTempHome();
  const run = (ui: FakeUi) =>
    setupTracking({ ui, openBrowser: () => undefined, now: () => now }, 'default');

  it('offers a local file first and creates it, folder included', async () => {
    const path = join(home(), 'Jobs', 'my-jobs.xlsx');
    const ui = new FakeUi([DEFAULT, path, DEFAULT]);

    await run(ui);

    expect(ui.prompts[0]).toMatchObject({ message: 'Where should Jobhunter track jobs?' });
    expect(ui.prompts[0]?.choices?.[0]).toMatchObject({ value: 'local' });
    expect(ui.prompts[2]?.message).toBe(
      `The folder ${shortPath(join(home(), 'Jobs'))} doesn't exist. Create it?`,
    );
    expect(await inspectLocalSheet(path)).toBe('jobhunter');
    expect((await readProfile('default'))?.localSheet).toEqual({ path });
    expect(ui.output).toContain(`✔ Tracking sheet created: ${shortPath(path)}`);
  });

  it('puts jobhunter.xlsx in a folder and adds a missing extension', async () => {
    expect(await resolveSheetPath(home(), 'jobhunter.xlsx')).toEqual({
      path: join(home(), 'jobhunter.xlsx'),
    });
    expect(await resolveSheetPath(join(home(), 'tracker'), 'jobhunter.xlsx')).toEqual({
      path: join(home(), 'tracker.xlsx'),
    });
    expect(await resolveSheetPath('~/Jobs/JH.XLSX', 'jobhunter.xlsx')).toEqual({
      path: join(homedir(), 'Jobs', 'JH.XLSX'),
    });
    expect(await resolveSheetPath(join(home(), 'jobs.ods'), 'jobhunter.xlsx')).toMatchObject({
      error: expect.stringContaining('Use a name ending in .xlsx') as unknown,
    });
    expect(defaultSheetPath('default')).toBe(join(homedir(), 'Documents', 'jobhunter.xlsx'));
    expect(defaultSheetPath('design')).toBe(join(homedir(), 'Documents', 'jobhunter-design.xlsx'));
  });

  it('asks again after a wrong file type', async () => {
    const ui = new FakeUi(['local', join(home(), 'jobs.numbers'), join(home(), 'jobs.xlsx')]);
    await run(ui);
    expect(ui.output.join('\n')).toContain('Use a name ending in .xlsx');
    expect(await inspectLocalSheet(join(home(), 'jobs.xlsx'))).toBe('jobhunter');
  });

  it('reuses an existing Jobhunter sheet and keeps its jobs', async () => {
    const path = join(home(), 'jobhunter.xlsx');
    await createLocalSheet(path, now);
    const before = await readFile(path);
    const ui = new FakeUi(['local', path, DEFAULT]);

    await run(ui);

    expect(ui.prompts[2]?.message).toContain('is already a Jobhunter tracking sheet. Use it');
    expect(await readFile(path)).toEqual(before);
    expect((await readProfile('default'))?.localSheet).toEqual({ path });
  });

  it('never overwrites another spreadsheet', async () => {
    const budget = join(home(), 'budget.xlsx');
    const content = writeWorkbook({ sheets: [{ name: 'Budget', rows: [[{ value: 1 }]] }] });
    await writeFile(budget, content);
    const ui = new FakeUi(['local', budget, join(home(), 'jobs.xlsx')]);

    await run(ui);

    expect(ui.output.join('\n')).toContain(
      "isn't a Jobhunter tracking sheet. Jobhunter won't overwrite it",
    );
    expect(await readFile(budget)).toEqual(content);
    expect((await readProfile('default'))?.localSheet).toEqual({ path: join(home(), 'jobs.xlsx') });
  });

  it('keeps the current file on Enter', async () => {
    const path = join(home(), 'jobs.xlsx');
    await createLocalSheet(path, now);
    await saveProfile({ version: 1, name: 'default', localSheet: { path } });
    const ui = new FakeUi([DEFAULT, DEFAULT]);

    await run(ui);

    expect(ui.prompts.map((p) => p.type)).toEqual(['select', 'input']);
    expect(ui.output).toContain(`✔ Tracking jobs in ${shortPath(path)}`);
  });

  it('can be skipped', async () => {
    await mkdir(home(), { recursive: true });
    const ui = new FakeUi(['skip']);
    await run(ui);
    expect(await readProfile('default')).toBeUndefined();
    expect(ui.output.join('\n')).toContain('Skipped.');
  });
});
