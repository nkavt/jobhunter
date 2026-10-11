import candidateInstructionsSystem from './candidate-instructions/system.md';
import candidateInstructionsUser from './candidate-instructions/user.md';
import cvToMarkdownSystem from './cv-to-markdown/system.md';
import cvToMarkdownUser from './cv-to-markdown/user.md';
import extractCvFactsSystem from './extract-cv-facts/system.md';
import extractCvFactsUser from './extract-cv-facts/user.md';
import type { PromptTemplate } from './types.js';

/**
 * Every prompt sent to the AI: `src/prompts/<name>/system.md` and `src/prompts/<name>/user.md`.
 * Register new prompts here; a test checks that every folder is registered.
 */
export const PROMPTS = {
  'candidate-instructions': {
    system: candidateInstructionsSystem,
    user: candidateInstructionsUser,
  },
  'cv-to-markdown': { system: cvToMarkdownSystem, user: cvToMarkdownUser },
  'extract-cv-facts': { system: extractCvFactsSystem, user: extractCvFactsUser },
} as const satisfies Record<string, PromptTemplate>;
