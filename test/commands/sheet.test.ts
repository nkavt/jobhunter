import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { showSheet } from '../../src/commands/sheet/index.js';
import { readProfile, saveConfig, saveProfile } from '../../src/config/index.js';
import { createLocalSheet } from '../../src/tracker/index.js';
import { FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const URL = 'https://docs.google.com/spreadsheets/d/sheet-1/edit';

async function setUp(sheet: boolean) {
  await saveConfig({
    version: 1,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    apiKey: 'sk-ant-x',
    activeProfile: 'default',
  });
  await saveProfile({
    version: 1,
    name: 'default',
    ...(sheet
      ? {
          sheet: { spreadsheetId: 'sheet-1', folderId: 'folder-1', columns: null, statusMap: null },
        }
      : {}),
  });
}

describe('jobhunter sheet', () => {
  const home = useTempHome();

  it('prints the link, and opens it on request', async () => {
    await setUp(true);
    const opened: string[] = [];
    const ui = new FakeUi([]);

    expect(await showSheet({ ui, openBrowser: (url) => opened.push(url) })).toBe(true);
    expect(ui.output).toEqual([URL]);
    expect(opened).toEqual([]);

    await showSheet({ ui, openBrowser: (url) => opened.push(url) }, { open: true });
    expect(opened).toEqual([URL]);
  });

  it('prints the local file, and opens it in its app on request', async () => {
    await setUp(false);
    const path = join(home(), 'jobhunter.xlsx');
    await createLocalSheet(path, new Date());
    const profile = await readProfile('default');
    if (!profile) throw new Error('no profile');
    await saveProfile({ ...profile, localSheet: { path } });
    const opened: string[] = [];
    const ui = new FakeUi([]);

    expect(await showSheet({ ui, openBrowser: (p) => opened.push(p) }, { open: true })).toBe(true);
    expect(ui.output).toEqual([path]);
    expect(opened).toEqual([path]);

    await saveProfile({ ...profile, localSheet: { path: join(home(), 'moved.xlsx') } });
    expect(await showSheet({ ui, openBrowser: () => undefined })).toBe(false);
    expect(ui.output.at(-1)).toContain("Can't find your tracking sheet");
  });

  it('points to init when there is no sheet or no setup at all', async () => {
    const ui = new FakeUi([]);
    expect(await showSheet({ ui, openBrowser: () => undefined })).toBe(false);

    await setUp(false);
    expect(await showSheet({ ui, openBrowser: () => undefined })).toBe(false);
    expect(ui.output.join('\n')).toContain('No tracking sheet yet. Run `jobhunter init`');
  });
});
