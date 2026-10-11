import { buildCreateBody, buildLayoutRequests } from '../sheet/layout.js';
import { googleRequest } from './api.js';
import type { GoogleClient } from './credentials.js';
import { findOrCreateFolder, moveToFolder } from './drive.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export const FOLDER_NAME = 'Jobhunter';

export interface CreatedSheet {
  spreadsheetId: string;
  folderId: string;
  url: string;
}

/** Create the tracking sheet with the full layout inside the `Jobhunter` folder. */
export async function createTrackingSheet(
  client: GoogleClient,
  options: { title: string; timeZone: string; now?: Date },
): Promise<CreatedSheet> {
  const folderId = await findOrCreateFolder(client, FOLDER_NAME);
  const created = await googleRequest<{ spreadsheetId: string; spreadsheetUrl: string }>(
    client,
    SHEETS,
    { method: 'POST', body: buildCreateBody(options.title, options.timeZone) },
  );
  await googleRequest(client, `${SHEETS}/${created.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: {
      requests: buildLayoutRequests({ createdAt: (options.now ?? new Date()).toISOString() }),
    },
  });
  await moveToFolder(client, created.spreadsheetId, folderId);
  return { spreadsheetId: created.spreadsheetId, folderId, url: created.spreadsheetUrl };
}

export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}
