import cvToMarkdownSystem from './cv-to-markdown/system.md';
import cvToMarkdownUser from './cv-to-markdown/user.md';

/**
 * Every prompt sent to the AI: `src/prompts/<name>/system.md` (stable rules, cacheable) and
 * `src/prompts/<name>/user.md` (the request, with `{{placeholders}}` for the data).
 * Register new prompts here; a test checks that every folder is registered.
 */
export const PROMPTS = {
  'cv-to-markdown': { system: cvToMarkdownSystem, user: cvToMarkdownUser },
} as const satisfies Record<string, { system: string; user: string }>;

export type PromptName = keyof typeof PROMPTS;
export type PromptValues = Record<string, string>;

/** A prompt template and the values passed to it don't match. */
export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptError';
  }
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Fill `{{name}}` placeholders. Strict on purpose: a placeholder without a value, or a value
 * the template never uses, throws instead of silently sending a broken prompt.
 */
export function renderPrompt(
  template: string,
  values: PromptValues = {},
  label = 'prompt',
): string {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new PromptError(`${label}: missing value for {{${key}}}`);
    used.add(key);
    return value;
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length > 0) {
    throw new PromptError(`${label}: unused value(s) ${unused.map((k) => `"${k}"`).join(', ')}`);
  }
  return rendered.trim();
}

export function renderSystemPrompt(name: PromptName, values?: PromptValues): string {
  return renderPrompt(PROMPTS[name].system, values, `${name}/system.md`);
}

export function renderUserPrompt(name: PromptName, values?: PromptValues): string {
  return renderPrompt(PROMPTS[name].user, values, `${name}/user.md`);
}
