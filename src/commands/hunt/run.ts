import { access, readFile } from 'node:fs/promises';
import {
  cvFile,
  instructionsFile,
  loadConfig,
  pendingFile,
  readProfile,
  sheetBackupFile,
  type Profile,
} from '../../config/index.js';
import { companyTitleFilter, filterJob } from '../../filter/index.js';
import { BATCH_SIZE, minScoreFor, scoreJobs } from '../../fit/index.js';
import {
  loadCredentials,
  loadToken,
  spreadsheetUrl,
  type GoogleClient,
} from '../../google/index.js';
import { groupSameJobs, withAllLocations, type Job } from '../../jobs/index.js';
import {
  defaultParallelCalls,
  getAdapterName,
  getConfiguredAdapterName,
  type Connection,
  type LLMAdapter,
  type Usage,
} from '../../llm/index.js';
import type { FeedMapping } from '../../mapping/index.js';
import {
  ATS,
  boardQueries,
  BUILTIN_MAPPINGS,
  BUILTIN_SOURCES,
  dueBoards,
  dueSearches,
  fetchSource,
  huntBoards,
  loadBoardState,
  loadSourceState,
  nextFetchAt,
  saveBoardState,
  saveSourceState,
  SourceError,
  type Ats,
  type BoardState,
  type SourceDefinition,
  type SourceResult,
} from '../../sources/index.js';
import {
  applicationCells,
  clearPending,
  ignoredCells,
  isKnown,
  knownMarkers,
  loadPending,
  LocalSheetTracker,
  pendingCount,
  savePending,
  SheetTracker,
  type IgnoredJob,
  type OpenLock,
  type TrackedJob,
  type Tracker,
} from '../../tracker/index.js';
import { dim, type Ui } from '../../ui/index.js';
import { HuntSetupError } from './errors.js';
import { LockGuard } from './lock-guard.js';

export interface HuntOptions {
  /** Fetch every source, even ones checked less than their interval ago. */
  force?: boolean;
  /** Show the results without writing to the sheet. */
  dryRun?: boolean;
  /** `false` skips the AI: every job that passes the filters goes to "To apply". */
  ai?: boolean;
  /**
   * At most this many jobs are scored per run; the rest wait for a later run. Without it, a run
   * in a terminal asks before going over the default.
   */
  maxAiJobs?: number;
  /** Drop jobs posted longer ago than this. */
  sinceDays?: number;
  /** Overrides the profile's cut-off for this run. */
  minScore?: number;
  /** AI calls at the same time. Default: 1 for a local server, 4 otherwise. */
  parallel?: number;
}

export interface HuntDeps {
  ui: Ui;
  connect: (connection: Connection, model?: string) => LLMAdapter;
  sources?: SourceDefinition[];
  mappings?: Record<string, FeedMapping>;
  fetchSource?: (
    source: SourceDefinition,
    mappings: Record<string, FeedMapping>,
  ) => Promise<SourceResult>;
  /** Systems whose company boards are read; `[]` turns that off. */
  ats?: Ats[];
  trackerFor?: (target: TrackerTarget) => Tracker;
  /** Finds a spreadsheet app's lock on the local tracking sheet. */
  findLock?: (path: string) => Promise<OpenLock | undefined>;
  /** Whether the user can answer prompts; without a terminal, a run never waits. */
  interactive?: boolean;
  now?: () => Date;
}

export type TrackerTarget =
  | { kind: 'google'; client: GoogleClient; spreadsheetId: string }
  | { kind: 'local'; path: string; profile: string };

function openTracker(target: TrackerTarget): Tracker {
  return target.kind === 'google'
    ? new SheetTracker(target.client, target.spreadsheetId)
    : new LocalSheetTracker(target.path, { backupFile: sheetBackupFile(target.profile) });
}

export interface HuntSummary {
  fetched: number;
  known: number;
  ignored: number;
  toApply: number;
  skipped: number;
  /** Passed the filters but over `maxAiJobs`; not written, so a later run picks them up. */
  deferred: number;
  /** Copies of a job posted once per location: judged with it, written to Ignored. */
  sameJob: number;
  /** Kept for the next run because the local sheet was open. */
  pending: number;
  usage?: Usage;
}

export const DEFAULT_MAX_AI_JOBS = 100;
export const DEFAULT_SINCE_DAYS = 30;

