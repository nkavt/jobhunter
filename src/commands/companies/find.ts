import { loadConfig, readProfile } from '../../config/index.js';
import type { Connection, LLMAdapter } from '../../llm/index.js';
import { createSearchEngine, type SearchEngine } from '../../search/index.js';
import {
  ATS,
  boardQueries,
  dueSearches,
  findCompanyBoards,
  loadBoardState,
  SEARCH_EVERY_DAYS,
  type Ats,
  type FindBoardsResult,
} from '../../sources/index.js';
import { dim, type Ui } from '../../ui/index.js';

/** Slower than this between searches, and the user hears how long it'll take. */
const SLOW_PAUSE_MS = 10_000;

export interface CompaniesFindDeps {
  ui: Ui;
  connect: (connection: Connection, model?: string) => LLMAdapter;
  /** Replaces the engine picked in `init`; tests use a fake one. */
  engine?: SearchEngine;
  ats?: Ats[];
  pause?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface CompaniesFindOptions {
  /** Repeat the searches that ran in the last week too. */
  force?: boolean;
}

/** Setup isn't complete enough to search; the message says what to do. */
export class CompaniesSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompaniesSetupError';
  }
}

/**
 * Search the web for companies' own job boards (each role on each ATS's site) and remember
 * them for `hunt`. Returns `undefined` when there was nothing to search.
 */
export async function runCompaniesFind(
  deps: CompaniesFindDeps,
  options: CompaniesFindOptions = {},
): Promise<FindBoardsResult | undefined> {
  const { ui } = deps;
  const now = deps.now?.() ?? new Date();
  const config = await loadConfig();
  const profile = await readProfile(config.activeProfile);
  if (!profile?.derived && !profile?.boardSearch) {
    throw new CompaniesSetupError(
      'Company job boards are searched for by your roles, which come from your CV. Run `jobhunter init` to import it first.',
    );
  }
  const ats = deps.ats ?? ATS;
  const queries = boardQueries(profile, ats);
  if (queries.length === 0) {
    ui.info('Nothing to search: `boardSearch.queries` in your profile.json is empty.');
    return undefined;
  }

  const state = await loadBoardState();
  const due = dueSearches(queries, state, now, options.force);
  if (due.length === 0) {
    ui.info(
      `Every search ran in the last ${String(SEARCH_EVERY_DAYS)} days. Run \`jobhunter companies find --force\` to search again.`,
    );
    return undefined;
  }

  const engine =
    deps.engine ?? createSearchEngine(config.search, () => deps.connect(config, config.model));
  if (!config.search) {
    ui.info(
      dim(
        'Searching DuckDuckGo. For a faster search, run `jobhunter init` → Web search and pick another one.',
      ),
    );
  }
  if (engine.pauseMs >= SLOW_PAUSE_MS && due.length > 1) {
    const minutes = Math.ceil(((due.length - 1) * engine.pauseMs) / 60_000);
    ui.info(
      dim(
        `${String(due.length)} searches, about ${String(minutes)} minute${minutes === 1 ? '' : 's'}: ${engine.name} has to be read page by page like a browser, with a pause between searches. Stop any time with Ctrl+C; the next run picks up where this one stopped.`,
      ),
    );
  }

  const result = await findCompanyBoards(
    profile,
    state,
    { ui, engine, ats, ...(deps.pause ? { pause: deps.pause } : {}) },
    { now, ...(options.force ? { force: true } : {}) },
  );

  if (result.stopped) {
    const next =
      result.stopped.reason === 'rate-limited'
        ? `The remaining ${String(result.left)} searches run next time.`
        : 'Run `jobhunter init` → Web search to fix it or pick another search.';
    ui.warn(`${result.stopped.message} ${next}`);
  }
  if (result.failed > 0) {
    ui.warn(
      `${String(result.failed)} searches failed (${result.lastFailure?.message ?? 'unknown error'}); the next run tries them again.`,
    );
  }
  const known = Object.keys(state.boards).length;
  ui.info(
    known > 0
      ? `${String(known)} company job boards known. \`jobhunter hunt\` reads them.`
      : 'No company job boards found yet.',
  );
  return result;
}
