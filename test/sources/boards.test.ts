import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../../src/config/index.js';
import { FeedMappingSchema, parseFeed } from '../../src/mapping/index.js';
import { SearchError, type SearchResult } from '../../src/search/index.js';
import {
  ATS,
  boardJobs,
  boardQueries,
  boardsDue,
  companyFromSlug,
  dueSearches,
  huntBoards,
  loadBoardState,
  MAX_SEARCHES_PER_RUN,
  saveBoardState,
  SEARCH_PAUSE_MS,
  type Ats,
  type AtsId,
  type BoardState,
} from '../../src/sources/boards/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-21T12:00:00Z');
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), 'utf8');
const ats = (id: AtsId): Ats => {
  const found = ATS.find((a) => a.id === id);
  if (!found) throw new Error(id);
  return found;
};
const BOARDS: Record<AtsId, string> = {
  greenhouse: 'stripe',
  lever: 'lendbuzz',
  ashby: 'ramp',
  workable: 'huggingface',
};
const convert = (id: AtsId) =>
  boardJobs(ats(id), BOARDS[id], parseFeed(fixture(`${id}.json`), 'json'));
const emptyState = (): BoardState => ({ searches: {}, boards: {} });
const profile: Pick<Profile, 'derived' | 'preferences' | 'boardSearch'> = {
  derived: {
    roles: ['Senior Backend Engineer', 'Platform Engineer', 'Go Developer', 'Tech Lead'],
    seniority: 'senior',
    yearsOfExperience: 8,
    tech: { primary: ['Go'], secondary: [] },
    domains: [],
    languages: [],
  },
};

describe('ATS mappings', () => {
  it('are valid mappings with distinct ids', () => {
    for (const system of ATS) {
      expect(FeedMappingSchema.safeParse(system.mapping).success, system.id).toBe(true);
    }
    expect(ATS.map((a) => a.name)).toEqual(['Greenhouse', 'Lever', 'Ashby', 'Workable']);
  });

  it('Greenhouse: company from the job, escaped HTML descriptions', () => {
    const { jobs, errors } = convert('greenhouse');
    expect(errors).toEqual([]);
    expect(jobs[0]).toMatchObject({
      source: 'greenhouse',
      sourceId: '8172510',
      company: 'Stripe',
      title: 'Abuse Investigator',
      url: 'https://stripe.com/jobs/search?gh_jid=8172510',
      location: { text: 'Seattle, San Francisco, New York City' },
    });
    expect(jobs[0]?.description).toMatch(/^Who we are/);
    expect(jobs[0]?.description).not.toMatch(/<\w+|&lt;/);
    expect(jobs[0]?.postedAt).toBe('2026-09-09T14:50:29.000Z');
  });

  it('Lever: work mode, salary range, and the lists joined into the description', () => {
    const { jobs, errors } = convert('lever');
    expect(errors).toEqual([]);
    expect(jobs[0]).toMatchObject({
      source: 'lever',
      company: 'Lendbuzz',
      title: 'Backend Engineer',
      workMode: 'hybrid',
      employmentType: 'full_time',
      location: { text: 'Tel Aviv' },
      url: 'https://jobs.lever.co/lendbuzz/f234abf5-c204-4b15-986a-d8ce996883fd',
    });
    expect(jobs[0]?.description).toContain('Responsibilities');
    expect(jobs[0]?.description).toContain('- Build backend systems.');
    expect(jobs[0]?.description).toContain('We offer equity.');
    expect(jobs[0]?.postedAt).toMatch(/Z$/);
    expect(jobs[1]).toMatchObject({
      workMode: 'remote',
      salary: { min: 80000, max: 175000, currency: 'USD', period: 'year' },
    });
  });

  it('Ashby: salary from the compensation parts, unlisted jobs left out', () => {
    const { jobs, errors } = convert('ashby');
    expect(errors).toEqual([]);
    expect(jobs.map((j) => j.title)).toEqual([
      'Security Engineer, Cloud',
      'Account Manager | Mid-Market',
    ]);
    expect(jobs[0]).toMatchObject({
      company: 'Ramp',
      workMode: 'hybrid',
      employmentType: 'full_time',
      salary: {
        min: 211400,
        max: 290600,
        currency: 'USD',
        period: 'year',
        text: '$211.4K - $290.6K',
      },
      url: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
    });
    expect(jobs[1]?.workMode).toBe('remote');
    // Ashby sends `null` when a job shows no pay.
    expect(jobs[1]).not.toHaveProperty('salary');
  });

  it('Workable: company from the account, location from its parts', () => {
    const { jobs, errors } = convert('workable');
    expect(errors).toEqual([]);
    expect(jobs[0]).toMatchObject({
      company: 'Hugging Face',
      sourceId: '81B46579FE',
      workMode: 'remote',
      employmentType: 'full_time',
      location: { text: 'Paris, Île-de-France, France' },
      postedAt: '2026-05-29T00:00:00.000Z',
    });
  });
});

