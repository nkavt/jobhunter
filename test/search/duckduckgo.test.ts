import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_HEADERS,
  parseResults,
  searchDuckDuckGo,
  SearchError,
} from '../../src/search/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/search/${name}`, import.meta.url), 'utf8');
const ENDPOINT = 'https://html.duckduckgo.com/html/';

describe('parseResults', () => {
  it('reads organic results, unwraps the redirect links and skips ads', () => {
    const results = parseResults(fixture('duckduckgo.html'));
    expect(results.map((r) => r.url)).toEqual([
      'https://jobs.lever.co/lendbuzz/f234abf5-c204-4b15-986a-d8ce996883fd',
      'https://jobs.lever.co/portcast/1f6381eb-03dd-451a-a8cc-2c862cec3fe3',
      'https://jobs.lever.co/entefy/f1d71d1e-5679-40fd-a3e3-72e3c016a6c9',
    ]);
    expect(results[0]?.title).toBe('Lendbuzz - Backend Engineer');
    // Tags and entities removed from the snippet.
    expect(results[0]?.snippet).toMatch(/^We are looking for an experienced, passionate Backend/);
    expect(results[0]?.snippet).toContain('R&D');
  });

  it('finds nothing on a page without results', () => {
    expect(parseResults('<html><body>No results.</body></html>')).toEqual([]);
  });
});

describe('searchDuckDuckGo', () => {
  const server = useMockServer();

  it('sends the query with the headers a browser sends', async () => {
    let query = '';
    let userAgent = '';
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        query = new URL(request.url).searchParams.get('q') ?? '';
        userAgent = request.headers.get('user-agent') ?? '';
        return new HttpResponse(fixture('duckduckgo.html'));
      }),
    );
    const results = await searchDuckDuckGo('site:jobs.lever.co "backend engineer"');
    expect(results).toHaveLength(3);
    expect(query).toBe('site:jobs.lever.co "backend engineer"');
    expect(userAgent).toBe(BROWSER_HEADERS['User-Agent']);
  });

  it('reports the bot check as rate limited', async () => {
    server.use(
      http.get(
        ENDPOINT,
        () => new HttpResponse(fixture('duckduckgo-blocked.html'), { status: 202 }),
      ),
    );
    const error = await searchDuckDuckGo('anything').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).reason).toBe('rate-limited');
  });

  it('reports other failures as failed', async () => {
    server.use(http.get(ENDPOINT, () => new HttpResponse('busy', { status: 503 })));
    const error = await searchDuckDuckGo('anything').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).reason).toBe('failed');
    expect((error as Error).message).toBe('DuckDuckGo answered with HTTP 503.');

    server.use(http.get(ENDPOINT, () => HttpResponse.error()));
    await expect(searchDuckDuckGo('anything')).rejects.toThrow("Couldn't reach DuckDuckGo.");
  });

  it('reports a page that breaks off halfway as a failed search, not a crash', async () => {
    server.use(
      http.get(
        ENDPOINT,
        () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('<html><body>'));
                controller.error(new Error('terminated'));
              },
            }),
          ),
      ),
    );
    const error = await searchDuckDuckGo('anything').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).reason).toBe('failed');
    expect((error as Error).message).toBe("Couldn't reach DuckDuckGo.");
  });
});
