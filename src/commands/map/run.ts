import { loadConfig, readProfile, type Profile } from '../../config/index.js';
import type { Job } from '../../jobs/index.js';
import type { Connection, LLMAdapter, Usage } from '../../llm/index.js';
import {
  checkPageUrl,
  fetchPage,
  findSite,
  loadSites,
  mapSite,
  saveSite,
  type FetchPage,
  type MapCandidate,
  type MapOutcome,
  type Review,
} from '../../sites/index.js';
import { dim, type Ui } from '../../ui/index.js';

export interface MapDeps {
  ui: Ui;
  connect: (connection: Connection, model?: string) => LLMAdapter;
  /** Replaces the real HTTP fetch; tests use a fake one. */
  fetchPage?: FetchPage;
  now?: () => Date;
}

export interface MapOptions {
  maxSteps?: number;
}

/** The address can't be mapped as given; the message says why. */
export class MapInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapInputError';
  }
}

/** What the AI knows about the user when it picks a site's filters. */
export function describeCandidate(profile: Profile | undefined): string {
  const lines: string[] = [];
  const { derived, preferences } = profile ?? {};
  if (derived) {
    lines.push(`Roles: ${derived.roles.join(', ')}`);
    lines.push(`Seniority: ${derived.seniority}`);
    const tech = derived.tech.primary.join(', ');
    if (tech) lines.push(`Main tech: ${tech}`);
  }
  if (preferences) {
    lines.push(`Work modes: ${preferences.workModes.join(', ')}`);
    lines.push(`Employment: ${preferences.employmentTypes.join(', ')}`);
    const countries = preferences.remote?.eligibleCountries ?? [];
    if (countries.length > 0) lines.push(`Can work remotely from: ${countries.join(', ')}`);
    const cities = preferences.onsite?.cities ?? [];
    if (cities.length > 0) lines.push(`On-site in: ${cities.join(', ')}`);
  }
  return lines.length > 0
    ? lines.join('\n')
    : 'Unknown (no CV imported yet): use the full job list, unfiltered.';
}

function describeJob(job: Job): string {
  const where = job.location.text ?? (job.workMode === 'remote' ? 'Remote' : undefined);
  const details = [
    where,
    job.employmentType,
    job.postedAt ? `posted ${job.postedAt.slice(0, 10)}` : undefined,
    `${String(job.description.length)} characters of description`,
  ].filter(Boolean);
  return `  ${job.title} · ${job.company}\n  ${dim(`${details.join(' · ')}\n  ${job.url}`)}`;
}

/** Show what a working mapping found and ask the user what to do with it. */
async function reviewCandidate(ui: Ui, { site, result }: MapCandidate): Promise<Review> {
  const found =
    site.list.kind === 'links'
      ? `${String(result.links.length)} job links on ${site.entryUrl}; ${String(result.jobs.length)} of ${String(result.pages.length)} job pages read`
      : `${String(result.jobs.length)} jobs in ${site.entryUrl}${result.errors.length > 0 ? ` (${String(result.errors.length)} unreadable)` : ''}`;
  ui.success(`${site.name}: ${found}`);
  for (const job of result.jobs.slice(0, 3)) ui.info(describeJob(job));

  const choice = await ui.select({
    message: 'Save this mapping?',
    choices: [
      { name: 'Save it', value: 'save' as const },
      { name: 'Tell the AI what to change', value: 'feedback' as const },
      { name: 'Cancel', value: 'cancel' as const },
    ],
  });
  if (choice !== 'feedback') return choice;
  const feedback = await ui.input({
    message: "What's wrong?",
    validate: (value) => (value.trim() ? true : 'Say what the AI should change.'),
  });
  return { feedback: feedback.trim() };
}

function reportUsage(ui: Ui, usage: Usage): void {
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const { inputTokens, cacheReadTokens, outputTokens } = usage;
  ui.info(
    dim(
      `AI tokens: ${k(inputTokens + cacheReadTokens)} in (${k(cacheReadTokens)} from cache), ${k(outputTokens)} out`,
    ),
  );
}

/**
 * Let the AI work out how to read a job site, then save the mapping so every `hunt` reads the
 * site without the AI.
 */
export async function runMap(
  deps: MapDeps,
  startUrl: string,
  options: MapOptions = {},
): Promise<MapOutcome | undefined> {
  const { ui } = deps;
  const problem = checkPageUrl(startUrl);
  if (problem) throw new MapInputError(problem);

  const config = await loadConfig();
  const profile = await readProfile(config.activeProfile);
  const known = findSite(await loadSites(), startUrl);
  if (known) {
    const again = await ui.confirm({
      message: `${known.name} was mapped on ${known.mappedAt.slice(0, 10)}. Map it again?`,
      default: false,
    });
    if (!again) return undefined;
  }

  const llm = deps.connect(config, config.model);
  ui.info(dim(`Mapping ${startUrl} with ${llm.model}. Stop any time with Ctrl+C.`));
  const outcome = await mapSite(
    {
      llm,
      fetch: deps.fetchPage ?? fetchPage,
      onStep: (step, number) => {
        ui.info(`${dim(`${String(number)}.`)} ${step.note}${step.url ? dim(` ${step.url}`) : ''}`);
      },
      review: (candidate) => reviewCandidate(ui, candidate),
      ...(deps.now ? { now: deps.now } : {}),
    },
    {
      startUrl,
      candidate: describeCandidate(profile),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    },
  );

  switch (outcome.status) {
    case 'saved': {
      const saved = await saveSite(outcome.site);
      ui.success(`Saved ${saved.name}. \`jobhunter hunt\` reads it from now on, without the AI.`);
      break;
    }
    case 'cancelled':
      ui.info('Nothing saved.');
      break;
    case 'gave-up':
      ui.warn(`The AI couldn't map this site: ${outcome.reason}`);
      break;
    case 'out-of-steps':
      ui.warn(
        'The AI ran out of steps before the mapping worked. Try again, or give it more with `--max-steps`.',
      );
      break;
  }
  reportUsage(ui, outcome.usage);
  return outcome;
}
