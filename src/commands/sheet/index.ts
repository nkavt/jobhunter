import type { Command } from 'commander';
import { loadConfig, NotInitializedError, readProfile } from '../../config/index.js';
import { openInBrowser, spreadsheetUrl } from '../../google/index.js';
import { createTerminalUi, type Ui } from '../../ui/index.js';

export interface SheetDeps {
  ui: Ui;
  openBrowser: (url: string) => void;
}

/** Print the tracking sheet's link (and open it with `open`). Returns false when there's none. */
export async function showSheet(
  deps: SheetDeps,
  options: { open?: boolean } = {},
): Promise<boolean> {
  const { ui } = deps;
  const config = await loadConfig().catch((error: unknown) => {
    if (error instanceof NotInitializedError) return undefined;
    throw error;
  });
  const profile = config && (await readProfile(config.activeProfile));
  if (!profile?.sheet) {
    ui.error('No tracking sheet yet. Run `jobhunter init` to create one.');
    return false;
  }
  const url = spreadsheetUrl(profile.sheet.spreadsheetId);
  ui.info(url);
  if (options.open) deps.openBrowser(url);
  return true;
}

export function registerSheet(program: Command): void {
  program
    .command('sheet')
    .description('Show the link to your tracking sheet')
    .option('-o, --open', 'open it in your browser')
    .action(async (flags: { open?: boolean }) => {
      const ui = createTerminalUi();
      try {
        if (!(await showSheet({ ui, openBrowser: openInBrowser }, flags))) process.exitCode = 1;
      } catch (error) {
        ui.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
