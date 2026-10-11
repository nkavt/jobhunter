import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  createTrackingSheet,
  getFile,
  GoogleApiError,
  GoogleAuthError,
  googleRequest,
  type GoogleClient,
} from '../../src/google/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { DRIVE, googleApis, saveGoogleSession, SHEETS } from '../helpers/google-api-mock.js';
import { useTempHome } from '../helpers/temp-home.js';

const client: GoogleClient = { clientId: 'c', clientSecret: 's' };

describe('Google API requests', () => {
  useTempHome();
  const server = useMockServer();

  it('sends the access token and parses JSON', async () => {
    await saveGoogleSession();
    let auth = '';
    server.use(
      http.get('https://example.googleapis.com/thing', ({ request }) => {
        auth = request.headers.get('authorization') ?? '';
        return HttpResponse.json({ ok: true });
      }),
    );
    expect(await googleRequest(client, 'https://example.googleapis.com/thing')).toEqual({
      ok: true,
    });
    expect(auth).toBe('Bearer access-1');
  });

  it('explains a disabled API with the link from Google', async () => {
    await saveGoogleSession();
    server.use(
      http.post(SHEETS, () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message:
                'Google Sheets API has not been used in project 123 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'SERVICE_DISABLED',
                  metadata: {
                    serviceTitle: 'Google Sheets API',
                    activationUrl:
                      'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123',
                  },
                },
              ],
            },
          },
          { status: 403 },
        ),
      ),
    );
    const error = await googleRequest(client, SHEETS, { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as Error).message).toBe(
      "Google Sheets API isn't enabled in your Google Cloud project. Enable it here, wait a minute, then try again: https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123",
    );
  });

  it('asks to sign in again on 401 and reports other errors with Google’s message', async () => {
    await saveGoogleSession();
    server.use(
      http.get(`${DRIVE}/a`, () =>
        HttpResponse.json({ error: { message: 'Invalid Credentials' } }, { status: 401 }),
      ),
      http.get(`${DRIVE}/b`, () =>
        HttpResponse.json({ error: { message: 'Rate limit exceeded' } }, { status: 429 }),
      ),
    );
    await expect(googleRequest(client, `${DRIVE}/a`)).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(googleRequest(client, `${DRIVE}/b`)).rejects.toThrow(
      'Google API error: Rate limit exceeded',
    );
  });

  it('treats a missing file as gone', async () => {
    await saveGoogleSession();
    googleApis(server, { files: { kept: { id: 'kept', name: 'Jobhunter', trashed: false } } });
    expect(await getFile(client, 'kept')).toMatchObject({ id: 'kept' });
    expect(await getFile(client, 'deleted')).toBeUndefined();
  });
});

describe('createTrackingSheet', () => {
  useTempHome();
  const server = useMockServer();

  it('creates the folder, the spreadsheet with its layout, and moves it into the folder', async () => {
    await saveGoogleSession();
    const calls = googleApis(server);

    const sheet = await createTrackingSheet(client, {
      title: 'Jobhunter',
      timeZone: 'Asia/Tbilisi',
    });

    expect(sheet).toEqual({
      spreadsheetId: 'sheet-1',
      folderId: 'folder-new',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    });
    expect(calls.map((c) => `${c.method} ${c.url.origin}${c.url.pathname}`)).toEqual([
      `GET ${DRIVE}`,
      `POST ${DRIVE}`,
      `POST ${SHEETS}`,
      `POST ${SHEETS}/sheet-1:batchUpdate`,
      `PATCH ${DRIVE}/sheet-1`,
    ]);
    expect(calls[0]?.url.searchParams.get('q')).toBe(
      "name = 'Jobhunter' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    );
    expect(calls[1]?.body).toEqual({
      name: 'Jobhunter',
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(calls[2]?.body).toMatchObject({
      properties: { title: 'Jobhunter', locale: 'en_US', timeZone: 'Asia/Tbilisi' },
    });
    expect((calls[3]?.body as { requests: unknown[] }).requests.length).toBeGreaterThan(50);
    expect(Object.fromEntries(calls[4]?.url.searchParams ?? [])).toMatchObject({
      addParents: 'folder-new',
      removeParents: 'root',
    });
  });

  it('reuses an existing Jobhunter folder', async () => {
    await saveGoogleSession();
    const calls = googleApis(server, { existingFolder: 'folder-old' });

    const sheet = await createTrackingSheet(client, { title: 'Jobhunter', timeZone: 'UTC' });

    expect(sheet.folderId).toBe('folder-old');
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/files')),
    ).toHaveLength(0);
  });
});
