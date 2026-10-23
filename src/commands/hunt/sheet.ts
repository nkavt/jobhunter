import { sheetBackupFile, type Profile } from '../../config/index.js';
import type { GoogleClient } from '../../google/index.js';
import { jobKey } from '../../jobs/index.js';
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
  type TrackedJob,
  type Tracker,
} from '../../tracker/index.js';
import type { Ui } from '../../ui/index.js';
import type { LockGuard } from './lock-guard.js';
import type { Found, HuntDeps, TrackerTarget } from './types.js';

function openTracker(target: TrackerTarget): Tracker {
  return target.kind === 'google'
    ? new SheetTracker(target.client, target.spreadsheetId)
    : new LocalSheetTracker(target.path, { backupFile: sheetBackupFile(target.profile) });
}

/** The profile's sheet: its local file, or its Google sheet when Google is connected. */
export function openSheet(
  profile: Profile,
  client: GoogleClient | undefined,
  deps: Pick<HuntDeps, 'trackerFor'>,
): Tracker | undefined {
  const target: TrackerTarget | undefined = profile.localSheet
    ? { kind: 'local', path: profile.localSheet.path, profile: profile.name }
    : client && profile.sheet
      ? { kind: 'google', client, spreadsheetId: profile.sheet.spreadsheetId }
      : undefined;
  return target && (deps.trackerFor ?? openTracker)(target);
}

/**
 * Writes rows to the sheet, or keeps them for the next run when the local sheet is open in a
 * spreadsheet app. Writes nothing on a dry run.
 */
export class SheetWriter {
  /** Rows kept for the next run. */
  kept = 0;

  constructor(
    private readonly tracker: Tracker | undefined,
    private readonly pendingPath: string,
    private readonly options: { lockGuard?: LockGuard | undefined; dryRun?: boolean | undefined },
  ) {}

  /** Add the jobs kept from a run when the sheet was open, first, so they count as known. */
  async addKept(ui: Ui): Promise<void> {
    const { lockGuard } = this.options;
    if (!lockGuard || !(this.tracker instanceof LocalSheetTracker)) return;
    const pending = await loadPending(this.pendingPath);
    if (pending && (await lockGuard.readyToWrite())) {
      await this.tracker.addRows(pending);
      await clearPending(this.pendingPath);
      ui.info(`Added ${String(pendingCount(pending))} jobs kept from your last run.`);
    }
  }

  async write(rows: { applications?: TrackedJob[]; ignored?: IgnoredJob[] }): Promise<void> {
    if (!this.tracker || this.options.dryRun) return;
    const applications = rows.applications ?? [];
    const ignored = rows.ignored ?? [];
    if (applications.length + ignored.length === 0) return;
    const { lockGuard } = this.options;
    if (lockGuard && !(await lockGuard.readyToWrite())) {
      await savePending(this.pendingPath, {
        applications: applications.map(applicationCells),
        ignored: ignored.map(ignoredCells),
      });
      this.kept += applications.length + ignored.length;
      return;
    }
    if (ignored.length > 0) await this.tracker.addIgnored(ignored);
    if (applications.length > 0) await this.tracker.addApplications(applications);
  }
}

/**
 * Jobs not in the sheet yet, each once. A board can list one posting several times (Workable
 * lists it once per location), and the same listing can be on two boards with one link.
 */
export function splitFound(
  found: readonly Found[],
  known: ReadonlySet<string>,
): { fresh: Found[]; inSheet: number; duplicates: number } {
  const seen = new Set<string>();
  const fresh: Found[] = [];
  let inSheet = 0;
  let duplicates = 0;
  for (const item of found) {
    if (isKnown(known, item.job)) {
      inSheet++;
    } else if (isKnown(seen, item.job)) {
      duplicates++;
    } else {
      for (const marker of knownMarkers(jobKey(item.job), item.job.url)) seen.add(marker);
      fresh.push(item);
    }
  }
  return { fresh, inSheet, duplicates };
}