describe('ATS boards from search results', () => {
  const board = (href: string) => {
    const url = new URL(href);
    for (const system of ATS) {
      const found = system.boardFrom(url);
      if (found) return `${system.id}:${found}`;
    }
    return undefined;
  };

  it('reads the board from job and board URLs on every host', () => {
    expect(board('https://boards.greenhouse.io/stripe/jobs/123')).toBe('greenhouse:stripe');
    expect(board('https://job-boards.eu.greenhouse.io/sportygroup/jobs/4725309101')).toBe(
      'greenhouse:sportygroup',
    );
    expect(board('https://boards.greenhouse.io/embed/job_board?for=acme')).toBe('greenhouse:acme');
    expect(board('https://jobs.lever.co/lendbuzz/f234abf5')).toBe('lever:lendbuzz');
    expect(board('https://jobs.eu.lever.co/acme/1')).toBe('lever:eu:acme');
    expect(board('https://jobs.ashbyhq.com/ramp/34413f8d')).toBe('ashby:ramp');
    expect(board('https://apply.workable.com/huggingface/j/81B46579FE/')).toBe(
      'workable:huggingface',
    );
  });

  it('ignores pages that are not a company board', () => {
    expect(board('https://apply.workable.com/j/81B46579FE')).toBeUndefined();
    expect(board('https://www.greenhouse.io/blog/hiring')).toBeUndefined();
    expect(board('https://jobs.lever.co/')).toBeUndefined();
    expect(board('https://example.com/jobs.lever.co/acme')).toBeUndefined();
  });

  it('reads EU Lever boards from the EU API', () => {
    expect(ats('lever').feedUrl('eu:acme')).toBe(
      'https://api.eu.lever.co/v0/postings/acme?mode=json',
    );
  });

  it('names a company from its slug when the board does not', () => {
    expect(companyFromSlug('acme-corp')).toBe('Acme Corp');
    expect(companyFromSlug('eu:acme')).toBe('Acme');
  });
});

describe('board searches', () => {
  it('search each site for the top CV roles, or the profile queries', () => {
    const queries = boardQueries(profile);
    expect(queries).toHaveLength(ATS.length * 3);
    expect(queries[0]).toBe('site:greenhouse.io "Senior Backend Engineer"');
    expect(queries).toContain('site:apply.workable.com "Go Developer"');

    const remote = boardQueries({
      ...profile,
      preferences: {
        workModes: ['remote'],
        visaSponsorshipNeeded: false,
        employmentTypes: ['full_time'],
      },
    });
    expect(remote[0]).toBe('site:greenhouse.io "Senior Backend Engineer" remote');

    const custom = boardQueries({ ...profile, boardSearch: { queries: ['golang remote'] } });
    expect(custom).toEqual(ATS.map((a) => `site:${a.site} golang remote`));
    expect(boardQueries({ ...profile, boardSearch: { queries: [] } })).toEqual([]);
  });

  it('repeat a search after a week, oldest first', () => {
    const state = emptyState();
    state.searches['a'] = { searchedAt: '2026-10-20T00:00:00Z', found: 1 };
    state.searches['b'] = { searchedAt: '2026-10-10T00:00:00Z', found: 1 };
    state.searches['c'] = { searchedAt: '2026-10-01T00:00:00Z', found: 1 };
    expect(dueSearches(['a', 'b', 'c', 'd'], state, now)).toEqual(['d', 'c', 'b']);
  });
});

