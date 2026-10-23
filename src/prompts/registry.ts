import candidateInstructionsSystem from './candidate-instructions/system.md';
import candidateInstructionsUser from './candidate-instructions/user.md';
import cvToMarkdownSystem from './cv-to-markdown/system.md';
import cvToMarkdownUser from './cv-to-markdown/user.md';
import extractCvFactsSystem from './extract-cv-facts/system.md';
import extractCvFactsUser from './extract-cv-facts/user.md';
import jobFitSystem from './job-fit/system.md';
import jobFitUser from './job-fit/user.md';
import jsonSchemaSnippet from './shared/json-schema.md';
import retryFeedbackSnippet from './shared/retry-feedback.md';
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
  'job-fit': { system: jobFitSystem, user: jobFitUser },
} as const satisfies Record<string, PromptTemplate>;

/**
 * Pieces added to other prompts by the AI adapters: `src/prompts/shared/<name>.md`.
 * Register new ones here; a test checks that every file is registered.
 */
export const SNIPPETS = {
  /** The answer's JSON Schema, for APIs that don't enforce one themselves. */
  'json-schema': jsonSchemaSnippet,
  /** Sent back when an answer didn't match its schema, before the one retry. */
  'retry-feedback': retryFeedbackSnippet,
} as const satisfies Record<string, string>;
