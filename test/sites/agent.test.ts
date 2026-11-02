import { describe, expect, it } from 'vitest';
import type { JsonRequest } from '../../src/llm/index.js';
import {
  mapSite,
  siteId,
  type MapCandidate,
  type Review,
  type StepResult,
} from '../../src/sites/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import {
  draft,
  fakeFetch,
  FEED_URL,
  LIST_URL,
  step,
  type StepInput,
} from '../helpers/site-fixtures.js';

const now = new Date('2026-10-21T12:00:00Z');
const START = 'https://careers.acme.example/';

const DRAFT = draft({
  name: 'Acme',
  entryUrl: LIST_URL,
  kind: 'links',
  linkSelector: 'a.job-link',
  fields: [
    { target: 'title', jsonLd: 'title' },
    { target: 'company', const: 'Acme' },
    { target: 'description', selector: '.description', attr: 'html', transforms: ['html'] },
  ],
});

/** A model that answers with these steps in order, and records the prompts it got. */
function scripted(steps: StepInput[]) {
  let next = 0;
  const prompts: string[] = [];
  const llm = new FakeLLM({
    json: (_attempt: number, request: JsonRequest<unknown>) => {
      prompts.push(request.prompt);
      return step(
        steps[next++] ?? { note: 'Nothing left', action: 'give_up', reason: 'script ended' },
      );
    },
  });
  return { llm, prompts };
}

function run(steps: StepInput[], reviews: Review[] = ['save'], maxSteps?: number) {
  const { llm, prompts } = scripted(steps);
  const fetch = fakeFetch();
  const reviewed: MapCandidate[] = [];
  const notes: string[] = [];
  const results: StepResult[] = [];
  const outcome = mapSite(
    {
      llm,
      fetch,
      now: () => now,
      onStep: (step) => notes.push(step.note),
      onResult: (result) => results.push(result),
      review: (candidate) => {
        reviewed.push(candidate);
        return Promise.resolve(reviews.shift() ?? 'cancel');
      },
    },
    { startUrl: START, candidate: 'Roles: Frontend Engineer', ...(maxSteps ? { maxSteps } : {}) },
  );
  return { outcome, prompts, fetch, reviewed, notes, results, llm };
}

describe('mapSite', () => {
  it('fetches, tests and finishes, then saves what the user accepts', async () => {
    const { outcome, prompts, fetch, reviewed, notes } = run([
      { note: 'Looking at the start page', action: 'fetch', url: LIST_URL },
      { note: 'Trying the job links', action: 'test', mapping: DRAFT },
      { note: 'Done', action: 'finish', mapping: DRAFT },
    ]);

    const result = await outcome;
    expect(result).toMatchObject({
      status: 'saved',
      site: {
        id: 'careers.acme.example',
        name: 'Acme',
        startUrl: START,
        entryUrl: LIST_URL,
        mappedAt: now.toISOString(),
        mappedBy: 'fake-model',
        list: { kind: 'links', selector: 'a.job-link' },
      },
    });
    expect(notes).toEqual(['Looking at the start page', 'Trying the job links', 'Done']);
    expect(reviewed[0]?.result.jobs.map((job) => job.title)).toEqual([
      'Frontend Engineer',
      'Backend Engineer',
      'Designer',
    ]);

    // The AI saw the page, then what its test read on each job page.
    expect(prompts[1]).toContain('Frontend Engineer → https://careers.acme.example/jobs/1');
    expect(prompts[2]).toContain('Job links found on the list: 3');
    expect(prompts[2]).toContain('title read: "Frontend Engineer"');
    expect(prompts[2]).toContain('Steps left, including this one: 13');
    // Each page is fetched once, however often it's tested.
    expect(fetch.urls.filter((url) => url === LIST_URL)).toHaveLength(1);
  });

  it('sends invalid mappings and unfetchable addresses back to the AI', async () => {
    const { outcome, prompts } = run([
      { note: 'Peeking at the router', action: 'fetch', url: 'http://192.168.1.1/' },
      {
        note: 'Trying',
        action: 'test',
        mapping: { ...DRAFT, linkSelector: '' },
      },
    ]);
    await outcome;
    expect(prompts[1]).toContain("Couldn't fetch http://192.168.1.1/");
    expect(prompts[2]).toContain('linkSelector / linkPath: give one when kind is "links"');
  });

  it("doesn't finish a mapping that makes no jobs", async () => {
    const broken = draft({ ...DRAFT, fields: [{ target: 'title', selector: '.nope' }] });
    const { outcome, prompts, reviewed } = run([
      { note: 'Done', action: 'finish', mapping: broken },
    ]);
    await outcome;
    expect(reviewed).toHaveLength(0);
    expect(prompts[1]).toContain('Not finished: the mapping must make more jobs than it fails on.');
  });

  it("passes the user's feedback on to the AI", async () => {
    const { outcome, prompts, reviewed } = run(
      [
        { note: 'Done', action: 'finish', mapping: DRAFT },
        { note: 'Done again', action: 'finish', mapping: DRAFT },
      ],
      [{ feedback: 'Only engineering jobs, please' }, 'save'],
    );
    expect((await outcome).status).toBe('saved');
    expect(reviewed).toHaveLength(2);
    expect(prompts[1]).toContain('"Only engineering jobs, please"');
  });

  it('stops when the user cancels, the AI gives up, or the steps run out', async () => {
    expect(
      (await run([{ note: 'Done', action: 'finish', mapping: DRAFT }], ['cancel']).outcome).status,
    ).toBe('cancelled');
    expect(
      await run([{ note: 'Login wall', action: 'give_up', reason: 'needs a login' }]).outcome,
    ).toMatchObject({ status: 'gave-up', reason: 'needs a login' });

    const fetches: StepInput[] = [1, 2, 3].map(() => ({
      note: 'Look',
      action: 'fetch',
      url: LIST_URL,
    }));
    const { outcome, prompts } = run(fetches, [], 2);
    expect((await outcome).status).toBe('out-of-steps');
    expect(prompts).toHaveLength(2);
  });

  it('shows older steps in one line', async () => {
    const { outcome, prompts } = run([
      { note: 'Look', action: 'fetch', url: LIST_URL },
      { note: 'Look', action: 'fetch', url: 'https://careers.acme.example/jobs/1' },
      { note: 'Look', action: 'fetch', url: 'https://careers.acme.example/jobs/2' },
      { note: 'Stop', action: 'give_up', reason: 'test' },
    ]);
    await outcome;
    expect(prompts[3]).toContain('## Step 1: fetch');
    expect(prompts[3]).toContain('(details no longer shown)');
    expect(prompts[3]).not.toContain('a.job-link href=/jobs/1');
  });
});

