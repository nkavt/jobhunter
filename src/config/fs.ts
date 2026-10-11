import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { ConfigError } from './errors.js';

const SECRET_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export interface WriteOptions {
  /** Restrict the file to the current user (mode 0600). */
  secret?: boolean;
}

/**
 * Write via a temp file in the same directory + rename, so a crash never leaves a
 * half-written file behind. Parent directories are created with mode 0700.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  { secret = false }: WriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, secret ? { mode: SECRET_FILE_MODE } : {});
    // An existing file keeps its old mode through rename; enforce it explicitly.
    if (secret) await chmod(tmp, SECRET_FILE_MODE);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
  options?: WriteOptions,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Returns `undefined` when the file doesn't exist; throws `ConfigError` when it's invalid. */
export async function readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON`, path, { cause: error });
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`${path} has invalid content:\n${issues}`, path, {
      cause: result.error,
    });
  }
  return result.data;
}

/** True when group/others have any access to the file. Missing files are fine. */
export async function hasLoosePermissions(path: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  try {
    const { mode } = await stat(path);
    return (mode & 0o077) !== 0;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
