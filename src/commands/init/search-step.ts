import {
  readProfile,
  saveConfig,
  type Config,
  type SearchConfig,
  type SearchProvider,
} from '../../config/index.js';
import {
  PROVIDER_NAMES,
  WEB_SEARCH_NAMES,
  type Connection,
  type LLMAdapter,
} from '../../llm/index.js';
import { createSearchEngine, type SearchEngine } from '../../search/index.js';
import {
  ATS,
  boardQueries,
  findCompanyBoards,
  loadBoardState,
  type Ats,
} from '../../sources/index.js';
import { dim, type Choice, type Ui } from '../../ui/index.js';

export interface SearchStepDeps {
  ui: Ui;
  connect: (connection: Connection, model?: string) => LLMAdapter;
  /** Builds the engine to check; tests replace it with a fake. */
  engineFor?: (search: SearchConfig, config: Config) => SearchEngine;
  ats?: Ats[];
  now?: () => Date;
}

type Choose = SearchProvider | 'skip';

const KEY_NAMES = { serpapi: 'SerpApi', brave: 'Brave Search' } as const;
const KEY_HELP = {
  serpapi: 'Your key is at https://serpapi.com/manage-api-key',
  brave: 'Create a key at https://api-dashboard.search.brave.com',
} as const;

/**
 * Pick how `companies find` searches the web, check it with one real search, and save it.
 * That first search's boards are kept, so the first hunt already has some.
 */
export async function setupSearch(deps: SearchStepDeps, config: Config): Promise<Config> {
  const { ui } = deps;
  const profile = await readProfile(config.activeProfile);
  if (!profile?.derived && !profile?.boardSearch) {
    ui.info(
      'Company search looks for your roles, which come from your CV. Run `jobhunter init` again once your CV is imported.',
    );
    return config;
  }
  ui.info('');
  ui.info(
    "Many companies post jobs only on their own careers page, hosted by Greenhouse, Lever, Ashby or Workable. Jobhunter finds those pages by searching the web for your roles (`jobhunter companies find`), and `hunt` reads them from then on. That search is what you're choosing here.",
  );

  let provider = await chooseProvider(ui, config);
  for (;;) {
    if (provider === 'skip') {
      ui.info('Skipped. Run `jobhunter init` again to choose how to search for companies.');
      return config;
    }
    const search = await searchConfig(ui, provider, config.search);
    const outcome = await check(deps, config, search);
    if (outcome === 'ok') {
      const updated: Config = { ...config, search };
      await saveConfig(updated);
      ui.info(dim('Next: `jobhunter companies find` runs the rest of the searches.'));
      return updated;
    }
    if (outcome === 'other') provider = await chooseProvider(ui, config);
    // 'again': same provider, ask for the key again (or retry).
  }
}

async function chooseProvider(ui: Ui, config: Config): Promise<Choose> {
  const aiName = WEB_SEARCH_NAMES[config.provider];
  const choices: Choice<Choose>[] = [];
  if (aiName) {
    choices.push({
      name: `${aiName}, with your AI key`,
      value: 'ai',
      description: `No extra key, but slower, with fewer results, and the most expensive per search: each one is billed to your ${PROVIDER_NAMES[config.provider]} account, along with the tokens to read its results.`,
    });
  }
  choices.push(
    {
      name: 'SerpApi (Google results)',
      value: 'serpapi',
      description:
        'Fast, with the best results. 250 free searches a month. Needs a SerpApi API key.',
    },
    {
      name: 'Brave Search API',
      value: 'brave',
      description:
        'Fast, with up to 20 results per search. $5 of free credit a month. Needs a Brave Search API key.',
    },
    {
      name: 'DuckDuckGo (free, slow)',
      value: 'duckduckgo',
      description:
        'No key, but very slow: DuckDuckGo has no API, so Jobhunter reads its result pages like a browser and has to wait 45 seconds between searches. Searching everything takes about 10 minutes, and DuckDuckGo still blocks it now and then.',
    },
    { name: 'Skip for now', value: 'skip' },
  );
  const fallback = config.search?.provider ?? choices[0]?.value;
  return ui.select<Choose>({
    message: 'How should Jobhunter search for companies?',
    choices,
    ...(fallback && choices.some((c) => c.value === fallback) ? { default: fallback } : {}),
  });
}

async function searchConfig(
  ui: Ui,
  provider: SearchProvider,
  saved: SearchConfig | undefined,
): Promise<SearchConfig> {
  if (provider === 'ai' || provider === 'duckduckgo') return { provider };
  const savedKey = saved?.provider === provider ? saved.apiKey : undefined;
  const hint = savedKey
    ? ` ${dim(`(Enter to keep ••••${savedKey.slice(-4)})`)}`
    : ` ${dim(`(${KEY_HELP[provider]})`)}`;
  const value = await ui.password({
    message: `${KEY_NAMES[provider]} API key${hint}`,
    validate: (input) => (input.trim() || savedKey ? true : 'Paste your API key'),
  });
  return { provider, apiKey: value.trim() || (savedKey ?? '') };
}

/**
 * One real search for the first role, its boards saved. DuckDuckGo isn't checked: one search
 * says little about the next, and there's no key to test.
 */
async function check(
  deps: SearchStepDeps,
  config: Config,
  search: SearchConfig,
): Promise<'ok' | 'again' | 'other'> {
  const { ui } = deps;
  if (search.provider === 'duckduckgo') return 'ok';
  const profile = await readProfile(config.activeProfile);
  const ats = deps.ats ?? ATS;
  if (!profile || boardQueries(profile, ats).length === 0) return 'ok';

  const engine =
    deps.engineFor?.(search, config) ??
    createSearchEngine(search, () => deps.connect(config, config.model));
  const state = await loadBoardState();
  const result = await findCompanyBoards(
    profile,
    state,
    { ui, engine, ats },
    { now: deps.now?.() ?? new Date(), force: true, limit: 1 },
  );
  const error = result.stopped ?? result.lastFailure;
  if (!error) return 'ok';

  ui.error(error.message);
  const badKey = error.reason === 'bad-key' && search.provider !== 'ai';
  const next = await ui.select<'again' | 'other' | 'keep'>({
    message: 'What would you like to do?',
    choices: [
      { name: badKey ? 'Enter a different key' : 'Try again', value: 'again' },
      { name: 'Choose another search', value: 'other' },
      { name: 'Save it anyway', value: 'keep' },
    ],
  });
  return next === 'keep' ? 'ok' : next;
}
