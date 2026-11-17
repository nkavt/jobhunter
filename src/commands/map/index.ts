import { InvalidArgumentError, type Command } from 'commander';
import { ConfigError, NotInitializedError } from '../../config/index.js';
import { connectAdapter } from '../../llm/index.js';
import { DEFAULT_MAX_STEPS } from '../../sites/index.js';
import { CancelledError, createTerminalUi, dim } from '../../ui/index.js';
import { MapInputError, runMap } from './run.js';

export { describeCandidate, MapInputError, runMap } from './run.js';
export type { MapDeps, MapOptions } from './run.js';

const steps = (value: string): number => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) {
    throw new InvalidArgumentError('Use a whole number from 1 to 50.');
  }
  return number;
};

export function registerMap(program: Command): void {
  program
    .command('map')
    .description(
      'Let the AI work out how to read a job site, so every hunt reads it without the AI',
    )
    .argument('<url>', "a company's careers page or a job board")
    .option(
      '--max-steps <n>',
      `pages and tests the AI may use (default ${String(DEFAULT_MAX_STEPS)})`,
      steps,
    )
    .action(async (url: string, flags: { maxSteps?: number }) => {
      const ui = createTerminalUi();
      try {
        const outcome = await runMap(
          { ui, connect: connectAdapter },
          url,
          flags.maxSteps !== undefined ? { maxSteps: flags.maxSteps } : {},
        );
        if (outcome && outcome.status !== 'saved' && outcome.status !== 'cancelled') {
          process.exitCode = 1;
        }
      } catch (error) {
        if (error instanceof CancelledError) {
          ui.info('Cancelled.');
          process.exitCode = 130;
          return;
        }
        ui.error(error instanceof Error ? error.message : String(error));
        const expected =
          error instanceof MapInputError ||
          error instanceof ConfigError ||
          error instanceof NotInitializedError;
        if (!expected && error instanceof Error && error.stack) ui.info(dim(error.stack));
        process.exitCode = 1;
      }
    });
}
