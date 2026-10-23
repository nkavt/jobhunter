import { readFile } from 'node:fs/promises';
import { cvFile, instructionsFile, type Config, type Profile } from '../../config/index.js';
import { BATCH_SIZE, minScoreFor, scoreJobs } from '../../fit/index.js';
import { groupSameJobs, type SameJob } from '../../jobs/index.js';
import {
  defaultParallelCalls,
  getAdapterName,
  getConfiguredAdapterName,
  type Usage,
} from '../../llm/index.js';
import type { IgnoredJob, TrackedJob } from '../../tracker/index.js';
import { dim, type Ui } from '../../ui/index.js';
import { DEFAULT_MAX_AI_JOBS, type Found, type HuntDeps, type HuntOptions } from './types.js';

export interface Scored {
  /** For To apply or Skipped, best first. */
  tracked: TrackedJob[];
  /** Copies of the scored jobs for other locations, for Ignored. */
  copies: IgnoredJob[];
  /** Jobs over the limit, left for a later run. */
  deferred: number;
  /** The limit this run used. */
  maxAiJobs: number;
  usage?: Usage;
}

/**
 * The jobs that passed the filters → To apply or Skipped. The same job posted once per location
 * is judged once, with all its locations. Newest first, so a limit keeps the freshest jobs; with
 * `ai: false`, every job goes to To apply.
 */
export async function scorePassed(
  passed: Found[],
  context: {
    deps: Pick<HuntDeps, 'ui' | 'connect' | 'interactive'>;
    config: Config;
    profile: Profile;
    options: HuntOptions;
    now: Date;
  },
): Promise<Scored> {
  const { deps, config, profile, options, now } = context;
  const { ui } = deps;
  const useAi = options.ai !== false;
  passed.sort((a, b) => (b.job.postedAt ?? '').localeCompare(a.job.postedAt ?? ''));
  const jobs = groupSameJobs(passed, (item) => item.job);
  let maxAiJobs = options.maxAiJobs ?? DEFAULT_MAX_AI_JOBS;
  const interactive = deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (useAi && jobs.length > maxAiJobs && options.maxAiJobs === undefined && interactive) {
    maxAiJobs = await askHowManyToScore(
      ui,
      jobs.length,
      passed.length - jobs.length,
      maxAiJobs,
      config,
    );
  }
  const toScore = useAi ? jobs.slice(0, maxAiJobs) : jobs;
  const result = {
    copies: sameJobCopies(toScore, now),
    deferred: jobs.length - toScore.length,
    maxAiJobs,
  };

  if (!useAi) {
    const tracked = toScore.map(({ first }): TrackedJob => ({
      ...first,
      status: 'To apply',
      note: '',
      foundAt: now,
    }));
    return { ...result, tracked };
  }
  if (toScore.length === 0) return { ...result, tracked: [] };

  const llm = deps.connect(config, config.model);
  const [cv, instructions] = await Promise.all([
    readFile(cvFile(profile.name), 'utf8'),
    readFile(instructionsFile(profile.name), 'utf8'),
  ]);
  const scoring = `Scoring ${String(toScore.length)} jobs with ${getAdapterName(llm)}`;
  const { fits, usage } = await ui.task(
    `${scoring}… 0/${String(toScore.length)}`,
    (update) =>
      scoreJobs(
        toScore.map(({ first }) => first.job),
        { cv, instructions, preferences: profile.preferences },
        llm,
        {
          copies: toScore.map(({ others }) => others.map((item) => item.job)),
          concurrency: options.parallel ?? defaultParallelCalls(config),
          onBatch: (done, total) => {
            update(`${scoring}… ${String(done)}/${String(total)}`);
          },
        },
      ),
    () => `Scored ${String(toScore.length)} jobs`,
  );
  const minScore = options.minScore ?? minScoreFor(profile.preferences);
  const tracked = toScore.map(({ first }, index): TrackedJob => {
    const fit = fits[index] ?? { score: 0, note: '' };
    return {
      ...first,
      status: fit.score >= minScore ? 'To apply' : 'Skipped',
      note: fit.note,
      score: fit.score,
      foundAt: now,
    };
  });
  tracked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { ...result, tracked, usage };
}

/**
 * The other copies of each job being judged, for Ignored, so they aren't judged again on the next
 * run. Copies of deferred jobs wait with them, so a job is always judged with all its locations.
 */
function sameJobCopies(jobs: readonly SameJob<Found>[], now: Date): IgnoredJob[] {
  return jobs.flatMap(({ others }) =>
    others.map((item) => ({
      ...item,
      reason: `same job as the one in Applications, posted in ${item.job.location.text ?? 'another location'}`,
      foundAt: now,
    })),
  );
}

/** More jobs passed than a run scores by default: score them all, only the newest, or a number? */
async function askHowManyToScore(
  ui: Ui,
  passed: number,
  /** Copies of those jobs for other locations, judged with them. */
  copies: number,
  cap: number,
  config: Config,
): Promise<number> {
  const calls = (jobs: number) => Math.ceil(jobs / BATCH_SIZE);
  ui.info(
    `${String(passed)} jobs passed your filters, more than the ${String(cap)} a run scores by default.`,
  );
  if (copies > 0) {
    ui.info(
      `${String(copies)} more are copies of these jobs for other locations; each job is scored once, with all its locations.`,
    );
  }
  const choice = await ui.select<number | 'other'>({
    message: 'How many should the AI score?',
    choices: [
      {
        name: `The newest ${String(cap)}`,
        value: cap,
        description: `About ${String(calls(cap))} AI requests. The rest aren't added to your sheet; a later run picks them up while they're still listed.`,
      },
      {
        name: `All ${String(passed)}`,
        value: passed,
        description: `About ${String(calls(passed))} AI requests with ${getConfiguredAdapterName(config)}, billed to your AI account. A large run can take a while, or run into your provider's rate limits.`,
      },
      {
        name: 'Another number…',
        value: 'other',
        description: `The newest jobs first, from 1 to ${String(passed)}.`,
      },
    ],
    default: cap,
  });
  if (choice !== 'other') return choice;
  const answer = await ui.input({
    message: `How many jobs should the AI score? (1–${String(passed)})`,
    validate: (value) => {
      const number = Number(value.trim());
      return Number.isInteger(number) && number >= 1 && number <= passed
        ? true
        : `Type a whole number from 1 to ${String(passed)}`;
    },
  });
  const count = Number(answer.trim());
  ui.info(dim(`About ${String(calls(count))} AI requests.`));
  return count;
}
