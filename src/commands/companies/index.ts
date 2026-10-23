import type { Command } from 'commander';
import { ConfigError, NotInitializedError } from '../../config/index.js';
import { connectAdapter } from '../../llm/index.js';
import { CancelledError, createTerminalUi, dim } from '../../ui/index.js';
import { CompaniesSetupError, runCompaniesFind } from './find.js';

export { CompaniesSetupError, runCompaniesFind } from './find.js';
export type { CompaniesFindDeps, CompaniesFindOptions } from './find.js';

export function registerCompanies(program: Command): void {
  const companies = program
    .command('companies')
    .description("Companies' own job boards (Greenhouse, Lever, Ashby, Workable) that hunt reads");

  companies
    .command('find')
    .description(
      'Search the web for companies hiring for your roles, and remember their job boards',
    )
    .option('-f, --force', 'repeat the searches that ran in the last week too')
    .action(async (flags: { force?: boolean }) => {
      const ui = createTerminalUi();
      try {
        const result = await runCompaniesFind(
          { ui, connect: connectAdapter },
          flags.force ? { force: true } : {},
        );
        if (result?.stopped && result.stopped.reason !== 'rate-limited') process.exitCode = 1;
      } catch (error) {
        if (error instanceof CancelledError) {
          ui.info('Cancelled.');
          process.exitCode = 130;
          return;
        }
        ui.error(error instanceof Error ? error.message : String(error));
        const expected =
          error instanceof CompaniesSetupError ||
          error instanceof ConfigError ||
          error instanceof NotInitializedError;
        if (!expected && error instanceof Error && error.stack) ui.info(dim(error.stack));
        process.exitCode = 1;
      }
    });
}
