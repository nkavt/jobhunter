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
