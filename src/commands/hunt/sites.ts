import { normalizeUrl } from '../../jobs/index.js';
import {
  fetchPage,
  readSite,
  SiteError,
  type FetchPage,
  type SiteMapping,
} from '../../sites/index.js';
import { nextFetchAt, type SourceState } from '../../sources/index.js';
import { dim, type Ui } from '../../ui/index.js';
import type { Found } from './types.js';

/** Mapped sites are read at most this often; most are a company's careers page. */
export const SITE_INTERVAL_HOURS = 12;

/** A site's entry in the sources' state, next to the built-in feeds. */
const stateId = (site: SiteMapping) => `site:${site.id}`;
const schedule = (site: SiteMapping) => ({
  id: stateId(site),
  minIntervalHours: SITE_INTERVAL_HOURS,
});

/** The mapped sites not read recently (all of them with `force`). */
export function dueSites(
  sites: readonly SiteMapping[],
  state: SourceState,
  now: Date,
  force = false,
): SiteMapping[] {
  return force ? [...sites] : sites.filter((site) => !nextFetchAt(schedule(site), state, now));
}

/**
 * Read each site mapped by `jobhunter map`, noting when in `state`; the caller saves it. Job
 * pages already in the sheet aren't fetched again. A site that fails is a warning: when it
 * finds no jobs at all, its page has probably changed and it's worth mapping again.
 */
export async function readSites(
  due: readonly SiteMapping[],
  state: SourceState,
  deps: { ui: Ui; fetchPage?: FetchPage | undefined },
  options: { now: Date; known: ReadonlySet<string> },
): Promise<Found[]> {
  const { ui } = deps;
  const found: Found[] = [];
  for (const site of due) {
    let skipped = 0;
    const skip = (url: string) => {
      const known = options.known.has(`url:${normalizeUrl(url)}`);
      if (known) skipped++;
      return known;
    };
    try {
      const result = await ui.task(
        `Reading ${site.name}…`,
        () => readSite(site, deps.fetchPage ?? fetchPage, { skip }),
        (r) =>
          `${site.name}: ${String(r.jobs.length)} jobs${skipped ? `, ${String(skipped)} already in your sheet` : ''}${r.errors.length ? ` (${String(r.errors.length)} unreadable)` : ''}`,
      );
      state[stateId(site)] = {
        lastFetchedAt: options.now.toISOString(),
        lastJobCount: result.jobs.length,
      };
      found.push(...result.jobs.map((job) => ({ job, channel: site.name })));
      if (result.jobs.length === 0 && skipped === 0 && result.errors.length > 0) {
        ui.warn(
          `${site.name}: no job could be read. If the site has changed, run \`jobhunter map ${site.startUrl}\` again.`,
        );
      } else if (site.list.kind === 'links' && result.links.length === 0) {
        ui.info(
          dim(
            `${site.name} lists no jobs right now. If that's wrong, run \`jobhunter map ${site.startUrl}\` again.`,
          ),
        );
      }
    } catch (error) {
      if (!(error instanceof SiteError)) throw error;
      ui.warn(error.message);
    }
  }
  return found;
}
