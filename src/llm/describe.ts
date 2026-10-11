import type { Provider } from '../config/config.js';
import type { LLMAdapter } from './types.js';

export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: 'Anthropic',
};

/** Which model is doing the work, for messages: `claude-sonnet-5-5 (Anthropic)`. */
export function getAdapterName(adapter: Pick<LLMAdapter, 'model' | 'providerName'>): string {
  return `${adapter.model} (${adapter.providerName})`;
}

/** Same as `getAdapterName`, from what's saved in config.json. */
export function getConfiguredAdapterName(config: { provider: Provider; model: string }): string {
  return getAdapterName({ model: config.model, providerName: PROVIDER_NAMES[config.provider] });
}
