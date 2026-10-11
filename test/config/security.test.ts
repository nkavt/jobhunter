import { chmod } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configFile,
  findInsecureSecretFiles,
  saveConfig,
  warnAboutInsecureSecretFiles,
} from '../../src/config/index.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

describe.skipIf(isWindows)('secret file permissions', () => {
  useTempHome();
  afterEach(() => vi.restoreAllMocks());

  const save = () =>
    saveConfig({
      version: 1,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-test',
      activeProfile: 'default',
    });

  it('reports nothing when secret files are missing or private', async () => {
    expect(await findInsecureSecretFiles()).toEqual([]);
    await save();
    expect(await findInsecureSecretFiles()).toEqual([]);
  });

  it('warns with a chmod hint when config.json is readable by others', async () => {
    await save();
    await chmod(configFile(), 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await warnAboutInsecureSecretFiles();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`chmod 600 "${configFile()}"`));
  });
});
