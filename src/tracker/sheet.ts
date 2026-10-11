import { googleRequest, type GoogleClient } from '../google/index.js';
import { APPLICATION_COLUMNS, dataRowRequests, IGNORED_COLUMNS } from '../sheet/layout.js';
import {
  applicationCells,
  ignoredCells,
  knownMarkers,
  toRow,
  type IgnoredJob,
  type TrackedJob,
} from './rows.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TABS = { applications: 'Applications', ignored: 'Ignored' } as const;

/** The tracking sheet doesn't look like Jobhunter's layout (e.g. a column was renamed). */
export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerError';
  }
}

export interface Tracker {
  /** Markers of every job already in the sheet (see `isKnown`). */
  knownJobs(): Promise<Set<string>>;
  addApplications(jobs: TrackedJob[]): Promise<void>;
  addIgnored(jobs: IgnoredJob[]): Promise<void>;
}

interface ValueRange {
  range: string;
  values?: string[][];
}

/** Reads and writes the tracking sheet through the Sheets values API. */
export class SheetTracker implements Tracker {
  private headers?: { applications: string[]; ignored: string[] };

  constructor(
    private readonly client: GoogleClient,
    private readonly spreadsheetId: string,
  ) {}

  async knownJobs(): Promise<Set<string>> {
    const params = new URLSearchParams([
      ['ranges', TABS.applications],
      ['ranges', TABS.ignored],
      ['majorDimension', 'ROWS'],
    ]);
    const { valueRanges } = await googleRequest<{ valueRanges: ValueRange[] }>(
      this.client,
      `${SHEETS}/${this.spreadsheetId}/values:batchGet?${params.toString()}`,
    );
    const [applications = [], ignored = []] = valueRanges.map((range) => range.values ?? []);
    this.headers = {
      applications: requireColumns(TABS.applications, applications[0], ['Key', 'Link']),
      ignored: requireColumns(TABS.ignored, ignored[0], ['Key', 'Link']),
    };

    const known = new Set<string>();
    for (const [rows, header] of [
      [applications, this.headers.applications],
      [ignored, this.headers.ignored],
    ] as const) {
      const keyAt = header.indexOf('Key');
      const linkAt = header.indexOf('Link');
      for (const row of rows.slice(1)) {
        for (const marker of knownMarkers(row[keyAt], row[linkAt])) known.add(marker);
      }
    }
    return known;
  }

  async addApplications(jobs: TrackedJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const header = (await this.loadHeaders()).applications;
    await this.append(
      'applications',
      header,
      jobs.map((job) => toRow(header, applicationCells(job))),
    );
  }

  async addIgnored(jobs: IgnoredJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const header = (await this.loadHeaders()).ignored;
    await this.append(
      'ignored',
      header,
      jobs.map((job) => toRow(header, ignoredCells(job))),
    );
  }

  private async loadHeaders(): Promise<{ applications: string[]; ignored: string[] }> {
    if (!this.headers) await this.knownJobs();
    return this.headers ?? { applications: [], ignored: [] };
  }

  /**
   * RAW input: values are stored exactly as given. With USER_ENTERED, a job title from a feed
   * starting with "=" would run as a formula in the user's sheet.
   * New rows copy the look of the row above (the header, on an empty tab), so they're
   * reformatted afterwards: dropdown, dates, wrapped notes.
   */
  private async append(
    tab: keyof typeof TABS,
    header: string[],
    rows: (string | number)[][],
  ): Promise<void> {
    const params = new URLSearchParams({
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
    });
    const { updates } = await googleRequest<{ updates?: { updatedRange?: string } }>(
      this.client,
      `${SHEETS}/${this.spreadsheetId}/values/${encodeURIComponent(`${TABS[tab]}!A1`)}:append?${params.toString()}`,
      { method: 'POST', body: { values: rows } },
    );
    const written = rowSpan(updates?.updatedRange);
    if (!written) return;
    await googleRequest(this.client, `${SHEETS}/${this.spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: { requests: dataRowRequests(tab, header, written.start, written.end) },
    });
  }
}

function requireColumns(tab: string, header: string[] | undefined, required: string[]): string[] {
  const columns = header ?? [];
  const missing = required.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    const expected = (tab === TABS.applications ? APPLICATION_COLUMNS : IGNORED_COLUMNS).map(
      (c) => c.header,
    );
    throw new TrackerError(
      `The "${tab}" tab of your tracking sheet is missing the column(s) ${missing.map((m) => `"${m}"`).join(', ')}. Expected headers: ${expected.join(', ')}.`,
    );
  }
  return columns;
}

/** "Applications!A2:N13" → rows 1–13 (0-based start, exclusive end), as batchUpdate ranges use. */
export function rowSpan(range: string | undefined): { start: number; end: number } | undefined {
  const match = /![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/.exec(range ?? '');
  if (!match?.[1]) return undefined;
  const first = Number(match[1]);
  return { start: first - 1, end: Number(match[2] ?? first) };
}