interface Found {
  job: Job;
  channel: string;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * fetch sources → skip jobs already in the sheet → code filters → AI score → write rows.
 * Ignored rows are written right after filtering, so an AI failure doesn't lose them.
 */
export async function runHunt(deps: HuntDeps, options: HuntOptions = {}): Promise<HuntSummary> {
  const { ui } = deps;
  const now = deps.now?.() ?? new Date();
  const useAi = options.ai !== false;

  // Setup
  const config = await loadConfig();
  const profile: Profile = (await readProfile(config.activeProfile)) ?? {
    version: 1,
    name: config.activeProfile,
  };
  const [client, token, hasInstructions] = await Promise.all([
    loadCredentials(),
    loadToken(),
    exists(instructionsFile(profile.name)),
  ]);
  const localPath = profile.localSheet?.path;
  const google = !localPath && !options.dryRun;
  const missing = [
    ...(useAi && (!profile.cv || !hasInstructions) ? ['your CV and candidate profile'] : []),
    ...(google && (!client || !token) ? ['the Google Sheets connection'] : []),
    ...(google && client && token && !profile.sheet ? ['the tracking sheet'] : []),
  ];
  if (missing.length > 0) {
    throw new HuntSetupError(
      `Before hunting, set up ${missing.join(' and ')}: run \`jobhunter init\`.`,
    );
  }
  if (localPath && !(await exists(localPath))) {
    throw new HuntSetupError(
      `Can't find your tracking sheet at ${localPath}. Run \`jobhunter init\` to choose it again.`,
    );
  }

  // Companies' own job boards come from `jobhunter companies find`; say first when they're skipped.
  const ats = deps.ats ?? ATS;
  const boardState = await loadBoardState();
  showCompaniesHint(ui, profile, boardState, ats, now);

  // Which sources are due
  const sources = deps.sources ?? BUILTIN_SOURCES;
  const state = await loadSourceState();
  const due: SourceDefinition[] = [];
  for (const source of sources) {
    const next = options.force ? undefined : nextFetchAt(source, state, now);
    if (next) {
      ui.info(
        dim(
          `${source.name}: checked recently; next check after ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
        ),
      );
    } else {
      due.push(source);
    }
  }
  const summary: HuntSummary = {
    fetched: 0,
    known: 0,
    ignored: 0,
    toApply: 0,
    skipped: 0,
    deferred: 0,
    sameJob: 0,
    pending: 0,
  };
  const boardsWaiting = ats.length > 0 && dueBoards(boardState, now, options.force).length > 0;
  if (due.length === 0 && !boardsWaiting) {
    ui.info('Every source was checked recently. Run `jobhunter hunt --force` to check now.');
    return summary;
  }

  // A local sheet open in a spreadsheet app: ask to close it before spending time and tokens
  const lockGuard = localPath && !options.dryRun ? new LockGuard(deps, localPath) : undefined;
  if (lockGuard) await lockGuard.beforeStart();

  // Fetch
  const found: Found[] = [];
  const fetch = deps.fetchSource ?? fetchSource;
  for (const source of due) {
    try {
      const result = await ui.task(
        `Fetching ${source.name}…`,
        () => fetch(source, deps.mappings ?? BUILTIN_MAPPINGS),
        (r) =>
          `${source.name}: ${String(r.jobs.length)} jobs${r.errors.length ? ` (${String(r.errors.length)} unreadable)` : ''}`,
      );
      state[source.id] = { lastFetchedAt: now.toISOString(), lastJobCount: result.jobs.length };
      found.push(...result.jobs.map((job) => ({ job, channel: source.name })));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      ui.warn(error.message);
    }
  }
  await saveSourceState(state);

  // Companies' own job boards, found by `jobhunter companies find`. A board lists every job the
  // company has, so only titles matching the roles and level go on; the rest would flood the
  // Ignored tab and the AI.
  const titleFits = companyTitleFilter(profile.derived);
  const boardJobs = await huntBoards(
    boardState,
    { ui, ats, ...(deps.mappings ? { mappings: deps.mappings } : {}) },
    {
      now,
      ...(options.force ? { force: true } : {}),
      keep: (job) => titleFits(job.title),
    },
  );
  await saveBoardState(boardState);
  found.push(...boardJobs);
  summary.fetched = found.length;

  // Skip jobs already in the sheet (and duplicates within this run)
  const target: TrackerTarget | undefined = localPath
    ? { kind: 'local', path: localPath, profile: profile.name }
    : client && profile.sheet
      ? { kind: 'google', client, spreadsheetId: profile.sheet.spreadsheetId }
      : undefined;
  const tracker = target && (deps.trackerFor ?? openTracker)(target);

  // Jobs kept from a run when the sheet was open go in first, so they count as known.
  const pendingPath = pendingFile(profile.name);
  if (lockGuard && tracker instanceof LocalSheetTracker) {
    const pending = await loadPending(pendingPath);
    if (pending && (await lockGuard.readyToWrite())) {
      await tracker.addRows(pending);
      await clearPending(pendingPath);
      ui.info(`Added ${String(pendingCount(pending))} jobs kept from your last run.`);
    }
  }
  /** Write rows, or keep them for the next run when the local sheet is open. */
  const write = async (rows: { applications?: TrackedJob[]; ignored?: IgnoredJob[] }) => {
    if (!tracker || options.dryRun) return;
    const applications = rows.applications ?? [];
    const ignored = rows.ignored ?? [];
    if (applications.length + ignored.length === 0) return;
    if (lockGuard && !(await lockGuard.readyToWrite())) {
      await savePending(pendingPath, {
        applications: applications.map(applicationCells),
        ignored: ignored.map(ignoredCells),
      });
      summary.pending += applications.length + ignored.length;
      return;
    }
    if (ignored.length > 0) await tracker.addIgnored(ignored);
    if (applications.length > 0) await tracker.addApplications(applications);
  };
  const known = tracker
    ? await ui.task(
        'Checking your sheet…',
        () => tracker.knownJobs(),
        () => 'Checked your sheet',
      )
    : new Set<string>();
  const fresh: Found[] = [];
  for (const item of found) {
    if (isKnown(known, item.job)) {
      summary.known++;
      continue;
    }
    for (const marker of knownMarkers(undefined, item.job.url)) known.add(marker);
    fresh.push(item);
  }

  // Code filters
  const ignored: IgnoredJob[] = [];
  const passed: Found[] = [];
  for (const item of fresh) {
    const reasons = filterJob(
      item.job,
      { derived: profile.derived, preferences: profile.preferences },
      { now, maxAgeDays: options.sinceDays ?? DEFAULT_SINCE_DAYS },
    );
    if (reasons.length > 0) ignored.push({ ...item, reason: reasons.join('; '), foundAt: now });
    else passed.push(item);
  }
  summary.ignored = ignored.length;
  await write({ ignored });

  // The same job posted once per location is judged once, with all its locations
  // (newest first, so a cap keeps the freshest jobs)
  const minScore = options.minScore ?? minScoreFor(profile.preferences);
  passed.sort((a, b) => (b.job.postedAt ?? '').localeCompare(a.job.postedAt ?? ''));
  const jobs = groupSameJobs(passed, (item) => item.job);
  let maxAiJobs = options.maxAiJobs ?? DEFAULT_MAX_AI_JOBS;
  const interactive = deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (useAi && jobs.length > maxAiJobs && options.maxAiJobs === undefined && interactive) {
    maxAiJobs = await askHowManyToScore(ui, jobs.length, maxAiJobs, config);
  }
  const toScore = useAi ? jobs.slice(0, maxAiJobs) : jobs;
  summary.deferred = jobs.length - toScore.length;
  // The other copies go to Ignored, so they aren't judged again on the next run. Copies of
  // deferred jobs wait with them, so the job is judged with all its locations later.
  const copies: IgnoredJob[] = toScore.flatMap(({ others }) =>
    others.map((item) => ({
      ...item,
      reason: `same job as the one in Applications, posted in ${item.job.location.text ?? 'another location'}`,
      foundAt: now,
    })),
  );
  summary.sameJob = copies.length;

  let tracked: TrackedJob[];
  if (!useAi) {
    tracked = toScore.map(({ first }) => ({
      ...first,
      status: 'To apply',
      note: '',
      foundAt: now,
    }));
  } else if (toScore.length === 0) {
    tracked = [];
  } else {
    const llm = deps.connect(config, config.model);
    const [cv, instructions] = await Promise.all([
      readFile(cvFile(profile.name), 'utf8'),
      readFile(instructionsFile(profile.name), 'utf8'),
    ]);
    const scoring = `Scoring ${String(toScore.length)} jobs with ${getAdapterName(llm)}`;
    const { fits, usage } = await ui.task(
      `${scoring}… 0/${String(toScore.length)}`,
      (update) =>
        scoreJobs(
          toScore.map(({ first, others }) =>
            withAllLocations({ first: first.job, others: others.map((item) => item.job) }),
          ),
          { cv, instructions, preferences: profile.preferences },
          llm,
          {
            concurrency: options.parallel ?? defaultParallelCalls(config),
            onBatch: (done, total) => {
              update(`${scoring}… ${String(done)}/${String(total)}`);
            },
          },
        ),
      () => `Scored ${String(toScore.length)} jobs`,
    );
    summary.usage = usage;
    tracked = toScore.map(({ first }, index) => {
      const fit = fits[index] ?? { score: 0, note: '' };
      return {
        ...first,
        status: fit.score >= minScore ? 'To apply' : 'Skipped',
        note: fit.note,
        score: fit.score,
        foundAt: now,
      };
    });
    tracked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  summary.toApply = tracked.filter((item) => item.status === 'To apply').length;
  summary.skipped = tracked.length - summary.toApply;
  await write({ applications: tracked, ignored: copies });

  report(ui, summary, tracked, maxAiJobs, options);
  if (summary.pending > 0) {
    ui.warn(
      `Your sheet was open, so ${String(summary.pending)} jobs were kept in ${pendingPath}. The next \`jobhunter hunt\` adds them.`,
    );
  }
  if (!options.dryRun) {
    if (localPath) ui.info(`Your sheet: ${localPath}`);
    else if (profile.sheet) ui.info(`Your sheet: ${spreadsheetUrl(profile.sheet.spreadsheetId)}`);
  }
  return summary;
}

/** More jobs passed than a run scores by default: score them all, only the newest, or a number? */
async function askHowManyToScore(
  ui: Ui,
  passed: number,
  cap: number,
  config: Parameters<typeof getConfiguredAdapterName>[0],
): Promise<number> {
  const calls = (jobs: number) => Math.ceil(jobs / BATCH_SIZE);
  const choice = await ui.select<number | 'other'>({
    message: `${String(passed)} jobs passed your filters, more than the ${String(cap)} a run scores by default. How many should the AI score?`,
    choices: [
      {
        name: `The newest ${String(cap)}`,
        value: cap,
        description: `About ${String(calls(cap))} AI requests. The rest aren't added to your sheet; a later run picks them up while they're still listed.`,
      },
      {
        name: `All ${String(passed)}`,
        value: passed,
        description: `About ${String(calls(passed))} AI requests with ${getConfiguredAdapterName(config)}, billed to your AI account. A large run can take a while, or run into your provider's rate limits.`,
      },
      {
        name: 'Another number…',
        value: 'other',
        description: `The newest jobs first, from 1 to ${String(passed)}.`,
      },
    ],
    default: cap,
  });
  if (choice !== 'other') return choice;
  const answer = await ui.input({
    message: `How many jobs should the AI score? (1–${String(passed)})`,
    validate: (value) => {
      const number = Number(value.trim());
      return Number.isInteger(number) && number >= 1 && number <= passed
        ? true
        : `Type a whole number from 1 to ${String(passed)}`;
    },
  });
  const count = Number(answer.trim());
  ui.info(dim(`About ${String(calls(count))} AI requests.`));
  return count;
}

function report(
  ui: Ui,
  summary: HuntSummary,
  tracked: TrackedJob[],
  maxAiJobs: number,
  options: HuntOptions,
): void {
  const best = tracked.filter((item) => item.status === 'To apply').slice(0, 10);
  if (best.length > 0) {
    ui.info('');
    ui.info('Best matches:');
    for (const item of best) {
      const score = item.score === undefined ? '  –' : String(item.score).padStart(3);
      ui.info(`${score}  ${item.job.title} · ${item.job.company} ${dim(`(${item.channel})`)}`);
      if (item.note) ui.info(dim(`     ${item.note}`));
    }
  }

  ui.info('');
  const fresh = summary.fetched - summary.known;
  ui.success(
    `${String(summary.fetched)} jobs · ${String(summary.known)} already in your sheet · ${String(fresh)} new → ` +
      `${String(summary.ignored)} ignored by your filters · ` +
      (summary.sameJob > 0
        ? `${String(summary.sameJob)} copies of a job in other locations · `
        : '') +
      `${String(summary.toApply)} To apply · ${String(summary.skipped)} Skipped`,
  );
  if (summary.usage) {
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
    const { inputTokens, cacheReadTokens, outputTokens } = summary.usage;
    ui.info(
      dim(
        `AI tokens: ${k(inputTokens + cacheReadTokens)} in (${k(cacheReadTokens)} from cache), ${k(outputTokens)} out`,
      ),
    );
  }
  if (summary.deferred > 0) {
    ui.info(
      `${String(summary.deferred)} more jobs passed your filters but weren't scored (limit ${String(maxAiJobs)} per run); a later run picks them up while they're still listed. To score more now, run \`jobhunter hunt --force --max-ai-jobs <n>\`: --force fetches them again, since every source was just checked.`,
    );
  }
  if (options.dryRun) ui.info(dim('Dry run: nothing was written to your sheet.'));
}

/** Searching for company boards is its own command; say when it's worth running. */
function showCompaniesHint(
  ui: Ui,
  profile: Profile,
  state: BoardState,
  ats: readonly Ats[],
  now: Date,
): void {
  const queries = ats.length > 0 ? boardQueries(profile, ats) : [];
  if (queries.length === 0) return;
  if (Object.keys(state.boards).length === 0) {
    ui.info(
      dim(
        'Company job boards (Greenhouse, Lever, Ashby, Workable) are skipped: none found yet. Run `jobhunter companies find` to look for some.',
      ),
    );
  } else if (dueSearches(queries, state, now).length > 0) {
    ui.info(dim('Time to look for new company job boards: run `jobhunter companies find`.'));
  }
}
