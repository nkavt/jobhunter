import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importCv } from '../../src/commands/init/cv-step.js';
import { runInit } from '../../src/commands/init/index.js';
import {
  cvFile,
  profileDir,
  readProfile,
  saveConfig,
  saveProfile,
  type Config,
} from '../../src/config/index.js';
import { CancelledError } from '../../src/ui/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { CANCEL, DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const CONVERTED = '# Alex Example\n\n## Experience\n### Engineer — Acme\n- Built things\n';

describe('init: CV step', () => {
  const home = useTempHome();

  async function cvSource(name = 'cv.pdf', content = '%PDF-1.7 fake') {
    const dir = join(home(), 'docs');
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  }

  const llm = () =>
    new FakeLLM({ text: CONVERTED, model: 'claude-sonnet-5-5', providerName: 'Anthropic' });

  it('converts the CV, shows a summary, and saves cv.md + the CV info', async () => {
    const source = await cvSource();
    const ui = new FakeUi([source, DEFAULT]);

    const info = await importCv({ ui, llm: llm() }, 'default');

    expect(await readFile(cvFile('default'), 'utf8')).toBe(CONVERTED);
    expect((await readProfile('default'))?.cv).toEqual(info);
    expect(info).toMatchObject({
      sourcePath: source,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as string,
    });
    expect(ui.output).toEqual(
      expect.arrayContaining([
        'Your CV is sent to claude-sonnet-5-5 (Anthropic) to convert it to Markdown.',
        '✔ CV converted',
        '  Name:      Alex Example',
        '  Sections:  Experience',
        '  Roles:     1',
        `✔ CV saved to ${cvFile('default')}`,
      ]),
    );
    expect(await readdir(profileDir('default'))).toEqual(['cv.md', 'profile.json']);
  });

  it('reads Markdown CVs directly without mentioning the AI', async () => {
    const source = await cvSource('cv.md', CONVERTED);
    const model = llm();
    const ui = new FakeUi([source, DEFAULT]);

    await importCv({ ui, llm: model }, 'default');

    expect(model.calls).toEqual([]);
    expect(ui.output).toContain('✔ CV read');
    expect(ui.output.join('\n')).not.toContain('is sent to');
  });

  it('asks again when the path is wrong', async () => {
    const source = await cvSource();
    const ui = new FakeUi(['/nope/cv.pdf', source, DEFAULT]);

    await importCv({ ui, llm: llm() }, 'default');

    expect(ui.output.some((line) => line.startsWith("✖ Can't find /nope/cv.pdf"))).toBe(true);
    expect((await readProfile('default'))?.cv?.sourcePath).toBe(source);
  });

  it('lets the user fix the result in their editor before saving', async () => {
    const source = await cvSource();
    const ui = new FakeUi([source, 'edit', DEFAULT]);
    ui.onEdit = (path) => writeFile(path, '# Alex B. Example\n');

    await importCv({ ui, llm: llm() }, 'default');

    expect(ui.edited).toEqual([join(profileDir('default'), 'cv.draft.md')]);
    expect(ui.output).toContain('  Name:      Alex B. Example');
    expect(await readFile(cvFile('default'), 'utf8')).toBe('# Alex B. Example\n');
  });

  it('can switch to a different file after seeing the summary', async () => {
    const first = await cvSource('old.pdf');
    const second = await cvSource('new.pdf', '%PDF-1.7 other');
    const ui = new FakeUi([first, 'other', second, DEFAULT]);

    await importCv({ ui, llm: llm() }, 'default');

    expect((await readProfile('default'))?.cv?.sourcePath).toBe(second);
  });

  it('skips on Enter when there is no CV yet', async () => {
    const ui = new FakeUi(['']);
    expect(await importCv({ ui, llm: llm() }, 'default')).toBeUndefined();
    expect(ui.output).toContain('Skipped. Run `jobhunter init` again to import your CV.');
    await expect(access(cvFile('default'))).rejects.toThrow();
  });

  it('offers the previous file as the default and keeps the rest of the profile', async () => {
    const source = await cvSource();
    await saveProfile({
      version: 1,
      name: 'default',
      cv: { sourcePath: source, sha256: 'b'.repeat(64), parsedAt: '2026-01-01T00:00:00.000Z' },
      sheet: null,
    });
    const ui = new FakeUi(['', DEFAULT]);

    await importCv({ ui, llm: llm() }, 'default');

    const profile = await readProfile('default');
    expect(profile?.cv?.sourcePath).toBe(source);
    expect(profile?.cv?.sha256).not.toBe('b'.repeat(64));
    expect(profile?.sheet).toBeNull();
    expect(ui.prompts[0]?.message).not.toContain('skip');
  });

  it('keeps the existing cv.md when the user cancels after converting a new one', async () => {
    const source = await cvSource();
    await importCv({ ui: new FakeUi([source, DEFAULT]), llm: llm() }, 'default');

    const replacement = new FakeLLM({ text: '# Someone Else\n' });
    await expect(
      importCv({ ui: new FakeUi([source, 'cancel']), llm: replacement }, 'default'),
    ).rejects.toBeInstanceOf(CancelledError);

    expect(await readFile(cvFile('default'), 'utf8')).toBe(CONVERTED);
    expect(await readdir(profileDir('default'))).not.toContain('cv.draft.md');
  });

  it('cleans up the draft on Ctrl+C', async () => {
    const source = await cvSource();
    await expect(
      importCv({ ui: new FakeUi([source, CANCEL]), llm: llm() }, 'default'),
    ).rejects.toBeInstanceOf(CancelledError);
    await expect(access(join(profileDir('default'), 'cv.draft.md'))).rejects.toThrow();
  });
});

describe('init: choosing what to change', () => {
  useTempHome();
  const config: Config = {
    version: 1,
    provider: 'claude',
    model: 'claude-opus-5-5',
    apiKey: 'sk-ant-saved',
    activeProfile: 'default',
  };

  it('runs only the CV step when "CV" is picked, using the saved key and model', async () => {
    await saveConfig(config);
    const connections: { apiKey: string; model?: string }[] = [];
    const ui = new FakeUi(['cv', '']);

    await runInit({
      ui,
      connect: (apiKey, model) => {
        connections.push({ apiKey, ...(model ? { model } : {}) });
        return new FakeLLM();
      },
    });

    expect(connections).toEqual([{ apiKey: 'sk-ant-saved', model: 'claude-opus-5-5' }]);
    expect(ui.prompts.map((p) => p.type)).toEqual(['select', 'input']);
  });
});
