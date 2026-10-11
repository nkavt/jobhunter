import { hasLoosePermissions } from './fs.js';
import { secretFiles } from './paths.js';

/** Secret files (API key, Google tokens) that group/others can read. */
export async function findInsecureSecretFiles(): Promise<string[]> {
  const files = secretFiles();
  const loose = await Promise.all(files.map(hasLoosePermissions));
  return files.filter((_, index) => loose[index]);
}

export async function warnAboutInsecureSecretFiles(): Promise<void> {
  for (const path of await findInsecureSecretFiles()) {
    console.warn(
      `Warning: ${path} contains credentials but is readable by other users. Fix with: chmod 600 "${path}"`,
    );
  }
}
