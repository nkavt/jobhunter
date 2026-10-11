import { chmod, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError } from '../../src/config/errors.js';
import {
  hasLoosePermissions,
  readJsonFile,
  writeFileAtomic,
  writeJsonFile,
} from '../../src/config/fs.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('writeFileAtomic', () => {
  const home = useTempHome();

  it('creates missing parent directories and leaves no temp files', async () => {
    const path = join(home(), 'a', 'b', 'file.txt');
    await writeFileAtomic(path, 'hello');
    expect(await readFile(path, 'utf8')).toBe('hello');
    expect(await readdir(join(home(), 'a', 'b'))).toEqual(['file.txt']);
  });

  it.skipIf(isWindows)('writes secret files with mode 0600, even over a looser file', async () => {
    const path = join(home(), 'secret.json');
    await writeFile(path, 'old', { mode: 0o644 });
    await chmod(path, 0o644);

    await writeFileAtomic(path, 'new', { secret: true });

    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await mode(path)).toBe(0o600);
  });

  it.skipIf(isWindows)('creates parent directories private to the user', async () => {
    const dir = join(home(), 'private');
    await writeFileAtomic(join(dir, 'x.txt'), 'x');
    expect(await mode(dir)).toBe(0o700);
  });
});

describe('readJsonFile', () => {
  const home = useTempHome();
  const Schema = z.object({ name: z.string(), count: z.number() });

  it('returns undefined when the file does not exist', async () => {
    expect(await readJsonFile(join(home(), 'missing.json'), Schema)).toBeUndefined();
  });

  it('round-trips with writeJsonFile', async () => {
    const path = join(home(), 'data.json');
    await writeJsonFile(path, { name: 'x', count: 2 });
    expect(await readJsonFile(path, Schema)).toEqual({ name: 'x', count: 2 });
  });

  it('throws ConfigError for invalid JSON', async () => {
    const path = join(home(), 'broken.json');
    await mkdir(home(), { recursive: true });
    await writeFile(path, '{ not json');
    await expect(readJsonFile(path, Schema)).rejects.toThrow(ConfigError);
    await expect(readJsonFile(path, Schema)).rejects.toThrow('is not valid JSON');
  });

  it('throws ConfigError naming the invalid field', async () => {
    const path = join(home(), 'wrong.json');
    await writeJsonFile(path, { name: 'x', count: 'two' });
    await expect(readJsonFile(path, Schema)).rejects.toThrow(/count:/);
  });
});

describe.skipIf(isWindows)('hasLoosePermissions', () => {
  const home = useTempHome();

  it('is false for missing files and 0600 files, true for 0644', async () => {
    const path = join(home(), 'file');
    expect(await hasLoosePermissions(path)).toBe(false);

    await writeFileAtomic(path, 'x', { secret: true });
    expect(await hasLoosePermissions(path)).toBe(false);

    await chmod(path, 0o644);
    expect(await hasLoosePermissions(path)).toBe(true);
  });
});