describe('mapSite with feeds', () => {
  const FEED_LINKS = {
    ...DRAFT,
    entryUrl: FEED_URL,
    linkSelector: '',
    linkPath: 'link',
    format: 'xml' as const,
    items: 'rss.channel.item',
  };

  it('says what each step found, and each announced feed once', async () => {
    const { outcome, results, prompts } = run([
      { note: 'Looking at the list', action: 'fetch', url: LIST_URL },
      { note: 'Looking again', action: 'fetch', url: LIST_URL },
      { note: 'Checking the RSS feed', action: 'fetch', url: FEED_URL },
      { note: 'Trying a guess', action: 'fetch', url: 'https://careers.acme.example/rss' },
      { note: 'Using the feed links', action: 'finish', mapping: FEED_LINKS },
    ]);

    expect(await outcome).toMatchObject({
      status: 'saved',
      site: { entryUrl: FEED_URL, list: { kind: 'links', feed: { link: 'link' } } },
    });
    expect(results.map((r) => [r.summary, r.feeds.map((f) => f.url)])).toEqual([
      ['HTML page, 5 links, announces an RSS feed', [FEED_URL]],
      ['HTML page, 5 links, announces an RSS feed', []],
      ['RSS feed, 2 items', []],
      ['HTTP 404', []],
      ['2 job links, 2 of 2 job pages read', []],
    ]);
    expect(prompts[1]).toContain('Feeds announced by the page:');
    expect(prompts[3]).toContain('rss.channel.item: list of 2');
  });

  it('says how a test went', async () => {
    const { outcome, results } = run([
      { note: 'Trying', action: 'test', mapping: FEED_LINKS },
      { note: 'Broken', action: 'test', mapping: { ...FEED_LINKS, linkSelector: 'a' } },
      { note: 'Stop', action: 'give_up', reason: 'test' },
    ]);
    await outcome;
    expect(results.map((r) => r.summary)).toEqual([
      '2 job links, 2 of 2 job pages read',
      'the mapping has 1 problem to fix',
    ]);
  });
});

describe('mapSite with broken characters', () => {
  it('sends only well-formed text, however pages are cut', async () => {
    // Link texts are cut at 80 units: here right inside the 🚀.
    const text = `${'x'.repeat(78)}🚀 remote`;
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/jobs/${String(i)}">${text}</a>`);
    const pages = {
      'https://emoji.example/': `<html><head><title>Jobs \uD83D lone</title></head><body>${links.join('')}</body></html>`,
    };
    const steps: StepInput[] = [
      { note: 'Look', action: 'fetch', url: 'https://emoji.example/' },
      { note: 'Stop', action: 'give_up', reason: 'test' },
    ];
    const { llm, prompts } = scripted(steps);
    await mapSite(
      { llm, fetch: fakeFetch(pages), review: () => Promise.resolve('cancel') },
      { startUrl: 'https://emoji.example/', candidate: '' },
    );
    expect(prompts[1]).toContain(`${'x'.repeat(78)}… → https://emoji.example/jobs/0`);
    expect(prompts[1]).toContain('Title: Jobs \uFFFD lone');
    // A lone surrogate would be sent as "\udXXX", which the API rejects.
    expect(JSON.stringify(prompts[1])).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });
});

describe('siteId', () => {
  it("uses the list's host without www", () => {
    expect(siteId('https://www.Acme.example/careers')).toBe('acme.example');
  });
});
