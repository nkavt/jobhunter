import type { GoogleClient } from '../../google/index.js';
import type { Job } from '../../jobs/index.js';
import type { Connection, LLMAdapter, Usage } from '../../llm/index.js';
import type { FeedMapping } from '../../mapping/index.js';
import type { Ats, SourceDefinition, SourceResult } from '../../sources/index.js';
import type { OpenLock, Tracker } from '../../tracker/index.js';
import type { Ui } from '../../ui/index.js';

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

export interface HuntSummary {
  fetched: number;
  known: number;
  /** The same posting more than once in this run: listed again, or on two boards with one link. */
  duplicates: number;
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

/** A job and the source it came from, for the sheet's Channel column. */
export interface Found {
  job: Job;
  channel: string;
}
