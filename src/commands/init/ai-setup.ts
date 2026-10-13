import type { Config, Provider } from '../../config/index.js';
import {
  DEFAULT_MODELS,
  PROVIDER_NAMES,
  InvalidKeyError,
  LLMError,
  NetworkError,
  RateLimitError,
  type Connection,
  type LLMAdapter,
  type ModelInfo,
} from '../../llm/index.js';
import { CancelledError, dim, type Choice, type Ui } from '../../ui/index.js';

export const MAX_KEY_ATTEMPTS = 3;
const SHOW_OLDER = Symbol('show older models');

/** Where to get a new key, for the "rejected too many times" message. */
const KEY_HELP: Record<Provider, string> = {
  claude: 'Create a new key in the Anthropic Console',
  gemini: 'Create a new key in Google AI Studio',
};

export interface AiSetupDeps {
  ui: Ui;
  /** Build an adapter for a key. Listing models and testing access don't depend on its model. */
  connect: (connection: Connection, model?: string) => LLMAdapter;
}

/** Setup can't continue (e.g. too many invalid keys); the message is meant for the user. */
export class SetupAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupAbortedError';
  }
}

type AiConfig = Pick<Config, 'provider' | 'apiKey' | 'model'>;

/**
 * Provider → API key → key test + live model list → model → access test.
 * Returns the AI part of the config; nothing is saved here.
 */
export async function setupAi(deps: AiSetupDeps, existing?: Config): Promise<AiConfig> {
  const provider = await chooseProvider(deps.ui, existing?.provider);
  // A saved key or model only makes sense for the same provider.
  const same = existing?.provider === provider ? existing : undefined;

  for (;;) {
    const { connection, models } = await connectWithKey(deps, provider, same?.apiKey);
    const model = await chooseWorkingModel(deps, connection, models, same?.model);
    if (model) return { ...connection, model };
    // `undefined` = the user asked to enter a different key.
  }
}

async function chooseProvider(ui: Ui, saved?: Provider): Promise<Provider> {
  return ui.select<Provider>({
    message: 'AI provider',
    choices: [
      { name: 'Anthropic (Claude)', value: 'claude' },
      { name: 'Google (Gemini)', value: 'gemini' },
    ],
    default: saved ?? 'claude',
  });
}

async function connectWithKey(
  deps: AiSetupDeps,
  provider: Provider,
  savedKey?: string,
): Promise<{ connection: Connection; models: ModelInfo[] }> {
  for (let attempt = 1; ; attempt++) {
    const connection: Connection = {
      provider,
      apiKey: await askKey(deps.ui, PROVIDER_NAMES[provider], savedKey),
    };
    const models = await fetchModels(deps, connection);
    if (models) return { connection, models };
    if (attempt >= MAX_KEY_ATTEMPTS) {
      throw new SetupAbortedError(
        `The API key was rejected ${String(MAX_KEY_ATTEMPTS)} times. ${KEY_HELP[provider]} and run \`jobhunter init\` again.`,
      );
    }
  }
}

async function askKey(ui: Ui, providerName: string, savedKey?: string): Promise<string> {
  const hint = savedKey ? ` ${dim(`(Enter to keep ••••${savedKey.slice(-4)})`)}` : '';
  const value = await ui.password({
    message: `${providerName} API key${hint}`,
    validate: (input) => (input.trim() || savedKey ? true : 'Paste your API key'),
  });
  return value.trim() || (savedKey ?? '');
}

/** The model list doubles as the key test. `undefined` means the key was rejected. */
async function fetchModels(
  deps: AiSetupDeps,
  connection: Connection,
): Promise<ModelInfo[] | undefined> {
  for (;;) {
    try {
      const models = await deps.ui.task(
        'Checking key…',
        () => deps.connect(connection).listModels(),
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
  connection: Connection,
  models: ModelInfo[],
  preferred?: string,
): Promise<string | undefined> {
  const candidates = [preferred, DEFAULT_MODELS[connection.provider]];
  for (;;) {
    const model = await pickModel(deps.ui, models, candidates);
    const name = models.find((m) => m.id === model)?.displayName ?? model;
    try {
      await deps.ui.task(
        `Testing access to ${name}…`,
        () => deps.connect(connection).checkModelAccess(model),
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

async function pickModel(
  ui: Ui,
  models: ModelInfo[],
  /** Preselected if available, in order: the saved model, then the provider's default. */
  candidates: (string | undefined)[],
): Promise<string> {
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

    const fallback = defaultModel(list, candidates);
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
    case 'pro':
      return 'best quality · most expensive';
    case 'sonnet':
    case 'flash':
      return 'balanced · recommended';
    case 'haiku':
    case 'flash-lite':
      return 'fastest · cheapest';
    default:
      return '';
  }
}

function defaultModel(list: ModelInfo[], candidates: (string | undefined)[]): string | undefined {
  const ids = list.map((m) => m.id);
  for (const candidate of candidates) {
    if (candidate && ids.includes(candidate)) return candidate;
  }
  return list.find((m) => m.family === 'sonnet' || m.family === 'flash')?.id ?? list[0]?.id;
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
