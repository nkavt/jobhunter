import { stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleInitError, runInit } from '../../src/commands/init/index.js';
import { MAX_KEY_ATTEMPTS, SetupAbortedError } from '../../src/commands/init/ai-setup.js';
import { configFile, readConfig, saveConfig, type Config } from '../../src/config/index.js';
import {
  InsufficientCreditError,
  InvalidKeyError,
  NetworkError,
  type LLMAdapter,
  type ModelInfo,
} from '../../src/llm/index.js';
import { CancelledError } from '../../src/ui/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { CANCEL, DEFAULT, FakeUi, type DynamicAnswer } from '../helpers/fake-ui.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', family: 'opus', deprecated: false },
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    family: 'sonnet',
    deprecated: false,
  },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', family: 'haiku', deprecated: false },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', family: 'sonnet', deprecated: true },
];

const GOOD_KEY = 'sk-ant-good-1234';

/** A fake Anthropic: GOOD_KEY works, anything else is rejected. */
function fakeClaude(options: { failModel?: (model: string) => Error | undefined } = {}) {
  const connections: string[] = [];
  const connect = (apiKey: string): LLMAdapter => {
    connections.push(apiKey);
    return new FakeLLM({
      models: MODELS,
      errors: {
        listModels: () =>
          apiKey === GOOD_KEY ? undefined : new InvalidKeyError('bad key', 'claude'),
        checkModelAccess: (model) => options.failModel?.(model as string),
      },
    });
  };
  return { connect, connections };
}

const existingConfig: Config = {
  version: 1,
  provider: 'claude',
  model: 'claude-opus-5-5',
  apiKey: 'sk-ant-old-9876',
  activeProfile: 'default',
  google: { credentialsSource: '/tmp/client.json' },
};

