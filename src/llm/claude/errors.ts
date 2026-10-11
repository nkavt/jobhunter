import Anthropic from '@anthropic-ai/sdk';
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
  /** The request had web search enabled. */
  webSearch?: boolean;
}

/** Translate an Anthropic SDK error into one of our provider-agnostic errors. */
export function mapClaudeError(error: unknown, context: ErrorContext = {}): Error {
  if (error instanceof LLMError) return error;
  if (!(error instanceof Anthropic.APIError)) return toError(error);

  const message = apiMessage(error);
  const options = { cause: error };
  const mentionsWebSearch = context.webSearch === true && /web[\s_-]?search/i.test(message);

  if (error instanceof Anthropic.APIConnectionError) {
    return new NetworkError(`Couldn't reach Anthropic: ${message}`, 'claude', options);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new InvalidKeyError(
      'Your Anthropic API key is invalid or has been revoked.',
      'claude',
      options,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(error.headers.get('retry-after'));
    return new RateLimitError(
      'Anthropic rate limit reached. Try again in a moment.',
      'claude',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      options,
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new NetworkError(
      `Anthropic is having problems (${String(error.status)}). Try again in a moment.`,
      'claude',
      options,
    );
  }
  if (mentionsWebSearch) {
    return new WebSearchUnavailableError(
      `Web search isn't available for this Anthropic account: ${message}`,
      'claude',
      options,
    );
  }
  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(message)) {
    return new InsufficientCreditError(
      'Your Anthropic credit balance is too low. Add credits in the Anthropic Console under Billing.',
      'claude',
      options,
    );
  }
  if (
    context.model !== undefined &&
    (error instanceof Anthropic.NotFoundError || error instanceof Anthropic.PermissionDeniedError)
  ) {
    return new ModelUnavailableError(
      `The model "${context.model}" isn't available for this API key.`,
      'claude',
      context.model,
      options,
    );
  }
  return new LLMError(`Anthropic API error: ${message}`, 'claude', options);
}

/** The human-readable message from Anthropic's error body, falling back to the SDK message. */
function apiMessage(error: { message: string; error?: unknown }): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : error.message;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
