import { parse, type HTMLElement } from 'node-html-parser';
import type { Job } from '../jobs/index.js';
import {
  applyMapping,
  getPath,
  parseFeed,
  type FeedMapping,
  type FieldRule,
  type ItemError,
} from '../mapping/index.js';
import { pageFormat, PageError, type FetchPage, type Page } from './page.js';
import type { LinkFeed, PageRule, SiteList, SiteMapping } from './schema.js';

/** Job pages read per hunt and site at most; a filtered list rarely has more new jobs. */
export const MAX_JOB_PAGES = 40;
/** Job pages fetched at the same time from one site. */
const PARALLEL_PAGES = 3;

/** The site's list couldn't be read; the message names the site. */
export class SiteError extends Error {
  constructor(
    message: string,
    readonly site: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SiteError';
  }
}

export interface JobPageResult {
  url: string;
  /** What each field's rule found, before transforms; for the AI to check its selectors. */
  values: Record<string, unknown>;
  job?: Job;
  error?: string;
}

export interface SiteResult {
  jobs: Job[];
  errors: ItemError[];
  /** Job links found on the list (`links` sites only). */
  links: string[];
  /** Each job page read (`links` sites only). */
  pages: JobPageResult[];
}

function okPage(page: Page, site: string): Page {
  if (page.status >= 400) {
    throw new SiteError(`${site} answered with HTTP ${String(page.status)}.`, site);
  }
  return page;
}

/** Absolute web addresses without fragments, each once and in order. */
function uniqueLinks(hrefs: Iterable<unknown>, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const href of hrefs) {
    if (typeof href !== 'string' || !href.trim()) continue;
    try {
      const url = new URL(href.trim(), baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      links.add(url.toString());
    } catch {
      // Not a usable link.
    }
  }
  return [...links];
}

/** The `<a>` elements' targets, absolute, without fragments, each once and in page order. */
export function jobLinks(html: string, baseUrl: string, selector: string): string[] {
  return uniqueLinks(
    parse(html)
      .querySelectorAll(selector)
      .map(
        (element) =>
          element.getAttribute('href') ?? element.querySelector('a')?.getAttribute('href'),
      ),
    baseUrl,
  );
}

/** The job page addresses in a feed's items. Throws `FeedParseError` for a broken feed. */
export function feedLinks(body: string, baseUrl: string, feed: LinkFeed): string[] {
  const list = getPath(parseFeed(body, feed.format), feed.items);
  const items: unknown[] = Array.isArray(list) ? list : list == null ? [] : [list];
  // Atom links are elements with the address in an attribute: `<link href="…"/>`.
  const href = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && '@_href' in value
      ? (value as Record<string, unknown>)['@_href']
      : value;
  return uniqueLinks(
    items.map((item) => href(getPath(item, feed.link))),
    baseUrl,
  );
}

const JOB_POSTING = 'JobPosting';
const isJobPosting = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const type = (value as Record<string, unknown>)['@type'];
  return type === JOB_POSTING || (Array.isArray(type) && type.includes(JOB_POSTING));
};

