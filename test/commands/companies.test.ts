import { describe, expect, it } from 'vitest';
import { CompaniesSetupError, runCompaniesFind } from '../../src/commands/companies/index.js';
import { saveConfig, saveProfile, type SearchConfig } from '../../src/config/index.js';
import { SearchError, type SearchEngine, type SearchResult } from '../../src/search/index.js';
import { ATS, loadBoardState } from '../../src/sources/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DERIVED_ANSWER } from '../helpers/fixtures.js';
import { FakeUi } from '../helpers/fake-ui.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-21T12:00:00Z');
const lever = ATS.filter((a) => a.id === 'lever');

async function setUp({ search, roles = true }: { search?: SearchConfig; roles?: boolean } = {}) {
  await saveConfig({
    version: 1,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    apiKey: 'sk-ant-x',
    activeProfile: 'default',
    ...(search ? { search } : {}),
  });
  await saveProfile({
    version: 1,
    name: 'default',
    ...(roles
      ? { derived: { ...DERIVED_ANSWER, roles: ['Backend Engineer', 'Go Developer'] } }
      : {}),
  });
}

function engine(
  search: (query: string) => Promise<SearchResult[]>,
  pauseMs = 0,
): SearchEngine & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: 'Test Search',
    pauseMs,
    queries,
    search: (query) => {
      queries.push(query);
      return search(query);
    },
  };
}

const run = (ui: FakeUi, e: SearchEngine, force = false) =>
  runCompaniesFind(
    {
      ui,
      connect: () => new FakeLLM(),
      engine: e,
      ats: lever,
      pause: () => Promise.resolve(),
      now: () => now,
    },
    force ? { force: true } : {},
  );

describe('jobhunter companies find', () => {
  useTempHome();

  it('runs every search in one go and remembers the boards for hunt', async () => {
    await setUp({ search: { provider: 'serpapi', apiKey: 'k' } });
    const ui = new FakeUi([]);
    const e = engine((query) =>
      Promise.resolve([
        {
          url: `https://jobs.lever.co/${query.includes('Go') ? 'gopher' : 'acme'}/1`,
          title: '',
          snippet: '',
        },
      ]),
    );
    const result = await run(ui, e);

    expect(e.queries).toEqual(['site:lever.co "Backend Engineer"', 'site:lever.co "Go Developer"']);
    expect(result).toMatchObject({ searched: 2, added: 2, left: 0 });
    expect(Object.keys((await loadBoardState()).boards).sort()).toEqual([
      'lever:acme',
      'lever:gopher',
    ]);
    expect(ui.output).toContain('2 company job boards known. `jobhunter hunt` reads them.');
    expect(ui.output.join('\n')).not.toContain('DuckDuckGo');

    // A second run the same week has nothing to do, unless forced.
    const again = new FakeUi([]);
    expect(await run(again, e)).toBeUndefined();
    expect(again.output.join('\n')).toContain('Every search ran in the last 7 days');
    expect(await run(new FakeUi([]), e, true)).toMatchObject({ searched: 2 });
  });

  it('says how long a slow search takes, and how to pick a faster one', async () => {
    await setUp();
    const ui = new FakeUi([]);
    await run(
      ui,
      engine(() => Promise.resolve([]), 45_000),
    );
    const output = ui.output.join('\n');
    expect(output).toContain('Searching DuckDuckGo. For a faster search, run `jobhunter init`');
    expect(output).toContain('2 searches, about 1 minute:');
  });

  it('stops at a rejected key and says where to fix it', async () => {
    await setUp({ search: { provider: 'brave', apiKey: 'bad' } });
    const ui = new FakeUi([]);
    const result = await run(
      ui,
      engine(() =>
        Promise.reject(new SearchError("Brave Search didn't accept the API key.", 'bad-key')),
      ),
    );
    expect(result?.stopped?.reason).toBe('bad-key');
    expect(ui.output).toContain('✔ Test Search: no search went through');
    expect(ui.output.join('\n')).toContain(
      "⚠ Brave Search didn't accept the API key. Run `jobhunter init` → Company search",
    );
  });

  it('leaves the rest for later when asked to slow down', async () => {
    await setUp({ search: { provider: 'serpapi', apiKey: 'k' } });
    const ui = new FakeUi([]);
    let calls = 0;
    await run(
      ui,
      engine(() =>
        ++calls === 1
          ? Promise.resolve([])
          : Promise.reject(new SearchError('SerpApi asked to slow down.', 'rate-limited')),
      ),
    );
    expect(ui.output.join('\n')).toContain(
      'SerpApi asked to slow down. The remaining 1 searches run next time.',
    );
  });

  it('needs the roles from a CV first', async () => {
    await setUp({ roles: false });
    await expect(
      run(
        new FakeUi([]),
        engine(() => Promise.resolve([])),
      ),
    ).rejects.toBeInstanceOf(CompaniesSetupError);
  });
});
