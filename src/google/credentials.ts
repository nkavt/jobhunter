import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readJsonFile, writeFileAtomic } from '../config/fs.js';
import { googleCredentialsFile } from '../config/paths.js';
import { resolveUserPath } from '../util/user-path.js';
import { GoogleAuthError } from './errors.js';

/** The OAuth client file downloaded from Google Cloud Console (type: Desktop app). */
const CredentialsFileSchema = z.object({
  installed: z.looseObject({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    project_id: z.string().optional(),
  }),
});

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  projectId?: string;
}

function toClient(file: z.infer<typeof CredentialsFileSchema>): GoogleClient {
  const { client_id, client_secret, project_id } = file.installed;
  return {
    clientId: client_id,
    clientSecret: client_secret,
    ...(project_id ? { projectId: project_id } : {}),
  };
}

/**
 * Check the user's credentials file and keep a private copy (mode 0600) in the config dir,
 * so moving or deleting the download doesn't break Jobhunter.
 */
export async function importCredentials(
  input: string,
): Promise<{ client: GoogleClient; path: string }> {
  const path = resolveUserPath(input);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new GoogleAuthError(`Can't read ${path}.`, { cause: error });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new GoogleAuthError(`${path} isn't a valid JSON file.`, { cause: error });
  }

  if (typeof json === 'object' && json !== null && 'web' in json) {
    throw new GoogleAuthError(
      'This is a "Web application" client. Create an OAuth client of type "Desktop app" and use its file.',
    );
  }
  const parsed = CredentialsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new GoogleAuthError(
      "This doesn't look like a Google OAuth client file. Download it from Google Cloud Console → Credentials → OAuth client ID (Desktop app).",
    );
  }

  await writeFileAtomic(googleCredentialsFile(), raw, { secret: true });
  return { client: toClient(parsed.data), path };
}

/** The saved copy, or `undefined` if Google hasn't been set up yet. */
export async function loadCredentials(): Promise<GoogleClient | undefined> {
  const file = await readJsonFile(googleCredentialsFile(), CredentialsFileSchema);
  return file ? toClient(file) : undefined;
}
