import { readJsonFile, writeJsonFile } from '../config/fs.js';
import { sitesFile } from '../config/paths.js';
import { SitesFileSchema, type SiteMapping } from './schema.js';

/** The mapped sites; none when `jobhunter map` hasn't run yet. Throws `ConfigError` when broken. */
export async function loadSites(): Promise<SiteMapping[]> {
  return (await readJsonFile(sitesFile(), SitesFileSchema))?.sites ?? [];
}

/** The site mapped from this start address, so mapping it again replaces it. */
export function findSite(sites: readonly SiteMapping[], startUrl: string): SiteMapping | undefined {
  return sites.find((site) => site.startUrl === startUrl);
}

/**
 * Add a site, replacing the one mapped from the same start address. Another site with the same
 * ID (two lists on one host) gets a numbered one.
 */
export async function saveSite(site: SiteMapping): Promise<SiteMapping> {
  const sites = (await loadSites()).filter((known) => known.startUrl !== site.startUrl);
  const taken = new Set(sites.map((known) => known.id));
  let id = site.id;
  for (let n = 2; taken.has(id); n++) id = `${site.id}-${String(n)}`;
  const saved = { ...site, id };
  await writeJsonFile(sitesFile(), { version: 1, sites: [...sites, saved] });
  return saved;
}
