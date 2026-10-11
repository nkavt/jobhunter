import { writeJsonFile, writeFileAtomic } from '../../src/config/fs.js';
import { googleCredentialsFile, googleTokenFile } from '../../src/config/paths.js';
import { CREDENTIALS_FILE } from './google-mock.js';

/** Pretend the user already connected Google: credentials + a valid token on disk. */
export async function saveGoogleSession(): Promise<void> {
  await writeFileAtomic(googleCredentialsFile(), JSON.stringify(CREDENTIALS_FILE), {
    secret: true,
  });
  await writeJsonFile(
    googleTokenFile(),
    {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
      email: 'alex@example.com',
    },
    { secret: true },
  );
}
