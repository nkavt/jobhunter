import { http, HttpResponse, type JsonBodyType } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createAdapter,
  DEFAULT_GEMINI_MODEL,
  GEMINI_BASE_URL,
  GeminiAdapter,
  getAdapterName,
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  NetworkError,
  RateLimitError,
} from '../../../src/llm/index.js';
import { useMockServer, type CapturedRequest } from '../../helpers/anthropic-mock.js';

const API = `${GEMINI_BASE_URL}/v1beta`;
const server = useMockServer();
const adapter = (overrides = {}) =>
  new GeminiAdapter({ apiKey: 'AIza-test', model: 'gemini-test', maxRetries: 0, ...overrides });

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Answer generateContent for any model with the given responses in order (the last repeats). */
function generateHandler(...responses: (JsonBodyType | Response)[]) {
  const requests: CapturedRequest[] = [];
  const handler = http.post(`${API}/models/:call`, async ({ request }) => {
    requests.push({
      body: (await request.json()) as Record<string, unknown>,
      headers: request.headers,
      url: request.url,
    });
    const response = responses[Math.min(requests.length - 1, responses.length - 1)];
    return response instanceof Response ? response : HttpResponse.json(response);
  });
  return { handler, requests };
}

function reply(
  text: string,
  overrides: {
    finishReason?: string;
    usage?: Record<string, unknown>;
    grounding?: Record<string, unknown>;
  } = {},
) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: overrides.finishReason ?? 'STOP',
        ...(overrides.grounding ? { groundingMetadata: overrides.grounding } : {}),
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, ...overrides.usage },
  };
}

function googleError(status: number, code: string, message: string, details: unknown[] = []) {
  return HttpResponse.json({ error: { code: status, message, status: code, details } }, { status });
}

describe('GeminiAdapter: setup and auth', () => {
  it('uses the key from config and ignores GEMINI_* / GOOGLE_* environment variables', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'from-env');
    vi.stubEnv('GOOGLE_API_KEY', 'from-env');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://evil.example.com');
    const { handler, requests } = generateHandler(reply('Hi'));
    server.use(handler);

    await adapter().checkModelAccess();

    expect(requests[0]?.url).toBe(`${API}/models/gemini-test:generateContent`);
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('AIza-test');
  });

  it('defaults to the default Gemini model and is named after Google', () => {
    const gemini = new GeminiAdapter({ apiKey: 'k' });
    expect(gemini.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(getAdapterName(gemini)).toBe(`${DEFAULT_GEMINI_MODEL} (Google)`);
  });

  it('is what createAdapter builds for the gemini provider', () => {
    const created = createAdapter({ provider: 'gemini', apiKey: 'k', model: 'gemini-x' });
    expect(created).toBeInstanceOf(GeminiAdapter);
    expect(created.model).toBe('gemini-x');
  });
});

describe('GeminiAdapter: models and key test', () => {
  it('lists only chat models, newest version first, without the models/ prefix', async () => {
    const chat = ['generateContent', 'countTokens'];
    server.use(
      http.get(`${API}/models`, () =>
        HttpResponse.json({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: chat,
            },
            {
              name: 'models/gemini-3.8-flash-lite',
              displayName: 'Gemini 3.8 Flash-Lite',
              supportedGenerationMethods: chat,
            },
            {
              name: 'models/gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              supportedGenerationMethods: chat,
            },
            { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: chat },
            { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
            { name: 'models/gemma-3-27b-it', supportedGenerationMethods: chat },
          ],
        }),
      ),
    );

    expect(await adapter().listModels()).toEqual([
      { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', family: 'flash' },
      { id: 'gemini-3.8-flash-lite', displayName: 'Gemini 3.8 Flash-Lite', family: 'flash-lite' },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', family: 'pro' },
    ]);
  });

  it('follows pagination', async () => {
    server.use(
      http.get(`${API}/models`, ({ request }) =>
        new URL(request.url).searchParams.get('pageToken') === 'next'
          ? HttpResponse.json({ models: [{ name: 'models/gemini-2.0-flash' }] })
          : HttpResponse.json({
              models: [{ name: 'models/gemini-3.0-pro' }],
              nextPageToken: 'next',
            }),
      ),
    );
    expect((await adapter().listModels()).map((m) => m.id)).toEqual([
      'gemini-3.0-pro',
      'gemini-2.0-flash',
    ]);
  });

  it('maps Google\'s 400 "API key not valid" to InvalidKeyError', async () => {
    server.use(
      http.get(`${API}/models`, () =>
        googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ]),
      ),
    );
    await expect(adapter().validateKey()).rejects.toThrow(InvalidKeyError);
    await expect(adapter().validateKey()).rejects.toThrow('Your Google API key is invalid');
  });

  it('maps connection failures to NetworkError', async () => {
    server.use(http.get(`${API}/models`, () => HttpResponse.error()));
    await expect(adapter().listModels()).rejects.toThrow(NetworkError);
  });
});

