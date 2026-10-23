import { http, HttpResponse, type JsonBodyType } from 'msw';
import type { CapturedRequest } from './anthropic-mock.js';

export { useMockServer, type CapturedRequest } from './anthropic-mock.js';

/**
 * Answer POST {baseURL}/chat/completions with the given responses in order (the last one
 * repeats). Returns the captured requests for assertions.
 */
export function chatHandler(baseURL: string, ...responses: (JsonBodyType | Response)[]) {
  const requests: CapturedRequest[] = [];
  const handler = http.post(
    `${baseURL.replace(/\/$/, '')}/chat/completions`,
    async ({ request }) => {
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        headers: request.headers,
        url: request.url,
      });
      const response = responses[Math.min(requests.length - 1, responses.length - 1)];
      return response instanceof Response ? response : HttpResponse.json(response);
    },
  );
  return { handler, requests };
}

export function completion(
  content: string | null,
  overrides: { finish_reason?: string; refusal?: string; usage?: Record<string, unknown> } = {},
) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_780_000_000,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: overrides.refusal ?? null },
        finish_reason: overrides.finish_reason ?? 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...overrides.usage },
  };
}

/** OpenAI's error body. */
export function apiError(status: number, errorMessage: string, code: string | null = null) {
  return HttpResponse.json(
    { error: { message: errorMessage, type: 'invalid_request_error', code, param: null } },
    { status },
  );
}

export function modelsHandler(baseURL: string, models: Record<string, unknown>[]) {
  return http.get(`${baseURL.replace(/\/$/, '')}/models`, () =>
    HttpResponse.json({ object: 'list', data: models }),
  );
}
