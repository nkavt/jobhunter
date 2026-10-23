import { describe, expect, it } from 'vitest';
import type { Preferences } from '../../src/config/index.js';
import {
  DEFAULT_MIN_SCORE,
  describeJob,
  describePreferences,
  minScoreFor,
  scoreJobs,
} from '../../src/fit/index.js';
import type { Job } from '../../src/jobs/index.js';
import type { JsonRequest } from '../../src/llm/index.js';
import { InvalidResponseError } from '../../src/llm/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';

const job = (n: number, patch: Partial<Job> = {}): Job => ({
  source: 'remotive',
  sourceId: String(n),
  url: `https://remotive.com/remote-jobs/${String(n)}`,
  title: `Frontend Engineer ${String(n)}`,
  company: 'Acme',
  location: { worldwide: true, regions: [] },
  description: `Job ${String(n)} description.`,
  tags: [],
  ...patch,
});

const preferences: Preferences = {
  workModes: ['remote'],
  remote: { eligibleCountries: ['GE'], timezone: { base: 'UTC+4', toleranceHours: 3 } },
  visaSponsorshipNeeded: false,
  employmentTypes: ['full_time'],
  minSalary: { amount: 60000, currency: 'USD', period: 'year' },
};
const candidate = {
  instructions: '# Candidate profile\nSenior frontend engineer.',
  cv: '# Alex Example',
  preferences,
};

/** A fake model that scores each uid it was sent; `skip` drops one uid on the first attempt. */
function scorer(skip?: string) {
  return new FakeLLM({
    json: (attempt: number, request: JsonRequest<unknown>) => {
      const uids = [...request.prompt.matchAll(/<job uid="(j\d+)">/g)].map((m) => m[1] ?? '');
      return {
        results: uids
          .filter((uid) => !(attempt === 0 && uid === skip))
          .map((uid) => ({ uid, score: 70, note: `Good fit (${uid}).` })),
      };
    },
  });
}

describe('scoreJobs', () => {
  it('sends the candidate once in a cached system prompt and the jobs in batches', async () => {
    const llm = scorer();
    const { fits } = await scoreJobs([job(1), job(2), job(3)], candidate, llm, { batchSize: 2 });

    expect(fits).toEqual([
      { score: 70, note: 'Good fit (j1).' },
      { score: 70, note: 'Good fit (j2).' },
      { score: 70, note: 'Good fit (j1).' },
    ]);
    const requests = llm.calls.map((c) => c.request as JsonRequest<unknown>);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.cacheSystem).toBe(true);
    expect(requests[0]?.system).toBe(requests[1]?.system);
    expect(requests[0]?.system).toContain('Senior frontend engineer.');
    expect(requests[0]?.system).toContain('Remote: can legally work from GE, timezone UTC+4 ±3h.');
    expect(requests[0]?.prompt).toContain('<job uid="j1">');
    expect(requests[0]?.prompt).toContain('<job uid="j2">');
    expect(requests[1]?.prompt).toContain('Frontend Engineer 3');
  });

  it('tells the AI the user\'s cut-off for "Declined:" notes', async () => {
    const withDefault = scorer();
    await scoreJobs([job(1)], candidate, withDefault);
    const defaultSystem = (withDefault.calls[0]?.request as JsonRequest<unknown>).system;
    expect(defaultSystem).toContain(
      'When the score is below 50 (the candidate\'s cut-off), start with "Declined:"',
    );

    const strict = scorer();
    await scoreJobs(
      [job(1)],
      { ...candidate, preferences: { ...preferences, minScore: 70 } },
      strict,
    );
    expect((strict.calls[0]?.request as JsonRequest<unknown>).system).toContain(
      "below 70 (the candidate's cut-off)",
    );
  });

  it('uses the minScore preference, or the default', () => {
    expect(DEFAULT_MIN_SCORE).toBe(50);
    expect(minScoreFor(undefined)).toBe(50);
    expect(minScoreFor({ ...preferences, minScore: 70 })).toBe(70);
    expect(minScoreFor({ ...preferences, minScore: 0 })).toBe(0);
  });

  it('asks again when a job is missing from the answer', async () => {
    const llm = scorer('j2');
    const { fits } = await scoreJobs([job(1), job(2)], candidate, llm);
    expect(fits).toHaveLength(2);
    expect(llm.calls.at(-1)?.feedback).toContain('missing results for j2');
  });

  it('fails clearly when the answer stays wrong', async () => {
    const llm = new FakeLLM({ json: { results: [{ uid: 'j9', score: 150, note: '' }] } });
    await expect(scoreJobs([job(1)], candidate, llm)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects unknown and repeated uids', async () => {
    const llm = new FakeLLM({
      json: {
        results: [
          { uid: 'j1', score: 60, note: 'a' },
          { uid: 'j1', score: 60, note: 'b' },
          { uid: 'j7', score: 60, note: 'c' },
        ],
      },
    });
    await expect(scoreJobs([job(1)], candidate, llm)).rejects.toBeInstanceOf(InvalidResponseError);
    expect(llm.calls.at(-1)?.feedback).toMatch(/unknown uids j7[\s\S]*repeated uids j1/);
  });

  it('does nothing for no jobs', async () => {
    const llm = scorer();
    expect((await scoreJobs([], candidate, llm)).fits).toEqual([]);
    expect(llm.calls).toEqual([]);
  });

  it('reports progress after each batch', async () => {
    const progress: string[] = [];
    await scoreJobs([job(1), job(2), job(3)], candidate, scorer(), {
      batchSize: 2,
      onBatch: (done, total) => progress.push(`${String(done)}/${String(total)}`),
    });
    expect(progress).toEqual(['2/3', '3/3']);
  });
});

