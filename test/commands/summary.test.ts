import { describe, expect, it } from 'vitest';
import { finishInit, missingSetup } from '../../src/commands/init/summary.js';
import { cvFile, instructionsFile, saveConfig, saveProfile } from '../../src/config/index.js';
import { writeFileAtomic } from '../../src/config/fs.js';
import { FakeUi } from '../helpers/fake-ui.js';
import { saveGoogleSession } from '../helpers/google-session.js';
import { useTempHome } from '../helpers/temp-home.js';

async function completeSetup() {
  await saveConfig({
    version: 1,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    apiKey: 'sk-ant-x',
    activeProfile: 'default',
  });
  await saveProfile({
    version: 1,
    name: 'default',
    cv: { sourcePath: '/tmp/cv.pdf', sha256: 'a'.repeat(64), parsedAt: '2026-10-11T10:00:00.000Z' },
    preferences: {
      workModes: ['remote'],
      visaSponsorshipNeeded: false,
      employmentTypes: ['full_time'],
    },
    sheet: { spreadsheetId: 'sheet-1', folderId: 'folder-1', columns: null, statusMap: null },
  });
  await writeFileAtomic(cvFile('default'), '# Alex Example\n');
  await writeFileAtomic(instructionsFile('default'), '# Candidate profile\n');
  await saveGoogleSession();
}

describe('end of init', () => {
  useTempHome();

  it('wishes happy hunting when everything is set up', async () => {
    await completeSetup();
    const ui = new FakeUi([]);

    await finishInit(ui, 'default');

    expect(await missingSetup('default')).toEqual([]);
    expect(ui.output).toContain("✔ You're all set. 🎉 Happy hunting! 🏹");
  });

  it('lists what is still missing, in init order', async () => {
    expect(await missingSetup('default')).toEqual([
      'AI provider and key',
      'CV',
      'preferences and candidate profile',
      'Google Sheets connection',
    ]);

    const ui = new FakeUi([]);
    await finishInit(ui, 'default');
    expect(ui.output).toContain(
      'Almost there. Still to set up: AI provider and key, CV, preferences and candidate profile, Google Sheets connection.',
    );
    expect(ui.output.join('\n')).not.toContain('Happy hunting');
  });

  it('asks for the tracking sheet once Google is connected', async () => {
    await completeSetup();
    await saveProfile({
      version: 1,
      name: 'default',
      cv: {
        sourcePath: '/tmp/cv.pdf',
        sha256: 'a'.repeat(64),
        parsedAt: '2026-10-11T10:00:00.000Z',
      },
      preferences: {
        workModes: ['remote'],
        visaSponsorshipNeeded: false,
        employmentTypes: ['full_time'],
      },
    });
    expect(await missingSetup('default')).toEqual(['tracking sheet']);
  });
});
