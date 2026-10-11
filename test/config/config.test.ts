import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  configFile,
  loadConfig,
  NotInitializedError,
  readConfig,
  saveConfig,
  type Config,
} from '../../src/config/index.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

const config: Config = {
  version: 1,
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  apiKey: 'sk-ant-test',
  activeProfile: 'default',
};

describe('config.json', () => {
  useTempHome();

  it('is missing before init', async () => {
    expect(await readConfig()).toBeUndefined();
    await expect(loadConfig()).rejects.toThrow(NotInitializedError);
    await expect(loadConfig()).rejects.toThrow('jobhunter init');
  });

  it('round-trips through save and load', async () => {
    await saveConfig(config);
    expect(await loadConfig()).toEqual(config);
  });

  it.skipIf(isWindows)('is written with mode 0600 because it holds the API key', async () => {
    await saveConfig(config);
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  it('defaults activeProfile to "default"', async () => {
    await mkdir(dirname(configFile()), { recursive: true });
    const withoutProfile: Partial<Config> = { ...config };
    delete withoutProfile.activeProfile;
    await writeFile(configFile(), JSON.stringify(withoutProfile));
    expect((await loadConfig()).activeProfile).toBe('default');
  });

  it('refuses to save a config without an API key', async () => {
    await expect(saveConfig({ ...config, apiKey: '' })).rejects.toThrow();
    expect(await readConfig()).toBeUndefined();
  });

  it('still reads older config files that have a google entry, and drops it on save', async () => {
    await mkdir(dirname(configFile()), { recursive: true });
    await writeFile(
      configFile(),
      JSON.stringify({ ...config, google: { credentialsSource: '/x.json' } }),
    );
    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
    await saveConfig(loaded);
    expect(JSON.parse(await readFile(configFile(), 'utf8'))).not.toHaveProperty('google');
  });

  it('rejects unknown providers in the file', async () => {
    await mkdir(dirname(configFile()), { recursive: true });
    await writeFile(configFile(), JSON.stringify({ ...config, provider: 'gemini' }));
    await expect(loadConfig()).rejects.toThrow(ConfigError);
  });
});
