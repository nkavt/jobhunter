import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { googleCredentialsFile } from '../../src/config/index.js';
import { GoogleAuthError, importCredentials, loadCredentials } from '../../src/google/index.js';
import { CREDENTIALS_FILE } from '../helpers/google-mock.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

describe('Google credentials file', () => {
  const home = useTempHome();
  const download = async (name: string, content: string) => {
    await mkdir(join(home(), 'Downloads'), { recursive: true });
    const path = join(home(), 'Downloads', name);
    await writeFile(path, content);
    return path;
  };

  it('keeps a private copy and returns the client', async () => {
    const path = await download('client_secret_123.json', JSON.stringify(CREDENTIALS_FILE));

    const { client, path: source } = await importCredentials(`'${path}'`);

    expect(source).toBe(path);
    expect(client).toEqual({
      clientId: 'test-client.apps.googleusercontent.com',
      clientSecret: 'test-secret',
      projectId: 'jobhunter-test',
    });
    expect(JSON.parse(await readFile(googleCredentialsFile(), 'utf8'))).toEqual(CREDENTIALS_FILE);
    expect(await loadCredentials()).toEqual(client);
    if (!isWindows) expect((await stat(googleCredentialsFile())).mode & 0o777).toBe(0o600);
  });

  it('is undefined before setup', async () => {
    expect(await loadCredentials()).toBeUndefined();
  });

  it('explains what is wrong with unusable files', async () => {
    await expect(importCredentials(join(home(), 'nope.json'))).rejects.toThrow("Can't read");
    await expect(importCredentials(await download('a.json', '{ nope'))).rejects.toThrow(
      'valid JSON',
    );
    await expect(
      importCredentials(
        await download('web.json', JSON.stringify({ web: CREDENTIALS_FILE.installed })),
      ),
    ).rejects.toThrow('"Desktop app"');
    await expect(
      importCredentials(await download('other.json', '{"type":"service_account"}')),
    ).rejects.toThrow(GoogleAuthError);
    expect(await loadCredentials()).toBeUndefined();
  });
});
