import { z } from 'zod';
import {
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  RateLimitError,
  type LLMAdapter,
} from '../llm/index.js';
import { USER_AGENT } from '../sources/fetch.js';
import { SearchError, TIMEOUT_MS, type SearchResult } from './common.js';

/** Each query is one site and one role, so a couple of searches is plenty. */
const MAX_SEARCHES = 2;

const PagesSchema = z.object({
  pages: z.array(z.object({ url: z.string(), title: z.string() })),
});

/** Gemini's sources link through this redirect instead of to the page itself. */
const GROUNDING_REDIRECT = 'vertexaisearch.cloud.google.com';

/** Run a search query through the AI provider's own web search. */
export async function searchWithAi(query: string, llm: LLMAdapter): Promise<SearchResult[]> {
  let found: { data: z.infer<typeof PagesSchema>; sources: { url: string; title?: string }[] };
  try {
    found = await llm.searchJSON({
      prompt: [
        `Search the web for: ${query}`,
        'List the pages from the search results that match, up to 20. Only include URLs that ' +
          'appeared in the search results; never guess one.',
      ].join('\n\n'),
      schema: PagesSchema,
      schemaName: 'search_results',
      maxSearches: MAX_SEARCHES,
    });
  } catch (error) {
    throw searchError(error, llm.providerName);
  }

  const pages = [
    ...found.data.pages,
    ...found.sources.map((s) => ({ url: s.url, title: s.title ?? '' })),
  ];
  const resolved = await Promise.all(
    pages.map(async (page) => ({ ...page, url: await resolveRedirect(page.url) })),
  );
  const seen = new Set<string>();
  return resolved.flatMap(({ url, title }) => {
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ url, title: title.trim(), snippet: '' }];
  });
}

function searchError(error: unknown, providerName: string): unknown {
  if (!(error instanceof LLMError)) return error;
  const reason =
    error instanceof InvalidKeyError
      ? 'bad-key'
      : error instanceof InsufficientCreditError
        ? 'out-of-searches'
        : error instanceof RateLimitError
          ? 'rate-limited'
          : 'failed';
  return new SearchError(
    reason === 'bad-key' ? `${providerName} didn't accept the API key.` : error.message,
    reason,
    { cause: error },
  );
}

/** The page a Gemini redirect link points to; other links as they are, `undefined` if broken. */
async function resolveRedirect(href: string): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.hostname !== GROUNDING_REDIRECT) return url.href;
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get('location');
    return location ? new URL(location, url).href : undefined;
  } catch {
    return undefined;
  }
}
