import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { searchBrave, SearchError } from '../../src/search/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/search/brave.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const failure = (error: unknown) => error as SearchError;
const braveError = (status: number, code: string, detail = 'Something went wrong.') =>
  HttpResponse.json({ type: 'ErrorResponse', error: { status, code, detail } }, { status });

describe('searchBrave', () => {
  const server = useMockServer();

  it('sends the query with the key header, and reads the web results as plain text', async () => {
    let params = new URLSearchParams();
    let token = '';
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        params = new URL(request.url).searchParams;
        token = request.headers.get('x-subscription-token') ?? '';
        return HttpResponse.json(fixture);
      }),
    );
    const results = await searchBrave('site:jobs.lever.co "backend engineer"', 'key-1');
    expect(params.get('q')).toBe('site:jobs.lever.co "backend engineer"');
    expect(params.get('count')).toBe('20');
    expect(token).toBe('key-1');
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

  it('finds nothing when the answer has no web results', async () => {
    server.use(http.get(ENDPOINT, () => HttpResponse.json({ type: 'search', query: {} })));
    expect(await searchBrave('nothing', 'key')).toEqual([]);
  });

  it("fails, rather than finding nothing, when a 200 answer can't be read", async () => {
    server.use(http.get(ENDPOINT, () => new HttpResponse('<html>gateway</html>')));
    const error = failure(await searchBrave('q', 'key').catch((e: unknown) => e));
    expect(error).toBeInstanceOf(SearchError);
    expect(error.reason).toBe('failed');
    expect(error.message).toBe("Brave Search's answer couldn't be read.");
  });

  it('reports a rejected key, including the 422 Brave answers with', async () => {
    server.use(http.get(ENDPOINT, () => braveError(422, 'SUBSCRIPTION_TOKEN_INVALID')));
    const error = failure(await searchBrave('q', 'bad').catch((e: unknown) => e));
    expect(error).toBeInstanceOf(SearchError);
    expect(error.reason).toBe('bad-key');
    expect(error.message).toBe("Brave Search didn't accept the API key.");
  });

  it('tells a used-up plan apart from the per-second limit', async () => {
    server.use(http.get(ENDPOINT, () => braveError(429, 'USAGE_LIMIT_EXCEEDED')));
    const used = failure(await searchBrave('q', 'key').catch((e: unknown) => e));
    expect(used.reason).toBe('out-of-searches');

    server.use(http.get(ENDPOINT, () => braveError(429, 'RATE_LIMITED')));
    const busy = failure(await searchBrave('q', 'key').catch((e: unknown) => e));
    expect(busy.reason).toBe('rate-limited');
  });

  it('reports other failures', async () => {
    server.use(
      http.get(ENDPOINT, () => braveError(422, 'VALIDATION', 'Unable to validate request.')),
    );
    const invalid = failure(await searchBrave('q', 'key').catch((e: unknown) => e));
    expect(invalid.reason).toBe('failed');
    expect(invalid.message).toBe('Brave Search: Unable to validate request.');

    server.use(http.get(ENDPOINT, () => new HttpResponse('down', { status: 503 })));
    const down = failure(await searchBrave('q', 'key').catch((e: unknown) => e));
    expect(down.message).toBe('Brave Search answered with HTTP 503.');

    server.use(http.get(ENDPOINT, () => HttpResponse.error()));
    await expect(searchBrave('q', 'key')).rejects.toThrow("Couldn't reach Brave Search.");
  });
});
