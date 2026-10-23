import { access } from 'node:fs/promises';
import {
  instructionsFile,
  loadConfig,
  pendingFile,
  readProfile,
  type Profile,
} from '../../config/index.js';
import { filterJob } from '../../filter/index.js';
import { loadCredentials, loadToken, spreadsheetUrl } from '../../google/index.js';
import {
  ATS,
  BUILTIN_SOURCES,
  dueBoards,
  loadBoardState,
  loadSourceState,
  saveBoardState,
  saveSourceState,
} from '../../sources/index.js';
import type { IgnoredJob } from '../../tracker/index.js';
import { readCompanyBoards, showCompaniesHint } from './boards.js';
import { HuntSetupError } from './errors.js';
import { dueFeeds, fetchFeeds } from './feeds.js';
import { LockGuard } from './lock-guard.js';
import { report } from './report.js';
import { scorePassed } from './score.js';
import { openSheet, SheetWriter, splitFound } from './sheet.js';
import {
  DEFAULT_SINCE_DAYS,
  type Found,
  type HuntDeps,
  type HuntOptions,
  type HuntSummary,
} from './types.js';

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
    ...(options.ai !== false && (!profile.cv || !hasInstructions)
      ? ['your CV and candidate profile']
      : []),
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
  const feedState = await loadSourceState();
  const due = dueFeeds(ui, deps.sources ?? BUILTIN_SOURCES, feedState, now, options.force);
  const summary: HuntSummary = {
    fetched: 0,
    known: 0,
    duplicates: 0,
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
  const found: Found[] = await fetchFeeds(due, feedState, deps, now);
  await saveSourceState(feedState);
  found.push(
    ...(await readCompanyBoards(boardState, ats, profile, deps, { now, force: options.force })),
  );
  await saveBoardState(boardState);
  summary.fetched = found.length;

  // Skip jobs already in the sheet, and duplicates within this run
  const tracker = openSheet(profile, client, deps);
  const pendingPath = pendingFile(profile.name);
  const sheet = new SheetWriter(tracker, pendingPath, { lockGuard, dryRun: options.dryRun });
  await sheet.addKept(ui);
  const known = tracker
    ? await ui.task(
        'Checking your sheet…',
        () => tracker.knownJobs(),
        () => 'Checked your sheet',
      )
    : new Set<string>();
  const { fresh, inSheet, duplicates } = splitFound(found, known);
  summary.known = inSheet;
  summary.duplicates = duplicates;

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
  await sheet.write({ ignored });

  // AI score
  const scored = await scorePassed(passed, { deps, config, profile, options, now });
  const { tracked } = scored;
  summary.deferred = scored.deferred;
  summary.sameJob = scored.copies.length;
  if (scored.usage) summary.usage = scored.usage;
  summary.toApply = tracked.filter((item) => item.status === 'To apply').length;
  summary.skipped = tracked.length - summary.toApply;
  await sheet.write({ applications: tracked, ignored: scored.copies });
  summary.pending = sheet.kept;

  report(ui, summary, tracked, scored.maxAiJobs, options);
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
