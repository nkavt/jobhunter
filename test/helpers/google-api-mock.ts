import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import { saveGoogleSession } from './google-session.js';

export const DRIVE = 'https://www.googleapis.com/drive/v3/files';
export const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface ApiCall {
  method: string;
  url: URL;
  body: unknown;
}

/** Fake Drive + Sheets APIs; records every call. Pass `existingFolder` to simulate a reused folder. */
export function googleApis(
  server: SetupServer,
  options: { existingFolder?: string; files?: Record<string, object> } = {},
) {
  const calls: ApiCall[] = [];
  const record = async (request: Request) => {
    const text = await request.text();
    calls.push({
      method: request.method,
      url: new URL(request.url),
      body: text ? JSON.parse(text) : undefined,
    });
  };
  server.use(
    http.get(DRIVE, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        files: options.existingFolder ? [{ id: options.existingFolder, name: 'Jobhunter' }] : [],
      });
    }),
    http.post(DRIVE, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ id: 'folder-new' });
    }),
    http.get(`${DRIVE}/:id`, async ({ request, params }) => {
      await record(request);
      const file = options.files?.[String(params.id)];
      return file
        ? HttpResponse.json(file)
        : HttpResponse.json({ error: { code: 404, message: 'File not found' } }, { status: 404 });
    }),
    http.patch(`${DRIVE}/:id`, async ({ request, params }) => {
      await record(request);
      return HttpResponse.json({ id: params.id });
    }),
    http.post(SHEETS, async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        spreadsheetId: 'sheet-1',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
      });
    }),
    http.post(`${SHEETS}/:id\\:batchUpdate`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ replies: [] });
    }),
  );
  return calls;
}

export { saveGoogleSession };
