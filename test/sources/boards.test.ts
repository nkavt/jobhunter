import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../../src/config/index.js';
import { FeedMappingSchema, parseFeed } from '../../src/mapping/index.js';
import { SearchError, type SearchEngine, type SearchResult } from '../../src/search/index.js';
import {
  ATS,
  boardJobs,
  boardQueries,
  companyFromSlug,
  dueBoards,
  dueSearches,
  findCompanyBoards,
  huntBoards,
  loadBoardState,
  saveBoardState,
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

describe('findCompanyBoards', () => {
  useTempHome();

  const lever = ats('lever');
  const result = (url: string): SearchResult => ({ url, title: '', snippet: '' });
  const engine = (
    search: (query: string) => Promise<SearchResult[]>,
    pauseMs = 0,
  ): SearchEngine => ({ name: 'Test Search', pauseMs, search });

  it('runs every due search at the engine pace and remembers the boards', async () => {
    const pauses: number[] = [];
    const queries: string[] = [];
    const state = emptyState();
    const ui = new FakeUi([]);
    const found = await findCompanyBoards(
      profile,
      state,
      {
        ui,
        ats: [lever],
        engine: engine((query) => {
          queries.push(query);
          return Promise.resolve([
            result('https://jobs.lever.co/lendbuzz/1'),
            result('https://jobs.lever.co/lendbuzz/2'),
            result('https://jobs.lever.co/portcast/3'),
            result('https://example.com/elsewhere'),
          ]);
        }, 1000),
        pause: (ms) => {
          pauses.push(ms);
          return Promise.resolve();
        },
      },
      { now },
    );

    expect(queries).toEqual([
      'site:jobs.lever.co "Senior Backend Engineer"',
      'site:jobs.lever.co "Platform Engineer"',
      'site:jobs.lever.co "Go Developer"',
    ]);
    expect(pauses).toEqual([1000, 1000]);
    expect(found).toEqual({ searched: 3, added: 2, left: 0, failed: 0 });
    expect(Object.keys(state.boards).sort()).toEqual(['lever:lendbuzz', 'lever:portcast']);
    expect(state.searches['site:jobs.lever.co "Go Developer"']).toEqual({
      searchedAt: now.toISOString(),
      found: 4 - 1,
    });
    expect(ui.output).toContain('✔ Test Search: 2 new company job boards');
    // Saved as it goes.
    expect(await loadBoardState()).toEqual(state);

    // Nothing due again for a week, unless forced.
    const again = await findCompanyBoards(
      profile,
      state,
      { ui, ats: [lever], engine: engine(() => Promise.resolve([])) },
      { now },
    );
    expect(again.searched).toBe(0);
    const forced = await findCompanyBoards(
      profile,
      state,
      { ui, ats: [lever], engine: engine(() => Promise.resolve([])) },
      { now, force: true, limit: 1 },
    );
    expect(forced.searched).toBe(1);
  });

  it('stops when the engine refuses, keeping the searches that ran', async () => {
    const many = { ...profile, boardSearch: { queries: ['a', 'b', 'c', 'd', 'e'] } };
    let calls = 0;
    const state = emptyState();
    const found = await findCompanyBoards(
      many,
      state,
      {
        ui: new FakeUi([]),
        ats: [lever],
        engine: engine(() => {
          calls++;
          return calls === 2
            ? Promise.reject(new SearchError('Slow down.', 'rate-limited'))
            : Promise.resolve([]);
        }),
      },
      { now },
    );
    expect(calls).toBe(2);
    expect(found.stopped?.reason).toBe('rate-limited');
    expect(found).toMatchObject({ searched: 1, left: 4 });
    expect(Object.keys((await loadBoardState()).searches)).toEqual(['site:jobs.lever.co a']);
  });

  it('skips a search that fails on its own and tries it again next time', async () => {
    const two = { ...profile, boardSearch: { queries: ['a', 'b'] } };
    const state = emptyState();
    const found = await findCompanyBoards(
      two,
      state,
      {
        ui: new FakeUi([]),
        ats: [lever],
        engine: engine((query) =>
          query.endsWith(' a')
            ? Promise.reject(new SearchError('Search answered with HTTP 503.'))
            : Promise.resolve([]),
        ),
      },
      { now },
    );
    expect(found).toMatchObject({ searched: 1, failed: 1, left: 1 });
    expect(found.lastFailure?.message).toBe('Search answered with HTTP 503.');
    expect(Object.keys(state.searches)).toEqual(['site:jobs.lever.co b']);
  });

  it('forgets searches for roles the profile no longer has', async () => {
    const state = emptyState();
    state.searches['site:jobs.lever.co "Old Role"'] = { searchedAt: now.toISOString(), found: 0 };
    await findCompanyBoards(
      { ...profile, boardSearch: { queries: [] } },
      state,
      { ui: new FakeUi([]), ats: [lever], engine: engine(() => Promise.resolve([])) },
      { now },
    );
    expect(state.searches).toEqual({});
  });
});

describe('huntBoards', () => {
  const server = useMockServer();
  useTempHome();

  const keepAll = () => true;
  const lever = ats('lever');
  const leverFeed = (slug: string, body: string) =>
    http.get(`https://api.lever.co/v0/postings/${slug}`, () =>
      HttpResponse.text(body, { headers: { 'Content-Type': 'application/json' } }),
    );
  const known = (...boards: string[]): BoardState => {
    const state = emptyState();
    for (const board of boards) {
      state.boards[`lever:${board}`] = { ats: 'lever', board, foundAt: '2026-10-01T00:00:00Z' };
    }
    return state;
  };

  it('reads the known boards and only passes on the jobs `keep` lets through', async () => {
    server.use(leverFeed('lendbuzz', fixture('lever.json')), leverFeed('portcast', '[]'));
    const state = known('lendbuzz', 'portcast');
    const jobs = await huntBoards(
      state,
      { ui: new FakeUi([]), ats: [lever] },
      { now, keep: (job) => job.title.includes('Engineer') },
    );
    // The company named after the slug.
    expect(jobs.map((j) => [j.job.title, j.job.company, j.channel])).toEqual([
      ['Backend Engineer', 'Lendbuzz', 'Lever'],
    ]);
    expect(state.boards['lever:lendbuzz']?.lastFetchedAt).toBe(now.toISOString());
    expect(dueBoards(state, now)).toEqual([]);
    expect(dueBoards(state, now, true)).toHaveLength(2);
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
    const state = known('gone', 'busy');
    const ui = new FakeUi([]);
    const jobs = await huntBoards(state, { ui, ats: [lever] }, { now, keep: keepAll });
    expect(jobs).toEqual([]);
    expect(Object.keys(state.boards)).toEqual(['lever:busy']);
    expect(state.boards['lever:busy']?.lastFetchedAt).toBeUndefined();
    expect(ui.output.join('\n')).toContain("Couldn't read 1 company job boards");
  });

  it('keeps the state through a save', async () => {
    const state = known('acme');
    await saveBoardState(state);
    expect(await loadBoardState()).toEqual(state);
  });
});
