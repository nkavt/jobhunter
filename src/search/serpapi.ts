import { z } from 'zod';
import { USER_AGENT } from '../sources/fetch.js';
import { jsonBody, SearchError, TIMEOUT_MS, type SearchResult } from './common.js';

const ENDPOINT = 'https://serpapi.com/search.json';

const OrganicResultSchema = z.object({
  link: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
});

const ResponseSchema = z.object({
  error: z.string().optional(),
  search_information: z.object({ organic_results_state: z.string().optional() }).optional(),
  organic_results: z.array(OrganicResultSchema).optional(),
});

/** One page (about 10 results) of Google results through SerpApi. */
export async function searchSerpApi(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Not the error itself as the message: the URL holds the key.
    throw new SearchError("Couldn't reach SerpApi.", 'failed', { cause: error });
  }
  const parsed = ResponseSchema.safeParse(await jsonBody(response));
  const body = parsed.success ? parsed.data : {};

  if (!response.ok) throw failure(response.status, body.error);
  if (body.organic_results) return results(body.organic_results);
  // No results is a 200 with an `error` saying so.
  if (body.search_information?.organic_results_state === 'Fully empty') return [];
  throw new SearchError(
    body.error ? `SerpApi: ${body.error}` : "SerpApi's answer had no results list.",
  );
}

function failure(status: number, message: string | undefined): SearchError {
  if (status === 401 || status === 403) {
    return new SearchError("SerpApi didn't accept the API key.", 'bad-key');
  }
  if (status === 429) {
    // The same status for both: the plan's searches are used up, or too many this hour.
    return message && /run out of searches/i.test(message)
      ? new SearchError('Your SerpApi account has run out of searches.', 'out-of-searches')
      : new SearchError('SerpApi asked to slow down.', 'rate-limited');
  }
  return new SearchError(
    message ? `SerpApi: ${message}` : `SerpApi answered with HTTP ${String(status)}.`,
  );
}

function results(items: z.infer<typeof OrganicResultSchema>[]): SearchResult[] {
  return items.flatMap((item) =>
    item.link
      ? [{ url: item.link, title: item.title?.trim() ?? '', snippet: item.snippet?.trim() ?? '' }]
      : [],
  );
}