describe('GeminiAdapter: model access check', () => {
  it('maps an unknown model to ModelUnavailableError', async () => {
    server.use(generateHandler(googleError(404, 'NOT_FOUND', 'models/nope is not found')).handler);
    const error = await adapter()
      .checkModelAccess('nope')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect((error as ModelUnavailableError).model).toBe('nope');
  });

  it('keeps the retry delay on quota errors', async () => {
    server.use(
      generateHandler(
        googleError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota', [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' },
        ]),
      ).handler,
    );
    const error = await adapter()
      .checkModelAccess()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(31_000);
  });

  it('maps billing problems to InsufficientCreditError', async () => {
    server.use(
      generateHandler(
        googleError(400, 'FAILED_PRECONDITION', 'Your prepayment credits are depleted.'),
      ).handler,
    );
    await expect(adapter().checkModelAccess()).rejects.toThrow(InsufficientCreditError);
  });
});

describe('GeminiAdapter: generateText', () => {
  it('sends the system prompt and reports usage, counting thinking as output', async () => {
    const { handler, requests } = generateHandler(
      reply('Hello', {
        usage: {
          promptTokenCount: 100,
          cachedContentTokenCount: 60,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 30,
        },
      }),
    );
    server.use(handler);

    const result = await adapter().generateText({
      system: 'Be brief',
      prompt: 'Say hi',
      maxTokens: 50,
    });

    expect(result).toEqual({
      text: 'Hello',
      usage: {
        inputTokens: 40,
        outputTokens: 37,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        webSearches: 0,
      },
    });
    expect(requests[0]?.body).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
      systemInstruction: { parts: [{ text: 'Be brief' }] },
      generationConfig: { maxOutputTokens: 50 + 16_384 },
    });
  });

  it('attaches PDFs inline', async () => {
    const { handler, requests } = generateHandler(reply('# CV'));
    server.use(handler);

    await adapter().generateText({
      prompt: 'Convert',
      files: [{ mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]), name: 'cv.pdf' }],
    });

    expect(requests[0]?.body.contents).toEqual([
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'application/pdf', data: 'AQID' } }, { text: 'Convert' }],
      },
    ]);
  });

  it('rejects file types Gemini cannot read', async () => {
    await expect(
      adapter().generateText({
        prompt: 'x',
        files: [{ mimeType: 'application/zip', data: new Uint8Array() }],
      }),
    ).rejects.toThrow("Gemini can't read files of type application/zip");
  });

  it('fails clearly when the answer is cut off or blocked', async () => {
    server.use(generateHandler(reply('Hel', { finishReason: 'MAX_TOKENS' })).handler);
    await expect(adapter().generateText({ prompt: 'x', maxTokens: 3 })).rejects.toThrow(
      'cut off at 3 tokens',
    );
    server.use(generateHandler(reply('', { finishReason: 'SAFETY' })).handler);
    await expect(adapter().generateText({ prompt: 'x' })).rejects.toThrow('(SAFETY)');
  });
});

describe('GeminiAdapter: generateJSON', () => {
  const schema = z.object({ score: z.number().int().max(100) });

  it('requests JSON with a schema and returns validated data', async () => {
    const { handler, requests } = generateHandler(reply('{"score": 80}'));
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Score', schema });

    expect(result.data).toEqual({ score: 80 });
    expect(requests[0]?.body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
  });

  it('retries once with the problems, keeping the conversation', async () => {
    const { handler, requests } = generateHandler(reply('{"score": 500}'), reply('{"score": 50}'));
    server.use(handler);

    const result = await adapter().generateJSON({ prompt: 'Score', schema });

    expect(result.data).toEqual({ score: 50 });
    const contents = requests[1]?.body.contents as { role: string }[];
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('wraps non-object schemas in { result } and unwraps the answer', async () => {
    server.use(generateHandler(reply('{"result": ["a", "b"]}')).handler);
    const result = await adapter().generateJSON({ prompt: 'x', schema: z.array(z.string()) });
    expect(result.data).toEqual(['a', 'b']);
  });

  it('gives up after two bad answers', async () => {
    server.use(generateHandler(reply('not json')).handler);
    await expect(adapter().generateJSON({ prompt: 'x', schema })).rejects.toThrow(LLMError);
  });
});

describe('GeminiAdapter: searchJSON', () => {
  it('researches with Google Search, then structures the notes', async () => {
    const { handler, requests } = generateHandler(
      reply('Acme is hiring a Node developer.', {
        grounding: {
          webSearchQueries: ['acme jobs', 'acme node'],
          groundingChunks: [
            { web: { uri: 'https://acme.example/jobs', title: 'Acme jobs' } },
            { web: { uri: 'https://acme.example/jobs', title: 'Acme jobs' } },
            { web: { uri: 'https://board.example/acme' } },
          ],
        },
      }),
      reply('{"companies": ["Acme"]}'),
    );
    server.use(handler);

    const result = await adapter().searchJSON({
      prompt: 'Find companies',
      schema: z.object({ companies: z.array(z.string()) }),
    });

    expect(result.data).toEqual({ companies: ['Acme'] });
    expect(result.sources).toEqual([
      { url: 'https://acme.example/jobs', title: 'Acme jobs' },
      { url: 'https://board.example/acme' },
    ]);
    expect(result.usage.webSearches).toBe(2);
    expect(requests[0]?.body.tools).toEqual([{ googleSearch: {} }]);
    expect(JSON.stringify(requests[1]?.body.contents)).toContain('Acme is hiring');
  });
});
