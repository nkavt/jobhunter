import { googleRequest } from './api.js';
import type { GoogleClient } from './credentials.js';
import { GoogleApiError } from './errors.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  trashed?: boolean;
  webViewLink?: string;
}

/** Jobhunter's folder in the user's Drive: reused if it exists (only app-created files are visible). */
export async function findOrCreateFolder(client: GoogleClient, name: string): Promise<string> {
  const query = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER}' and trashed = false`;
  const { files } = await googleRequest<{ files: DriveFile[] }>(
    client,
    `${DRIVE}?${new URLSearchParams({ q: query, fields: 'files(id,name)', spaces: 'drive' }).toString()}`,
  );
  const existing = files[0];
  if (existing) return existing.id;

  const created = await googleRequest<DriveFile>(client, `${DRIVE}?fields=id`, {
    method: 'POST',
    body: { name, mimeType: FOLDER },
  });
  return created.id;
}

/** Move a file from the Drive root into a folder. */
export async function moveToFolder(
  client: GoogleClient,
  fileId: string,
  folderId: string,
): Promise<void> {
  await googleRequest(
    client,
    `${DRIVE}/${fileId}?${new URLSearchParams({ addParents: folderId, removeParents: 'root', fields: 'id' }).toString()}`,
    { method: 'PATCH', body: {} },
  );
}

/** The file's metadata, or `undefined` if it's gone or Jobhunter can no longer see it. */
export async function getFile(
  client: GoogleClient,
  fileId: string,
): Promise<DriveFile | undefined> {
  try {
    return await googleRequest<DriveFile>(
      client,
      `${DRIVE}/${fileId}?fields=id,name,trashed,webViewLink`,
    );
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 404 || error.status === 403))
      return undefined;
    throw error;
  }
}
