import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const ANTHROPIC = 'https://api.anthropic.com';

/** Fails any request that no handler covers, so tests never reach the real API. */
export function useMockServer() {
  const server = setupServer();
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
  return server;
}

export interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
  url: string;
}

/**
 * Answer POST /v1/messages with the given responses in order (the last one repeats).
 * Returns the captured requests for assertions.
 */
export function messagesHandler(...responses: (JsonBodyType | Response)[]) {
  const requests: CapturedRequest[] = [];
  const handler = http.post(`${ANTHROPIC}/v1/messages`, async ({ request }) => {
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

export function message(
  content: Record<string, unknown>[],
  overrides: { stop_reason?: string; usage?: Record<string, unknown> } = {},
) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...overrides.usage,
    },
  };
}

export const text = (value: string) => ({ type: 'text', text: value, citations: null });

export function apiError(status: number, type: string, errorMessage: string, headers = {}) {
  return HttpResponse.json(
    { type: 'error', error: { type, message: errorMessage } },
    { status, headers },
  );
}

export function model(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-01-01T00:00:00Z',
    lifecycle: 'active',
    line: null,
    deprecated_at: null,
    capabilities: null,
    max_input_tokens: null,
    max_tokens: null,
    ...overrides,
  };
}
