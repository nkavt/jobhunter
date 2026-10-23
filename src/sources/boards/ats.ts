import type { FeedMapping } from '../../mapping/index.js';

export const ATS_IDS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsId = (typeof ATS_IDS)[number];

/**
 * An applicant tracking system whose companies publish their jobs on public boards with a
 * JSON API. Boards are found by web search (`site:`), then read through the API.
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
  feedUrl: (board: string) => string;
  /** Reshape the feed before mapping: join or pick fields a mapping can't express. */
  prepare?: (feed: unknown) => unknown;
  /** The company's name from the whole feed, for boards whose jobs don't name it. */
  company?: (feed: unknown) => string | undefined;
  mapping: FeedMapping;
}

type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const items = (value: unknown): Item[] => (Array.isArray(value) ? value.filter(isItem) : []);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Board slugs are a single path segment; these are the sites' own pages, not boards. */
const RESERVED = new Set(['embed', 'api', 'j', 'jobs', 'v0', 'v1']);
function firstSegment(url: URL): string | undefined {
  const segment = decodeURIComponent(url.pathname.split('/')[1] ?? '').trim();
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
    feedUrl: (board) =>
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
    mapping: {
      format: 'json',
      items: 'jobs',
      fields: {
        sourceId: { from: 'id', transform: 'string' },
        url: 'absolute_url',
        title: { from: 'title', transform: 'text' },
        company: { from: 'company_name', transform: 'text' },
        location: { from: 'location.name', transform: 'location' },
        postedAt: { from: 'first_published', transform: 'date' },
        // HTML with its tags escaped ("&lt;p&gt;"): the first pass unescapes, the second strips.
        description: { from: 'content', transform: ['html', 'html'] },
      },
    },
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
    feedUrl: (board) =>
      board.startsWith(LEVER_EU)
        ? `https://api.eu.lever.co/v0/postings/${encodeURIComponent(board.slice(LEVER_EU.length))}?mode=json`
        : `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
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
    mapping: {
      format: 'json',
      items: '',
      fields: {
        sourceId: 'id',
        url: 'hostedUrl',
        title: { from: 'text', transform: 'text' },
        location: { from: 'categories.location', transform: 'location' },
        workMode: {
          from: 'workplaceType',
          map: { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' },
        },
        employmentType: {
          from: 'categories.commitment',
          map: {
            'Full-Time': 'full_time',
            'Full-time': 'full_time',
            'Part-Time': 'part_time',
            'Part-time': 'part_time',
            Contract: 'contract',
            Contractor: 'contract',
            Freelance: 'freelance',
            Intern: 'internship',
            Internship: 'internship',
          },
        },
        'salary.min': { from: 'salaryRange.min', transform: 'positive' },
        'salary.max': { from: 'salaryRange.max', transform: 'positive' },
        'salary.currency': { from: 'salaryRange.currency', transform: 'text' },
        'salary.period': {
          from: 'salaryRange.interval',
          map: { 'per-year-salary': 'year', 'per-month-salary': 'month', 'per-hour-wage': 'hour' },
        },
        postedAt: { from: 'createdAt', transform: 'date' },
        description: { from: 'fullDescription', transform: 'html' },
      },
    },
  },
  {
    id: 'ashby',
    name: 'Ashby',
    site: 'jobs.ashbyhq.com',
    boardFrom: (url) => (url.hostname === 'jobs.ashbyhq.com' ? firstSegment(url) : undefined),
    feedUrl: (board) =>
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`,
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
    mapping: {
      format: 'json',
      items: '',
      fields: {
        sourceId: 'id',
        url: 'jobUrl',
        title: { from: 'title', transform: 'text' },
        location: { from: 'location', transform: 'location' },
        workMode: {
          from: 'workplaceType',
          map: { Remote: 'remote', Hybrid: 'hybrid', OnSite: 'onsite' },
        },
        employmentType: {
          from: 'employmentType',
          map: {
            FullTime: 'full_time',
            PartTime: 'part_time',
            Contract: 'contract',
            Intern: 'internship',
          },
        },
        'salary.min': { from: 'salary.minValue', transform: 'positive' },
        'salary.max': { from: 'salary.maxValue', transform: 'positive' },
        'salary.currency': { from: 'salary.currencyCode', transform: 'text' },
        'salary.period': {
          from: 'salary.interval',
          map: { '1 YEAR': 'year', '1 MONTH': 'month', '1 HOUR': 'hour' },
        },
        // `null` when the job shows no pay; the transform turns that into "no value".
        'salary.text': {
          from: 'compensation.scrapeableCompensationSalarySummary',
          transform: 'text',
        },
        postedAt: { from: 'publishedAt', transform: 'date' },
        description: { from: 'descriptionHtml', transform: 'html' },
      },
    },
  },
  {
    id: 'workable',
    name: 'Workable',
    site: 'apply.workable.com',
    boardFrom: (url) => (url.hostname === 'apply.workable.com' ? firstSegment(url) : undefined),
    feedUrl: (board) =>
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`,
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
    mapping: {
      format: 'json',
      items: '',
      fields: {
        sourceId: 'shortcode',
        url: 'url',
        title: { from: 'title', transform: 'text' },
        location: { from: 'place', transform: 'location' },
        // Only says when a job is remote; anything else is left to the description.
        workMode: { from: 'telecommuting', map: { true: 'remote' } },
        employmentType: {
          from: 'employment_type',
          map: {
            'Full-time': 'full_time',
            'Part-time': 'part_time',
            Contract: 'contract',
            Internship: 'internship',
          },
        },
        postedAt: { from: 'published_on', transform: 'date' },
        description: { from: 'description', transform: 'html' },
      },
    },
  },
];
