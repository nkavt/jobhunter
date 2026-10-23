import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { searchSerpApi, SearchError } from '../../src/search/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/search/serpapi.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const ENDPOINT = 'https://serpapi.com/search.json';

const failure = (error: unknown) => error as SearchError;

describe('searchSerpApi', () => {
  const server = useMockServer();

  it('sends the query and key to Google search, and reads the organic results', async () => {
    let params = new URLSearchParams();
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json(fixture);
      }),
    );
    const results = await searchSerpApi('site:jobs.lever.co "backend engineer"', 'key-1');
    expect(params.get('engine')).toBe('google');
    expect(params.get('q')).toBe('site:jobs.lever.co "backend engineer"');
    expect(params.get('api_key')).toBe('key-1');
    expect(results).toEqual([
      {
        url: 'https://jobs.lever.co/lendbuzz/f234abf5-c204-4b15-986a-d8ce996883fd',
        title: 'Lendbuzz - Backend Engineer',
        snippet:
          'We are looking for an experienced, passionate Backend Engineer to join our R&D team.',
      },
      {
        url: 'https://jobs.lever.co/portcast/1f6381eb-03dd-451a-a8cc-2c862cec3fe3',
        title: 'Portcast - Senior Backend Engineer',
        snippet: '',
      },
    ]);
  });

  it('finds nothing when Google has no results', async () => {
    server.use(
      http.get(ENDPOINT, () =>
        HttpResponse.json({
          search_metadata: { status: 'Success' },
          search_information: { organic_results_state: 'Fully empty' },
          error: "Google hasn't returned any results for this query.",
        }),
      ),
    );
    expect(await searchSerpApi('nothing', 'key')).toEqual([]);
  });

  it('reports a rejected key', async () => {
    server.use(
      http.get(ENDPOINT, () =>
        HttpResponse.json(
          {
            error:
              'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key',
          },
          { status: 401 },
        ),
      ),
    );
    const error = failure(await searchSerpApi('q', 'bad').catch((e: unknown) => e));
    expect(error).toBeInstanceOf(SearchError);
    expect(error.reason).toBe('bad-key');
    expect(error.message).toBe("SerpApi didn't accept the API key.");
  });

  it('tells running out of searches apart from the hourly limit', async () => {
    server.use(
      http.get(ENDPOINT, () =>
        HttpResponse.json({ error: 'Your account has run out of searches.' }, { status: 429 }),
      ),
    );
    const used = failure(await searchSerpApi('q', 'key').catch((e: unknown) => e));
    expect(used.reason).toBe('out-of-searches');

    server.use(
      http.get(ENDPOINT, () =>
        HttpResponse.json({ error: 'Hourly throughput limit reached.' }, { status: 429 }),
      ),
    );
    const busy = failure(await searchSerpApi('q', 'key').catch((e: unknown) => e));
    expect(busy.reason).toBe('rate-limited');
  });

  it('reports other failures without the key in the message', async () => {
    server.use(http.get(ENDPOINT, () => new HttpResponse('down', { status: 503 })));
    const error = failure(await searchSerpApi('q', 'secret-key').catch((e: unknown) => e));
    expect(error.reason).toBe('failed');
    expect(error.message).toBe('SerpApi answered with HTTP 503.');

    server.use(http.get(ENDPOINT, () => HttpResponse.error()));
    const offline = failure(await searchSerpApi('q', 'secret-key').catch((e: unknown) => e));
    expect(offline.message).toBe("Couldn't reach SerpApi.");
    expect(offline.message).not.toContain('secret-key');
  });
});
