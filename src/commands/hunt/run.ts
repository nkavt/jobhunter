import { access, readFile } from 'node:fs/promises';
import {
  cvFile,
  instructionsFile,
  loadConfig,
  readProfile,
  type Profile,
} from '../../config/index.js';
import { filterJob } from '../../filter/index.js';
import { minScoreFor, scoreJobs } from '../../fit/index.js';
import { loadCredentials, loadToken, type GoogleClient } from '../../google/index.js';
import type { Job } from '../../jobs/index.js';
import { getAdapterName, type LLMAdapter, type Usage } from '../../llm/index.js';
import type { FeedMapping } from '../../mapping/index.js';
import {
  BUILTIN_MAPPINGS,
  BUILTIN_SOURCES,
  fetchSource,
  loadSourceState,
  nextFetchAt,
  saveSourceState,
  SourceError,
  type SourceDefinition,
  type SourceResult,
} from '../../sources/index.js';
import {
  isKnown,
  knownMarkers,
  SheetTracker,
  type IgnoredJob,
  type TrackedJob,
  type Tracker,
} from '../../tracker/index.js';
import { dim, type Ui } from '../../ui/index.js';

export interface HuntOptions {
  /** Fetch every source, even ones checked less than their interval ago. */
  force?: boolean;
  /** Show the results without writing to the sheet. */
  dryRun?: boolean;
  /** `false` skips the AI: every job that passes the filters goes to "To apply". */
  ai?: boolean;
  /** At most this many jobs are scored per run; the rest wait for a later run. */
  maxAiJobs?: number;
  /** Drop jobs posted longer ago than this. */
  sinceDays?: number;
  /** Overrides the profile's cut-off for this run. */
  minScore?: number;
}

export interface HuntDeps {
  ui: Ui;
  connect: (apiKey: string, model?: string) => LLMAdapter;
  sources?: SourceDefinition[];
  mappings?: Record<string, FeedMapping>;
  fetchSource?: (
    source: SourceDefinition,
    mappings: Record<string, FeedMapping>,
  ) => Promise<SourceResult>;
  trackerFor?: (client: GoogleClient, spreadsheetId: string) => Tracker;
  now?: () => Date;
}

export interface HuntSummary {
  fetched: number;
  known: number;
  ignored: number;
  toApply: number;
  skipped: number;
  /** Passed the filters but over `maxAiJobs`; not written, so a later run picks them up. */
  deferred: number;
  usage?: Usage;
}

/** Setup isn't complete enough to hunt; the message says what to do. */
export class HuntSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HuntSetupError';
  }
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
  const missing = [
    ...(useAi && (!profile.cv || !hasInstructions) ? ['your CV and candidate profile'] : []),
    ...(!options.dryRun && (!client || !token) ? ['the Google Sheets connection'] : []),
    ...(!options.dryRun && client && token && !profile.sheet ? ['the tracking sheet'] : []),
  ];
  if (missing.length > 0) {
    throw new HuntSetupError(
      `Before hunting, set up ${missing.join(' and ')}: run \`jobhunter init\`.`,
    );
  }

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
  };
  if (due.length === 0) {
    ui.info('Every source was checked recently. Run `jobhunter hunt --force` to check now.');
    return summary;
  }

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
  summary.fetched = found.length;

  // Skip jobs already in the sheet (and duplicates within this run)
  const tracker =
    client && profile.sheet
      ? (deps.trackerFor ?? ((c, id) => new SheetTracker(c, id)))(
          client,
          profile.sheet.spreadsheetId,
        )
      : undefined;
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
  if (tracker && !options.dryRun && ignored.length > 0) await tracker.addIgnored(ignored);

  // AI score (newest first, so a cap keeps the freshest jobs)
  const minScore = options.minScore ?? minScoreFor(profile.preferences);
  passed.sort((a, b) => (b.job.postedAt ?? '').localeCompare(a.job.postedAt ?? ''));
  const maxAiJobs = options.maxAiJobs ?? DEFAULT_MAX_AI_JOBS;
  const toScore = useAi ? passed.slice(0, maxAiJobs) : passed;
  summary.deferred = passed.length - toScore.length;

  let tracked: TrackedJob[];
  if (!useAi) {
    tracked = toScore.map((item) => ({ ...item, status: 'To apply', note: '', foundAt: now }));
  } else if (toScore.length === 0) {
    tracked = [];
  } else {
    const llm = deps.connect(config.apiKey, config.model);
    const [cv, instructions] = await Promise.all([
      readFile(cvFile(profile.name), 'utf8'),
      readFile(instructionsFile(profile.name), 'utf8'),
    ]);
    const { fits, usage } = await ui.task(
      `Scoring ${String(toScore.length)} jobs with ${getAdapterName(llm)}…`,
      () =>
        scoreJobs(
          toScore.map((item) => item.job),
          { cv, instructions, preferences: profile.preferences },
          llm,
        ),
      () => `Scored ${String(toScore.length)} jobs`,
    );
    summary.usage = usage;
    tracked = toScore.map((item, index) => {
      const fit = fits[index] ?? { score: 0, note: '' };
      return {
        ...item,
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
  if (tracker && !options.dryRun && tracked.length > 0) await tracker.addApplications(tracked);

  report(ui, summary, tracked, options);
  return summary;
}

function report(ui: Ui, summary: HuntSummary, tracked: TrackedJob[], options: HuntOptions): void {
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
      `${String(summary.ignored)} ignored by your filters · ${String(summary.toApply)} To apply · ${String(summary.skipped)} Skipped`,
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
      `${String(summary.deferred)} more jobs passed your filters but weren't scored (limit ${String(options.maxAiJobs ?? DEFAULT_MAX_AI_JOBS)} per run); a later run picks them up while they're still listed.`,
    );
  }
  if (options.dryRun) ui.info(dim('Dry run: nothing was written to your sheet.'));
}
