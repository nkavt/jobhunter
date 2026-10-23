import { InvalidArgumentError, type Command } from 'commander';
import { connectAdapter } from '../../llm/index.js';
import { TrackerError } from '../../tracker/index.js';
import { CancelledError, createTerminalUi, dim } from '../../ui/index.js';
import { HuntSetupError } from './errors.js';
import { runHunt } from './run.js';
import { DEFAULT_MAX_AI_JOBS, DEFAULT_SINCE_DAYS } from './types.js';

export { HuntSetupError } from './errors.js';
export { runHunt } from './run.js';
export {
  DEFAULT_MAX_AI_JOBS,
  DEFAULT_SINCE_DAYS,
  type HuntDeps,
  type HuntOptions,
  type HuntSummary,
} from './types.js';

const integer =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (value: string): number => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new InvalidArgumentError(`Use a whole number from ${String(min)} to ${String(max)}.`);
    }
    return number;
  };

interface HuntFlags {
  force?: boolean;
  dryRun?: boolean;
  ai: boolean;
  maxAiJobs?: number;
  since?: number;
  minScore?: number;
  parallel?: number;
}

export function registerHunt(program: Command): void {
  program
    .command('hunt')
    .description(
      'Fetch the job boards, skip jobs already in your sheet, score the rest and add them',
    )
    .option('-f, --force', 'check every job board, even ones checked in the last few hours')
    .option('--dry-run', 'show the results without writing to your sheet')
    .option('--no-ai', 'skip the AI: every job that passes your filters goes to "To apply"')
    .option(
      '--max-ai-jobs <n>',
      `score at most this many jobs per run (default ${String(DEFAULT_MAX_AI_JOBS)})`,
      integer(1),
    )
    .option(
      '--since <days>',
      `ignore jobs posted more than this many days ago (default ${String(DEFAULT_SINCE_DAYS)})`,
      integer(1),
    )
    .option(
      '--min-score <score>',
      'score needed for "To apply" in this run (0-100)',
      integer(0, 100),
    )
    .option(
      '--parallel <n>',
      'AI calls to make at the same time (default 4, or 1 for a model on your own machine)',
      integer(1, 16),
    )
    .action(async (flags: HuntFlags) => {
      const ui = createTerminalUi();
      try {
        await runHunt(
          { ui, connect: connectAdapter },
          {
            ai: flags.ai,
            ...(flags.force ? { force: true } : {}),
            ...(flags.dryRun ? { dryRun: true } : {}),
            ...(flags.maxAiJobs !== undefined ? { maxAiJobs: flags.maxAiJobs } : {}),
            ...(flags.since !== undefined ? { sinceDays: flags.since } : {}),
            ...(flags.minScore !== undefined ? { minScore: flags.minScore } : {}),
            ...(flags.parallel !== undefined ? { parallel: flags.parallel } : {}),
          },
        );
      } catch (error) {
        if (error instanceof CancelledError) {
          ui.info('Cancelled.');
          process.exitCode = 130;
          return;
        }
        ui.error(error instanceof Error ? error.message : String(error));
        const expected = error instanceof HuntSetupError || error instanceof TrackerError;
        if (!expected && error instanceof Error && error.stack) {
          ui.info(dim(error.stack));
        }
        process.exitCode = 1;
      }
    });
}
