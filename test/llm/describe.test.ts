import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/llm/claude/adapter.js';
import { getAdapterName, getConfiguredAdapterName, getProviderName } from '../../src/llm/index.js';

describe('adapter names for messages', () => {
  it('names the model and the provider', () => {
    const claude = new ClaudeAdapter({ apiKey: 'k', model: 'claude-opus-5-5' });
    expect(claude.providerName).toBe('Anthropic');
    expect(getAdapterName(claude)).toBe('claude-opus-5-5 (Anthropic)');
  });

  it('works from config.json values', () => {
    expect(getConfiguredAdapterName({ provider: 'claude', model: 'claude-haiku-5-5' })).toBe(
      'claude-haiku-5-5 (Anthropic)',
    );
  });
});

describe('provider names', () => {
  it('names Google for Gemini and the host for an OpenAI-compatible API', () => {
    expect(getConfiguredAdapterName({ provider: 'gemini', model: 'gemini-3.8-flash' })).toBe(
      'gemini-3.8-flash (Google)',
    );
    expect(
      getConfiguredAdapterName({
        provider: 'openai',
        model: 'llama-4',
        baseURL: 'http://localhost:11434/v1',
      }),
    ).toBe('llama-4 (localhost:11434)');
    expect(getProviderName('openai')).toBe('OpenAI-compatible API');
  });
});
