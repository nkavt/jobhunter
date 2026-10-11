import type { Config } from '../../config/index.js';
import {
  DEFAULT_CLAUDE_MODEL,
  InvalidKeyError,
  LLMError,
  NetworkError,
  RateLimitError,
  type LLMAdapter,
  type ModelInfo,
} from '../../llm/index.js';
import { CancelledError, dim, type Choice, type Ui } from '../../ui/index.js';

export const MAX_KEY_ATTEMPTS = 3;
const SHOW_OLDER = Symbol('show older models');

export interface AiSetupDeps {
  ui: Ui;
  /** Build an adapter for a key. Listing models and testing access don't depend on its model. */
  connect: (apiKey: string) => LLMAdapter;
}

/** Setup can't continue (e.g. too many invalid keys); the message is meant for the user. */
export class SetupAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupAbortedError';
  }
}

/**
 * Provider → API key → key test + live model list → model → access test.
 * Returns the AI part of the config; nothing is saved here.
 */
export async function setupAi(
  deps: AiSetupDeps,
  existing?: Config,
): Promise<Pick<Config, 'provider' | 'apiKey' | 'model'>> {
  const provider = await chooseProvider(deps.ui);

  for (;;) {
    const { apiKey, models } = await connectWithKey(deps, existing?.apiKey);
    const model = await chooseWorkingModel(deps, apiKey, models, existing?.model);
    if (model) return { provider, apiKey, model };
    // `undefined` = the user asked to enter a different key.
  }
}

async function chooseProvider(ui: Ui): Promise<'claude'> {
  const provider = await ui.select<'claude' | 'gemini'>({
    message: 'AI provider',
    choices: [
      { name: 'Anthropic (Claude)', value: 'claude' },
      { name: 'Google (Gemini)', value: 'gemini', disabled: 'coming soon' },
    ],
    default: 'claude',
  });
  if (provider !== 'claude') throw new SetupAbortedError('Only Claude is supported for now.');
  return provider;
}

async function connectWithKey(
  deps: AiSetupDeps,
  savedKey?: string,
): Promise<{ apiKey: string; models: ModelInfo[] }> {
  for (let attempt = 1; ; attempt++) {
    const apiKey = await askKey(deps.ui, savedKey);
    const models = await fetchModels(deps, apiKey);
    if (models) return { apiKey, models };
    if (attempt >= MAX_KEY_ATTEMPTS) {
      throw new SetupAbortedError(
        `The API key was rejected ${String(MAX_KEY_ATTEMPTS)} times. Create a new key in the Anthropic Console and run \`jobhunter init\` again.`,
      );
    }
  }
}

async function askKey(ui: Ui, savedKey?: string): Promise<string> {
  const hint = savedKey ? ` ${dim(`(Enter to keep ••••${savedKey.slice(-4)})`)}` : '';
  const value = await ui.password({
    message: `Anthropic API key${hint}`,
    validate: (input) => (input.trim() || savedKey ? true : 'Paste your API key'),
  });
  return value.trim() || (savedKey ?? '');
}

/** The model list doubles as the key test. `undefined` means the key was rejected. */
async function fetchModels(deps: AiSetupDeps, apiKey: string): Promise<ModelInfo[] | undefined> {
  for (;;) {
    try {
      const models = await deps.ui.task(
        'Checking key…',
        () => deps.connect(apiKey).listModels(),
        () => 'Key valid',
      );
      if (models.length === 0) throw new SetupAbortedError('This API key has no models available.');
      return models;
    } catch (error) {
      if (error instanceof InvalidKeyError) {
        deps.ui.error('Invalid API key.');
        return undefined;
      }
      if (error instanceof NetworkError || error instanceof RateLimitError) {
        deps.ui.error(error.message);
        if (await retryOrCancel(deps.ui)) continue;
      }
      throw error;
    }
  }
}

/** Returns the model once a test request succeeds, or `undefined` to re-enter the key. */
async function chooseWorkingModel(
  deps: AiSetupDeps,
  apiKey: string,
  models: ModelInfo[],
  preferred?: string,
): Promise<string | undefined> {
  for (;;) {
    const model = await pickModel(deps.ui, models, preferred);
    const name = models.find((m) => m.id === model)?.displayName ?? model;
    try {
      await deps.ui.task(
        `Testing access to ${name}…`,
        () => deps.connect(apiKey).checkModelAccess(model),
        () => 'Ready',
      );
      return model;
    } catch (error) {
      if (!(error instanceof LLMError)) throw error;
      deps.ui.error(error.message);
      const next = await deps.ui.select({
        message: 'What would you like to do?',
        choices: [
          { name: 'Pick another model', value: 'model' as const },
          { name: 'Enter a different API key', value: 'key' as const },
          { name: 'Cancel', value: 'cancel' as const },
        ],
      });
      if (next === 'key') return undefined;
      if (next === 'cancel') throw new CancelledError();
    }
  }
}

async function pickModel(ui: Ui, models: ModelInfo[], preferred?: string): Promise<string> {
  const current = models.filter((m) => !m.deprecated);
  const hasOlder = current.length > 0 && current.length < models.length;
  let list = current.length > 0 ? current : models;

  for (;;) {
    const width = Math.max(...list.map((m) => m.displayName.length));
    const choices: Choice<string | typeof SHOW_OLDER>[] = list.map((m) => ({
      name: `${m.displayName.padEnd(width)}  ${dim(modelHint(m))}`,
      value: m.id,
    }));
    if (hasOlder && list === current) {
      choices.push({ name: dim('Show older models'), value: SHOW_OLDER });
    }

    const fallback = defaultModel(list, preferred);
    const choice = await ui.select({
      message: 'Model',
      choices,
      ...(fallback !== undefined ? { default: fallback } : {}),
    });
    if (choice !== SHOW_OLDER) return choice;
    list = models;
  }
}

function modelHint(model: ModelInfo): string {
  if (model.deprecated) return 'older';
  switch (model.family) {
    case 'opus':
      return 'best quality · most expensive';
    case 'sonnet':
      return 'balanced · recommended';
    case 'haiku':
      return 'fastest · cheapest';
    default:
      return '';
  }
}

function defaultModel(list: ModelInfo[], preferred?: string): string | undefined {
  const ids = list.map((m) => m.id);
  for (const candidate of [preferred, DEFAULT_CLAUDE_MODEL]) {
    if (candidate && ids.includes(candidate)) return candidate;
  }
  return list.find((m) => m.family === 'sonnet')?.id ?? list[0]?.id;
}

async function retryOrCancel(ui: Ui): Promise<boolean> {
  const choice = await ui.select({
    message: 'What would you like to do?',
    choices: [
      { name: 'Retry', value: 'retry' as const },
      { name: 'Cancel', value: 'cancel' as const },
    ],
  });
  if (choice === 'cancel') throw new CancelledError();
  return true;
}
