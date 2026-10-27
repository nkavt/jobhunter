import { describe, expect, it } from 'vitest';
import { describeCandidate, MapInputError, runMap } from '../../src/commands/map/index.js';
import { saveConfig, saveProfile, type Profile } from '../../src/config/index.js';
import type { JsonRequest } from '../../src/llm/index.js';
import { loadSites, saveSite, type Step } from '../../src/sites/index.js';
import { FakeLLM } from '../helpers/fake-llm.js';
import { DERIVED_ANSWER } from '../helpers/fixtures.js';
import { FakeUi } from '../helpers/fake-ui.js';
import { ACME_SITE, fakeFetch, LIST_URL } from '../helpers/site-fixtures.js';
import { useTempHome } from '../helpers/temp-home.js';

const now = new Date('2026-10-21T12:00:00Z');
const START = 'https://careers.acme.example/';

const FINISH: Step = {
  note: 'The job links work',
  action: 'finish',
  mapping: {
    name: 'Acme',
    entryUrl: LIST_URL,
    kind: 'links',
    linkSelector: 'a.job-link',
    fields: [
      { target: 'title', jsonLd: 'title' },
      { target: 'company', const: 'Acme' },
    ],
  },
};

async function setUp() {
  await saveConfig({
    version: 1,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    apiKey: 'sk-ant-x',
    activeProfile: 'default',
  });
  await saveProfile({
    version: 1,
    name: 'default',
    derived: { ...DERIVED_ANSWER, roles: ['Frontend Engineer'] },
  });
}

function deps(ui: FakeUi, steps: Step[]) {
  let next = 0;
  const prompts: string[] = [];
  const llm = new FakeLLM({
    json: (_attempt: number, request: JsonRequest<unknown>) => {
      prompts.push(request.prompt);
      return steps[next++];
    },
  });
  return { deps: { ui, connect: () => llm, fetchPage: fakeFetch(), now: () => now }, prompts };
}

describe('jobhunter map', () => {
  useTempHome();

  it('saves the mapping the user accepts, and tells the AI who the jobs are for', async () => {
    await setUp();
    const ui = new FakeUi(['save']);
    const { deps: d, prompts } = deps(ui, [FINISH]);

    const outcome = await runMap(d, START);

    expect(outcome?.status).toBe('saved');
    expect(prompts[0]).toContain('Roles: Frontend Engineer');
    expect(await loadSites()).toMatchObject([
      { id: 'careers.acme.example', name: 'Acme', startUrl: START, entryUrl: LIST_URL },
    ]);
    const output = ui.output.join('\n');
    expect(output).toContain('Acme: 3 job links');
    expect(output).toContain('Frontend Engineer · Acme');
    expect(output).toContain('`jobhunter hunt` reads it from now on');
  });

  it('asks before mapping a site again, and replaces it', async () => {
    await setUp();
    await saveSite({ ...ACME_SITE, startUrl: START });

    const keep = new FakeUi([false]);
    expect(await runMap(deps(keep, [FINISH]).deps, START)).toBeUndefined();

    const again = new FakeUi([true, 'save']);
    await runMap(deps(again, [FINISH]).deps, START);
    const sites = await loadSites();
    expect(sites).toHaveLength(1);
    expect(sites[0]?.mappedAt).toBe(now.toISOString());
  });

  it('saves nothing when the AI gives up', async () => {
    await setUp();
    const ui = new FakeUi([]);
    const { deps: d } = deps(ui, [
      { note: 'Login wall', action: 'give_up', reason: 'needs a login' },
    ]);
    expect((await runMap(d, START))?.status).toBe('gave-up');
    expect(await loadSites()).toEqual([]);
    expect(ui.output.join('\n')).toContain("couldn't map this site: needs a login");
  });

  it('refuses addresses on your own network', async () => {
    await setUp();
    await expect(runMap(deps(new FakeUi([]), []).deps, 'http://localhost:8080/')).rejects.toThrow(
      MapInputError,
    );
  });
});

describe('describeCandidate', () => {
  it('says to use the full list without a CV', () => {
    expect(describeCandidate(undefined)).toContain('unfiltered');
  });

  it('lists roles and preferences', () => {
    const profile: Profile = {
      version: 1,
      name: 'default',
      derived: { ...DERIVED_ANSWER, roles: ['Go Developer'] },
      preferences: {
        workModes: ['remote'],
        remote: { eligibleCountries: ['GE'] },
        visaSponsorshipNeeded: false,
        employmentTypes: ['full_time'],
      },
    };
    const text = describeCandidate(profile);
    expect(text).toContain('Roles: Go Developer');
    expect(text).toContain('Work modes: remote');
    expect(text).toContain('Can work remotely from: GE');
  });
});
