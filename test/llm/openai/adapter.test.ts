import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createAdapter,
  getAdapterName,
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  NetworkError,
  RateLimitError,
  WebSearchUnavailableError,
  type LLMAdapter,
} from '../../../src/llm/index.js';
import { OpenAIAdapter } from '../../../src/llm/openai/adapter.js';
import {
  apiError,
  chatHandler,
  completion,
  modelsHandler,
  useMockServer,
} from '../../helpers/openai-mock.js';

const BASE = 'https://llm.example.com/v1';
const server = useMockServer();
const adapter = (overrides = {}) =>
  new OpenAIAdapter({
    apiKey: 'sk-test',
    baseURL: BASE,
    model: 'test-model',
    maxRetries: 0,
    ...overrides,
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenAIAdapter: setup and auth', () => {
  it('uses the key and base URL from config and ignores OPENAI_* environment variables', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-env');
    vi.stubEnv('OPENAI_BASE_URL', 'https://evil.example.com/v1');
    vi.stubEnv('OPENAI_ORG_ID', 'org-env');
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-env');
    const { handler, requests } = chatHandler(BASE, completion('Hi'));
    server.use(handler);

    await adapter().checkModelAccess();

    expect(requests[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(requests[0]?.headers.get('openai-organization')).toBeNull();
    expect(requests[0]?.headers.get('openai-project')).toBeNull();
  });

  it('is named after the host it talks to', () => {
    expect(getAdapterName(adapter())).toBe('test-model (llm.example.com)');
  });

  it('is what createAdapter loads for the openai provider, on the first call', async () => {
    const { handler, requests } = chatHandler(BASE, completion('Hi'));
    server.use(handler);

    const created = createAdapter({ provider: 'openai', apiKey: 'k', model: 'm', baseURL: BASE });
    expect(created.model).toBe('m');
    expect(created.providerName).toBe('llm.example.com');
    await created.generateText({ prompt: 'Hi' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer k');
  });

  it('needs a base URL', async () => {
    const created = createAdapter({ provider: 'openai', apiKey: 'k', model: 'm' });
    await expect(created.generateText({ prompt: 'Hi' })).rejects.toThrow('needs a base URL');
  });
});

describe('OpenAIAdapter: models and key test', () => {
  it('lists models newest first', async () => {
    server.use(
      modelsHandler(BASE, [
        { id: 'old', object: 'model', created: 1_700_000_000, owned_by: 'x' },
        { id: 'new', object: 'model', created: 1_780_000_000, owned_by: 'x' },
        { id: 'undated', object: 'model', owned_by: 'x' },
      ]),
    );
    const models = await adapter().listModels();
    expect(models.map((m) => m.id)).toEqual(['new', 'old', 'undated']);
    expect(models[0]).toEqual({
      id: 'new',
      displayName: 'new',
      createdAt: new Date(1_780_000_000_000).toISOString(),
    });
  });

  it('maps a rejected key to InvalidKeyError', async () => {
    server.use(http.get(`${BASE}/models`, () => apiError(401, 'Incorrect API key provided')));
    await expect(adapter().validateKey()).rejects.toThrow(InvalidKeyError);
    await expect(adapter().validateKey()).rejects.toThrow(
      'Your llm.example.com API key is invalid',
    );
  });

  it('maps connection failures to NetworkError', async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()));
    await expect(adapter().listModels()).rejects.toThrow(NetworkError);
  });
});

