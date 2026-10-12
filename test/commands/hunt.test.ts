import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HuntSetupError, runHunt, type HuntDeps } from '../../src/commands/hunt/index.js';
import {
  cvFile,
  instructionsFile,
  pendingFile,
  readProfile,
  saveConfig,
  saveProfile,
} from '../../src/config/index.js';
import { writeFileAtomic } from '../../src/config/fs.js';
import type { JsonRequest } from '../../src/llm/index.js';
import type { Job } from '../../src/jobs/index.js';
import {
  loadSourceState,
  saveSourceState,
  SourceError,
  type SourceDefinition,
} from '../../src/sources/index.js';
import {
  createLocalSheet,
  loadPending,
  type IgnoredJob,
  type OpenLock,
  type TrackedJob,
  type Tracker,
} from '../../src/tracker/index.js';
import { readWorkbook } from '../../src/xlsx/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DERIVED_ANSWER } from '../helpers/fixtures.js';
import { FakeUi, type DEFAULT } from '../helpers/fake-ui.js';
import { saveGoogleSession } from '../helpers/google-session.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-11T12:00:00Z');

const source = (id: string, name: string): SourceDefinition => ({
  id,
  name,
  feedUrl: `https://${id}.example/feed`,
  minIntervalHours: 6,
  mappingKey: id,
});
const BOARD_A = source('board-a', 'Board A');
const BOARD_B = source('board-b', 'Board B');

const job = (id: string, patch: Partial<Job> = {}): Job => ({
  source: 'board-a',
  sourceId: id,
  url: `https://board-a.example/jobs/${id}`,
  title: 'Senior Frontend Engineer',
  company: `Company ${id}`,
  location: { worldwide: true, regions: [] },
  workMode: 'remote',
  postedAt: '2026-10-10T10:00:00.000Z',
  description: `Job ${id}.`,
  tags: [],
  ...patch,
});

class FakeTracker implements Tracker {
  applications: TrackedJob[] = [];
  ignored: IgnoredJob[] = [];
  constructor(private readonly known = new Set<string>()) {}
  knownJobs() {
    return Promise.resolve(new Set(this.known));
  }
  addApplications(jobs: TrackedJob[]) {
    this.applications.push(...jobs);
    return Promise.resolve();
  }
  addIgnored(jobs: IgnoredJob[]) {
    this.ignored.push(...jobs);
    return Promise.resolve();
  }
}

/** Scores each job by the number in its title ("… Engineer 80" → 80); 60 otherwise. */
function scorer() {
  return new FakeLLM({
    json: (_attempt: number, request: JsonRequest<unknown>) => ({
      results: [...request.prompt.matchAll(/<job uid="(j\d+)">\nTitle: ([^\n]*)/g)].map(
        ([, uid, title]) => ({
          uid,
          score: Number(/(\d+)$/.exec(title ?? '')?.[1] ?? 60),
          note: `Note for ${title ?? ''}.`,
        }),
      ),
    }),
  });
}

async function setUp({ sheet = true, google = true } = {}) {
  await saveConfig({
    version: 1,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    apiKey: 'sk-ant-x',
    activeProfile: 'default',
  });
  await saveProfile({
    version: 1,
    name: 'default',
    cv: { sourcePath: '/tmp/cv.pdf', sha256: 'a'.repeat(64), parsedAt: '2026-10-11T10:00:00.000Z' },
    derived: { ...DERIVED_ANSWER, roles: ['Senior Frontend Engineer'] },
    preferences: {
      workModes: ['remote'],
      visaSponsorshipNeeded: false,
      employmentTypes: ['full_time'],
      minScore: 70,
    },
    ...(sheet
      ? {
          sheet: { spreadsheetId: 'sheet-1', folderId: 'folder-1', columns: null, statusMap: null },
        }
      : {}),
  });
  await writeFileAtomic(cvFile('default'), '# Alex Example\n');
  await writeFileAtomic(instructionsFile('default'), '# Candidate profile\n');
  if (google) await saveGoogleSession();
}

