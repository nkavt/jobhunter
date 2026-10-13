import OpenAI from 'openai';
import type { Provider } from '../../config/config.js';
import {
  InsufficientCreditError,
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  NetworkError,
  RateLimitError,
} from '../errors.js';

export interface ErrorContext {
  provider: Provider;
  /** Who the user pays for the API, for messages: `Google`, `openrouter.ai`. */
  providerName: string;
  /** The model the failed request used, if any. */
  model?: string;
}

/** Translate an OpenAI SDK error into one of our provider-agnostic errors. */
export function mapOpenAIError(error: unknown, context: ErrorContext): Error {
  if (error instanceof LLMError) return error;
  if (!(error instanceof OpenAI.APIError)) return toError(error);

  const { provider, providerName: name } = context;
  const message = apiMessage(error);
  const options = { cause: error };

  if (error instanceof OpenAI.APIConnectionError) {
    return new NetworkError(`Couldn't reach ${name}: ${message}`, provider, options);
  }
  // Gemini answers a bad key with 400 "API key not valid" rather than 401.
  if (
    error instanceof OpenAI.AuthenticationError ||
    (error instanceof OpenAI.BadRequestError && /api[\s_-]?key/i.test(message))
  ) {
    return new InvalidKeyError(
      `Your ${name} API key is invalid or has been revoked.`,
      provider,
      options,
    );
  }
  // OpenAI-style APIs report an empty balance as 429 `insufficient_quota`, not a rate limit.
  if (error.code === 'insufficient_quota' || error.status === 402) {
    return new InsufficientCreditError(
      `Your ${name} account has no credit or quota left for this request. Check its billing settings.`,
      provider,
      options,
    );
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfter = Number(error.headers.get('retry-after'));
    return new RateLimitError(
      `${name} rate limit reached. Try again in a moment.`,
      provider,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      options,
    );
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new NetworkError(
      `${name} is having problems (${String(error.status)}). Try again in a moment.`,
      provider,
      options,
    );
  }
  if (
    context.model !== undefined &&
    (error instanceof OpenAI.NotFoundError || error instanceof OpenAI.PermissionDeniedError)
  ) {
    return new ModelUnavailableError(
      `The model "${context.model}" isn't available for this API key.`,
      provider,
      context.model,
      options,
    );
  }
  return new LLMError(`${name} API error: ${message}`, provider, options);
}

/**
 * The human-readable message from the error body. OpenAI puts it at `error.message`;
 * Gemini sends a list with the message one level down.
 */
function apiMessage(error: { message: string; error?: unknown }): string {
  const body: unknown = Array.isArray(error.error) ? error.error[0] : error.error;
  if (typeof body === 'object' && body !== null) {
    const nested = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof nested === 'string') return nested;
    const direct = (body as { message?: unknown }).message;
    if (typeof direct === 'string') return direct;
  }
  return error.message;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
