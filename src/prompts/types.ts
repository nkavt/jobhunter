import type { PROMPTS, SNIPPETS } from './registry.js';

/** The two parts of a prompt: `system.md` (stable rules) and `user.md` (the request). */
export interface PromptTemplate {
  system: string;
  user: string;
}

/** A registered prompt, i.e. a folder in `src/prompts/`. */
export type PromptName = keyof typeof PROMPTS;

/** A registered snippet, i.e. a file in `src/prompts/shared/`. */
export type SnippetName = keyof typeof SNIPPETS;

/** Values for a template's `{{placeholders}}`. */
export type PromptValues = Record<string, string>;