describe('scoreJobs in parallel', () => {
  /** A scorer whose calls take a while, recording how many run at once and in what order. */
  class SlowScorer extends FakeLLM {
    running = 0;
    maxRunning = 0;
    started: string[] = [];
    constructor(
      private readonly delayFor: (firstUid: string) => number,
      private readonly failOn?: string,
    ) {
      super({
        json: (_attempt: number, request: JsonRequest<unknown>) => ({
          results: [...request.prompt.matchAll(/<job uid="(j\d+)">\nTitle: [^\n]* (\d+)/g)].map(
            ([, uid, n]) => ({ uid, score: Number(n), note: `Job ${n ?? ''}.` }),
          ),
        }),
      });
    }

    override async generateJSON<T>(request: JsonRequest<T>) {
      const first = /Title: [^\n]* (\d+)/.exec(request.prompt)?.[1] ?? '';
      this.started.push(first);
      this.running++;
      this.maxRunning = Math.max(this.maxRunning, this.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, this.delayFor(first)));
        if (first === this.failOn) throw new Error(`batch ${first} failed`);
        return await super.generateJSON(request);
      } finally {
        this.running--;
      }
    }
  }

  const jobs = (count: number) => Array.from({ length: count }, (_, i) => job(i + 1));

  it('scores the first batch alone, then a few at a time, keeping the order of the jobs', async () => {
    // Later batches finish first, to check results still come back in job order.
    const llm = new SlowScorer((first) => 40 - Number(first));
    const progress: number[] = [];

    const { fits } = await scoreJobs(jobs(12), candidate, llm, {
      batchSize: 2,
      concurrency: 3,
      onBatch: (done) => progress.push(done),
    });

    expect(fits.map((fit) => fit.score)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(llm.maxRunning).toBe(3);
    expect(llm.started[0]).toBe('1');
    expect(progress).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('runs the first batch before any other, so they can use the cached prompt', async () => {
    const llm = new SlowScorer(() => 5);
    const order: string[] = [];
    const original = llm.generateJSON.bind(llm);
    llm.generateJSON = async <T>(request: JsonRequest<T>) => {
      const first = /Title: [^\n]* (\d+)/.exec(request.prompt)?.[1] ?? '';
      order.push(`start ${first}`);
      const result = await original(request);
      order.push(`end ${first}`);
      return result;
    };

    await scoreJobs(jobs(6), candidate, llm, { batchSize: 2 });

    expect(order.slice(0, 2)).toEqual(['start 1', 'end 1']);
  });

  it('stops starting batches after one fails', async () => {
    const llm = new SlowScorer(() => 5, '3');
    await expect(
      scoreJobs(jobs(20), candidate, llm, { batchSize: 2, concurrency: 2 }),
    ).rejects.toThrow('batch 3 failed');
    expect(llm.started.length).toBeLessThan(10);
  });
});

describe('describing jobs and preferences for the AI', () => {
  it('handles jobs without location text, salary text or description', () => {
    const text = describeJob(
      job(2, {
        location: { regions: [] },
        salary: { min: 40, max: 48, currency: 'USD', period: 'hour' },
        description: '',
      }),
      'j1',
      100,
    );
    expect(text).toContain('Location: not stated');
    expect(text).toContain('Salary: 40–48 USD/hour');
    expect(text).toContain('(no description)');
  });

  it('lists the job fields and cuts long descriptions', () => {
    const text = describeJob(
      job(1, {
        workMode: 'remote',
        employmentType: 'full_time',
        salary: { min: 80000, max: 150000, currency: 'USD', period: 'year', text: '$80k - $150k' },
        tags: ['react'],
        description: 'x'.repeat(50),
      }),
      'j1',
      10,
    );
    expect(text).toBe(
      '<job uid="j1">\nTitle: Frontend Engineer 1\nCompany: Acme\nLocation: anywhere\nWork mode: remote\nEmployment type: full-time\nSalary: $80k - $150k\nTags: react\n\nxxxxxxxxxx… [cut]\n</job>',
    );
  });

  it('lists every place a job was posted in, each with its work mode', () => {
    const at = (n: number, text: string, patch: Partial<Job> = {}) =>
      job(n, { location: { text, regions: [text] }, ...patch });
    const text = describeJob(at(1, 'Germany', { workMode: 'remote' }), 'j1', 100, [
      at(2, 'Tokyo, Japan', { workMode: 'hybrid' }),
      at(3, 'Germany', { workMode: 'remote' }),
      job(4),
    ]);
    expect(text).toContain('\nPosted in: Germany (remote); Tokyo, Japan (hybrid); anywhere\n');
    expect(text).not.toContain('Location:');
    expect(text).not.toContain('Work mode:');
  });

  it('describes preferences in plain sentences', () => {
    expect(describePreferences(preferences)).toBe(
      [
        'Work mode: remote.',
        'Remote: can legally work from GE, timezone UTC+4 ±3h.',
        'Visa sponsorship needed: no.',
        'Employment type: full-time.',
        'Minimum salary: 60000 USD/year.',
      ].join('\n'),
    );
    expect(describePreferences(undefined)).toBe('No preferences given.');
    const onsite = describePreferences({
      ...preferences,
      workModes: ['hybrid'],
      remote: undefined,
      onsite: { cities: ['Tbilisi', 'Berlin'], relocation: ['DE', 'NL'] },
      avoid: { industries: ['gambling'], companies: ['Initech'] },
    });
    expect(onsite).toContain('Onsite/hybrid: Tbilisi, Berlin; relocating only to DE, NL.');
    expect(onsite).toContain('Avoid industries: gambling.');
    expect(onsite).toContain('Avoid companies: Initech.');
    expect(
      describePreferences({ ...preferences, onsite: { cities: ['Tbilisi'], relocation: 'yes' } }),
    ).toContain('open to relocating anywhere');
  });
});
