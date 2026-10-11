import type { Command } from 'commander';
import {
  ConfigError,
  configFile,
  readConfig,
  saveConfig,
  type Config,
} from '../../config/index.js';
import { ClaudeAdapter, type LLMAdapter } from '../../llm/index.js';
import { CancelledError, createTerminalUi, dim, type Ui } from '../../ui/index.js';
import { SetupAbortedError, setupAi } from './ai-setup.js';
import { importCv } from './cv-step.js';

export interface InitDeps {
  ui: Ui;
  /** Build an adapter; the model only matters for generating (CV conversion etc.). */
  connect: (apiKey: string, model?: string) => LLMAdapter;
}

type Step = 'ai' | 'cv';

export async function runInit(deps: InitDeps): Promise<void> {
  const { ui } = deps;
  const existing = await readExistingConfig(ui);
  const steps = existing ? await chooseSteps(ui, existing) : new Set<Step>(['ai', 'cv']);
  if (steps.size === 0) {
    ui.info('Nothing changed.');
    return;
  }

  let config = existing;
  if (steps.has('ai')) {
    const ai = await setupAi(deps, existing);
    config = {
      version: 1,
      ...ai,
      activeProfile: existing?.activeProfile ?? 'default',
      ...(existing?.google ? { google: existing.google } : {}),
    };
    await saveConfig(config);
    ui.success(`Saved to ${configFile()}`);
  }

  if (steps.has('cv') && config) {
    await importCv({ ui, llm: deps.connect(config.apiKey, config.model) }, config.activeProfile);
  }

  ui.info(dim('Coming next in init: job preferences and Google Sheets.'));
}

async function chooseSteps(ui: Ui, existing: Config): Promise<Set<Step>> {
  const choice = await ui.select<Step | 'all' | 'none'>({
    message: `Jobhunter is already set up (Claude · ${existing.model}). What would you like to change?`,
    choices: [
      { name: 'Everything', value: 'all' },
      { name: 'AI provider, key or model', value: 'ai' },
      { name: 'CV', value: 'cv' },
      { name: 'Nothing, exit', value: 'none' },
    ],
    default: 'none',
  });
  if (choice === 'all') return new Set<Step>(['ai', 'cv']);
  if (choice === 'none') return new Set<Step>();
  return new Set<Step>([choice]);
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
    ui.info('Cancelled. Nothing more was saved.');
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
        await runInit({
          ui,
          connect: (apiKey, model) => new ClaudeAdapter({ apiKey, ...(model ? { model } : {}) }),
        });
      } catch (error) {
        handleInitError(ui, error);
      }
    });
}
