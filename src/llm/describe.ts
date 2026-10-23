import type { Provider } from '../config/config.js';
import type { LLMAdapter } from './types.js';

export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: 'Anthropic',
  gemini: 'Google',
  openai: 'OpenAI-compatible API',
};

/** Who serves the model: the company, or for an OpenAI-compatible API its host (`openrouter.ai`). */
export function getProviderName(provider: Provider, baseURL?: string): string {
  if (provider === 'openai' && baseURL !== undefined) {
    try {
      return new URL(baseURL).host;
    } catch {
      // Fall through to the generic name.
    }
  }
  return PROVIDER_NAMES[provider];
}

/** Which model is doing the work, for messages: `claude-sonnet-5-5 (Anthropic)`. */
export function getAdapterName(adapter: Pick<LLMAdapter, 'model' | 'providerName'>): string {
  return `${adapter.model} (${adapter.providerName})`;
}

/** Same as `getAdapterName`, from what's saved in config.json. */
export function getConfiguredAdapterName(config: {
  provider: Provider;
  model: string;
  baseURL?: string | undefined;
}): string {
  return getAdapterName({
    model: config.model,
    providerName: getProviderName(config.provider, config.baseURL),
  });
}
