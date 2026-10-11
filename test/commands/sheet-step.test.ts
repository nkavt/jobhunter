import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { setupSheet } from '../../src/commands/init/sheet-step.js';
import { readProfile, saveProfile } from '../../src/config/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { googleApis, saveGoogleSession, SHEETS } from '../helpers/google-api-mock.js';
import { useTempHome } from '../helpers/temp-home.js';

const savedSheet = {
  spreadsheetId: 'sheet-old',
  folderId: 'folder-old',
  columns: null,
  statusMap: null,
};

describe('init: tracking sheet step', () => {
  useTempHome();
  const server = useMockServer();

  it('creates the sheet and remembers it in profile.json', async () => {
    await saveGoogleSession();
    googleApis(server);
    const ui = new FakeUi([DEFAULT]);

    await setupSheet({ ui, timeZone: 'Asia/Tbilisi' }, 'default');

    expect((await readProfile('default'))?.sheet).toEqual({
      spreadsheetId: 'sheet-1',
      folderId: 'folder-new',
      columns: null,
      statusMap: null,
    });
    expect(ui.output).toContain(
      '✔ Your tracking sheet is ready in the Jobhunter folder of your Drive: https://docs.google.com/spreadsheets/d/sheet-1/edit',
    );
    expect(ui.prompts[0]?.choices).toContainEqual(
      expect.objectContaining({ name: 'Use an existing sheet', disabled: 'coming soon' }),
    );
  });

  it('names sheets for other profiles after the profile', async () => {
    await saveGoogleSession();
    const calls = googleApis(server);
    await setupSheet({ ui: new FakeUi([DEFAULT]), timeZone: 'UTC' }, 'backend');
    expect(calls.find((c) => c.url.href === SHEETS)?.body).toMatchObject({
      properties: { title: 'Jobhunter – backend' },
    });
  });

  it('keeps an existing sheet that still exists', async () => {
    await saveGoogleSession();
    await saveProfile({ version: 1, name: 'default', sheet: savedSheet });
    const calls = googleApis(server, {
      files: {
        'sheet-old': {
          id: 'sheet-old',
          name: 'Jobhunter',
          trashed: false,
          webViewLink: 'https://docs.google.com/spreadsheets/d/sheet-old/edit',
        },
      },
    });
    const ui = new FakeUi([DEFAULT]);

    await setupSheet({ ui }, 'default');

    expect(ui.prompts[0]?.message).toBe(
      'Your tracking sheet: https://docs.google.com/spreadsheets/d/sheet-old/edit',
    );
    expect(calls.some((c) => c.url.href === SHEETS)).toBe(false);
    expect((await readProfile('default'))?.sheet).toEqual(savedSheet);
  });

  it('offers a new sheet when the saved one was deleted', async () => {
    await saveGoogleSession();
    await saveProfile({ version: 1, name: 'default', sheet: savedSheet });
    googleApis(server, {
      files: { 'sheet-old': { id: 'sheet-old', name: 'Jobhunter', trashed: true } },
    });
    const ui = new FakeUi([DEFAULT]);

    await setupSheet({ ui, timeZone: 'UTC' }, 'default');

    expect(ui.output).toContain(
      "⚠ Your tracking sheet was deleted or Jobhunter can't open it anymore.",
    );
    expect((await readProfile('default'))?.sheet?.spreadsheetId).toBe('sheet-1');
  });

  it('needs Google to be connected', async () => {
    const ui = new FakeUi([]);
    await setupSheet({ ui }, 'default');
    expect(ui.output).toEqual(['Connect Google first; the tracking sheet lives in your Drive.']);
  });

  it('shows Google errors and offers to try again', async () => {
    await saveGoogleSession();
    let failures = 1;
    googleApis(server);
    server.use(
      http.post(SHEETS, () =>
        failures-- > 0
          ? HttpResponse.json({ error: { message: 'Backend Error' } }, { status: 500 })
          : HttpResponse.json({
              spreadsheetId: 'sheet-1',
              spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            }),
      ),
    );
    const ui = new FakeUi([DEFAULT, 'retry', DEFAULT]);

    await setupSheet({ ui, timeZone: 'UTC' }, 'default');

    expect(ui.output).toContain('✖ Google API error: Backend Error');
    expect((await readProfile('default'))?.sheet?.spreadsheetId).toBe('sheet-1');
  });
});
