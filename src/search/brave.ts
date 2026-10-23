import { z } from 'zod';
import { USER_AGENT } from '../sources/fetch.js';
import { jsonBody, plainText, SearchError, TIMEOUT_MS, type SearchResult } from './common.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
/** The most the API returns per request. */
const COUNT = 20;

const ErrorSchema = z.object({ code: z.string().optional(), detail: z.string().optional() });

const ResponseSchema = z.object({
  error: ErrorSchema.optional(),
  web: z
    .object({
      results: z.array(
        z.object({
          url: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

/** One page (up to 20 results) from the Brave Search API. */
export async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(COUNT));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SearchError("Couldn't reach Brave Search.", 'failed', { cause: error });
  }
  const parsed = ResponseSchema.safeParse(await jsonBody(response));
  const body = parsed.success ? parsed.data : {};

  if (!response.ok) throw failure(response.status, body.error);
  // Not "no results": the search didn't really happen, so it's tried again next time.
  if (!parsed.success) throw new SearchError("Brave Search's answer couldn't be read.");
  // No `web` section at all when nothing matched.
  return (body.web?.results ?? []).flatMap((item) =>
    item.url
      ? [
          {
            url: item.url,
            title: plainText(item.title ?? ''),
            snippet: plainText(item.description ?? ''),
          },
        ]
      : [],
  );
}

function failure(status: number, error: z.infer<typeof ErrorSchema> = {}): SearchError {
  const code = error.code ?? '';
  // An invalid token is a 422 (with a code saying so), not only a 401.
  if (status === 401 || status === 403 || /TOKEN/.test(code)) {
    return new SearchError("Brave Search didn't accept the API key.", 'bad-key');
  }
  if (status === 402 || /USAGE_LIMIT|QUOTA/.test(code)) {
    return new SearchError(
      "Your Brave Search plan's searches are used up for this month.",
      'out-of-searches',
    );
  }
  if (status === 429) return new SearchError('Brave Search asked to slow down.', 'rate-limited');
  return new SearchError(
    error.detail
      ? `Brave Search: ${error.detail}`
      : `Brave Search answered with HTTP ${String(status)}.`,
  );
}
