import type { Config, Provider } from '../config/config.js';
import { ClaudeAdapter } from './claude/adapter.js';
import { GeminiAdapter } from './gemini/adapter.js';
import type { LLMAdapter } from './types.js';

export type AdapterConfig = Pick<Config, 'provider' | 'apiKey' | 'model'>;
/** What reaching a provider takes, before a model is picked. */
export type Connection = Pick<Config, 'provider' | 'apiKey'>;

/** One factory per provider; adding a provider is a new entry here. */
const factories: Record<Provider, (connection: Connection, model?: string) => LLMAdapter> = {
  claude: ({ apiKey }, model) => new ClaudeAdapter({ apiKey, ...(model ? { model } : {}) }),
  gemini: ({ apiKey }, model) => new GeminiAdapter({ apiKey, ...(model ? { model } : {}) }),
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
  return factories[connection.provider](connection, model);
}
