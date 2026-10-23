import type { Profile } from '../../config/index.js';
import { SearchError, type SearchEngine, type SearchResult } from '../../search/index.js';
import type { Ui } from '../../ui/index.js';
import { ATS, type Ats } from './ats.js';
import { boardKey, saveBoardState, type BoardState, type KnownBoard } from './state.js';

/** Each search is repeated after this long, to find companies that started hiring since. */
export const SEARCH_EVERY_DAYS = 7;
/** Searches made from the CV's roles. */
const MAX_ROLES = 3;

export type SearchProfile = Pick<Profile, 'boardSearch' | 'derived' | 'preferences'>;

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

/** Searches that never ran or ran too long ago (all of them with `force`), oldest first. */
export function dueSearches(
  queries: readonly string[],
  state: BoardState,
  now: Date,
  force = false,
): string[] {
  const cutoff = now.getTime() - SEARCH_EVERY_DAYS * 86_400_000;
  const last = (query: string) => {
    const at = state.searches[query]?.searchedAt;
    return at ? new Date(at).getTime() : 0;
  };
  return queries
    .filter((query) => force || last(query) <= cutoff)
    .sort((a, b) => last(a) - last(b));
}

export interface FindBoardsDeps {
  ui: Ui;
  engine: SearchEngine;
  ats?: readonly Ats[];
  pause?: (ms: number) => Promise<void>;
}

export interface FindBoardsOptions {
  now: Date;
  /** Repeat searches that ran in the last week too. */
  force?: boolean;
  /** Run at most this many searches. */
  limit?: number;
}

export interface FindBoardsResult {
  /** Searches that ran. */
  searched: number;
  /** Boards not known before. */
  added: number;
  /** Searches still due, e.g. after `stopped`. */
  left: number;
  /** The engine refused (bad key, rate limit, used-up plan); later searches didn't run. */
  stopped?: SearchError;
  /** Searches that failed on their own; they're tried again next time. */
  failed: number;
  /** Why the last of those failed. */
  lastFailure?: SearchError;
}

/**
 * Run the due searches one by one, at the engine's pace, and remember the boards they find.
 * The state is saved after every search, so stopping halfway loses nothing.
 */
export async function findCompanyBoards(
  profile: SearchProfile,
  state: BoardState,
  deps: FindBoardsDeps,
  options: FindBoardsOptions,
): Promise<FindBoardsResult> {
  const { ui, engine } = deps;
  const ats = deps.ats ?? ATS;
  const { now } = options;
  const queries = boardQueries(profile, ats);
  // Searches for roles the profile no longer has.
  state.searches = Object.fromEntries(
    Object.entries(state.searches).filter(([query]) => queries.includes(query)),
  );
  const due = dueSearches(queries, state, now, options.force).slice(0, options.limit);
  const result: FindBoardsResult = { searched: 0, added: 0, left: 0, failed: 0 };
  if (due.length === 0) return result;

  const pause = deps.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const label = `Searching ${engine.name} for company job boards`;
  await ui.task(
    `${label}… 0/${String(due.length)}`,
    async (update) => {
      for (const [index, query] of due.entries()) {
        if (index > 0 && engine.pauseMs > 0) await pause(engine.pauseMs);
        let results: SearchResult[];
        try {
          results = await engine.search(query);
        } catch (error) {
          if (!(error instanceof SearchError)) throw error;
          if (error.reason !== 'failed') {
            result.stopped = error;
            break;
          }
          result.failed++;
          result.lastFailure = error;
          continue;
        }
        let found = 0;
        for (const item of results) {
          const board = boardFromResult(item.url, ats);
          if (!board) continue;
          found++;
          const key = boardKey(board);
          if (state.boards[key]) continue;
          state.boards[key] = { ...board, foundAt: now.toISOString() };
          result.added++;
        }
        state.searches[query] = { searchedAt: now.toISOString(), found };
        result.searched++;
        await saveBoardState(state);
        update(`${label}… ${String(index + 1)}/${String(due.length)}`);
      }
    },
    () =>
      result.stopped && result.searched === 0
        ? `${engine.name}: no search went through`
        : `${engine.name}: ${String(result.added)} new company job boards`,
  );
  result.left = dueSearches(queries, state, now, false).length;
  return result;
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
