import { ATS_FEEDS } from '../builtin.js';

export const ATS_IDS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsId = (typeof ATS_IDS)[number];

/**
 * An applicant tracking system whose companies publish their jobs on public boards with a
 * JSON API. Boards are found by web search (`site:`), then read through the API with the
 * ATS's mapping in `BUILTIN_MAPPINGS`.
 */
export interface Ats {
  /** Stored on every job (`job.source`). */
  id: AtsId;
  /** Shown in the sheet's Channel column. */
  name: string;
  /** Searched with `site:`. */
  site: string;
  /** The board a search result links into, e.g. `jobs.lever.co/acme/123` → `acme`. */
  boardFrom: (url: URL) => string | undefined;
  /** The feed URL with `{board}` for the board; also the key of its mapping. */
  feed: string;
  /** Boards on another host, by the prefix of their saved name: Lever's EU boards are `eu:acme`. */
  regionalFeeds?: Record<string, string>;
  /** Reshape the feed before mapping: join or pick fields a mapping can't express. */
  prepare?: (feed: unknown) => unknown;
  /** The company's name from the whole feed, for boards whose jobs don't name it. */
  company?: (feed: unknown) => string | undefined;
}

/** Where a board's jobs are, and which mapping reads them. */
export function feedOf(ats: Ats, board: string): { url: string; mappingKey: string } {
  for (const [prefix, template] of Object.entries(ats.regionalFeeds ?? {})) {
    if (board.startsWith(prefix)) return fill(template, board.slice(prefix.length));
  }
  return fill(ats.feed, board);
}

const fill = (template: string, slug: string) => ({
  url: template.replace('{board}', encodeURIComponent(slug)),
  mappingKey: template,
});

type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const items = (value: unknown): Item[] => (Array.isArray(value) ? value.filter(isItem) : []);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Board slugs are a single path segment; these are the sites' own pages, not boards. */
const RESERVED = new Set(['embed', 'api', 'j', 'jobs', 'v0', 'v1']);
function firstSegment(url: URL): string | undefined {
  let segment: string;
  try {
    segment = decodeURIComponent(url.pathname.split('/')[1] ?? '').trim();
  } catch {
    // A stray `%` ("100%-remote"): not a board name we could read.
    return undefined;
  }
  return segment && !RESERVED.has(segment.toLowerCase()) && !/[\s?#]/.test(segment)
    ? segment
    : undefined;
}

const LEVER_EU = 'eu:';

export const ATS: Ats[] = [
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    // Covers boards., job-boards. and the EU hosts; one API serves them all.
    site: 'greenhouse.io',
    boardFrom: (url) => {
      if (!/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(url.hostname)) return undefined;
      // Embedded boards: boards.greenhouse.io/embed/job_board?for=acme
      return url.searchParams.get('for') ?? firstSegment(url);
    },
    feed: ATS_FEEDS.greenhouse,
  },
  {
    id: 'lever',
    name: 'Lever',
    // Covers jobs. and jobs.eu.; Lever's own pages that also match aren't boards and are skipped.
    site: 'lever.co',
    boardFrom: (url) => {
      const slug = /^jobs(\.eu)?\.lever\.co$/.test(url.hostname) ? firstSegment(url) : undefined;
      return slug && url.hostname.includes('.eu.') ? `${LEVER_EU}${slug}` : slug;
    },
    feed: ATS_FEEDS.lever,
    regionalFeeds: { [LEVER_EU]: ATS_FEEDS.leverEu },
    // Requirements and benefits are separate lists next to the description.
    prepare: (feed) =>
      items(feed).map((job) => ({
        ...job,
        fullDescription: [
          str(job.description),
          ...items(job.lists).map(
            (list) => `<h3>${str(list.text)}</h3><ul>${str(list.content)}</ul>`,
          ),
          str(job.additional),
        ].join(''),
      })),
  },
  {
    id: 'ashby',
    name: 'Ashby',
    site: 'jobs.ashbyhq.com',
    boardFrom: (url) => (url.hostname === 'jobs.ashbyhq.com' ? firstSegment(url) : undefined),
    feed: ATS_FEEDS.ashby,
    // The salary is one of several compensation parts (equity, bonus…).
    prepare: (feed) =>
      items(isItem(feed) ? feed.jobs : undefined)
        .filter((job) => job.isListed !== false)
        .map((job) => {
          const compensation = isItem(job.compensation) ? job.compensation : {};
          const salary = items(compensation.summaryComponents).find(
            (part) => part.compensationType === 'Salary',
          );
          return { ...job, salary };
        }),
  },
  {
    id: 'workable',
    name: 'Workable',
    site: 'apply.workable.com',
    boardFrom: (url) => (url.hostname === 'apply.workable.com' ? firstSegment(url) : undefined),
    feed: ATS_FEEDS.workable,
    // City, region and country come separately.
    prepare: (feed) =>
      items(isItem(feed) ? feed.jobs : undefined).map((job) => {
        const place = items(job.locations)[0] ?? {
          city: job.city,
          region: job.state,
          country: job.country,
        };
        const parts = [place.city, place.region, place.country].map(str).filter(Boolean);
        return { ...job, place: [...new Set(parts)].join(', ') };
      }),
    company: (feed) => (isItem(feed) ? str(feed.name) || undefined : undefined),
  },
];
