import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { InvalidKeyError, RateLimitError, WebSearchUnavailableError } from '../../src/llm/index.js';
import { searchWithAi, SearchError } from '../../src/search/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { FakeLLM } from '../helpers/fake-llm.js';

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123';

describe('searchWithAi', () => {
  const server = useMockServer();

  it('asks for the query with web search and returns the pages and sources once each', async () => {
    const llm = new FakeLLM({
      search: {
        data: {
          pages: [
            { url: 'https://jobs.lever.co/acme/1', title: 'Acme - Backend Engineer' },
            { url: 'not a url', title: 'Broken' },
          ],
        },
        sources: [
          { url: 'https://jobs.lever.co/acme/1', title: 'Acme' },
          { url: 'https://jobs.lever.co/globex/2' },
        ],
      },
    });
    const results = await searchWithAi('site:jobs.lever.co "backend engineer"', llm);

    expect(llm.calls[0]?.method).toBe('searchJSON');
    expect((llm.calls[0]?.request as { prompt: string }).prompt).toContain(
      'Search the web for: site:jobs.lever.co "backend engineer"',
    );
    expect(results).toEqual([
      { url: 'https://jobs.lever.co/acme/1', title: 'Acme - Backend Engineer', snippet: '' },
      { url: 'https://jobs.lever.co/globex/2', title: '', snippet: '' },
    ]);
  });

  it("follows Gemini's redirect links to the page itself", async () => {
    server.use(
      http.head(
        REDIRECT,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://jobs.ashbyhq.com/ramp/34413f8d' },
          }),
      ),
    );
    const llm = new FakeLLM({ search: { data: { pages: [] }, sources: [{ url: REDIRECT }] } });
    const results = await searchWithAi('q', llm);
    expect(results.map((r) => r.url)).toEqual(['https://jobs.ashbyhq.com/ramp/34413f8d']);
  });

  it('turns AI errors into search errors', async () => {
    const failing = (error: Error) => new FakeLLM({ errors: { searchJSON: error } });

    const badKey = (await searchWithAi('q', failing(new InvalidKeyError('nope', 'claude'))).catch(
      (e: unknown) => e,
    )) as SearchError;
    expect(badKey).toBeInstanceOf(SearchError);
    expect(badKey.reason).toBe('bad-key');
    expect(badKey.message).toBe("Fake AI didn't accept the API key.");

    const busy = (await searchWithAi(
      'q',
      failing(new RateLimitError('Too many requests.', 'claude')),
    ).catch((e: unknown) => e)) as SearchError;
    expect(busy.reason).toBe('rate-limited');
    expect(busy.message).toBe('Too many requests.');

    // Search not in the plan: stop, since every search would fail the same way.
    const unavailable = (await searchWithAi(
      'q',
      failing(new WebSearchUnavailableError('No Google Search on this plan. BTW: …', 'gemini')),
    ).catch((e: unknown) => e)) as SearchError;
    expect(unavailable.reason).toBe('out-of-searches');
    expect(unavailable.message).toBe('No Google Search on this plan. BTW: …');
  });
});
