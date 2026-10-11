import { describe, expect, it } from 'vitest';
import { showSheet } from '../../src/commands/sheet/index.js';
import { saveConfig, saveProfile } from '../../src/config/index.js';
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
  useTempHome();

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

  it('points to init when there is no sheet or no setup at all', async () => {
    const ui = new FakeUi([]);
    expect(await showSheet({ ui, openBrowser: () => undefined })).toBe(false);

    await setUp(false);
    expect(await showSheet({ ui, openBrowser: () => undefined })).toBe(false);
    expect(ui.output.join('\n')).toContain('No tracking sheet yet. Run `jobhunter init`');
  });
});
