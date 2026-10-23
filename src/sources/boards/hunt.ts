import type { Job } from '../../jobs/index.js';
import {
  applyMapping,
  parseFeed,
  type FeedMapping,
  type FieldRule,
  type MappingResult,
} from '../../mapping/index.js';
import type { Ui } from '../../ui/index.js';
import { BUILTIN_MAPPINGS } from '../builtin.js';
import { USER_AGENT } from '../fetch.js';
import { ATS, feedOf, type Ats } from './ats.js';
import { boardKey, type BoardState, type KnownBoard } from './state.js';

/** Like the job boards' feeds: no need to read a company's board more often. */
export const BOARD_EVERY_HOURS = 6;
const BOARD_CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;

export interface BoardHuntDeps {
  ui: Ui;
  ats?: readonly Ats[];
  /** Keyed by each ATS's feed template; the built-in mappings by default. */
  mappings?: Record<string, FeedMapping>;
}

export interface BoardHuntOptions {
  now: Date;
  /** Read every board, even ones read in the last few hours. */
  force?: boolean;
  /** Boards list every job the company has; only these reach the hunt. */
  keep: (job: Job) => boolean;
}

export interface BoardJob {
  job: Job;
  /** The ATS's name, for the sheet's Channel column. */
  channel: string;
}

/** Boards not read in the last few hours (all of them with `force`). */
export function dueBoards(state: BoardState, now: Date, force = false): KnownBoard[] {
  const cutoff = now.getTime() - BOARD_EVERY_HOURS * 3_600_000;
  return Object.values(state.boards).filter(
    (board) => force || !board.lastFetchedAt || new Date(board.lastFetchedAt).getTime() <= cutoff,
  );
}

/**
 * Read every known board that's due. Boards are found by `findCompanyBoards`
 * (`jobhunter companies find`). Updates `state`; the caller saves it. Problems are shown as
 * warnings, never thrown.
 */
export async function huntBoards(
  state: BoardState,
  deps: BoardHuntDeps,
  options: BoardHuntOptions,
): Promise<BoardJob[]> {
  const ats = deps.ats ?? ATS;
  if (ats.length === 0) return [];
  return readBoards(state, deps, ats, options);
}

type BoardOutcome =
  | { kind: 'jobs'; jobs: Job[] }
  /** The board doesn't exist (any more). */
  | { kind: 'gone' }
  | { kind: 'failed' };

async function readBoards(
  state: BoardState,
  deps: BoardHuntDeps,
  ats: readonly Ats[],
  options: BoardHuntOptions,
): Promise<BoardJob[]> {
  const systems = new Map(ats.map((system) => [system.id, system]));
  const mappings = deps.mappings ?? BUILTIN_MAPPINGS;
  const due = dueBoards(state, options.now, options.force).filter((board) =>
    systems.has(board.ats),
  );
  if (due.length === 0) return [];

  const label = 'Reading company job boards';
  const outcomes = await deps.ui.task(
    `${label}… 0/${String(due.length)}`,
    async (update) => {
      let done = 0;
      return pool(due, BOARD_CONCURRENCY, async (board) => {
        const system = systems.get(board.ats);
        const outcome = system
          ? await readBoard(system, board.board, mappings)
          : { kind: 'gone' as const };
        done++;
        update(`${label}… ${String(done)}/${String(due.length)}`);
        return outcome.kind === 'jobs'
          ? { kind: 'jobs' as const, jobs: outcome.jobs.filter(options.keep) }
          : outcome;
      });
    },
    (results) => {
      const jobs = results.reduce((n, r) => n + (r.kind === 'jobs' ? r.jobs.length : 0), 0);
      return `Company job boards: ${String(jobs)} jobs for your roles from ${String(due.length)} boards`;
    },
  );

  const found: BoardJob[] = [];
  const gone = new Set<string>();
  let failed = 0;
  for (const [index, board] of due.entries()) {
    const outcome = outcomes[index];
    const key = boardKey(board);
    if (outcome?.kind === 'gone') {
      gone.add(key);
    } else if (outcome?.kind === 'jobs') {
      state.boards[key] = { ...board, lastFetchedAt: options.now.toISOString() };
      const channel = systems.get(board.ats)?.name ?? board.ats;
      found.push(...outcome.jobs.map((job) => ({ job, channel })));
    } else {
      failed++;
    }
  }
  state.boards = Object.fromEntries(Object.entries(state.boards).filter(([key]) => !gone.has(key)));
  if (failed > 0) {
    deps.ui.warn(`Couldn't read ${String(failed)} company job boards; the next hunt tries again.`);
  }
  return found;
}

async function readBoard(
  ats: Ats,
  board: string,
  mappings: Record<string, FeedMapping>,
): Promise<BoardOutcome> {
  let feed: unknown;
  try {
    const response = await fetch(feedOf(ats, board).url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: 'gone' };
    if (!response.ok) return { kind: 'failed' };
    feed = parseFeed(await response.text(), 'json');
  } catch {
    return { kind: 'failed' };
  }
  // Jobs that don't map are dropped quietly: one odd posting shouldn't hide the board.
  return { kind: 'jobs', jobs: boardJobs(ats, board, feed, mappings).jobs };
}

/** Convert a board's parsed feed into jobs, naming the company when its jobs don't. */
export function boardJobs(
  ats: Ats,
  board: string,
  feed: unknown,
  mappings: Record<string, FeedMapping> = BUILTIN_MAPPINGS,
): MappingResult {
  const { mappingKey } = feedOf(ats, board);
  const base = mappings[mappingKey];
  if (!base) throw new Error(`No mapping for ${ats.name} feeds (${mappingKey}).`);
  const company = ats.company?.(feed) ?? companyFromSlug(board);
  const mapping: FeedMapping = {
    ...base,
    fields: { ...base.fields, company: withDefault(base.fields.company, company) },
  };
  return applyMapping(ats.prepare?.(feed) ?? feed, mapping, ats.id);
}

function withDefault(rule: FieldRule | undefined, value: string): FieldRule {
  if (rule === undefined) return { const: value };
  return typeof rule === 'string' ? { from: rule, default: value } : { ...rule, default: value };
}

/** "acme-corp" → "Acme Corp", for boards that don't name their company. */
export function companyFromSlug(board: string): string {
  return board
    .replace(/^[a-z]{2}:/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Run `work` over `items`, at most `limit` at a time; results keep the items' order. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
