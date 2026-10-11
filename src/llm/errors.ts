import type { Provider } from '../config/config.js';

/** Base class for provider failures; commands react to the concrete subclasses. */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: Provider,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API key is wrong, revoked, or expired. */
export class InvalidKeyError extends LLMError {}

/** Couldn't reach the provider, or it returned a server error. Usually worth retrying. */
export class NetworkError extends LLMError {}

/** The account has no credit / its plan doesn't allow the request. */
export class InsufficientCreditError extends LLMError {}

/** The requested model doesn't exist or isn't enabled for this key. */
export class ModelUnavailableError extends LLMError {
  constructor(
    message: string,
    provider: Provider,
    readonly model: string,
    options?: ErrorOptions,
  ) {
    super(message, provider, options);
  }
}

export class RateLimitError extends LLMError {
  constructor(
    message: string,
    provider: Provider,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, provider, options);
  }
}

/** Web search is turned off for this account/organisation. */
export class WebSearchUnavailableError extends LLMError {}

/** The model's structured output still didn't match the schema after a retry. */
export class InvalidResponseError extends LLMError {
  constructor(
    message: string,
    provider: Provider,
    readonly issues: string[],
    options?: ErrorOptions,
  ) {
    super(message, provider, options);
  }
}
