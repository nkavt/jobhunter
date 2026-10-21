import type { Config, Provider } from '../config/config.js';
import { isLocalURL } from './local.js';

// Kept apart from the adapters so they can be read without loading a provider SDK.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** The model each adapter uses when none is given. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  // No sensible default across OpenAI-compatible hosts: the model is always picked in setup.
  openai: '',
};

/**
 * AI calls `hunt` makes at the same time. A model on the user's own machine works through one
 * request at a time anyway, so parallel calls there only make each one slower and time out.
 */
export function defaultParallelCalls(config: Pick<Config, 'provider' | 'baseURL'>): number {
  return config.provider === 'openai' && config.baseURL !== undefined && isLocalURL(config.baseURL)
    ? 1
    : 4;
}
