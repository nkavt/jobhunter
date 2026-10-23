import { decodeEntities } from '../jobs/index.js';

export const TIMEOUT_MS = 30_000;

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

/**
 * Why a search couldn't run. `rate-limited` passes if you wait; `out-of-searches` and `bad-key`
 * need the user to act (a new plan, a new key).
 */
export type SearchFailure = 'rate-limited' | 'out-of-searches' | 'bad-key' | 'failed';

/** A search couldn't run; the message names the search engine. */
export class SearchError extends Error {
  constructor(
    message: string,
    readonly reason: SearchFailure = 'failed',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SearchError';
  }
}

/** Snippets and titles come with highlighting tags (`<b>`, `<strong>`) and entities. */
export const plainText = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, '')).trim();

/** The body as JSON, or `undefined` when it isn't. */
export async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
