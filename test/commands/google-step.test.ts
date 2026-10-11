import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectGoogle } from '../../src/commands/init/google-step.js';
import { runInit } from '../../src/commands/init/index.js';
import { readConfig, saveConfig } from '../../src/config/index.js';
import { loadToken } from '../../src/google/index.js';
import { CancelledError } from '../../src/ui/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { CREDENTIALS_FILE, fakeBrowser, tokenEndpoint } from '../helpers/google-mock.js';
import { useTempHome } from '../helpers/temp-home.js';

describe('init: Google step', () => {
  const home = useTempHome();
  const server = useMockServer();

  async function downloadedCredentials() {
    const dir = join(home(), 'Downloads');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'client_secret_123.json');
    await writeFile(path, JSON.stringify(CREDENTIALS_FILE));
    return path;
  }
  const signsIn = () => fakeBrowser((state) => ({ code: 'code-1', state }));

  it('shows the setup guide, imports the credentials, signs in, and returns the config part', async () => {
    tokenEndpoint(server);
    const path = await downloadedCredentials();
    const browser = signsIn();
    const ui = new FakeUi(['connect', '/wrong/path.json', path]);

    expect(await connectGoogle({ ui, openBrowser: browser.open })).toBe(true);
    expect(await loadToken()).toMatchObject({ email: 'alex@example.com' });
    expect(ui.output).toEqual(
      expect.arrayContaining([
        '  2. APIs & Services → Library → enable "Google Sheets API" and "Google Drive API"',
        "✖ Can't read /wrong/path.json.",
        '✔ Credentials saved',
        'Sign in with Google in your browser, then come back here.',
        '✔ Connected as alex@example.com',
      ]),
    );
    expect(ui.output.some((line) => line.includes("If the browser doesn't open, go to:"))).toBe(
      true,
    );
  });

  it('can be skipped', async () => {
    const ui = new FakeUi(['skip']);
    expect(await connectGoogle({ ui, openBrowser: () => undefined })).toBe(false);
    expect(ui.output).toContain('Skipped. Run `jobhunter init` again to connect Google Sheets.');
  });

  it('keeps an existing connection by default', async () => {
    tokenEndpoint(server);
    await connectGoogle({
      ui: new FakeUi(['connect', await downloadedCredentials()]),
      openBrowser: signsIn().open,
    });
    const browser = signsIn();
    const ui = new FakeUi([DEFAULT]);

    expect(await connectGoogle({ ui, openBrowser: browser.open })).toBe(true);
    expect(ui.prompts[0]?.message).toBe('Google: connected as alex@example.com');
    expect(browser.visits).toHaveLength(0);
  });

  it('signs in again with the saved credentials without asking for the file', async () => {
    const forms = tokenEndpoint(server);
    await connectGoogle({
      ui: new FakeUi(['connect', await downloadedCredentials()]),
      openBrowser: signsIn().open,
    });
    const ui = new FakeUi(['login']);

    await connectGoogle({ ui, openBrowser: signsIn().open });

    expect(ui.prompts.map((p) => p.type)).toEqual(['select']);
    expect(forms).toHaveLength(2);
  });

  it('offers to try again when sign-in fails', async () => {
    tokenEndpoint(server);
    const path = await downloadedCredentials();
    let attempt = 0;
    const browser = fakeBrowser((state) =>
      attempt++ === 0 ? { error: 'access_denied', state } : { code: 'code-1', state },
    );
    const ui = new FakeUi(['connect', path, 'retry']);

    expect(await connectGoogle({ ui, openBrowser: browser.open })).toBe(true);
    expect(
      ui.output.some((line) => line.includes('add your Google account under Test users')),
    ).toBe(true);
  });

  it('treats an empty credentials path as cancel', async () => {
    await expect(
      connectGoogle({ ui: new FakeUi(['connect', '']), openBrowser: () => undefined }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('connects from the init menu without adding anything to config.json', async () => {
    tokenEndpoint(server);
    await saveConfig({
      version: 1,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-saved',
      activeProfile: 'default',
    });
    const path = await downloadedCredentials();
    const browser = signsIn();

    await runInit({
      ui: new FakeUi(['google', 'connect', path, 'skip']),
      openBrowser: browser.open,
      connect: () => new FakeLLM(),
    });

    expect(await loadToken()).toMatchObject({ email: 'alex@example.com' });
    expect(await readConfig()).not.toHaveProperty('google');
  });
});
