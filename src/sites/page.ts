import { isLocalURL } from '../llm/index.js';
import { USER_AGENT } from '../sources/fetch.js';
import { cut } from './text.js';

const TIMEOUT_MS = 30_000;
/** Larger pages are cut off; job lists and job pages are far smaller. */
const MAX_BYTES = 3_000_000;

export interface Page {
  /** Where the page ended up, after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** A page couldn't be fetched at all (an HTTP error status still returns a `Page`). */
export class PageError extends Error {
  constructor(
    message: string,
    readonly url: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PageError';
  }
}

export type FetchPage = (url: string) => Promise<Page>;

/**
 * Only public http(s) addresses: the AI picks what to fetch, partly from what pages say, so it
 * must not be able to reach the user's own machine or network.
 */
export function checkPageUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" isn't a valid address.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http and https addresses can be fetched, not ${parsed.protocol}`;
  }
  if (isLocalURL(url)) return `${parsed.hostname} is on your own machine or network.`;
  return undefined;
}

export async function fetchPage(url: string): Promise<Page> {
  const problem = checkPageUrl(url);
  if (problem) throw new PageError(problem, url);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html, application/json, application/xml;q=0.9, */*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new PageError(`Couldn't reach ${new URL(url).hostname}.`, url, { cause: error });
  }
  // A redirect can lead anywhere; check where it ended up too.
  const redirected = response.url && response.url !== url ? checkPageUrl(response.url) : undefined;
  if (redirected) throw new PageError(redirected, url);

  const body = await response.text();
  return {
    url: response.url || url,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: cut(body, MAX_BYTES),
  };
}

/** Fetch each address once; the agent and its tests often ask for the same page again. */
export function cachedFetch(fetch: FetchPage): FetchPage {
  const pages = new Map<string, Promise<Page>>();
  return (url) => {
    let page = pages.get(url);
    if (!page) {
      page = fetch(url);
      pages.set(url, page);
      // A failure is worth retrying later.
      page.catch(() => pages.delete(url));
    }
    return page;
  };
}

export type PageFormat = 'html' | 'json' | 'xml';

/** From the content type, or the body when the type is missing or generic. */
export function pageFormat(page: Pick<Page, 'contentType' | 'body'>): PageFormat {
  const type = page.contentType.toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  if (type.includes('xml') || type.includes('rss') || type.includes('atom')) return 'xml';
  const start = page.body.trimStart();
  if (start.startsWith('{') || start.startsWith('[')) return 'json';
  if (start.startsWith('<?xml') || /^<(rss|feed)\b/i.test(start)) return 'xml';
  return 'html';
}
