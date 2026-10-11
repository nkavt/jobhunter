import { homedir } from 'node:os';
import { join } from 'node:path';

const APP = 'jobhunter';

/**
 * Root for all config files. `JOBHUNTER_HOME` overrides everything (tests, dev);
 * otherwise follows XDG: `$XDG_CONFIG_HOME/jobhunter`, default `~/.config/jobhunter`.
 * Read on every call so tests can switch it per case.
 */
export function configDir(): string {
  const home = process.env.JOBHUNTER_HOME;
  if (home) return join(home, 'config');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), APP);
}

/** `$XDG_CACHE_HOME/jobhunter`, default `~/.cache/jobhunter`. */
export function cacheDir(): string {
  const home = process.env.JOBHUNTER_HOME;
  if (home) return join(home, 'cache');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), APP);
}

export const configFile = (): string => join(configDir(), 'config.json');
export const googleCredentialsFile = (): string => join(configDir(), 'google-credentials.json');
export const googleTokenFile = (): string => join(configDir(), 'google-token.json');
export const mappingsFile = (): string => join(configDir(), 'mappings.json');
export const sourcesFile = (): string => join(configDir(), 'sources.json');

export const profilesDir = (): string => join(configDir(), 'profiles');
export const profileDir = (name: string): string => join(profilesDir(), name);
export const profileFile = (name: string): string => join(profileDir(name), 'profile.json');
export const cvFile = (name: string): string => join(profileDir(name), 'cv.md');
export const instructionsFile = (name: string): string => join(profileDir(name), 'instructions.md');

/** Files that hold credentials; written with mode 0600 and checked on startup. */
export const secretFiles = (): string[] => [
  configFile(),
  googleCredentialsFile(),
  googleTokenFile(),
];