describe('OpenAIAdapter: model access check', () => {
  it('sends a tiny request to the chosen model', async () => {
    const { handler, requests } = chatHandler(BASE, completion('Hi'));
    server.use(handler);
    await adapter().checkModelAccess('other-model');
    expect(requests[0]?.body).toMatchObject({ model: 'other-model', max_tokens: 16 });
  });

  it('maps an unknown model to ModelUnavailableError', async () => {
    server.use(chatHandler(BASE, apiError(404, 'The model `nope` does not exist')).handler);
    const error = await adapter()
      .checkModelAccess('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect((error as ModelUnavailableError).model).toBe('nope');
  });

  it('tells an empty balance apart from a rate limit', async () => {
    server.use(
      chatHandler(BASE, apiError(429, 'You exceeded your current quota', 'insufficient_quota'))
        .handler,
    );
    await expect(adapter().checkModelAccess()).rejects.toThrow(InsufficientCreditError);
  });

  it('keeps retry-after on rate limits', async () => {
    server.use(
      chatHandler(
        BASE,
        HttpResponse.json(
          { error: { message: 'Slow down', type: 'rate_limit', code: null } },
          { status: 429, headers: { 'retry-after': '7' } },
        ),
      ).handler,
    );
    const error = await adapter()
      .checkModelAccess()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(7000);
  });
});

describe('OpenAIAdapter: generateText', () => {
  it('sends system and user messages and reports usage, splitting out cached tokens', async () => {
    const { handler, requests } = chatHandler(
      BASE,
      completion('Hello', {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      }),
    );
    server.use(handler);

    const result = await adapter().generateText({
      system: 'Be brief',
      prompt: 'Say hi',
      maxTokens: 50,
      cacheSystem: true,
    });

    expect(result).toEqual({
      text: 'Hello',
      usage: {
        inputTokens: 40,
        outputTokens: 7,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        webSearches: 0,
      },
    });
    expect(requests[0]?.body).toEqual({
      model: 'test-model',
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Say hi' },
      ],
    });
  });

  it('attaches PDFs as files and images as data URLs', async () => {
    const { handler, requests } = chatHandler(BASE, completion('# CV'));
    server.use(handler);

    await adapter().generateText({
      prompt: 'Convert',
      files: [
        { mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]), name: 'cv.pdf' },
        { mimeType: 'image/png', data: new Uint8Array([4]) },
      ],
    });

    const [user] = requests[0]?.body.messages as { content: unknown[] }[];
    expect(user?.content).toEqual([
      { type: 'file', file: { filename: 'cv.pdf', file_data: 'data:application/pdf;base64,AQID' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BA==' } },
      { type: 'text', text: 'Convert' },
    ]);
  });

  it('rejects file types it cannot send', async () => {
    await expect(
      adapter().generateText({
        prompt: 'x',
        files: [{ mimeType: 'application/zip', data: new Uint8Array() }],
      }),
    ).rejects.toThrow("can't read files of type application/zip");
  });

  it('fails clearly when the answer is cut off', async () => {
    server.use(chatHandler(BASE, completion('Hel', { finish_reason: 'length' })).handler);
    await expect(adapter().generateText({ prompt: 'x', maxTokens: 3 })).rejects.toThrow(
      'cut off at 3 tokens',
    );
  });
});

describe('OpenAIAdapter: generateJSON', () => {
  const schema = z.object({ score: z.number().int().max(100) });

  it('requests a JSON schema response and returns validated data', async () => {
    const { handler, requests } = chatHandler(BASE, completion('{"score": 80}'));
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Score', schema, schemaName: 'fit' });

    expect(result.data).toEqual({ score: 80 });
    expect(requests[0]?.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'fit', schema: { type: 'object' } },
    });
  });

  it('accepts JSON wrapped in a code fence', async () => {
    server.use(chatHandler(BASE, completion('```json\n{"score": 5}\n```')).handler);
    expect((await adapter().generateJSON({ prompt: 'x', schema })).data).toEqual({ score: 5 });
  });

  it('retries once with the problems, keeping the conversation', async () => {
    const { handler, requests } = chatHandler(
      BASE,
      completion('{"score": 500}'),
      completion('{"score": 50}'),
    );
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Score', schema });

    expect(result.data).toEqual({ score: 50 });
    expect(result.usage.inputTokens).toBe(20);
    const messages = requests[1]?.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]?.content).toContain('score');
  });

  it('wraps non-object schemas in { result } and unwraps the answer', async () => {
    server.use(chatHandler(BASE, completion('{"result": ["a", "b"]}')).handler);
    const result = await adapter().generateJSON({ prompt: 'x', schema: z.array(z.string()) });
    expect(result.data).toEqual(['a', 'b']);
  });

  it('gives up with InvalidResponseError-style LLMError after two bad answers', async () => {
    server.use(chatHandler(BASE, completion('not json')).handler);
    await expect(adapter().generateJSON({ prompt: 'x', schema })).rejects.toThrow(LLMError);
  });
});

describe('OpenAIAdapter: searchJSON', () => {
  it('reports that web search is not available', async () => {
    const llm: LLMAdapter = adapter();
    await expect(llm.searchJSON({ prompt: 'x', schema: z.object({}) })).rejects.toThrow(
      WebSearchUnavailableError,
    );
  });
});
