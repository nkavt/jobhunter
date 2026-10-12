import type { Command } from 'commander';
import {
  ConfigError,
  configFile,
  readConfig,
  saveConfig,
  type Config,
} from '../../config/index.js';
import { openInBrowser } from '../../google/index.js';
import { ClaudeAdapter, getConfiguredAdapterName, type LLMAdapter } from '../../llm/index.js';
import { CancelledError, createTerminalUi, dim, type Ui } from '../../ui/index.js';
import { SetupAbortedError, setupAi } from './ai-setup.js';
import { importCv } from './cv-step.js';
import { finishInit } from './summary.js';
import { updateProfile } from './profile-step.js';
import { setupTracking } from './tracking-step.js';

export interface InitDeps {
  ui: Ui;
  /** Opens the Google sign-in page; tests replace it with a fake browser. */
  openBrowser: (url: string) => void;
  /** Build an adapter; the model only matters for generating (CV conversion etc.). */
  connect: (apiKey: string, model?: string) => LLMAdapter;
}

type Step = 'ai' | 'cv' | 'profile' | 'sheet';
const ALL_STEPS: Step[] = ['ai', 'cv', 'profile', 'sheet'];

export async function runInit(deps: InitDeps): Promise<void> {
  const { ui } = deps;
  const existing = await readExistingConfig(ui);
  const steps = existing ? await chooseSteps(ui, existing) : new Set<Step>(ALL_STEPS);
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
    };
    await saveConfig(config);
    ui.success(`Saved to ${configFile()}`);
  }

  if (!config) return;
  const llm = deps.connect(config.apiKey, config.model);
  const profileName = config.activeProfile;

  // A new CV changes the facts the profile is built from, so the profile step follows it.
  // Skipping the CV skips the profile step too, since there's nothing to build it from.
  let runProfile = steps.has('profile');
  if (steps.has('cv')) {
    const imported = await importCv({ ui, llm }, profileName);
    runProfile = imported !== undefined;
  }
  if (runProfile) await updateProfile({ ui, llm }, profileName);

  // A local .xlsx file by default; a Google Sheet needs the Google connection first.
  if (steps.has('sheet')) await setupTracking(deps, profileName);

  await finishInit(ui, profileName);
}

async function chooseSteps(ui: Ui, existing: Config): Promise<Set<Step>> {
  const choice = await ui.select<Step | 'all' | 'none'>({
    message: `Jobhunter is already set up with ${getConfiguredAdapterName(existing)}. What would you like to change?`,
    choices: [
      { name: 'Everything', value: 'all' },
      { name: 'AI provider, key or model', value: 'ai' },
      { name: 'CV (also updates your preferences and candidate profile)', value: 'cv' },
      { name: 'Preferences and candidate profile', value: 'profile' },
      { name: 'Tracking sheet (local file or Google Sheet)', value: 'sheet' },
      { name: 'Nothing, exit', value: 'none' },
    ],
    default: 'none',
  });
  if (choice === 'all') return new Set<Step>(ALL_STEPS);
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
    .description(
      'Set up Claude, import your CV, answer a few questions and create your tracking sheet',
    )
    .action(async () => {
      const ui = createTerminalUi();
      try {
        await runInit({
          ui,
          openBrowser: openInBrowser,
          connect: (apiKey, model) => new ClaudeAdapter({ apiKey, ...(model ? { model } : {}) }),
        });
      } catch (error) {
        handleInitError(ui, error);
      }
    });
}
