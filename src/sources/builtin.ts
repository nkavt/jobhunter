import type { FeedMapping } from '../mapping/index.js';

export interface SourceDefinition {
  /** Stable slug, stored on every job (`job.source`). */
  id: string;
  /** Shown in the sheet's Channel column. The boards' terms ask to be named as the source. */
  name: string;
  feedUrl: string;
  /** Don't fetch more often than this; Remotive asks for at most ~4 requests a day. */
  minIntervalHours: number;
  /** Key into the mappings (built-in, and later the config's `mappings.json`). */
  mappingKey: string;
}

const REMOTE = { const: 'remote' } as const;

/**
 * Companies' own job boards: each ATS's feed URL, with `{board}` for the company's board. These
 * are also the keys of their mappings, one per ATS for all its companies.
 */
export const ATS_FEEDS = {
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true',
  lever: 'https://api.lever.co/v0/postings/{board}?mode=json',
  leverEu: 'https://api.eu.lever.co/v0/postings/{board}?mode=json',
  ashby: 'https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true',
  workable: 'https://apply.workable.com/api/v1/widget/accounts/{board}?details=true',
} as const;

// Lever's EU boards are the same API on another host.
const LEVER: FeedMapping = {
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
    // `fullDescription` is prepared: the description with the requirement and benefit lists.
    description: { from: 'fullDescription', transform: 'html' },
  },
};

/**
 * Built-in mappings: plain data in the same format as `mappings.json`, so user or AI-written
 * mappings can be merged with these later and applied by the same engine.
 */
export const BUILTIN_MAPPINGS: Record<string, FeedMapping> = {
  'https://remotive.com/api/remote-jobs': {
    format: 'json',
    items: 'jobs',
    fields: {
      sourceId: { from: 'id', transform: 'string' },
      url: 'url',
      title: { from: 'title', transform: 'text' },
      company: { from: 'company_name', transform: 'text' },
      location: { from: 'candidate_required_location', transform: 'location' },
      workMode: REMOTE,
      employmentType: {
        from: 'job_type',
        map: {
          full_time: 'full_time',
          part_time: 'part_time',
          contract: 'contract',
          freelance: 'freelance',
          internship: 'internship',
        },
      },
      salary: { from: 'salary', transform: 'salaryText' },
      postedAt: { from: 'publication_date', transform: 'date' },
      description: { from: 'description', transform: 'html' },
      tags: { from: 'tags', transform: 'list' },
    },
  },

  'https://remoteok.com/api': {
    format: 'json',
    items: '',
    // The first entry is Remote OK's legal notice, not a job.
    skipIf: { missing: 'id' },
    fields: {
      sourceId: { from: 'id', transform: 'string' },
      url: 'url',
      title: { from: 'position', transform: 'text' },
      company: { from: 'company', transform: 'text' },
      location: { from: 'location', transform: 'location' },
      workMode: REMOTE,
      // 0 means "not given".
      'salary.min': { from: 'salary_min', transform: 'positive' },
      'salary.max': { from: 'salary_max', transform: 'positive' },
      'salary.currency': { const: 'USD' },
      // No period is given, and both hourly ($36–48) and yearly ($40k–350k) amounts appear.
      'salary.period': { from: 'salary_max', transform: 'periodFromAmount' },
      postedAt: { from: 'date', transform: 'date' },
      description: { from: 'description', transform: 'html' },
      tags: { from: 'tags', transform: 'list' },
    },
  },

  'https://weworkremotely.com/remote-jobs.rss': {
    format: 'xml',
    items: 'rss.channel.item',
    fields: {
      sourceId: 'guid',
      url: 'link',
      // Titles look like "Vercel: Software Engineer - Data Platform".
      company: { from: 'title', transform: 'before:: ' },
      title: { from: 'title', transform: 'after:: ' },
      location: { from: 'region', transform: 'location' },
      workMode: REMOTE,
      employmentType: {
        from: 'type',
        map: { 'Full-Time': 'full_time', 'Part-Time': 'part_time', Contract: 'contract' },
      },
      postedAt: { from: 'pubDate', transform: 'date' },
      description: { from: 'description', transform: 'html' },
      tags: { from: 'skills', transform: 'list' },
    },
  },

  // Companies' own job boards. Fields marked "prepared" are added by the ATS's `prepare` in
  // src/sources/boards/ats.ts, for what a mapping can't express; jobs without a company get the
  // board's company as a default.

  [ATS_FEEDS.greenhouse]: {
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

  [ATS_FEEDS.lever]: LEVER,
  [ATS_FEEDS.leverEu]: LEVER,

  [ATS_FEEDS.ashby]: {
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
      // `salary` is prepared: the salary part of the compensation.
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

  [ATS_FEEDS.workable]: {
    format: 'json',
    items: '',
    fields: {
      sourceId: 'shortcode',
      url: 'url',
      title: { from: 'title', transform: 'text' },
      // `place` is prepared: city, region and country joined.
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
};

export const BUILTIN_SOURCES: SourceDefinition[] = [
  {
    id: 'remotive',
    name: 'Remotive',
    // The free API returns only the latest jobs and ignores filters; our keyword filter decides relevance.
    feedUrl: 'https://remotive.com/api/remote-jobs',
    minIntervalHours: 6,
    mappingKey: 'https://remotive.com/api/remote-jobs',
  },
  {
    id: 'remoteok',
    name: 'Remote OK',
    feedUrl: 'https://remoteok.com/api',
    minIntervalHours: 6,
    mappingKey: 'https://remoteok.com/api',
  },
  {
    id: 'weworkremotely',
    name: 'We Work Remotely',
    feedUrl: 'https://weworkremotely.com/remote-jobs.rss',
    minIntervalHours: 6,
    mappingKey: 'https://weworkremotely.com/remote-jobs.rss',
  },
];
