import { describe, expect, it } from 'vitest';
import {
  InvalidKeyError,
  LLMError,
  ModelUnavailableError,
  RateLimitError,
} from '../../src/llm/index.js';

describe('LLM errors', () => {
  it('share a base class and carry the provider', () => {
    const error = new InvalidKeyError('bad key', 'claude');
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toBeInstanceOf(Error);
    expect(error.provider).toBe('claude');
  });

  it('name themselves after the concrete class', () => {
    expect(new InvalidKeyError('x', 'claude').name).toBe('InvalidKeyError');
    expect(new RateLimitError('x', 'claude', 1000).name).toBe('RateLimitError');
  });

  it('expose extra details where they matter', () => {
    expect(new ModelUnavailableError('x', 'claude', 'claude-old').model).toBe('claude-old');
    expect(new RateLimitError('x', 'claude', 1500).retryAfterMs).toBe(1500);
  });
});
