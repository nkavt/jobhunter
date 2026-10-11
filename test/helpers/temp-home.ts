import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

/** Points JOBHUNTER_HOME at a fresh temp dir for every test; returns a getter for it. */
export function useTempHome(): () => string {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jobhunter-test-'));
    vi.stubEnv('JOBHUNTER_HOME', dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  return () => dir;
}

export const isWindows = process.platform === 'win32';
