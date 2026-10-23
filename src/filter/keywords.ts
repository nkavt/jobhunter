import type { Derived } from '../config/index.js';
import type { Seniority } from '../schema/enums.js';

/** Level words in titles, by level. Lead, staff and principal mean different things at each company. */
const LEVEL_WORDS: [number, string[]][] = [
  [0, ['intern', 'internship', 'trainee', 'apprentice', 'graduate', 'new grad', 'entry-level']],
  [1, ['junior', 'jr']],
  [2, ['mid', 'middle', 'intermediate']],
  [3, ['senior', 'sr']],
  [4, ['lead', 'staff', 'principal']],
];
const SENIORITY = new Set(LEVEL_WORDS.flatMap(([, words]) => words));

/** Words that say nothing about what the job is. */
const NOISE = new Set([
  ...SENIORITY,
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

/** Software roles under any name ("Product Engineer", "AI Developer"): the AI judges the fit. */
const SOFTWARE_ROLE = /\b(engineer|engineering|developer|programmer|swe)s?\b/i;
/** Engineer titles that aren't software development. */
const NOT_SOFTWARE =
  /\b(sales|pre-?sales|solutions?|support|customer|success|field|mechanical|electrical|civil|chemical|hardware|manufacturing|process|quality|construction|structural|maintenance|network|recruit\w*|manager|business develop\w*)\b/i;

/**
 * True when the title has one of the keywords, or is a software engineering role of any kind
 * ("Product Engineer", "AI Engineer") so the AI can judge it. `isOther` turns away software
 * roles of a kind the user doesn't do.
 *
 * @example
 * titleMatches('Senior Product Engineer', ['frontend']) // true: a software role
 * titleMatches('Sales Engineer', ['frontend'])          // false
 * titleMatches('Account Executive', ['frontend'])       // false
 */
export function titleMatches(
  title: string,
  keywords: readonly string[],
  isOther: (title: string) => boolean = () => false,
): boolean {
  if (keywords.length === 0) return true;
  const squashed = squash(title);
  if (keywords.some((keyword) => squashed.includes(keyword))) return true;
  return SOFTWARE_ROLE.test(title) && !NOT_SOFTWARE.test(title) && !isOther(title);
}

/**
 * Specialities a generic software title can name ("Data Engineer", "Android Developer",
 * "Java Developer"), as regular expressions. On a company board they're someone else's job,
 * unless the CV names them.
 */
const OTHER_SPECIALITIES = [
  // Mobile
  'mobile',
  'ios',
  'android',
  'flutter',
  // Data and machine learning. Not "data" alone: "Software Engineer, Market Data" is a software role.
  'data (engineer\\w*|platform|infrastructure|science)',
  'big data',
  'analytics',
  'analyst',
  'bi',
  'business intelligence',
  'database',
  'machine learning',
  'ml',
  'deep learning',
  'computer vision',
  'research',
  'scientist',
  // Operations
  'dev(sec)?ops',
  'finops',
  'sre',
  'site reliability',
  'infrastructure',
  'systems engineer',
  'operations',
  'networking',
  'linux',
  // Testing and security
  'qa',
  'test(ing)?',
  'sdet',
  'automation engineer',
  'security',
  // Hardware and low level
  'embedded',
  'firmware',
  'robotics',
  'fpga',
  'asic',
  'silicon',
  'gpu',
  'kernel',
  'compiler',
  // Games, desktop and enterprise platforms
  'games?',
  'gaming',
  'unity',
  'unreal',
  'desktop',
  'salesforce',
  'sap',
  'servicenow',
  // Selling, outreach and setting up for customers
  'gtm',
  'go-to-market',
  'seo',
  'evangelist',
  'developer relations',
  'advocate',
  'implementation',
  // Other fields
  'quant',
  'blockchain',
  'web3',
  'solidity',
  'designer',
  // Languages
  'java',
  'go(lang)?',
  'python',
  'c#',
  '\\.net',
  'c\\+\\+',
  'rust',
  'scala',
  'kotlin',
  'swift',
  'elixir',
  'php',
  'ruby',
];

/** `pattern` as whole words: "go" matches "Go Developer", not "Google". */
const whole = (pattern: string) => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'i');

const LEVELS: Record<Seniority, number> = { junior: 1, mid: 2, senior: 3, lead: 4, principal: 4 };
const TITLE_LEVELS = LEVEL_WORDS.map(
  ([level, words]) => [new RegExp(`\\b(${words.join('|')})\\b`, 'i'), level] as const,
);

/** False when every level the title names is two or more away from the CV's. */
function levelFits(title: string, seniority: Seniority | undefined): boolean {
  if (!seniority) return true;
  // "Member of Technical Staff" is a title of its own, not a level.
  const plain = title.replace(/technical staff/i, '');
  const named = TITLE_LEVELS.filter(([pattern]) => pattern.test(plain));
  return named.length === 0 || named.some(([, level]) => Math.abs(level - LEVELS[seniority]) < 2);
}

/**
 * The stricter title check for companies' own job boards, which list every job the company has.
 * Like `titleMatches`, but a generic software title mustn't name another speciality ("Android
 * Developer", "Data Engineer") unless the CV does, and the level must be within one of the CV's.
 * The level check is for company boards only: the remote boards are searched by role already,
 * so they rarely list jobs far from it.
 *
 * @example
 * const keep = companyTitleFilter({ roles: ['Senior Backend Engineer'], tech, seniority: 'senior' });
 * keep('Senior Software Engineer, Payments') // true: a generic software role
 * keep('Senior Android Engineer')            // false: another speciality
 * keep('Backend Engineer Intern')            // false: too junior
 */
export function companyTitleFilter(
  derived: Pick<Derived, 'roles' | 'tech' | 'seniority'> | undefined,
): (title: string) => boolean {
  const keywords = titleKeywords(derived);
  const own = [
    ...(derived?.roles ?? []),
    ...(derived?.tech.primary ?? []),
    ...(derived?.tech.secondary ?? []),
  ].join(' ');
  const others = OTHER_SPECIALITIES.filter((pattern) => !whole(pattern).test(own));
  const other = others.length > 0 ? whole(others.join('|')) : undefined;
  const isOther = (title: string) => other?.test(title) ?? false;
  return (title) => levelFits(title, derived?.seniority) && titleMatches(title, keywords, isOther);
}
