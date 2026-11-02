import { addUsage, type LLMAdapter, type Usage } from '../llm/index.js';
import { MAPPING_TARGETS, TRANSFORMS } from '../mapping/index.js';
import { renderSystemPrompt, renderUserPrompt } from '../prompts/index.js';
import { EmploymentTypeSchema, SalaryPeriodSchema, WorkModeSchema } from '../schema/enums.js';
import { inspectPage, type FeedLink, type PageView } from './digest.js';
import { draftToList, StepSchema, type DraftMapping, type Step } from './draft.js';
import { readSite, SiteError, type SiteResult } from './extract.js';
import { cachedFetch, checkPageUrl, PageError, type FetchPage } from './page.js';
import type { SiteMapping } from './schema.js';
import { clip, wellFormed } from './text.js';

export const DEFAULT_MAX_STEPS = 15;
/** Job pages read when a mapping is tested. */
const TEST_PAGES = 3;
/** Older steps are shown in one line; only the latest ones in full. */
const FULL_STEPS = 2;
const MAX_TOKENS = 8192;

const list = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(', ');

/** A mapping that made jobs, for the user to look at before it's saved. */
export interface MapCandidate {
  site: SiteMapping;
  result: SiteResult;
}

/** What the user says about a candidate: keep it, stop, or what the AI should change. */
export type Review = 'save' | 'cancel' | { feedback: string };

export interface MapSiteDeps {
  llm: LLMAdapter;
  fetch: FetchPage;
  /** Shown before each step runs. */
  onStep?: (step: Step, number: number) => void;
  /** Shown after each step: what it found, and feeds no earlier page announced. */
  onResult?: (result: StepResult) => void;
  review: (candidate: MapCandidate) => Promise<Review>;
  now?: () => Date;
}

export interface MapSiteOptions {
  startUrl: string;
  /** Who the jobs are for, so the AI can pick filters: roles, seniority, work modes. */
  candidate: string;
  maxSteps?: number;
}

export type MapOutcome =
  | { status: 'saved'; site: SiteMapping; usage: Usage }
  | { status: 'cancelled'; usage: Usage }
  | { status: 'gave-up'; reason: string; usage: Usage }
  | { status: 'out-of-steps'; usage: Usage };

/** What a step found, for the user. */
export interface StepResult {
  /** One line, e.g. `RSS feed, 20 items` or `20 job links, 3 of 3 job pages read`. */
  summary: string;
  /** Feeds announced by the page fetched in this step, the first time each is seen. */
  feeds: FeedLink[];
}

interface HistoryEntry {
  step: Step;
  /** What came back, in full. */
  observation: string;
  /** One line for when the step is no longer recent. */
  brief: string;
  /** One line for the user. */
  summary: string;
}

/** A slug for the site, from the job list's host: `careers.acme.com`. */
export function siteId(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
}

/**
 * Let the AI explore a site step by step (fetch a page, test a mapping) until it has a mapping
 * that makes jobs and the user accepts it.
 */
export async function mapSite(deps: MapSiteDeps, options: MapSiteOptions): Promise<MapOutcome> {
  const fetch = cachedFetch(deps.fetch);
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const history: HistoryEntry[] = [];
  const usages: Usage[] = [];
  const usage = () => addUsage(...usages);
  const seenFeeds = new Set<string>();
  const record = (entry: HistoryEntry, feeds: FeedLink[] = []) => {
    history.push(entry);
    const fresh = feeds.filter((feed) => !seenFeeds.has(feed.url));
    for (const feed of fresh) seenFeeds.add(feed.url);
    deps.onResult?.({ summary: entry.summary, feeds: fresh });
  };

  const system = renderSystemPrompt('map-site', {
    targets: list(MAPPING_TARGETS),
    transforms: list(TRANSFORMS),
    workModes: list(WorkModeSchema.options),
    employmentTypes: list(EmploymentTypeSchema.options),
    salaryPeriods: list(SalaryPeriodSchema.options),
  });

  for (let number = 1; number <= maxSteps; number++) {
    const { data: step, usage: stepUsage } = await deps.llm.generateJSON({
      system,
      cacheSystem: true,
      // Pages can hold broken characters, which would make the request invalid JSON.
      prompt: wellFormed(
        renderUserPrompt('map-site', {
          startUrl: options.startUrl,
          candidate: options.candidate,
          stepsLeft: String(maxSteps - number + 1),
          history: renderHistory(history),
        }),
      ),
      schema: StepSchema,
      schemaName: 'map_step',
      maxTokens: MAX_TOKENS,
    });
    usages.push(stepUsage);
    deps.onStep?.(step, number);

    switch (step.action) {
      case 'give_up':
        return { status: 'gave-up', reason: step.reason || step.note, usage: usage() };

      case 'fetch': {
        const { url } = step;
        const view = await observeFetch(fetch, url);
        record(
          { step, observation: view.digest, brief: view.summary, summary: view.summary },
          view.feeds,
        );
        break;
      }

      case 'test':
      case 'finish': {
        const draft = step.mapping as DraftMapping;
        const tried = await tryDraft(fetch, draft, options.startUrl, deps.now?.() ?? new Date());
        if (!tried.candidate) {
          record({ step, ...tried });
          break;
        }
        if (step.action === 'test' || !works(tried.candidate.result)) {
          const verdict =
            step.action === 'finish'
              ? '\n\nNot finished: the mapping must make more jobs than it fails on.'
              : '';
          record({ step, ...tried, observation: tried.observation + verdict });
          break;
        }

        deps.onResult?.({ summary: tried.summary, feeds: [] });
        const review = await deps.review({
          ...tried.candidate,
          site: { ...tried.candidate.site, mappedBy: deps.llm.model },
        });
        if (review === 'save') {
          return {
            status: 'saved',
            site: { ...tried.candidate.site, mappedBy: deps.llm.model },
            usage: usage(),
          };
        }
        if (review === 'cancel') return { status: 'cancelled', usage: usage() };
        history.push({
          step,
          summary: tried.summary,
          observation: `${tried.observation}\n\nThe user looked at these jobs and said the mapping isn't right yet:\n"${review.feedback}"`,
          brief: `${tried.brief}; the user asked for changes: "${clip(review.feedback, 200)}"`,
        });
        break;
      }
    }
  }
  return { status: 'out-of-steps', usage: usage() };
}

