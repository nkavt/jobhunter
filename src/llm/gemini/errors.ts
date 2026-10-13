import { ApiError } from '@google/genai';
import {
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  NetworkError,
  RateLimitError,
  WebSearchUnavailableError,
} from '../errors.js';

export interface ErrorContext {
  /** The model the failed request used, if any. */
  model?: string;
  /** The request had Google Search enabled. */
  webSearch?: boolean;
}

interface GoogleErrorBody {
  message: string;
  /** e.g. `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`. */
  status?: string;
  details?: { '@type'?: string; retryDelay?: string; reason?: string }[];
}

/** Translate a Google GenAI SDK error into one of our provider-agnostic errors. */
export function mapGeminiError(error: unknown, context: ErrorContext = {}): Error {
  if (error instanceof LLMError) return error;
  const options = { cause: error };

  if (!(error instanceof ApiError)) {
    // The SDK lets fetch failures and timeouts through as plain errors.
    if (
      error instanceof Error &&
      (['AbortError', 'TimeoutError'].includes(error.name) ||
        (error instanceof TypeError && /fetch/i.test(error.message)))
    ) {
      return new NetworkError(`Couldn't reach Google: ${error.message}`, 'gemini', options);
    }
    return toError(error);
  }

  const body = parseBody(error);
  const message = body.message;
  const reasons = (body.details ?? []).map((detail) => detail.reason ?? '');

  // Google answers a bad key with 400 INVALID_ARGUMENT "API key not valid", not 401.
  if (
    error.status === 401 ||
    reasons.includes('API_KEY_INVALID') ||
    (error.status === 400 && /api key/i.test(message))
  ) {
    return new InvalidKeyError(
      'Your Google API key is invalid or has been revoked.',
      'gemini',
      options,
    );
  }
  if (error.status === 429) {
    return new RateLimitError(
      'Gemini rate limit or quota reached. Try again in a moment, or check your quota in Google AI Studio.',
      'gemini',
      retryDelayMs(body),
      options,
    );
  }
  if (error.status >= 500) {
    return new NetworkError(
      `Google is having problems (${String(error.status)}). Try again in a moment.`,
      'gemini',
      options,
    );
  }
  if (context.webSearch === true && /search|grounding/i.test(message)) {
    return new WebSearchUnavailableError(
      `Google Search isn't available for this Gemini key or model: ${message}`,
      'gemini',
      options,
    );
  }
  if (/billing|credit|prepay/i.test(message)) {
    return new InsufficientCreditError(
      `Your Gemini API account can't pay for this request: ${message}`,
      'gemini',
      options,
    );
  }
  if (context.model !== undefined && (error.status === 404 || error.status === 403)) {
    return new ModelUnavailableError(
      `The model "${context.model}" isn't available for this API key.`,
      'gemini',
      context.model,
      options,
    );
  }
  return new LLMError(`Google API error: ${message}`, 'gemini', options);
}

/** The SDK puts the response body, JSON-encoded, in the error message. */
function parseBody(error: ApiError): GoogleErrorBody {
  try {
    const parsed = JSON.parse(error.message) as { error?: Partial<GoogleErrorBody> };
    const inner = parsed.error;
    if (inner && typeof inner.message === 'string') return inner as GoogleErrorBody;
  } catch {
    // Not JSON; use the message as is.
  }
  return { message: error.message };
}

/** `RetryInfo.retryDelay` looks like `"31s"`. */
function retryDelayMs(body: GoogleErrorBody): number | undefined {
  const delay = body.details?.find((detail) => detail.retryDelay)?.retryDelay;
  const seconds = Number(delay?.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
