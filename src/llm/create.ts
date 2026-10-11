import type { Config, Provider } from '../config/config.js';
import { ClaudeAdapter } from './claude/adapter.js';
import type { LLMAdapter } from './types.js';

type AdapterConfig = Pick<Config, 'provider' | 'apiKey' | 'model'>;

/** One factory per provider; adding a provider is a new entry here. */
const factories: Record<Provider, (config: AdapterConfig) => LLMAdapter> = {
  claude: ({ apiKey, model }) => new ClaudeAdapter({ apiKey, model }),
};

/** Build the adapter for the provider and model saved in config.json. */
export function createAdapter(config: AdapterConfig): LLMAdapter {
  return factories[config.provider](config);
}