function deps(
  feeds: Record<string, Job[] | Error>,
  { tracker = new FakeTracker(), llm = scorer() } = {},
) {
  const ui = new FakeUi([]);
  const fetched: string[] = [];
  const value = {
    ui,
    connect: () => llm,
    sources: [BOARD_A, BOARD_B],
    mappings: {},
    fetchSource: (s: SourceDefinition) => {
      fetched.push(s.id);
      const feed = feeds[s.id] ?? [];
      return feed instanceof Error
        ? Promise.reject(feed)
        : Promise.resolve({ source: s, jobs: feed, errors: [], skipped: 0 });
    },
    trackerFor: () => tracker,
    now: () => now,
  } satisfies HuntDeps;
  return { deps: value, ui, tracker, llm, fetched };
}

describe('jobhunter hunt', () => {
  useTempHome();

  it('fetches, skips known jobs, filters, scores and writes each job to the right tab', async () => {
    await setUp();
    const tracker = new FakeTracker(new Set(['url:https://board-a.example/jobs/known']));
    const {
      deps: d,
      ui,
      llm,
    } = deps(
      {
        'board-a': [
          job('known'),
          job('great', { title: 'Senior Frontend Engineer 90' }),
          job('meh', { title: 'Senior Frontend Engineer 40' }),
          job('sales', { title: 'Account Executive' }),
        ],
        'board-b': [
          job('old', { source: 'board-b', postedAt: '2026-08-01T00:00:00.000Z' }),
          // The same listing on both boards is written once.
          job('great', { title: 'Senior Frontend Engineer 90' }),
        ],
      },
      { tracker },
    );

    const summary = await runHunt(d);

    expect(summary).toMatchObject({ fetched: 6, known: 2, ignored: 2, toApply: 1, skipped: 1 });
    expect(tracker.ignored.map((i) => [i.job.sourceId, i.reason, i.channel])).toEqual([
      ['sales', "title doesn't match your roles", 'Board A'],
      ['old', 'posted 71 days ago', 'Board B'],
    ]);
    expect(
      tracker.applications.map((a) => [a.job.sourceId, a.status, a.score, a.note, a.channel]),
    ).toEqual([
      ['great', 'To apply', 90, 'Note for Senior Frontend Engineer 90.', 'Board A'],
      ['meh', 'Skipped', 40, 'Note for Senior Frontend Engineer 40.', 'Board A'],
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(ui.progress).toEqual(['Scoring 2 jobs with fake-model (Fake AI)… 2/2']);
    expect(ui.output.join('\n')).toContain(
      '6 jobs · 2 already in your sheet · 4 new → 2 ignored by your filters · 1 To apply · 1 Skipped',
    );
    expect(ui.output.join('\n')).toContain('Senior Frontend Engineer 90 · Company great');
    expect(ui.output.at(-1)).toBe(
      'Your sheet: https://docs.google.com/spreadsheets/d/sheet-1/edit',
    );

    const state = await loadSourceState();
    expect(state['board-a']).toEqual({ lastFetchedAt: now.toISOString(), lastJobCount: 4 });
  });

  it('skips boards checked recently unless forced', async () => {
    await setUp();
    await saveSourceState({
      'board-a': { lastFetchedAt: '2026-10-11T10:00:00.000Z', lastJobCount: 3 },
    });

    const first = deps({ 'board-b': [job('b1', { source: 'board-b' })] });
    await runHunt(first.deps);
    expect(first.fetched).toEqual(['board-b']);
    expect(first.ui.output.join('\n')).toContain('Board A: checked recently');

    const second = deps({});
    await runHunt(second.deps);
    expect(second.fetched).toEqual([]);
    expect(second.ui.output.join('\n')).toContain('Every source was checked recently');

    const forced = deps({});
    await runHunt(forced.deps, { force: true });
    expect(forced.fetched).toEqual(['board-a', 'board-b']);
  });

  it('warns about a board that fails and carries on with the others', async () => {
    await setUp();
    const {
      deps: d,
      ui,
      tracker,
    } = deps({
      'board-a': new SourceError('Board A is not responding.', 'board-a'),
      'board-b': [job('b1', { source: 'board-b' })],
    });

    await runHunt(d);

    expect(ui.output.join('\n')).toContain('Board A is not responding.');
    expect(tracker.applications).toHaveLength(1);
    expect((await loadSourceState())['board-a']).toBeUndefined();
  });

  it('writes nothing on a dry run', async () => {
    await setUp();
    const {
      deps: d,
      ui,
      tracker,
    } = deps({
      'board-a': [job('a1'), job('sales', { title: 'Account Executive' })],
    });

    const summary = await runHunt(d, { dryRun: true });

    expect(summary).toMatchObject({ ignored: 1, toApply: 0, skipped: 1 });
    expect(tracker.applications).toEqual([]);
    expect(tracker.ignored).toEqual([]);
    expect(ui.output.join('\n')).toContain('Dry run: nothing was written to your sheet.');
  });

  it('puts every job that passes the filters in To apply without the AI', async () => {
    await setUp();
    const { deps: d, tracker, llm } = deps({ 'board-a': [job('a1'), job('a2')] });

    await runHunt(d, { ai: false });

    expect(llm.calls).toEqual([]);
    expect(tracker.applications.map((a) => [a.status, a.note, a.score])).toEqual([
      ['To apply', '', undefined],
      ['To apply', '', undefined],
    ]);
  });

  it('scores only the newest jobs over the limit and leaves the rest for later', async () => {
    await setUp();
    const {
      deps: d,
      ui,
      tracker,
    } = deps({
      'board-a': [
        job('older', { postedAt: '2026-10-01T00:00:00.000Z' }),
        job('newest', { postedAt: '2026-10-11T00:00:00.000Z' }),
        job('newer', { postedAt: '2026-10-05T00:00:00.000Z' }),
      ],
    });

    const summary = await runHunt(d, { maxAiJobs: 2, minScore: 50 });

    expect(summary.deferred).toBe(1);
    expect(tracker.applications.map((a) => a.job.sourceId).sort()).toEqual(['newer', 'newest']);
    expect(ui.output.join('\n')).toContain("1 more jobs passed your filters but weren't scored");
  });

  it('applies a --min-score override', async () => {
    await setUp();
    const { deps: d, tracker } = deps({
      'board-a': [job('a1', { title: 'Senior Frontend Engineer 55' })],
    });

    await runHunt(d, { minScore: 50 });

    expect(tracker.applications[0]?.status).toBe('To apply');
  });

  it('asks for init when setup is missing', async () => {
    await setUp({ google: false });
    await expect(runHunt(deps({}).deps)).rejects.toThrow(
      new HuntSetupError(
        'Before hunting, set up the Google Sheets connection: run `jobhunter init`.',
      ),
    );

    await setUp({ sheet: false });
    await expect(runHunt(deps({}).deps)).rejects.toThrow('set up the tracking sheet');

    // A dry run doesn't need Google.
    await setUp({ sheet: false });
    await expect(runHunt(deps({}).deps, { dryRun: true })).resolves.toMatchObject({ fetched: 0 });
  });
});

describe('jobhunter hunt with a local sheet', () => {
  const home = useTempHome();
  const sheetPath = () => join(home(), 'Jobs', 'jobhunter.xlsx');
  const lock: OpenLock = { app: 'LibreOffice', by: 'Alex', lockFile: '/x/.~lock', stale: false };

  async function setUpLocal() {
    await setUp({ sheet: false, google: false });
    const profile = await readProfile('default');
    if (!profile) throw new Error('no profile');
    await saveProfile({ ...profile, localSheet: { path: sheetPath() } });
    await mkdir(join(home(), 'Jobs'));
    await createLocalSheet(sheetPath(), now);
  }

  function localDeps(
    feeds: Record<string, Job[]>,
    {
      answers = [],
      interactive = false,
      locks = [],
    }: {
      answers?: (string | typeof DEFAULT)[];
      interactive?: boolean;
      /** Lock state per check, in order; after the list runs out the file is closed. */
      locks?: (OpenLock | undefined)[];
    } = {},
  ) {
    const ui = new FakeUi(answers);
    const fetched: string[] = [];
    const checks = [...locks];
    const value = {
      ui,
      connect: () => scorer(),
      sources: [BOARD_A],
      mappings: {},
      fetchSource: (s: SourceDefinition) => {
        fetched.push(s.id);
        return Promise.resolve({ source: s, jobs: feeds[s.id] ?? [], errors: [], skipped: 0 });
      },
      findLock: () => Promise.resolve(checks.shift()),
      interactive,
      now: () => now,
    } satisfies HuntDeps;
    return { deps: value, ui, fetched };
  }

  const companies = async (tab: string) =>
    (readWorkbook(await readFile(sheetPath())).find((sheet) => sheet.name === tab)?.rows ?? [])
      .slice(1)
      .map((row) => row[0]);

  it('adds the jobs to the file without any Google setup', async () => {
    await setUpLocal();
    const { deps: d, ui } = localDeps({
      'board-a': [
        job('a1', { title: 'Senior Frontend Engineer 90' }),
        job('s', { title: 'Account Executive' }),
      ],
    });

    const summary = await runHunt(d);

    expect(summary).toMatchObject({ toApply: 1, ignored: 1, pending: 0 });
    expect(await companies('Applications')).toEqual(['Company a1']);
    expect(await companies('To apply')).toEqual(['Company a1']);
    expect(await companies('Ignored')).toEqual(['']); // Restore column comes first
    expect(ui.output.at(-1)).toBe(`Your sheet: ${sheetPath()}`);

    // The next run knows them.
    await expect(
      runHunt(localDeps({ 'board-a': [job('a1')] }).deps, { force: true }),
    ).resolves.toMatchObject({ known: 1 });
  });

  it('stops before fetching when the file is open and nobody can answer', async () => {
    await setUpLocal();
    const { deps: d, fetched } = localDeps({ 'board-a': [job('a1')] }, { locks: [lock] });

    await expect(runHunt(d)).rejects.toThrow(
      new HuntSetupError(
        'jobhunter.xlsx is open in LibreOffice by Alex. Close it so Jobhunter can add the new jobs.',
      ),
    );
    expect(fetched).toEqual([]);
  });

  it('waits for the user to close the file', async () => {
    await setUpLocal();
    const { deps: d, ui } = localDeps(
      { 'board-a': [job('a1')] },
      { interactive: true, locks: [lock, lock], answers: ['retry', 'retry'] },
    );

    await runHunt(d);

    expect(ui.prompts.map((p) => p.message)).toEqual([
      'What would you like to do?',
      'What would you like to do?',
    ]);
    expect(await companies('Applications')).toEqual(['Company a1']);
  });

  it('can be cancelled while the file is open', async () => {
    await setUpLocal();
    const { deps: d, fetched } = localDeps(
      {},
      { interactive: true, locks: [lock], answers: ['cancel'] },
    );
    await expect(runHunt(d)).rejects.toThrow('Cancelled');
    expect(fetched).toEqual([]);
  });

  it('keeps the jobs for the next run when the file is opened during the run', async () => {
    await setUpLocal();
    // Closed at the start, opened before the writes.
    const first = localDeps(
      {
        'board-a': [
          job('a1', { title: 'Senior Frontend Engineer 90' }),
          job('s', { title: 'Account Executive' }),
        ],
      },
      { locks: [undefined, lock] },
    );

    const summary = await runHunt(first.deps);

    expect(summary.pending).toBe(2);
    expect(await companies('Applications')).toEqual([]);
    expect(first.ui.output.join('\n')).toContain(
      `Your sheet was open, so 2 jobs were kept in ${pendingFile('default')}. The next \`jobhunter hunt\` adds them.`,
    );
    expect((await loadPending(pendingFile('default')))?.applications).toHaveLength(1);

    // The next run adds them first, so the same jobs aren't added twice.
    const second = localDeps({ 'board-a': [job('a1', { title: 'Senior Frontend Engineer 90' })] });
    const next = await runHunt(second.deps, { force: true });

    expect(next).toMatchObject({ known: 1, toApply: 0 });
    expect(second.ui.output).toContain('Added 2 jobs kept from your last run.');
    expect(await companies('Applications')).toEqual(['Company a1']);
    expect(await loadPending(pendingFile('default'))).toBeUndefined();
  });

  it('asks for init when the file is gone', async () => {
    await setUpLocal();
    const profile = await readProfile('default');
    if (!profile) throw new Error('no profile');
    await saveProfile({ ...profile, localSheet: { path: join(home(), 'moved.xlsx') } });

    await expect(runHunt(localDeps({}).deps)).rejects.toThrow(
      `Can't find your tracking sheet at ${join(home(), 'moved.xlsx')}`,
    );
  });
});
