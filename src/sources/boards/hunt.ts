import type { Profile } from '../../config/index.js';
import type { Job } from '../../jobs/index.js';
import {
  applyMapping,
  parseFeed,
  type FeedMapping,
  type FieldRule,
  type MappingResult,
} from '../../mapping/index.js';
import { searchDuckDuckGo, SearchError, type SearchResult } from '../../search/index.js';
import { dim, type Ui } from '../../ui/index.js';
import { USER_AGENT } from '../fetch.js';
import { ATS, type Ats } from './ats.js';
import { boardKey, type BoardState, type KnownBoard } from './state.js';

/** Each search is repeated after this long, to find companies that started hiring since. */
export const SEARCH_EVERY_DAYS = 7;
/** DuckDuckGo's bot check answers when searches come too fast, so only a few run per hunt. */
export const MAX_SEARCHES_PER_RUN = 3;
export const SEARCH_PAUSE_MS = 45_000;
/** Like the job boards' feeds: no need to read a company's board more often. */
export const BOARD_EVERY_HOURS = 6;
/** Searches made from the CV's roles. */
const MAX_ROLES = 3;
const BOARD_CONCURRENCY = 6;
const TIMEOUT_MS = 30_000;

export interface BoardHuntDeps {
  ui: Ui;
  ats?: Ats[];
  search?: (query: string) => Promise<SearchResult[]>;
  pause?: (ms: number) => Promise<void>;
}

export interface BoardHuntOptions {
  now: Date;
  /** Read every board, even ones read in the last few hours. Searches keep their pace. */
  force?: boolean;
  /** Boards list every job the company has; only these reach the hunt. */
  keep: (job: Job) => boolean;
}

export interface BoardJob {
  job: Job;
  /** The ATS's name, for the sheet's Channel column. */
  channel: string;
}

type SearchProfile = Pick<Profile, 'boardSearch' | 'derived' | 'preferences'>;

/**
 * Every search, oldest-first order aside: each query on each ATS's site. The queries are the
 * profile's `boardSearch.queries`, or else the CV's top roles (plus "remote" for remote-only).
 */
export function boardQueries(profile: SearchProfile, ats: readonly Ats[] = ATS): string[] {
  const custom = profile.boardSearch?.queries;
  const remoteOnly = profile.preferences?.workModes.every((mode) => mode === 'remote') ?? false;
  const queries =
    custom ??
    (profile.derived?.roles ?? [])
      .slice(0, MAX_ROLES)
      .map((role) => `"${role.replace(/"/g, '')}"${remoteOnly ? ' remote' : ''}`);
  return ats.flatMap((system) => queries.map((query) => `site:${system.site} ${query.trim()}`));
}

/** Searches that never ran or ran too long ago, oldest first. */
export function dueSearches(queries: readonly string[], state: BoardState, now: Date): string[] {
  const cutoff = now.getTime() - SEARCH_EVERY_DAYS * 86_400_000;
  const last = (query: string) => {
    const at = state.searches[query]?.searchedAt;
    return at ? new Date(at).getTime() : 0;
  };
  return queries.filter((query) => last(query) <= cutoff).sort((a, b) => last(a) - last(b));
}

/** Boards not read in the last few hours (all of them with `force`). */
export function dueBoards(state: BoardState, now: Date, force = false): KnownBoard[] {
  const cutoff = now.getTime() - BOARD_EVERY_HOURS * 3_600_000;
  return Object.values(state.boards).filter(
    (board) => force || !board.lastFetchedAt || new Date(board.lastFetchedAt).getTime() <= cutoff,
  );
}

/** Whether a hunt has anything to search or read. */
export function boardsDue(
  profile: SearchProfile,
  state: BoardState,
  now: Date,
  options: { force?: boolean; ats?: readonly Ats[] } = {},
): boolean {
  return (
    dueSearches(boardQueries(profile, options.ats), state, now).length > 0 ||
    dueBoards(state, now, options.force).length > 0
  );
}

/**
 * Search for new company boards (a few searches per run), then read every board that's due.
 * Updates `state`; the caller saves it. Problems are shown as warnings, never thrown.
 */
export async function huntBoards(
  profile: SearchProfile,
  state: BoardState,
  deps: BoardHuntDeps,
  options: BoardHuntOptions,
): Promise<BoardJob[]> {
  const ats = deps.ats ?? ATS;
  if (ats.length === 0) return [];
  await discover(profile, state, deps, ats, options.now);
  return readBoards(state, deps, ats, options);
}

async function discover(
  profile: SearchProfile,
  state: BoardState,
  deps: BoardHuntDeps,
  ats: readonly Ats[],
  now: Date,
): Promise<void> {
  const { ui } = deps;
  const queries = boardQueries(profile, ats);
  // Searches for roles the profile no longer has.
  state.searches = Object.fromEntries(
    Object.entries(state.searches).filter(([query]) => queries.includes(query)),
  );
  const due = dueSearches(queries, state, now).slice(0, MAX_SEARCHES_PER_RUN);
  if (due.length === 0) return;

  const search = deps.search ?? searchDuckDuckGo;
  const pause = deps.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const label = 'Searching DuckDuckGo for company job boards';
  const { stopped } = await ui.task(
    `${label}… 0/${String(due.length)}`,
    async (update) => {
      let added = 0;
      let stopped: SearchError | undefined;
      for (const [index, query] of due.entries()) {
        if (index > 0) await pause(SEARCH_PAUSE_MS);
        let results: SearchResult[];
        try {
          results = await search(query);
        } catch (error) {
          if (!(error instanceof SearchError)) throw error;
          stopped = error;
          break;
        }
        let found = 0;
        for (const result of results) {
          const board = boardFromResult(result.url, ats);
          if (!board) continue;
          found++;
          const key = boardKey(board);
          if (state.boards[key]) continue;
          state.boards[key] = { ...board, foundAt: now.toISOString() };
          added++;
        }
        state.searches[query] = { searchedAt: now.toISOString(), found };
        update(`${label}… ${String(index + 1)}/${String(due.length)}`);
      }
      return { added, stopped };
    },
    (r) => `DuckDuckGo: ${String(r.added)} new company job boards`,
  );
  const left = dueSearches(queries, state, now).length;
  if (stopped) {
    ui.info(dim(`${stopped.message} The remaining ${String(left)} searches wait for a later run.`));
  } else if (left > 0) {
    ui.info(dim(`${String(left)} more searches for company job boards run in later hunts.`));
  }
}

function boardFromResult(
  href: string,
  ats: readonly Ats[],
): Pick<KnownBoard, 'ats' | 'board'> | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  for (const system of ats) {
    const board = system.boardFrom(url);
    if (board) return { ats: system.id, board };
  }
  return undefined;
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
        const outcome = system ? await readBoard(system, board.board) : { kind: 'gone' as const };
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

async function readBoard(ats: Ats, board: string): Promise<BoardOutcome> {
  let feed: unknown;
  try {
    const response = await fetch(ats.feedUrl(board), {
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
  return { kind: 'jobs', jobs: boardJobs(ats, board, feed).jobs };
}

/** Convert a board's parsed feed into jobs, naming the company when its jobs don't. */
export function boardJobs(ats: Ats, board: string, feed: unknown): MappingResult {
  const company = ats.company?.(feed) ?? companyFromSlug(board);
  const mapping: FeedMapping = {
    ...ats.mapping,
    fields: { ...ats.mapping.fields, company: withDefault(ats.mapping.fields.company, company) },
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