describe('jobhunter init: AI setup', () => {
  useTempHome();
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('saves provider, key and the chosen model after both tests pass', async () => {
    const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']);
    await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

    expect(await readConfig()).toEqual({
      version: 1,
      provider: 'claude',
      apiKey: GOOD_KEY,
      model: 'claude-sonnet-5-5',
      activeProfile: 'default',
    });
    expect(ui.output).toEqual(
      expect.arrayContaining(['✔ Key valid', '✔ Ready', `✔ Saved to ${configFile()}`]),
    );
    expect(ui.remainingAnswers).toBe(0);
  });

  it.skipIf(isWindows)('writes the config readable only by the user', async () => {
    await runInit({
      openBrowser: () => undefined,
      ui: new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']),
      ...fakeClaude(),
    });
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  it('lists Gemini as coming soon but not selectable', async () => {
    const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']);
    await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });
    expect(ui.prompts[0]?.choices).toContainEqual(
      expect.objectContaining({ value: 'gemini', disabled: 'coming soon' }),
    );
    await expect(
      runInit({ openBrowser: () => undefined, ui: new FakeUi(['gemini']), ...fakeClaude() }),
    ).rejects.toThrow('not an enabled choice');
  });

  it('shows current models with hints and hides older ones until asked', async () => {
    const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']);
    await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

    const choices = ui.prompts.find((p) => p.message === 'Model')?.choices ?? [];
    expect(choices.map((c) => c.value).slice(0, 3)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(choices.map((c) => c.value)).not.toContain('claude-sonnet-4-5');
    expect(choices[0]?.name).toContain('best quality');
    expect(choices.at(-1)?.name).toContain('Show older models');
  });

  it('can switch to an older model via "Show older models"', async () => {
    const showOlder: DynamicAnswer = ({ choices }) =>
      choices.find((c) => c.name.includes('Show older models'))?.value;
    const ui = new FakeUi(['claude', GOOD_KEY, showOlder, 'claude-sonnet-4-5', '', 'skip']);

    await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

    const modelPrompts = ui.prompts.filter((p) => p.message === 'Model');
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[1]?.choices?.map((c) => c.value)).toContain('claude-sonnet-4-5');
    expect((await readConfig())?.model).toBe('claude-sonnet-4-5');
  });

  it('asks again after an invalid key', async () => {
    const ui = new FakeUi(['claude', 'sk-ant-typo', GOOD_KEY, DEFAULT, '', 'skip']);
    const claude = fakeClaude();
    await runInit({ openBrowser: () => undefined, ui, ...claude });

    expect(claude.connections[0]).toBe('sk-ant-typo');
    expect(ui.output).toContain('✖ Invalid API key.');
    expect((await readConfig())?.apiKey).toBe(GOOD_KEY);
  });

  it(`gives up after ${String(MAX_KEY_ATTEMPTS)} invalid keys without saving`, async () => {
    const ui = new FakeUi(['claude', 'bad-1', 'bad-2', 'bad-3']);
    await expect(
      runInit({ openBrowser: () => undefined, ui, ...fakeClaude() }),
    ).rejects.toBeInstanceOf(SetupAbortedError);
    expect(await readConfig()).toBeUndefined();
  });

  it('offers retry on network errors without asking for the key again', async () => {
    let calls = 0;
    const connect = (): LLMAdapter =>
      new FakeLLM({
        models: MODELS,
        errors: {
          listModels: () =>
            calls++ === 0 ? new NetworkError("Couldn't reach Anthropic", 'claude') : undefined,
        },
      });
    const ui = new FakeUi(['claude', GOOD_KEY, 'retry', DEFAULT, '', 'skip']);

    await runInit({ openBrowser: () => undefined, ui, connect });

    expect(ui.output).toContain("✖ Couldn't reach Anthropic");
    expect(ui.prompts.filter((p) => p.type === 'password')).toHaveLength(1);
    expect((await readConfig())?.model).toBe('claude-sonnet-5-5');
  });

  it('lets the user pick another model when access fails', async () => {
    const claude = fakeClaude({
      failModel: (model) =>
        model === 'claude-opus-5-5'
          ? new InsufficientCreditError('Your Anthropic credit balance is too low.', 'claude')
          : undefined,
    });
    const ui = new FakeUi([
      'claude',
      GOOD_KEY,
      'claude-opus-5-5',
      'model',
      'claude-haiku-5-5',
      '',
      'skip',
    ]);

    await runInit({ openBrowser: () => undefined, ui, ...claude });

    expect(ui.output).toContain('✖ Your Anthropic credit balance is too low.');
    expect((await readConfig())?.model).toBe('claude-haiku-5-5');
  });

  it('lets the user re-enter the key when access fails', async () => {
    let failed = false;
    const claude = fakeClaude({
      failModel: () => {
        if (failed) return undefined;
        failed = true;
        return new InsufficientCreditError('No credit', 'claude');
      },
    });
    const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, 'key', GOOD_KEY, DEFAULT, '', 'skip']);

    await runInit({ openBrowser: () => undefined, ui, ...claude });

    expect(ui.prompts.filter((p) => p.type === 'password')).toHaveLength(2);
    expect(await readConfig()).toMatchObject({ apiKey: GOOD_KEY });
  });

  it('saves nothing when cancelled', async () => {
    const ui = new FakeUi(['claude', CANCEL]);
    await expect(
      runInit({ openBrowser: () => undefined, ui, ...fakeClaude() }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(await readConfig()).toBeUndefined();
  });

  describe('when already set up', () => {
    it('changes nothing when the user picks "Nothing, exit" (the default)', async () => {
      await saveConfig(existingConfig);
      const ui = new FakeUi([DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

      expect(ui.prompts[0]?.message).toContain(
        'already set up with claude-opus-5-5 (Anthropic). What would you like to change?',
      );
      expect(ui.output).toContain('Nothing changed.');
      expect(await readConfig()).toEqual(existingConfig);
    });

    it('keeps the saved key on Enter, preselects the saved model, and keeps other settings', async () => {
      await saveConfig({ ...existingConfig, apiKey: GOOD_KEY });
      const ui = new FakeUi(['ai', 'claude', '', DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

      expect(ui.prompts.find((p) => p.type === 'password')?.message).toContain(
        'Enter to keep ••••1234',
      );
      expect(await readConfig()).toEqual({ ...existingConfig, apiKey: GOOD_KEY });
    });

    it('starts fresh when the existing config is broken', async () => {
      await mkdir(dirname(configFile()), { recursive: true });
      await writeFile(configFile(), '{ broken');
      const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']);

      await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });

      expect(ui.output.some((line) => line.startsWith('⚠ Your existing config'))).toBe(true);
      expect((await readConfig())?.apiKey).toBe(GOOD_KEY);
    });
  });
});

describe('handleInitError', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('reports a cancel calmly with exit code 130', () => {
    const ui = new FakeUi([]);
    handleInitError(ui, new CancelledError());
    expect(ui.output).toEqual(['Cancelled. Nothing more was saved.']);
    expect(process.exitCode).toBe(130);
  });

  it('shows the message of an aborted setup without a stack trace', () => {
    const ui = new FakeUi([]);
    handleInitError(ui, new SetupAbortedError('Too many invalid keys.'));
    expect(ui.output).toEqual(['✖ Too many invalid keys.']);
    expect(process.exitCode).toBe(1);
  });
});
