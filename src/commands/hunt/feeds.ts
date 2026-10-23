import {
  BUILTIN_MAPPINGS,
  fetchSource,
  nextFetchAt,
  SourceError,
  type SourceDefinition,
  type SourceState,
} from '../../sources/index.js';
import { dim, type Ui } from '../../ui/index.js';
import type { Found, HuntDeps } from './types.js';

/** The job boards' feeds not checked recently (all of them with `force`); says when each is due. */
export function dueFeeds(
  ui: Ui,
  sources: readonly SourceDefinition[],
  state: SourceState,
  now: Date,
  force = false,
): SourceDefinition[] {
  return sources.filter((source) => {
    const next = force ? undefined : nextFetchAt(source, state, now);
    if (next) {
      ui.info(
        dim(
          `${source.name}: checked recently; next check after ${next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
        ),
      );
    }
    return !next;
  });
}

/**
 * Fetch each feed, one at a time, and note when it was checked in `state`; the caller saves it.
 * A feed that's down is a warning: the others still run.
 */
export async function fetchFeeds(
  due: readonly SourceDefinition[],
  state: SourceState,
  deps: Pick<HuntDeps, 'ui' | 'fetchSource' | 'mappings'>,
  now: Date,
): Promise<Found[]> {
  const { ui } = deps;
  const fetch = deps.fetchSource ?? fetchSource;
  const found: Found[] = [];
  for (const source of due) {
    try {
      const result = await ui.task(
        `Fetching ${source.name}…`,
        () => fetch(source, deps.mappings ?? BUILTIN_MAPPINGS),
        (r) =>
          `${source.name}: ${String(r.jobs.length)} jobs${r.errors.length ? ` (${String(r.errors.length)} unreadable)` : ''}`,
      );
      state[source.id] = { lastFetchedAt: now.toISOString(), lastJobCount: result.jobs.length };
      found.push(...result.jobs.map((job) => ({ job, channel: source.name })));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      ui.warn(error.message);
    }
  }
  return found;
}
