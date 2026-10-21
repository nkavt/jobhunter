import { stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleInitError, runInit } from '../../src/commands/init/index.js';
import { MAX_KEY_ATTEMPTS, SetupAbortedError } from '../../src/commands/init/ai-setup.js';
import { configFile, readConfig, saveConfig, type Config } from '../../src/config/index.js';
import {
  DEFAULT_GEMINI_MODEL,
  InsufficientCreditError,
  InvalidKeyError,
  NetworkError,
  type Connection,
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

const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-pro', displayName: 'gemini-3.8-pro', family: 'pro' },
  { id: 'gemini-3.8-flash', displayName: 'gemini-3.8-flash', family: 'flash' },
  { id: 'gemini-3.8-flash-lite', displayName: 'gemini-3.8-flash-lite', family: 'flash-lite' },
];

const GOOD_KEY = 'sk-ant-good-1234';

/** A fake Anthropic: GOOD_KEY works, anything else is rejected. */
function fakeClaude(options: { failModel?: (model: string) => Error | undefined } = {}) {
  const connections: string[] = [];
  const connect = ({ apiKey }: Connection): LLMAdapter => {
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

  it('offers Anthropic, Google and any OpenAI-compatible API', async () => {
    const ui = new FakeUi(['claude', GOOD_KEY, DEFAULT, '', 'skip']);
    await runInit({ openBrowser: () => undefined, ui, ...fakeClaude() });
    expect(ui.prompts[0]?.choices?.map((c) => c.value)).toEqual(['claude', 'gemini', 'openai']);
    expect(ui.prompts[0]?.choices?.every((c) => !c.disabled)).toBe(true);
  });

  it('sets up Gemini with a Google key, preselecting the default Gemini model', async () => {
    const connections: Connection[] = [];
    const connect = (connection: Connection): LLMAdapter => {
      connections.push(connection);
      return new FakeLLM({ models: GEMINI_MODELS });
    };
    const ui = new FakeUi(['gemini', 'AIza-good-5678', DEFAULT, '', 'skip']);

    await runInit({ openBrowser: () => undefined, ui, connect });

    expect(ui.prompts.find((p) => p.type === 'password')?.message).toBe('Google API key');
    expect(ui.prompts.some((p) => p.message.startsWith('API base URL'))).toBe(false);
    const choices = ui.prompts.find((p) => p.message === 'Model')?.choices ?? [];
    expect(choices.find((c) => c.value === 'gemini-3.8-pro')?.name).toContain('best quality');
    expect(choices.some((c) => c.name.includes('Type a model ID'))).toBe(false);
    expect(connections[0]).toEqual({ provider: 'gemini', apiKey: 'AIza-good-5678' });
    expect(await readConfig()).toEqual({
      version: 1,
      provider: 'gemini',
      apiKey: 'AIza-good-5678',
      model: DEFAULT_GEMINI_MODEL,
      activeProfile: 'default',
    });
  });

  it('asks for the base URL of an OpenAI-compatible API and saves it', async () => {
    const connections: Connection[] = [];
    const connect = (connection: Connection): LLMAdapter => {
      connections.push(connection);
      return new FakeLLM({ models: [{ id: 'llama-4', displayName: 'llama-4' }] });
    };
    const ui = new FakeUi([
      'openai',
      ' https://openrouter.ai/api/v1 ',
      'sk-or-1234',
      'llama-4',
      '',
      'skip',
    ]);

    await runInit({ openBrowser: () => undefined, ui, connect });

    expect(ui.prompts.find((p) => p.type === 'password')?.message).toBe('openrouter.ai API key');
    // Thinking is only asked about for a local server.
    expect(ui.prompts.some((p) => p.type === 'confirm')).toBe(false);
    expect(connections[0]).toEqual({
      provider: 'openai',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-1234',
    });
    expect(await readConfig()).toMatchObject({
      provider: 'openai',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-1234',
      model: 'llama-4',
    });
  });

  it('lets the user type a model ID the OpenAI-compatible API does not list', async () => {
    const connect = (): LLMAdapter =>
      new FakeLLM({ models: [{ id: 'listed', displayName: 'listed' }] });
    const typeModel: DynamicAnswer = ({ choices }) =>
      choices.find((c) => c.name.includes('Type a model ID'))?.value;
    const ui = new FakeUi([
      'openai',
      'http://localhost:11434/v1',
      false,
      'ollama',
      typeModel,
      'qwen3:32b',
      '',
      'skip',
    ]);

    await runInit({ openBrowser: () => undefined, ui, connect });

    expect((await readConfig())?.model).toBe('qwen3:32b');
  });

  it('asks for the model ID straight away when the OpenAI-compatible API lists none', async () => {
    const connect = (): LLMAdapter => new FakeLLM({ models: [] });
    const ui = new FakeUi([
      'openai',
      'http://localhost:8000/v1',
      false,
      'key',
      'my-model',
      '',
      'skip',
    ]);

    await runInit({ openBrowser: () => undefined, ui, connect });

    expect(ui.prompts.some((p) => p.message === 'Model')).toBe(false);
    expect((await readConfig())?.model).toBe('my-model');
  });

  it('asks whether a model on a local server may think, and saves the answer', async () => {
    const connections: Connection[] = [];
    const connect = (connection: Connection): LLMAdapter => {
      connections.push(connection);
      return new FakeLLM({ models: [{ id: 'qwen3', displayName: 'qwen3' }] });
    };
    const ui = new FakeUi([
      'openai',
      'http://localhost:11434/v1',
      true,
      'ollama',
      'qwen3',
      '',
      'skip',
    ]);

    await runInit({ openBrowser: () => undefined, ui, connect });

    const thinking = ui.prompts.find((p) => p.type === 'confirm');
    expect(thinking?.message).toMatch(/^Let the model think before answering\?/);
    expect(connections[0]).toMatchObject({ thinking: true });
    expect(await readConfig()).toMatchObject({ provider: 'openai', thinking: true });
  });

  it('asks again when the base URL is not an http(s) URL', async () => {
    const ui = new FakeUi(['openai', 'openrouter.ai', 'https://openrouter.ai/api/v1', CANCEL]);
    await expect(
      runInit({ openBrowser: () => undefined, ui, ...fakeClaude() }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ui.rejected).toEqual(['Enter an http(s) URL']);
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

    it("doesn't offer the saved key or model after switching provider", async () => {
      await saveConfig({ ...existingConfig, apiKey: GOOD_KEY });
      const connect = (): LLMAdapter => new FakeLLM({ models: GEMINI_MODELS });
      const ui = new FakeUi(['ai', 'gemini', 'AIza-new-0000', DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, connect });

      expect(ui.prompts.find((p) => p.message === 'AI provider')).toBeDefined();
      expect(ui.prompts.find((p) => p.type === 'password')?.message).toBe('Google API key');
      expect(await readConfig()).toMatchObject({
        provider: 'gemini',
        apiKey: 'AIza-new-0000',
        model: DEFAULT_GEMINI_MODEL,
      });
    });

    it('keeps the saved base URL and thinking choice of an OpenAI-compatible API on Enter', async () => {
      const saved: Config = {
        ...existingConfig,
        provider: 'openai',
        baseURL: 'http://localhost:11434/v1',
        thinking: true,
        model: 'llama-4',
        apiKey: 'ollama-key',
      };
      await saveConfig(saved);
      const connect = (): LLMAdapter =>
        new FakeLLM({ models: [{ id: 'llama-4', displayName: 'llama-4' }] });
      const ui = new FakeUi(['ai', DEFAULT, DEFAULT, DEFAULT, '', DEFAULT]);

      await runInit({ openBrowser: () => undefined, ui, connect });

      expect(await readConfig()).toEqual(saved);
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
