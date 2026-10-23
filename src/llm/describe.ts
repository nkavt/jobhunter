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

/** The provider's built-in web search, for messages; `undefined` = it has none. */
export const WEB_SEARCH_NAMES: Record<Provider, string | undefined> = {
  claude: "Claude's web search",
  gemini: 'Gemini with Google Search',
  // Chat Completions has no standard web search tool.
  openai: undefined,
};

/** What to know before choosing the provider's web search; shown in `init` and with its errors. */
export const WEB_SEARCH_NOTES: Record<Provider, string | undefined> = {
  claude: undefined,
  gemini:
    "BTW: on Gemini's free tier, Gemini 3 models can't use Google Search at all. Turn on billing for your Google AI Studio project (5,000 free searches a month), or use another search.",
  openai: undefined,
};

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
