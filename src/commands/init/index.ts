import type { Command } from 'commander';
import {
  ConfigError,
  configFile,
  readConfig,
  saveConfig,
  type Config,
} from '../../config/index.js';
import { ClaudeAdapter } from '../../llm/index.js';
import { CancelledError, createTerminalUi, dim, type Ui } from '../../ui/index.js';
import { SetupAbortedError, setupAi, type AiSetupDeps } from './ai-setup.js';

export async function runInit(deps: AiSetupDeps): Promise<void> {
  const { ui } = deps;
  const existing = await readExistingConfig(ui);

  if (existing) {
    const reconfigure = await ui.confirm({
      message: `Jobhunter is already set up (Claude · ${existing.model}). Change the AI provider, key or model?`,
      default: false,
    });
    if (!reconfigure) {
      ui.info('Nothing changed.');
      return;
    }
  }

  const ai = await setupAi(deps, existing);
  await saveConfig({
    version: 1,
    ...ai,
    activeProfile: existing?.activeProfile ?? 'default',
    ...(existing?.google ? { google: existing.google } : {}),
  });

  ui.success(`Saved to ${configFile()}`);
  ui.info(dim('Coming next in init: CV import, job preferences and Google Sheets.'));
}

/** A broken config file shouldn't block setup; start fresh and overwrite it. */
async function readExistingConfig(ui: Ui): Promise<Config | undefined> {
  try {
    return await readConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    ui.warn(`Your existing config can't be read, so setup will start fresh.\n${error.message}`);
    return undefined;
  }
}

/** Turn expected failures into a message + exit code instead of a stack trace. */
export function handleInitError(ui: Ui, error: unknown): void {
  if (error instanceof CancelledError) {
    ui.info('Cancelled. Nothing was saved.');
    process.exitCode = 130;
    return;
  }
  ui.error(error instanceof Error ? error.message : String(error));
  if (!(error instanceof SetupAbortedError) && error instanceof Error && error.stack) {
    ui.info(dim(error.stack));
  }
  process.exitCode = 1;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Set up Claude, import your CV, answer a few questions and connect Google Sheets')
    .action(async () => {
      const ui = createTerminalUi();
      try {
        await runInit({ ui, connect: (apiKey) => new ClaudeAdapter({ apiKey }) });
      } catch (error) {
        handleInitError(ui, error);
      }
    });
}