/** Good enough to show the user: some jobs, and more jobs than failures. */
function works(result: SiteResult): boolean {
  return result.jobs.length > 0 && result.errors.length < result.jobs.length;
}

/** For `JSON.stringify`: leaves out the `""` and `[]` that mean "not used" in a draft. */
const withoutUnused = (_key: string, value: unknown): unknown =>
  value === '' || (Array.isArray(value) && value.length === 0) ? undefined : value;

function renderHistory(history: readonly HistoryEntry[]): string {
  if (history.length === 0) return 'Nothing yet: start with the start address.';
  return history
    .map((entry, index) => {
      const recent = index >= history.length - FULL_STEPS;
      const { step } = entry;
      const target =
        step.action === 'fetch'
          ? ` ${step.url}`
          : recent && step.mapping
            ? `\n${JSON.stringify(step.mapping, withoutUnused)}`
            : '';
      const heading = `## Step ${String(index + 1)}: ${step.action}${target}`;
      return recent
        ? `${heading}\n${entry.observation}`
        : `${heading}\n${entry.brief} (details no longer shown)`;
    })
    .join('\n\n');
}

async function observeFetch(fetch: FetchPage, url: string): Promise<PageView> {
  const failed = (message: string): PageView => ({
    digest: `Couldn't fetch ${url}\n${message}`,
    summary: `couldn't fetch it: ${message}`,
    feeds: [],
  });
  const problem = checkPageUrl(url);
  if (problem) return failed(problem);
  try {
    return inspectPage(await fetch(url));
  } catch (error) {
    if (!(error instanceof PageError)) throw error;
    return failed(error.message);
  }
}

interface Tried {
  candidate?: MapCandidate;
  observation: string;
  brief: string;
  summary: string;
}

async function tryDraft(
  fetch: FetchPage,
  draft: DraftMapping,
  startUrl: string,
  now: Date,
): Promise<Tried> {
  const badUrl = checkPageUrl(draft.entryUrl);
  const converted = draftToList(draft);
  const problems = [...(badUrl ? [`entryUrl: ${badUrl}`] : []), ...(converted.problems ?? [])];
  if (problems.length > 0 || !converted.list) {
    return {
      observation: `The mapping is invalid:\n${problems.map((p) => `- ${p}`).join('\n')}`,
      brief: `invalid mapping (${clip(problems.join('; '), 200)})`,
      summary: `the mapping has ${String(problems.length)} problem${problems.length === 1 ? '' : 's'} to fix`,
    };
  }

  const site: SiteMapping = {
    id: siteId(draft.entryUrl),
    name: draft.name,
    startUrl,
    entryUrl: draft.entryUrl,
    list: converted.list,
    mappedAt: now.toISOString(),
  };
  let result: SiteResult;
  try {
    result = await readSite(site, fetch, { maxPages: TEST_PAGES });
  } catch (error) {
    if (!(error instanceof SiteError)) throw error;
    return {
      observation: `The test failed: ${error.message}`,
      brief: `test failed: ${error.message}`,
      summary: `the test failed: ${error.message}`,
    };
  }
  return {
    candidate: { site, result },
    observation: describeResult(site, result),
    brief: `${String(result.jobs.length)} jobs, ${String(result.errors.length)} failed${site.list.kind === 'links' ? `, ${String(result.links.length)} links` : ''}`,
    summary:
      site.list.kind === 'links'
        ? `${String(result.links.length)} job links, ${String(result.jobs.length)} of ${String(result.pages.length)} job pages read`
        : `${String(result.jobs.length)} jobs read${result.errors.length > 0 ? `, ${String(result.errors.length)} unreadable` : ''}`,
  };
}

const show = (value: unknown) =>
  value === undefined ? '(nothing)' : clip(JSON.stringify(value), 300);

/** What a test run found, for the AI to check its mapping against. */
export function describeResult(site: SiteMapping, result: SiteResult): string {
  const lines: string[] = [];
  if (site.list.kind === 'links') {
    lines.push(`Job links found on the list: ${String(result.links.length)}`);
    lines.push(...result.links.slice(0, 10).map((link) => `- ${link}`));
    if (result.links.length > 10) lines.push(`- … ${String(result.links.length - 10)} more`);
    for (const page of result.pages) {
      lines.push('', `Job page ${page.url}`);
      for (const [target, value] of Object.entries(page.values)) {
        lines.push(`  ${target} read: ${show(value)}`);
      }
      lines.push(page.job ? `  → job: ${show(page.job)}` : `  → failed: ${page.error ?? ''}`);
    }
  } else {
    lines.push(`Jobs made: ${String(result.jobs.length)}; failed: ${String(result.errors.length)}`);
    for (const job of result.jobs.slice(0, TEST_PAGES)) lines.push(`- ${show(job)}`);
    for (const error of result.errors.slice(0, 5)) {
      lines.push(`- item ${String(error.index)} failed: ${error.message}`);
    }
  }
  return lines.join('\n');
}
