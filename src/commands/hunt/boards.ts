import type { Profile } from '../../config/index.js';
import { companyTitleFilter } from '../../filter/index.js';
import {
  boardQueries,
  dueSearches,
  huntBoards,
  type Ats,
  type BoardState,
} from '../../sources/index.js';
import { dim, type Ui } from '../../ui/index.js';
import type { Found, HuntDeps } from './types.js';

/**
 * Read the companies' own job boards found by `jobhunter companies find`; updates `state`, the
 * caller saves it. A board lists every job the company has, so only titles matching the roles
 * and level go on: the rest would flood the Ignored tab and the AI.
 */
export async function readCompanyBoards(
  state: BoardState,
  ats: readonly Ats[],
  profile: Profile,
  deps: Pick<HuntDeps, 'ui' | 'mappings'>,
  options: { now: Date; force?: boolean | undefined },
): Promise<Found[]> {
  const titleFits = companyTitleFilter(profile.derived);
  return huntBoards(
    state,
    { ui: deps.ui, ats, ...(deps.mappings ? { mappings: deps.mappings } : {}) },
    {
      now: options.now,
      ...(options.force ? { force: true } : {}),
      keep: (job) => titleFits(job.title),
    },
  );
}

/** Searching for company boards is its own command; say when it's worth running. */
export function showCompaniesHint(
  ui: Ui,
  profile: Profile,
  state: BoardState,
  ats: readonly Ats[],
  now: Date,
): void {
  const queries = ats.length > 0 ? boardQueries(profile, ats) : [];
  if (queries.length === 0) return;
  if (Object.keys(state.boards).length === 0) {
    ui.info(
      dim(
        'Company job boards (Greenhouse, Lever, Ashby, Workable) are skipped: none found yet. Run `jobhunter companies find` to look for some.',
      ),
    );
  } else if (dueSearches(queries, state, now).length > 0) {
    ui.info(dim('Time to look for new company job boards: run `jobhunter companies find`.'));
  }
}
