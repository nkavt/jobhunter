import { describe, expect, it } from 'vitest';
import { BRAVE_PAUSE_MS, createSearchEngine, DUCKDUCKGO_PAUSE_MS } from '../../src/search/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';

describe('createSearchEngine', () => {
  const noAi = () => {
    throw new Error('the AI should not be loaded');
  };

  it('uses DuckDuckGo, slowly, when nothing is chosen', () => {
    for (const config of [undefined, { provider: 'duckduckgo' as const }]) {
      const engine = createSearchEngine(config, noAi);
      expect(engine.name).toBe('DuckDuckGo');
      expect(engine.pauseMs).toBe(DUCKDUCKGO_PAUSE_MS);
    }
  });

  it('paces each API the way it allows', () => {
    const serp = createSearchEngine({ provider: 'serpapi', apiKey: 'k' }, noAi);
    expect([serp.name, serp.pauseMs]).toEqual(['SerpApi', 0]);
    const brave = createSearchEngine({ provider: 'brave', apiKey: 'k' }, noAi);
    expect([brave.name, brave.pauseMs]).toEqual(['Brave Search', BRAVE_PAUSE_MS]);
  });

  it("names the AI provider's own web search", () => {
    const engine = createSearchEngine({ provider: 'ai' }, () => new FakeLLM());
    expect(engine.name).toBe("Claude's web search");
    expect(engine.pauseMs).toBe(0);
  });
});
