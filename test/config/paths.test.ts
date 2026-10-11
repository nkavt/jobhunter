import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheDir,
  configDir,
  configFile,
  cvFile,
  instructionsFile,
  profileFile,
} from '../../src/config/index.js';

describe('paths', () => {
  beforeEach(() => {
    vi.stubEnv('JOBHUNTER_HOME', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    vi.stubEnv('XDG_CACHE_HOME', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to ~/.config/jobhunter and ~/.cache/jobhunter', () => {
    expect(configDir()).toBe(join(homedir(), '.config', 'jobhunter'));
    expect(cacheDir()).toBe(join(homedir(), '.cache', 'jobhunter'));
  });

  it('follows XDG_CONFIG_HOME and XDG_CACHE_HOME', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg/config');
    vi.stubEnv('XDG_CACHE_HOME', '/xdg/cache');
    expect(configDir()).toBe(join('/xdg/config', 'jobhunter'));
    expect(cacheDir()).toBe(join('/xdg/cache', 'jobhunter'));
  });

  it('lets JOBHUNTER_HOME override everything', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg/config');
    vi.stubEnv('JOBHUNTER_HOME', '/tmp/jh');
    expect(configDir()).toBe(join('/tmp/jh', 'config'));
    expect(cacheDir()).toBe(join('/tmp/jh', 'cache'));
  });

  it('keeps per-profile files under profiles/<name>/', () => {
    vi.stubEnv('JOBHUNTER_HOME', '/tmp/jh');
    const base = join('/tmp/jh', 'config');
    expect(configFile()).toBe(join(base, 'config.json'));
    expect(profileFile('default')).toBe(join(base, 'profiles', 'default', 'profile.json'));
    expect(cvFile('default')).toBe(join(base, 'profiles', 'default', 'cv.md'));
    expect(instructionsFile('default')).toBe(join(base, 'profiles', 'default', 'instructions.md'));
  });
});
