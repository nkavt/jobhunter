import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, getAdapterName, getConfiguredAdapterName } from '../../src/llm/index.js';

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
