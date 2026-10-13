import type { Provider } from '../config/config.js';

// Kept apart from the adapters so they can be read without loading a provider SDK.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** The model each adapter uses when none is given. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
};
