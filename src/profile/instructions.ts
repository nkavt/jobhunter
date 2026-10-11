import type { Derived } from '../config/index.js';
import type { LLMAdapter, Usage } from '../llm/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';

/**
 * Write `instructions.md`: the candidate profile the AI uses when scoring jobs.
 * Preferences are deliberately not part of it; they're added separately at scoring time.
 */
export async function generateInstructions(
  cvMarkdown: string,
  derived: Derived,
  llm: LLMAdapter,
): Promise<{ markdown: string; usage: Usage }> {
  const { text, usage } = await llm.generateText({
    system: renderSystemPrompt('candidate-instructions'),
    prompt: renderUserPrompt('candidate-instructions', {
      facts: JSON.stringify(derived, null, 2),
      cv: cvMarkdown,
    }),
    maxTokens: 4096,
  });
  const markdown = text.trim();
  if (!markdown) throw new Error('The candidate profile came back empty.');
  return { markdown: `${markdown}\n`, usage };
}
