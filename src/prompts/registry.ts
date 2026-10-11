import cvToMarkdownSystem from './cv-to-markdown/system.md';
import cvToMarkdownUser from './cv-to-markdown/user.md';
import type { PromptTemplate } from './types.js';

/**
 * Every prompt sent to the AI: `src/prompts/<name>/system.md` and `src/prompts/<name>/user.md`.
 * Register new prompts here; a test checks that every folder is registered.
 */
export const PROMPTS = {
  'cv-to-markdown': { system: cvToMarkdownSystem, user: cvToMarkdownUser },
} as const satisfies Record<string, PromptTemplate>;
