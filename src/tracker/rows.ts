import { jobKey, normalizeUrl, type Job } from '../jobs/index.js';
import type { Status } from '../sheet/layout.js';

/** A job going into `Applications` after the AI check. */
export interface TrackedJob {
  job: Job;
  /** Source name shown in the Channel column, e.g. "Remotive". */
  channel: string;
  status: Extract<Status, 'To apply' | 'Skipped'>;
  /** The AI's note: why it's a good fit, or why it was declined. */
  note: string;
  score?: number;
  foundAt: Date;
}

/** A job going into `Ignored` because the code filters dropped it. */
export interface IgnoredJob {
  job: Job;
  channel: string;
  reason: string;
  foundAt: Date;
}

export type Cell = string | number;

/** `2026-10-11`: sorts correctly as text, readable in any locale. */
export const day = (date: Date): string => date.toISOString().slice(0, 10);

/** Values per header for an `Applications` row; user-owned columns stay empty. */
export function applicationCells(tracked: TrackedJob): Record<string, Cell> {
  const { job } = tracked;
  return {
    Company: job.company,
    Role: job.title,
    Channel: tracked.channel,
    Status: tracked.status,
    'Last update': day(tracked.foundAt),
    Link: job.url,
    Notes: tracked.note,
    Key: jobKey(job),
    Source: job.source,
    Found: tracked.foundAt.toISOString(),
    ...(tracked.score !== undefined ? { Match: tracked.score } : {}),
  };
}

/** Values per header for an `Ignored` row. */
export function ignoredCells(ignored: IgnoredJob): Record<string, Cell> {
  const { job } = ignored;
  return {
    Company: job.company,
    Role: job.title,
    Channel: ignored.channel,
    Reason: ignored.reason,
    Found: day(ignored.foundAt),
    Link: job.url,
    Key: jobKey(job),
    Source: job.source,
  };
}

/** Order values by the sheet's actual header row (columns are found by name, never position). */
export function toRow(header: readonly string[], cells: Record<string, Cell>): Cell[] {
  return header.map((name) => cells[name] ?? '');
}

/** What makes a job "already tracked": its key, or its link (rows added by hand have no key). */
export function knownMarkers(key: string | undefined, link: string | undefined): string[] {
  return [key ? `key:${key}` : '', link ? `url:${normalizeUrl(link)}` : ''].filter(Boolean);
}

export function isKnown(known: ReadonlySet<string>, job: Job): boolean {
  return known.has(`key:${jobKey(job)}`) || known.has(`url:${normalizeUrl(job.url)}`);
}
