import { access } from 'node:fs/promises';
import type { Command } from 'commander';
import { loadConfig, NotInitializedError, readProfile } from '../../config/index.js';
import { openInBrowser, spreadsheetUrl } from '../../google/index.js';
import { createTerminalUi, type Ui } from '../../ui/index.js';

export interface SheetDeps {
  ui: Ui;
  /** Opens a URL in the browser, or a file in its default app. */
  openBrowser: (url: string) => void;
}

/** Print the tracking sheet's path or link (and open it with `open`). Returns false when there's none. */
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
  const local = profile?.localSheet?.path;
  if (local) {
    if (
      !(await access(local).then(
        () => true,
        () => false,
      ))
    ) {
      ui.error(
        `Can't find your tracking sheet at ${local}. Run \`jobhunter init\` to choose it again.`,
      );
      return false;
    }
    ui.info(local);
    if (options.open) deps.openBrowser(local);
    return true;
  }
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
    .description('Show where your tracking sheet is')
    .option(
      '-o, --open',
      'open it (in your spreadsheet app, or in your browser for a Google Sheet)',
    )
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