/** The page's schema.org JobPosting, from its JSON-LD (also inside `@graph` or a list). */
export function findJobPosting(root: HTMLElement): Record<string, unknown> | undefined {
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.rawText);
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(data) ? data : [data];
    for (const candidate of candidates) {
      if (isJobPosting(candidate)) return candidate;
      const graph = (candidate as Record<string, unknown> | null)?.['@graph'];
      if (Array.isArray(graph)) {
        const found = graph.find(isJobPosting);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function rawValue(root: HTMLElement, posting: unknown, rule: PageRule): unknown {
  if (rule.const !== undefined) return rule.const;
  if (rule.jsonLd !== undefined) return readPath(posting, rule.jsonLd);
  if (rule.selector === undefined) return undefined;
  let element: HTMLElement | null;
  try {
    element = root.querySelector(rule.selector);
  } catch {
    // An invalid selector finds nothing; the AI sees the field come back empty.
    return undefined;
  }
  if (!element) return undefined;
  if (rule.attr === 'html') return element.innerHTML;
  if (rule.attr) return element.getAttribute(rule.attr);
  return element.structuredText;
}

/**
 * Read one job page with the page rules. The values found are run through the feed mapping
 * engine, so transforms and validation work the same as for feeds.
 */
export function readJobPage(
  html: string,
  url: string,
  fields: Partial<Record<string, PageRule>>,
  source: string,
): JobPageResult {
  const root = parse(html);
  const posting = findJobPosting(root);
  const item: Record<string, unknown> = {};
  const mapping: FeedMapping = { format: 'json', items: '', fields: {} };
  const values: Record<string, unknown> = {};

  for (const [target, rule] of Object.entries(fields)) {
    if (!rule) continue;
    // Dotted targets like `salary.min` would read as paths; the item uses flat keys.
    const key = target.replace(/\./g, '_');
    const value = rawValue(root, posting, rule);
    item[key] = value;
    values[target] = value;
    const { transform, map } = rule;
    const fieldRule: FieldRule = {
      from: key,
      ...(transform !== undefined ? { transform } : {}),
      ...(map !== undefined ? { map } : {}),
      ...(rule.default !== undefined ? { default: rule.default } : {}),
    };
    mapping.fields[target as keyof FeedMapping['fields']] = fieldRule;
  }
  mapping.fields.url ??= { const: url };
  mapping.fields.sourceId ??= { const: url };

  const result = applyMapping([item], mapping, source);
  const job = result.jobs[0];
  return job ? { url, values, job } : { url, values, error: result.errors[0]?.message ?? 'no job' };
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return results;
}

export interface ReadSiteOptions {
  /** Job pages to read at most (`links` sites); the rest are left out. */
  maxPages?: number;
  /** Links not worth fetching, e.g. jobs already in the sheet. */
  skip?: (url: string) => boolean;
}

/** Fetch a site's list (and its job pages) and turn it into jobs. */
export async function readSite(
  site: Pick<SiteMapping, 'id' | 'name' | 'entryUrl' | 'list'>,
  fetch: FetchPage,
  options: ReadSiteOptions = {},
): Promise<SiteResult> {
  let list: Page;
  try {
    list = okPage(await fetch(site.entryUrl), site.name);
  } catch (error) {
    if (error instanceof PageError) {
      throw new SiteError(`${site.name}: ${error.message}`, site.id, { cause: error });
    }
    throw error;
  }
  return site.list.kind === 'feed'
    ? readFeedList(site, site.list.mapping, list)
    : readLinksList(site, site.list, list, fetch, options);
}

function readFeedList(
  site: Pick<SiteMapping, 'id' | 'name'>,
  mapping: FeedMapping,
  list: Page,
): SiteResult {
  try {
    const result = applyMapping(parseFeed(list.body, mapping.format), mapping, site.id);
    return { jobs: result.jobs, errors: result.errors, links: [], pages: [] };
  } catch (error) {
    throw new SiteError(
      `${site.name}: ${error instanceof Error ? error.message : String(error)}`,
      site.id,
      { cause: error },
    );
  }
}

function listLinks(
  site: Pick<SiteMapping, 'id' | 'name'>,
  list: Extract<SiteList, { kind: 'links' }>,
  page: Page,
): string[] {
  if (list.feed) {
    try {
      return feedLinks(page.body, page.url, list.feed);
    } catch (error) {
      throw new SiteError(
        `${site.name}: ${error instanceof Error ? error.message : String(error)}`,
        site.id,
        { cause: error },
      );
    }
  }
  if (pageFormat(page) !== 'html') {
    throw new SiteError(`${site.name}: the job list isn't an HTML page.`, site.id);
  }
  return jobLinks(page.body, page.url, list.selector ?? '');
}

async function readLinksList(
  site: Pick<SiteMapping, 'id' | 'name'>,
  list: Extract<SiteList, { kind: 'links' }>,
  page: Page,
  fetch: FetchPage,
  options: ReadSiteOptions,
): Promise<SiteResult> {
  const links = listLinks(site, list, page);
  const wanted = links
    .filter((link) => !options.skip?.(link))
    .slice(0, options.maxPages ?? MAX_JOB_PAGES);

  const pages = await inBatches(wanted, PARALLEL_PAGES, async (url) => {
    try {
      const jobPage = await fetch(url);
      if (jobPage.status >= 400) {
        return { url, values: {}, error: `HTTP ${String(jobPage.status)}` };
      }
      return readJobPage(jobPage.body, url, list.fields, site.id);
    } catch (error) {
      if (!(error instanceof PageError)) throw error;
      return { url, values: {}, error: error.message };
    }
  });

  const result: SiteResult = { jobs: [], errors: [], links, pages };
  pages.forEach((jobPage, index) => {
    if (jobPage.job) result.jobs.push(jobPage.job);
    else result.errors.push({ index, message: `${jobPage.url}: ${jobPage.error ?? 'no job'}` });
  });
  return result;
}
