import type { Config, Provider } from '../config/config.js';
import { DEFAULT_MODELS } from './defaults.js';
import { getProviderName } from './describe.js';
import { LLMError } from './errors.js';
import type {
  JsonRequest,
  JsonResult,
  LLMAdapter,
  ModelInfo,
  SearchRequest,
  SearchResult,
  TextRequest,
  TextResult,
} from './types.js';

export type AdapterConfig = Pick<Config, 'provider' | 'apiKey' | 'model' | 'baseURL' | 'thinking'>;
/** What reaching a provider takes, before a model is picked. */
export type Connection = Pick<Config, 'provider' | 'apiKey' | 'baseURL' | 'thinking'>;

/**
 * One loader per provider; adding a provider is a new entry here. Each imports its adapter
 * (and with it the provider's SDK) only when called, so nobody loads an SDK they don't use.
 */
const loaders: Record<Provider, (connection: Connection, model: string) => Promise<LLMAdapter>> = {
  claude: async ({ apiKey }, model) => {
    const { ClaudeAdapter } = await import('./claude/adapter.js');
    return new ClaudeAdapter({ apiKey, model });
  },
  gemini: async ({ apiKey }, model) => {
    const { GeminiAdapter } = await import('./gemini/adapter.js');
    return new GeminiAdapter({ apiKey, model });
  },
  openai: async ({ apiKey, baseURL, thinking }, model) => {
    if (baseURL === undefined) {
      throw new LLMError('An OpenAI-compatible provider needs a base URL.', 'openai');
    }
    const { OpenAIAdapter } = await import('./openai/adapter.js');
    return new OpenAIAdapter({
      apiKey,
      baseURL,
      ...(model ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    });
  },
};

/** Build the adapter for the provider and model saved in config.json. */
export function createAdapter(config: AdapterConfig): LLMAdapter {
  return connectAdapter(config, config.model);
}

/**
 * Build an adapter during setup, when the model may not be chosen yet. Listing models and
 * testing access don't depend on it; without one, the provider's default is used.
 */
export function connectAdapter(connection: Connection, model?: string): LLMAdapter {
  return new LazyAdapter(connection, model ?? DEFAULT_MODELS[connection.provider]);
}

/** Stands in for the real adapter and loads it on the first API call. */
class LazyAdapter implements LLMAdapter {
  readonly provider: Provider;
  readonly providerName: string;
  private loaded?: Promise<LLMAdapter>;

  constructor(
    private readonly connection: Connection,
    readonly model: string,
  ) {
    this.provider = connection.provider;
    this.providerName = getProviderName(connection.provider, connection.baseURL);
  }

  async listModels(): Promise<ModelInfo[]> {
    const adapter = await this.load();
    return adapter.listModels();
  }

  async validateKey(): Promise<void> {
    const adapter = await this.load();
    return adapter.validateKey();
  }

  async checkModelAccess(model?: string): Promise<void> {
    const adapter = await this.load();
    return adapter.checkModelAccess(model);
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const adapter = await this.load();
    return adapter.generateText(request);
  }

  async generateJSON<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
    const adapter = await this.load();
    return adapter.generateJSON(request);
  }

  async searchJSON<T>(request: SearchRequest<T>): Promise<SearchResult<T>> {
    const adapter = await this.load();
    return adapter.searchJSON(request);
  }

  private load(): Promise<LLMAdapter> {
    this.loaded ??= loaders[this.provider](this.connection, this.model);
    return this.loaded;
  }
}