describe('huntBoards', () => {
  const server = useMockServer();
  useTempHome();

  const keepAll = () => true;
  const lever = ats('lever');
  const pauses: number[] = [];
  const deps = (search: (query: string) => Promise<SearchResult[]>) => ({
    ui: new FakeUi([]),
    ats: [lever],
    search,
    pause: (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    },
  });
  const result = (url: string): SearchResult => ({ url, title: '', snippet: '' });
  const leverFeed = (slug: string, body: string) =>
    http.get(`https://api.lever.co/v0/postings/${slug}`, () =>
      HttpResponse.text(body, { headers: { 'Content-Type': 'application/json' } }),
    );

  it('finds boards by search, reads them, and remembers both', async () => {
    pauses.length = 0;
    server.use(leverFeed('lendbuzz', fixture('lever.json')), leverFeed('portcast', '[]'));
    const queries: string[] = [];
    const state = emptyState();
    const jobs = await huntBoards(
      profile,
      state,
      deps((query) => {
        queries.push(query);
        return Promise.resolve([
          result('https://jobs.lever.co/lendbuzz/1'),
          result('https://jobs.lever.co/lendbuzz/2'),
          result('https://jobs.lever.co/portcast/3'),
          result('https://example.com/elsewhere'),
        ]);
      }),
      { now, keep: (job) => job.title.includes('Engineer') },
    );

    expect(queries).toEqual([
      'site:jobs.lever.co "Senior Backend Engineer"',
      'site:jobs.lever.co "Platform Engineer"',
      'site:jobs.lever.co "Go Developer"',
    ]);
    expect(pauses).toEqual([SEARCH_PAUSE_MS, SEARCH_PAUSE_MS]);
    // Only the jobs `keep` lets through; the company named after the slug.
    expect(jobs.map((j) => [j.job.title, j.job.company, j.channel])).toEqual([
      ['Backend Engineer', 'Lendbuzz', 'Lever'],
    ]);
    expect(Object.keys(state.boards).sort()).toEqual(['lever:lendbuzz', 'lever:portcast']);
    expect(state.boards['lever:lendbuzz']?.lastFetchedAt).toBe(now.toISOString());
    expect(state.searches['site:jobs.lever.co "Go Developer"']).toEqual({
      searchedAt: now.toISOString(),
      found: 4 - 1,
    });

    // Saved and read back: nothing is due again right away.
    await saveBoardState(state);
    const saved = await loadBoardState();
    expect(saved).toEqual(state);
    expect(boardsDue(profile, saved, now, { ats: [lever] })).toBe(false);
    expect(boardsDue(profile, saved, now, { ats: [lever], force: true })).toBe(true);
  });

  it('runs a few searches per hunt and stops at the bot check', async () => {
    const many = { ...profile, boardSearch: { queries: ['a', 'b', 'c', 'd', 'e'] } };
    let calls = 0;
    const state = emptyState();
    const d = deps(() => {
      calls++;
      return calls === 2
        ? Promise.reject(new SearchError('DuckDuckGo asked to slow down.', 'rate-limited'))
        : Promise.resolve([]);
    });
    await huntBoards(many, state, d, { now, keep: keepAll });
    expect(calls).toBe(2);
    expect(Object.keys(state.searches)).toEqual(['site:jobs.lever.co a']);
    expect(d.ui.output.join('\n')).toContain('The remaining 4 searches wait for a later run.');

    calls = 10;
    await huntBoards(many, state, d, { now, keep: keepAll });
    expect(Object.keys(state.searches)).toHaveLength(1 + MAX_SEARCHES_PER_RUN);
  });

  it('forgets boards that no longer exist and retries ones that failed', async () => {
    server.use(
      http.get(
        'https://api.lever.co/v0/postings/gone',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'https://api.lever.co/v0/postings/busy',
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    const state = emptyState();
    for (const board of ['gone', 'busy']) {
      state.boards[`lever:${board}`] = { ats: 'lever', board, foundAt: '2026-10-01T00:00:00Z' };
    }
    const d = deps(() => Promise.resolve([]));
    const jobs = await huntBoards({ ...profile, boardSearch: { queries: [] } }, state, d, {
      now,
      keep: keepAll,
    });
    expect(jobs).toEqual([]);
    expect(Object.keys(state.boards)).toEqual(['lever:busy']);
    expect(state.boards['lever:busy']?.lastFetchedAt).toBeUndefined();
    expect(d.ui.output.join('\n')).toContain("Couldn't read 1 company job boards");
  });
});
