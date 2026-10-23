import type { SearchConfig } from '../config/index.js';
import { WEB_SEARCH_NAMES, type LLMAdapter } from '../llm/index.js';
import { searchWithAi } from './ai.js';
import { searchBrave } from './brave.js';
import type { SearchResult } from './common.js';
import { searchDuckDuckGo } from './duckduckgo.js';
import { searchSerpApi } from './serpapi.js';

/** A web search backend, with the pace it allows. */
export interface SearchEngine {
  /** For messages: `SerpApi`. */
  readonly name: string;
  /** Wait this long between two searches. */
  readonly pauseMs: number;
  search(query: string): Promise<SearchResult[]>;
}

/** DuckDuckGo's bot check answers when searches come closer together than this. */
export const DUCKDUCKGO_PAUSE_MS = 45_000;
/** Brave's limit is per second and generous; a short pause keeps a run well under any plan's. */
export const BRAVE_PAUSE_MS = 1_100;

/**
 * The engine `config.search` picks; DuckDuckGo when it's missing. `llm` is only called for
 * `ai`, so other engines don't load an AI SDK.
 */
export function createSearchEngine(
  config: SearchConfig | undefined,
  llm: () => LLMAdapter,
): SearchEngine {
  switch (config?.provider) {
    case 'ai': {
      const adapter = llm();
      return {
        name: WEB_SEARCH_NAMES[adapter.provider] ?? `${adapter.providerName}'s web search`,
        pauseMs: 0,
        search: (query) => searchWithAi(query, adapter),
      };
    }
    case 'serpapi': {
      const { apiKey } = config;
      return { name: 'SerpApi', pauseMs: 0, search: (query) => searchSerpApi(query, apiKey) };
    }
    case 'brave': {
      const { apiKey } = config;
      return {
        name: 'Brave Search',
        pauseMs: BRAVE_PAUSE_MS,
        search: (query) => searchBrave(query, apiKey),
      };
    }
    case 'duckduckgo':
    case undefined:
      return { name: 'DuckDuckGo', pauseMs: DUCKDUCKGO_PAUSE_MS, search: searchDuckDuckGo };
  }
}
