import type { Derived } from '../config/index.js';
import type { Seniority } from '../schema/enums.js';

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

/** Software roles under any name ("Product Engineer", "AI Developer"): the AI judges the fit. */
const SOFTWARE_ROLE = /\b(engineer|engineering|developer|programmer|swe)s?\b/i;
/** Engineer titles that aren't software development. */
const NOT_SOFTWARE =
  /\b(sales|pre-?sales|solutions?|support|customer|success|field|mechanical|electrical|civil|chemical|hardware|manufacturing|process|quality|construction|structural|maintenance|network|recruit\w*|manager|business develop\w*)\b/i;

/**
 * True when the title has one of the keywords, or is a software engineering role of any kind
 * ("Product Engineer", "AI Engineer") so the AI can judge it.
 *
 * @example
 * titleMatches('Senior Product Engineer', ['frontend']) // true: a software role
 * titleMatches('Sales Engineer', ['frontend'])          // false
 * titleMatches('Account Executive', ['frontend'])       // false
 */
export function titleMatches(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const squashed = squash(title);
  if (keywords.some((keyword) => squashed.includes(keyword))) return true;
  return isSoftwareRole(title);
}

const isSoftwareRole = (title: string) => SOFTWARE_ROLE.test(title) && !NOT_SOFTWARE.test(title);

/**
 * Specialities a generic software title can name ("Data Engineer", "Android Developer",
 * "Java Developer"). On a company board they're someone else's job, unless the CV names them.
 */
const OTHER_SPECIALITIES = [
  'mobile',
  'ios',
  'android',
  'flutter',
  // Not "data" alone: "Software Engineer, Market Data" is a software role.
  'data engineer',
  'data engineering',
  'data platform',
  'data infrastructure',
  'data science',
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
  'devops',
  'devsecops',
  'sre',
  'site reliability',
  'infrastructure',
  'systems engineer',
  'operations',
  'finops',
  'networking',
  'linux',
  'qa',
  'test',
  'testing',
  'sdet',
  'automation engineer',
  'security',
  'embedded',
  'firmware',
  'robotics',
  'fpga',
  'asic',
  'silicon',
  'gpu',
  'kernel',
  'compiler',
  'game',
  'games',
  'gaming',
  'unity',
  'unreal',
  'desktop',
  'salesforce',
  'sap',
  'servicenow',
  'gtm',
  'go-to-market',
  'seo',
  'evangelist',
  'developer relations',
  'advocate',
  'implementation',
  'quant',
  'blockchain',
  'web3',
  'solidity',
  'designer',
  'java',
  'go',
  'golang',
  'python',
  'c#',
  '.net',
  'c++',
  'rust',
  'scala',
  'kotlin',
  'swift',
  'elixir',
  'php',
  'ruby',
];

/** `phrase` as whole words: "go" matches "Go Developer", not "Google". */
const wordPattern = (phrase: string) =>
  new RegExp(`(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');

const LEVELS: Record<Seniority, number> = { junior: 1, mid: 2, senior: 3, lead: 4, principal: 4 };
/** Levels a title can name; lead, staff and principal mean different things at each company. */
const TITLE_LEVELS: [RegExp, number][] = [
  [/\b(intern|internship|trainee|apprentice|graduate|new grad|entry[- ]level)\b/i, 0],
  [/\b(junior|jr)\b/i, 1],
  [/\b(mid|middle|intermediate)\b/i, 2],
  [/\b(senior|sr)\b/i, 3],
  [/\b(lead|staff|principal)\b/i, 4],
];

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
  const others = OTHER_SPECIALITIES.map(wordPattern).filter((pattern) => !pattern.test(own));
  return (title) => {
    if (!levelFits(title, derived?.seniority)) return false;
    if (keywords.length === 0) return true;
    const squashed = squash(title);
    if (keywords.some((keyword) => squashed.includes(keyword))) return true;
    return isSoftwareRole(title) && !others.some((pattern) => pattern.test(title));
  };
}
