import { decodeEntities } from '../jobs/index.js';
import { plainText, SearchError, TIMEOUT_MS, type SearchResult } from './common.js';

const ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * What Chrome on macOS sends for a search on the HTML version. With Jobhunter's own User-Agent
 * nearly every search got the bot check; with these, spaced-out searches go through.
 */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://html.duckduckgo.com/',
};

/**
 * One page (about 10 results) from DuckDuckGo's HTML version. There's no API for web results,
 * so this reads the page; it answers a bot check (HTTP 202) when requests come too close together.
 */
export async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  let response: Response;
  try {
    // GET: POSTs to the same endpoint hit the bot check far more often.
    response = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SearchError("Couldn't reach DuckDuckGo.", 'failed', { cause: error });
  }
  const html = await response.text();
  if (response.status === 202 || html.includes('anomaly-modal')) {
    throw new SearchError('DuckDuckGo asked to slow down.', 'rate-limited');
  }
  if (!response.ok) {
    throw new SearchError(`DuckDuckGo answered with HTTP ${String(response.status)}.`);
  }
  return parseResults(html);
}

const RESULT_LINK = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
const SNIPPET = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

/** Organic results from a results page, ads left out. */
export function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result is a `<div class="result …">`; split on them so a link and its snippet stay together.
  for (const block of html.split(/<div class="result /).slice(1)) {
    if (/^[^>]*result--ad/.test(block)) continue;
    const link = RESULT_LINK.exec(block);
    if (!link) continue;
    const url = resultUrl(decodeEntities(link[1] ?? ''));
    if (!url) continue;
    results.push({
      url,
      title: plainText(link[2] ?? ''),
      snippet: plainText(SNIPPET.exec(block)?.[1] ?? ''),
    });
  }
  return results;
}

/** Results link through `//duckduckgo.com/l/?uddg=<target>`; unwrap to the target. */
function resultUrl(href: string): string | undefined {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.hostname === 'duckduckgo.com' ? url.searchParams.get('uddg') : url.href;
    return target ? new URL(target).href : undefined;
  } catch {
    return undefined;
  }
}
