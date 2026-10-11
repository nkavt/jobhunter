import type { Derived } from '../config/index.js';

/** Words that say nothing about what the job is. */
const NOISE = new Set([
  'senior',
  'sr',
  'junior',
  'jr',
  'mid',
  'middle',
  'lead',
  'principal',
  'staff',
  'head',
  'chief',
  'engineer',
  'developer',
  'programmer',
  'dev',
  'specialist',
  'expert',
  'architect',
  'consultant',
  'i',
  'ii',
  'iii',
  'iv',
  'of',
  'and',
  'the',
  '&',
  '/',
]);

/** "Full-Stack", "full stack", "FullStack" → "fullstack": compare without case, spaces or dashes. */
export const squash = (text: string): string => text.toLowerCase().replace(/[\s\-_./]+/g, '');

/** Too broad on their own: "software" alone would also match "Software Sales Manager". */
const BROAD = new Set([
  'software',
  'web',
  'application',
  'applications',
  'platform',
  'product',
  'technical',
  'it',
]);
const SENIORITY = new Set([
  'senior',
  'sr',
  'junior',
  'jr',
  'mid',
  'middle',
  'lead',
  'principal',
  'staff',
]);

/**
 * Title keywords from the CV: each target role without seniority and generic words
 * ("Senior Frontend Engineer" → "frontend"), plus the primary technologies ("react").
 * When only a broad word is left ("Software Engineer"), the role is kept as a whole phrase.
 */
export function titleKeywords(
  derived: Pick<Derived, 'roles' | 'tech'> | undefined,
  extra: readonly string[] = [],
): string[] {
  const keywords = new Set<string>();
  for (const role of derived?.roles ?? []) {
    const words = role
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    const distinctive = words.filter((word) => !NOISE.has(word.replace(/[^a-z0-9+#-]/g, '')));
    const phrase = distinctive.some((word) => !BROAD.has(word))
      ? distinctive.join(' ')
      : words.filter((word) => !SENIORITY.has(word)).join(' ');
    if (phrase) keywords.add(squash(phrase));
  }
  for (const tech of derived?.tech.primary ?? []) keywords.add(squash(tech));
  for (const word of extra) keywords.add(squash(word));
  keywords.delete('');
  return [...keywords];
}

export function titleMatches(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const squashed = squash(title);
  return keywords.some((keyword) => squashed.includes(keyword));
}
