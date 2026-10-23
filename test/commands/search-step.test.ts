import { describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init/index.js';
import {
  readConfig,
  saveConfig,
  saveProfile,
  type Config,
  type SearchConfig,
} from '../../src/config/index.js';
import { SearchError, type SearchEngine } from '../../src/search/index.js';
import { loadBoardState } from '../../src/sources/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DERIVED_ANSWER } from '../helpers/fixtures.js';
import { DEFAULT, FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const config: Config = {
  version: 1,
  provider: 'claude',
  model: 'claude-haiku-5-5',
  apiKey: 'sk-ant-x',
  activeProfile: 'default',
};

async function setUp(saved: Config = config, { roles = true } = {}) {
  await saveConfig(saved);
  await saveProfile({
    version: 1,
    name: 'default',
    ...(roles ? { derived: { ...DERIVED_ANSWER, roles: ['Backend Engineer'] } } : {}),
  });
}

/** Accepts the key `good`; finds one Lever board. */
function fakeEngines() {
  const checked: SearchConfig[] = [];
  const engineFor = (search: SearchConfig): SearchEngine => {
    checked.push(search);
    return {
      name: 'Test Search',
      pauseMs: 0,
      search: () =>
        'apiKey' in search && search.apiKey !== 'good'
          ? Promise.reject(new SearchError("Test Search didn't accept the API key.", 'bad-key'))
          : Promise.resolve([{ url: 'https://jobs.lever.co/acme/1', title: '', snippet: '' }]),
    };
  };
  return { engineFor, checked };
}

const init = (ui: FakeUi, engines = fakeEngines()) =>
  runInit({
    ui,
    openBrowser: () => undefined,
    connect: () => new FakeLLM(),
    searchEngineFor: engines.engineFor,
  });

describe('jobhunter init: web search', () => {
  useTempHome();

  it("says what it's for and offers the AI's own search first, DuckDuckGo last", async () => {
    await setUp();
    const ui = new FakeUi(['search', 'skip']);
    await init(ui);

    expect(ui.output.join('\n')).toContain(
      "Jobhunter searches the web to find companies' own job boards",
    );
    const prompt = ui.prompts.find((p) => p.message === 'Which web search should Jobhunter use?');
    expect(prompt?.choices?.map((c) => c.value)).toEqual([
      'ai',
      'serpapi',
      'brave',
      'duckduckgo',
      'skip',
    ]);
    expect(prompt?.choices?.[0]?.name).toBe("Claude's web search, with your AI key");
    expect(prompt?.choices?.[0]?.description).toContain('the most expensive per search');
    const duckduckgo = prompt?.choices?.find((c) => c.value === 'duckduckgo');
    expect(duckduckgo?.name).toContain('slow');
    expect(duckduckgo?.description).toContain('reads its result pages like a browser');
    expect((await readConfig())?.search).toBeUndefined();
  });

  it('warns Gemini users up front that Google Search needs billing', async () => {
    await setUp({ ...config, provider: 'gemini', model: 'gemini-3.1-flash-lite' });
    const ui = new FakeUi(['search', 'skip']);
    await init(ui);
    const prompt = ui.prompts.find((p) => p.message === 'Which web search should Jobhunter use?');
    const ai = prompt?.choices?.[0];
    expect(ai?.name).toBe('Gemini with Google Search, with your AI key');
    expect(ai?.description).toContain(
      "BTW: on Gemini's free tier, Gemini 3 models can't use Google Search at all.",
    );
    // Claude has no such note.
    await setUp();
    const claude = new FakeUi(['search', 'skip']);
    await init(claude);
    expect(
      claude.prompts.find((p) => p.message === 'Which web search should Jobhunter use?')
        ?.choices?.[0]?.description,
    ).not.toContain('BTW');
  });

  it("doesn't offer AI search for an OpenAI-compatible API, which has none", async () => {
    await setUp({ ...config, provider: 'openai', baseURL: 'https://openrouter.ai/api/v1' });
    const ui = new FakeUi(['search', 'skip']);
    await init(ui);
    const prompt = ui.prompts.find((p) => p.message === 'Which web search should Jobhunter use?');
    expect(prompt?.choices?.map((c) => c.value)).toEqual([
      'serpapi',
      'brave',
      'duckduckgo',
      'skip',
    ]);
  });

  it('saves a SerpApi key after a test search, keeping the boards it found', async () => {
    await setUp();
    const engines = fakeEngines();
    const ui = new FakeUi(['search', 'serpapi', 'good']);
    await init(ui, engines);

    expect(ui.prompts.find((p) => p.type === 'password')?.message).toContain('SerpApi API key');
    expect(engines.checked).toEqual([{ provider: 'serpapi', apiKey: 'good' }]);
    expect((await readConfig())?.search).toEqual({ provider: 'serpapi', apiKey: 'good' });
    expect(Object.keys((await loadBoardState()).boards)).toEqual(['lever:acme']);
    expect(ui.output).toContain('✔ Test Search: 1 new company job boards');
    expect(ui.output.join('\n')).toContain('Next: `jobhunter companies find`');
  });

  it('asks for another key when the first is rejected', async () => {
    await setUp();
    const ui = new FakeUi(['search', 'brave', 'bad', 'again', 'good']);
    await init(ui);

    expect(ui.output).toContain("✖ Test Search didn't accept the API key.");
    const next = ui.prompts.find((p) => p.message === 'What would you like to do?');
    expect(next?.choices?.[0]?.name).toBe('Enter a different key');
    expect((await readConfig())?.search).toEqual({ provider: 'brave', apiKey: 'good' });
  });

  it('can switch to another search after a failed check', async () => {
    await setUp();
    const ui = new FakeUi(['search', 'brave', 'bad', 'other', 'ai']);
    await init(ui);
    expect((await readConfig())?.search).toEqual({ provider: 'ai' });
  });

  it('saves DuckDuckGo without a test search', async () => {
    await setUp();
    const engines = fakeEngines();
    await init(new FakeUi(['search', 'duckduckgo']), engines);
    expect(engines.checked).toEqual([]);
    expect((await readConfig())?.search).toEqual({ provider: 'duckduckgo' });
  });

  it('preselects the saved search and keeps its key on Enter', async () => {
    await setUp({ ...config, search: { provider: 'serpapi', apiKey: 'good' } });
    const ui = new FakeUi(['search', DEFAULT, '']);
    await init(ui);
    expect(ui.prompts.find((p) => p.type === 'password')?.message).toContain(
      'Enter to keep ••••good',
    );
    expect((await readConfig())?.search).toEqual({ provider: 'serpapi', apiKey: 'good' });
  });

  it('is skipped until there are roles to search for', async () => {
    await setUp(config, { roles: false });
    const ui = new FakeUi(['search']);
    await init(ui);
    expect(ui.output.join('\n')).toContain('The web search looks for your roles');
    expect(ui.remainingAnswers).toBe(0);
  });

  it('keeps the search when the AI setup changes', async () => {
    await setUp({ ...config, search: { provider: 'brave', apiKey: 'good' } });
    const connect = () =>
      new FakeLLM({ models: [{ id: 'claude-haiku-5-5', displayName: 'Haiku' }] });
    await runInit({
      ui: new FakeUi(['ai', 'claude', 'sk-ant-new', DEFAULT]),
      openBrowser: () => undefined,
      connect,
    });
    expect(await readConfig()).toMatchObject({
      apiKey: 'sk-ant-new',
      search: { provider: 'brave', apiKey: 'good' },
    });
  });
});
