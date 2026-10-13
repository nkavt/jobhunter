import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClaudeAdapter } from '../../../src/llm/claude/adapter.js';
import {
  connectAdapter,
  createAdapter,
  DEFAULT_CLAUDE_MODEL,
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  NetworkError,
  RateLimitError,
  WebSearchUnavailableError,
} from '../../../src/llm/index.js';
import {
  ANTHROPIC,
  apiError,
  message,
  messagesHandler,
  model,
  text,
  useMockServer,
} from '../../helpers/anthropic-mock.js';

const server = useMockServer();
const adapter = (overrides = {}) =>
  new ClaudeAdapter({ apiKey: 'sk-ant-test', model: 'claude-test', maxRetries: 0, ...overrides });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ClaudeAdapter: setup and auth', () => {
  it('uses the key from config and ignores ANTHROPIC_* environment variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-env');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example.com');
    const { handler, requests } = messagesHandler(message([text('Hello')]));
    server.use(handler);

    await adapter().checkModelAccess();

    expect(requests[0]?.url).toBe(`${ANTHROPIC}/v1/messages`);
    expect(requests[0]?.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('defaults to Claude Sonnet 5.5', () => {
    expect(new ClaudeAdapter({ apiKey: 'k' }).model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('is what createAdapter loads for the claude provider, on the first call', async () => {
    const { handler, requests } = messagesHandler(message([text('Hello')]));
    server.use(handler);

    const created = createAdapter({ provider: 'claude', apiKey: 'sk-ant-x', model: 'claude-x' });
    expect(created.model).toBe('claude-x');
    expect(created.providerName).toBe('Anthropic');
    await created.generateText({ prompt: 'Hi' });

    expect(requests[0]?.body.model).toBe('claude-x');
    expect(requests[0]?.headers.get('x-api-key')).toBe('sk-ant-x');
  });

  it('uses the default model when setup has not picked one yet', () => {
    expect(connectAdapter({ provider: 'claude', apiKey: 'k' }).model).toBe(DEFAULT_CLAUDE_MODEL);
  });
});

describe('ClaudeAdapter: models and key test', () => {
  it('lists models newest first, with family, skipping retired ones', async () => {
    server.use(
      http.get(`${ANTHROPIC}/v1/models`, () =>
        HttpResponse.json({
          data: [
            model('claude-old', {
              created_at: '2025-01-01T00:00:00Z',
              lifecycle: 'deprecated',
              line: 'sonnet',
            }),
            model('claude-gone', { lifecycle: 'retired' }),
            model('claude-new', {
              created_at: '2026-06-01T00:00:00Z',
              line: 'opus',
              display_name: 'Claude New',
            }),
          ],
          has_more: false,
          first_id: 'claude-old',
          last_id: 'claude-new',
        }),
      ),
    );

    expect(await adapter().listModels()).toEqual([
      {
        id: 'claude-new',
        displayName: 'Claude New',
        createdAt: '2026-06-01T00:00:00Z',
        deprecated: false,
        family: 'opus',
      },
      {
        id: 'claude-old',
        displayName: 'claude-old',
        createdAt: '2025-01-01T00:00:00Z',
        deprecated: true,
        family: 'sonnet',
      },
    ]);
  });

  it('follows pagination', async () => {
    server.use(
      http.get(`${ANTHROPIC}/v1/models`, ({ request }) => {
        const afterId = new URL(request.url).searchParams.get('after_id');
        return HttpResponse.json(
          afterId === 'claude-a'
            ? {
                data: [model('claude-b')],
                has_more: false,
                first_id: 'claude-b',
                last_id: 'claude-b',
              }
            : {
                data: [model('claude-a')],
                has_more: true,
                first_id: 'claude-a',
                last_id: 'claude-a',
              },
        );
      }),
    );
    expect((await adapter().listModels()).map((m) => m.id).sort()).toEqual([
      'claude-a',
      'claude-b',
    ]);
  });

  it('maps a rejected key to InvalidKeyError', async () => {
    server.use(
      http.get(`${ANTHROPIC}/v1/models`, () =>
        apiError(401, 'authentication_error', 'invalid x-api-key'),
      ),
    );
    await expect(adapter().validateKey()).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it('maps connection failures to NetworkError', async () => {
    server.use(http.get(`${ANTHROPIC}/v1/models`, () => HttpResponse.error()));
    await expect(adapter().validateKey()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('ClaudeAdapter: model access check', () => {
  it('sends a 1-token request to the chosen model', async () => {
    const { handler, requests } = messagesHandler(message([text('H')]));
    server.use(handler);
    await adapter().checkModelAccess('claude-other');
    expect(requests[0]?.body).toMatchObject({ model: 'claude-other', max_tokens: 1 });
  });

  it.each([
    [
      apiError(
        400,
        'invalid_request_error',
        'Your credit balance is too low to access the Anthropic API.',
      ),
      InsufficientCreditError,
    ],
    [apiError(404, 'not_found_error', 'model: claude-test'), ModelUnavailableError],
    [apiError(403, 'permission_error', 'not allowed'), ModelUnavailableError],
    [apiError(529, 'overloaded_error', 'Overloaded'), NetworkError],
    [apiError(400, 'invalid_request_error', 'something else'), LLMError],
  ])('maps API errors (%#)', async (response, ErrorClass) => {
    server.use(messagesHandler(response).handler);
    await expect(adapter().checkModelAccess()).rejects.toBeInstanceOf(ErrorClass);
  });

  it('keeps the model name and retry-after details', async () => {
    server.use(messagesHandler(apiError(404, 'not_found_error', 'model: claude-test')).handler);
    await expect(adapter().checkModelAccess()).rejects.toMatchObject({ model: 'claude-test' });

    server.use(
      messagesHandler(apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }))
        .handler,
    );
    const error = await adapter()
      .checkModelAccess()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7000);
  });
});

describe('ClaudeAdapter: generateText', () => {
  it('joins text blocks and reports usage', async () => {
    server.use(
      messagesHandler(
        message([text('Hello '), text('world')], {
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        }),
      ).handler,
    );
    expect(await adapter().generateText({ prompt: 'Hi' })).toEqual({
      text: 'Hello world',
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        webSearches: 0,
      },
    });
  });

  it('marks the system prompt cacheable and attaches PDFs as documents', async () => {
    const { handler, requests } = messagesHandler(message([text('ok')]));
    server.use(handler);

    await adapter().generateText({
      system: 'You are a CV parser.',
      cacheSystem: true,
      prompt: 'Convert this CV.',
      maxTokens: 8000,
      files: [{ mimeType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.7') }],
    });

    expect(requests[0]?.body).toMatchObject({
      max_tokens: 8000,
      system: [
        { type: 'text', text: 'You are a CV parser.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: Buffer.from('%PDF-1.7').toString('base64'),
              },
            },
            { type: 'text', text: 'Convert this CV.' },
          ],
        },
      ],
    });
  });

  it('rejects file types Claude cannot read', async () => {
    await expect(
      adapter().generateText({
        prompt: 'x',
        files: [{ mimeType: 'application/zip', data: new Uint8Array() }],
      }),
    ).rejects.toThrow("can't read files of type application/zip");
  });
});

describe('ClaudeAdapter: generateJSON', () => {
  const Fit = z.object({ verdict: z.enum(['good', 'bad']), score: z.number().min(0).max(100) });

  it('requests structured output and returns validated data', async () => {
    const { handler, requests } = messagesHandler(message([text('{"verdict":"good","score":82}')]));
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Rate this job', schema: Fit });

    expect(result.data).toEqual({ verdict: 'good', score: 82 });
    expect(requests[0]?.body).toMatchObject({
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });
  });

  it('retries once with the problems, keeping the conversation', async () => {
    const { handler, requests } = messagesHandler(
      message([text('{"verdict":"great","score":82}')]),
      message([text('{"verdict":"good","score":82}')]),
    );
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Rate this job', schema: Fit });

    expect(result.data.verdict).toBe('good');
    expect(result.usage.inputTokens).toBe(20);
    const retry = requests[1]?.body.messages as { role: string; content: unknown }[];
    expect(retry.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry[1]?.content).toBe('{"verdict":"great","score":82}');
    expect(retry[2]?.content).toContain('verdict:');
  });

  it('wraps non-object schemas in { result } and unwraps the answer', async () => {
    const { handler, requests } = messagesHandler(message([text('{"result":["a","b"]}')]));
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'List', schema: z.array(z.string()) });

    expect(result.data).toEqual(['a', 'b']);
    expect(requests[0]?.body).toMatchObject({
      output_config: { format: { schema: { type: 'object', required: ['result'] } } },
    });
  });

  it('fails clearly when the answer is cut off by max_tokens', async () => {
    server.use(
      messagesHandler(message([text('{"verdict":')], { stop_reason: 'max_tokens' })).handler,
    );
    await expect(
      adapter().generateJSON({ prompt: 'x', schema: Fit, maxTokens: 50 }),
    ).rejects.toThrow('cut off at 50 tokens');
  });
});

describe('ClaudeAdapter: searchJSON', () => {
  const Feeds = z.object({ feeds: z.array(z.object({ name: z.string(), url: z.string() })) });

  const searchResult = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      {
        type: 'web_search_result',
        url: 'https://boards.greenhouse.io/acme',
        title: 'Acme jobs',
        encrypted_content: 'x',
        page_age: null,
      },
    ],
  };
  const citedText = {
    type: 'text',
    text: 'Acme uses Greenhouse: https://boards-api.greenhouse.io/v1/boards/acme/jobs',
    citations: [
      {
        type: 'web_search_result_location',
        url: 'https://boards.greenhouse.io/acme',
        title: 'Acme jobs',
        cited_text: 'Acme',
        encrypted_index: 'x',
      },
      {
        type: 'web_search_result_location',
        url: 'https://acme.com/careers',
        title: null,
        cited_text: 'careers',
        encrypted_index: 'y',
      },
    ],
  };

  it('researches with web search, then structures the notes', async () => {
    const { handler, requests } = messagesHandler(
      message([searchResult, citedText], {
        usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } },
      }),
      message([
        text(
          '{"feeds":[{"name":"Acme","url":"https://boards-api.greenhouse.io/v1/boards/acme/jobs"}]}',
        ),
      ]),
    );
    server.use(handler);

    const result = await adapter().searchJSON({
      prompt: 'Find job feeds',
      schema: Feeds,
      maxSearches: 3,
    });

    expect(result.data.feeds[0]?.name).toBe('Acme');
    expect(result.sources).toEqual([
      { url: 'https://boards.greenhouse.io/acme', title: 'Acme jobs' },
      { url: 'https://acme.com/careers' },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 20, webSearches: 2 });

    expect(requests[0]?.body).toMatchObject({
      tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 3 }],
    });
    expect(requests[0]?.body).not.toHaveProperty('output_config');
    expect(requests[1]?.body).not.toHaveProperty('tools');
    expect(JSON.stringify(requests[1]?.body.messages)).toContain(
      'boards-api.greenhouse.io/v1/boards/acme/jobs',
    );
  });

  it('continues a paused research turn', async () => {
    const { handler, requests } = messagesHandler(
      message([searchResult], { stop_reason: 'pause_turn' }),
      message([citedText]),
      message([text('{"feeds":[]}')]),
    );
    server.use(handler);

    await adapter().searchJSON({ prompt: 'Find job feeds', schema: Feeds });

    expect(requests).toHaveLength(3);
    const continued = requests[1]?.body.messages as { role: string }[];
    expect(continued.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('fails when the research produced nothing', async () => {
    server.use(messagesHandler(message([searchResult])).handler);
    await expect(adapter().searchJSON({ prompt: 'x', schema: Feeds })).rejects.toThrow(
      'without any findings',
    );
  });

  it('maps a disabled web search to WebSearchUnavailableError', async () => {
    server.use(
      messagesHandler(
        apiError(400, 'invalid_request_error', 'Web search is not enabled for your organization.'),
      ).handler,
    );
    await expect(adapter().searchJSON({ prompt: 'x', schema: Feeds })).rejects.toBeInstanceOf(
      WebSearchUnavailableError,
    );
  });
});
