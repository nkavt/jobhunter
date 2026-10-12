import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../config/fs.js';
import {
  buildWorkbook,
  emptyTrackerData,
  trackerDataFrom,
  type TrackerData,
} from '../sheet/workbook.js';
import { readWorkbook, writeWorkbook, ZipError } from '../xlsx/index.js';
import {
  applicationCells,
  ignoredCells,
  knownMarkers,
  toRow,
  type IgnoredJob,
  type TrackedJob,
} from './rows.js';
import type { PendingRows } from './pending.js';
import { requireColumns, TrackerError, type Tracker } from './sheet.js';

/** What's at a path the user picked for their tracking sheet. */
export type LocalSheetState = 'missing' | 'jobhunter' | 'other';

export async function inspectLocalSheet(path: string): Promise<LocalSheetState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  try {
    return trackerDataFrom(readWorkbook(bytes)) ? 'jobhunter' : 'other';
  } catch (error) {
    if (error instanceof ZipError) return 'other';
    throw error;
  }
}

/** Write an empty tracking sheet; parent folders must exist. */
export async function createLocalSheet(path: string, createdAt: Date): Promise<void> {
  await writeFileAtomic(
    path,
    writeWorkbook(buildWorkbook(emptyTrackerData(createdAt.toISOString()))),
  );
}

export interface LocalSheetOptions {
  /** The previous version is copied here before each write. */
  backupFile?: string;
}

/**
 * The tracking sheet as an .xlsx file. Every write reads the file again first, so edits made
 * since the last read (in a spreadsheet app, or by a sync app) are kept, then replaces it
 * atomically: a crash never leaves a half-written file.
 */
export class LocalSheetTracker implements Tracker {
  constructor(
    readonly path: string,
    private readonly options: LocalSheetOptions = {},
  ) {}

  async knownJobs(): Promise<Set<string>> {
    const data = await this.read();
    const known = new Set<string>();
    for (const tab of [data.applications, data.ignored]) {
      const keyAt = tab.header.indexOf('Key');
      const linkAt = tab.header.indexOf('Link');
      for (const row of tab.rows) {
        const key = row[keyAt];
        const link = row[linkAt];
        for (const marker of knownMarkers(
          key === undefined ? undefined : String(key),
          link === undefined ? undefined : String(link),
        )) {
          known.add(marker);
        }
      }
    }
    return known;
  }

  async addApplications(jobs: TrackedJob[]): Promise<void> {
    await this.addRows({ applications: jobs.map(applicationCells) });
  }

  async addIgnored(jobs: IgnoredJob[]): Promise<void> {
    await this.addRows({ ignored: jobs.map(ignoredCells) });
  }

  /** Append rows given as values by header, in one write. */
  async addRows(rows: Partial<PendingRows>): Promise<void> {
    const applications = rows.applications ?? [];
    const ignored = rows.ignored ?? [];
    if (applications.length + ignored.length === 0) return;
    const data = await this.read();
    for (const cells of applications) {
      data.applications.rows.push(toRow(data.applications.header, cells));
    }
    for (const cells of ignored) data.ignored.rows.push(toRow(data.ignored.header, cells));
    await this.save(data);
  }

  private async read(): Promise<TrackerData> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        throw new TrackerError(
          `Can't find your tracking sheet at ${this.path}. Run \`jobhunter init\` to choose it again.`,
        );
      }
      throw error;
    }
    let data: TrackerData | undefined;
    try {
      data = trackerDataFrom(readWorkbook(bytes));
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      throw new TrackerError(`Your tracking sheet ${this.path} can't be read. ${error.message}`);
    }
    if (!data) {
      throw new TrackerError(
        `${this.path} isn't a Jobhunter tracking sheet (its hidden "_meta" tab is missing). Run \`jobhunter init\` to choose another file.`,
      );
    }
    requireColumns('Applications', data.applications.header, ['Key', 'Link', 'Status']);
    requireColumns('Ignored', data.ignored.header, ['Key', 'Link']);
    return data;
  }

  private async save(data: TrackerData): Promise<void> {
    if (this.options.backupFile) {
      await mkdir(dirname(this.options.backupFile), { recursive: true });
      await copyFile(this.path, this.options.backupFile);
    }
    try {
      await writeFileAtomic(this.path, writeWorkbook(buildWorkbook(data)));
    } catch (error) {
      // Windows refuses to replace a file another app has open.
      if (isCode(error, 'EBUSY') || isCode(error, 'EPERM')) {
        throw new TrackerError(
          `${this.path} is open in another app. Close it and run Jobhunter again.`,
        );
      }
      throw error;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
