import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init/index.js';
import { updateProfile } from '../../src/commands/init/profile-step.js';
import {
  cvFile,
  instructionsFile,
  profileDir,
  readProfile,
  saveConfig,
  saveProfile,
} from '../../src/config/index.js';
import { writeFileAtomic } from '../../src/config/fs.js';
import { CancelledError } from '../../src/ui/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';
import { DERIVED_ANSWER, FACTS_ANSWER } from '../helpers/fixtures.js';

const CV = '# Alex Example\n\n## Experience\n### Senior Engineer — Acme\n';
const PROFILE_MD =
  '# Candidate profile\n\n## Summary\nSenior frontend engineer, 8 years.\n\n## Core skills\n- TypeScript\n';

/** Accept every preference default (remote → countries, timezone; visa; types; salary; avoid ×2). */
const ACCEPT_PREFERENCES = [DEFAULT, DEFAULT, '', DEFAULT, DEFAULT, '', '', ''];

async function withCv(sheet?: null) {
  await saveProfile({
    version: 1,
    name: 'default',
    cv: { sourcePath: '/tmp/cv.pdf', sha256: 'a'.repeat(64), parsedAt: '2026-10-11T10:00:00.000Z' },
    ...(sheet === null ? { sheet: null } : {}),
  });
  await writeFileAtomic(cvFile('default'), CV);
}

const llm = (texts: string[] = [PROFILE_MD]) => {
  let call = 0;
  return new FakeLLM({
    model: 'claude-sonnet-5-5',
    providerName: 'Anthropic',
    json: FACTS_ANSWER,
    text: () => texts[Math.min(call++, texts.length - 1)] ?? '',
  });
};

describe('init: preferences and candidate profile', () => {
  useTempHome();

  it('reads the CV, asks preferences, and saves derived facts, preferences and instructions.md', async () => {
    await withCv(null);
    const ui = new FakeUi([...ACCEPT_PREFERENCES, DEFAULT]);

    expect(await updateProfile({ ui, llm: llm() }, 'default')).toBe(true);

    const profile = await readProfile('default');
    expect(profile?.derived).toEqual(DERIVED_ANSWER);
    expect(profile?.preferences).toEqual({
      workModes: ['remote'],
      remote: { eligibleCountries: ['GE'] },
      visaSponsorshipNeeded: false,
      employmentTypes: ['full_time'],
    });
    expect(profile?.sheet).toBeNull();
    expect(await readFile(instructionsFile('default'), 'utf8')).toBe(PROFILE_MD);
    expect(await readdir(profileDir('default'))).not.toContain('instructions.draft.md');
    expect(ui.output).toEqual(
      expect.arrayContaining([
        'Your CV is sent to claude-sonnet-5-5 (Anthropic) to read your roles, seniority and skills.',
        '  Roles:      Senior Frontend Engineer, Full-Stack Engineer',
        '  Seniority:  senior · 8 years',
        '  Stack:      TypeScript, React',
        '✔ Preferences saved',
        '  Senior frontend engineer, 8 years.',
        `✔ Candidate profile saved to ${instructionsFile('default')}`,
      ]),
    );
  });

  it('needs a CV first', async () => {
    const ui = new FakeUi([]);
    expect(await updateProfile({ ui, llm: llm() }, 'default')).toBe(false);
    expect(ui.output).toContain(
      'Import your CV first; your preferences and candidate profile are based on it.',
    );
  });

  it('can write the profile again or edit it before saving', async () => {
    await withCv();
    const model = llm([PROFILE_MD, '# Candidate profile\n\n## Summary\nSecond try.\n']);
    const ui = new FakeUi([...ACCEPT_PREFERENCES, 'regenerate', 'edit', DEFAULT]);
    ui.onEdit = (path) => writeFile(path, '# Candidate profile\n\n## Summary\nEdited by hand.\n');

    await updateProfile({ ui, llm: model }, 'default');

    expect(model.calls.filter((c) => c.method === 'generateText')).toHaveLength(2);
    expect(ui.output).toContain('  Second try.');
    expect(await readFile(instructionsFile('default'), 'utf8')).toContain('Edited by hand.');
  });

  it('keeps the previous instructions.md when cancelled, but keeps the new preferences', async () => {
    await withCv();
    await writeFileAtomic(instructionsFile('default'), '# Old profile\n');

    await expect(
      updateProfile({ ui: new FakeUi([...ACCEPT_PREFERENCES, 'cancel']), llm: llm() }, 'default'),
    ).rejects.toBeInstanceOf(CancelledError);

    expect(await readFile(instructionsFile('default'), 'utf8')).toBe('# Old profile\n');
    expect((await readProfile('default'))?.preferences?.workModes).toEqual(['remote']);
    expect(await readdir(profileDir('default'))).not.toContain('instructions.draft.md');
  });

  describe('from the init menu', () => {
    const config = {
      version: 1 as const,
      provider: 'claude' as const,
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-saved',
      activeProfile: 'default',
    };

    it('"Preferences and candidate profile" runs only that step', async () => {
      await saveConfig(config);
      await withCv();
      const ui = new FakeUi(['profile', ...ACCEPT_PREFERENCES, DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, connect: () => llm() });

      expect(ui.prompts.filter((p) => p.type === 'password')).toHaveLength(0);
      expect(await readFile(instructionsFile('default'), 'utf8')).toBe(PROFILE_MD);
    });

    it('importing a new CV also updates the profile', async () => {
      await saveConfig(config);
      const source = join(profileDir('default'), '..', 'new-cv.md');
      await writeFileAtomic(source, CV);
      const ui = new FakeUi(['cv', source, DEFAULT, ...ACCEPT_PREFERENCES, DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, connect: () => llm() });

      expect((await readProfile('default'))?.derived?.seniority).toBe('senior');
      expect(await readFile(instructionsFile('default'), 'utf8')).toBe(PROFILE_MD);
    });
  });
});
