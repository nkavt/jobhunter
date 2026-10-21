import { describe, expect, it } from 'vitest';
import { defaultParallelCalls } from '../../src/llm/index.js';

describe('defaultParallelCalls', () => {
  it('makes one call at a time to a model on a local server', () => {
    expect(defaultParallelCalls({ provider: 'openai', baseURL: 'http://localhost:11434/v1' })).toBe(
      1,
    );
    expect(defaultParallelCalls({ provider: 'openai', baseURL: 'http://192.168.1.20/v1' })).toBe(1);
  });

  it('makes a few at once to a cloud API', () => {
    expect(defaultParallelCalls({ provider: 'claude' })).toBe(4);
    expect(defaultParallelCalls({ provider: 'gemini' })).toBe(4);
    expect(
      defaultParallelCalls({ provider: 'openai', baseURL: 'https://openrouter.ai/api/v1' }),
    ).toBe(4);
  });
});
