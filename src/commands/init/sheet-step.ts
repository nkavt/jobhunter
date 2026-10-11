import { readProfile, saveProfile, type Profile } from '../../config/index.js';
import {
  createTrackingSheet,
  getFile,
  GoogleApiError,
  GoogleAuthError,
  loadCredentials,
  loadToken,
  spreadsheetUrl,
} from '../../google/index.js';
import type { Ui } from '../../ui/index.js';

export interface SheetStepDeps {
  ui: Ui;
  /** Time zone for the new sheet; defaults to the machine's. */
  timeZone?: string;
}

/** Create (or keep) the tracking sheet and remember it in profile.json. */
export async function setupSheet(deps: SheetStepDeps, profileName: string): Promise<void> {
  const { ui } = deps;
  const [client, token] = await Promise.all([loadCredentials(), loadToken()]);
  if (!client || !token) {
    ui.info('Connect Google first; the tracking sheet lives in your Drive.');
    return;
  }

  const profile: Profile = (await readProfile(profileName)) ?? { version: 1, name: profileName };
  const existingId = profile.sheet?.spreadsheetId;

  for (;;) {
    try {
      if (existingId) {
        const file = await ui.task(
          'Checking your tracking sheet…',
          () => getFile(client, existingId),
          () => 'Checked your tracking sheet',
        );
        if (file && !file.trashed) {
          const url = file.webViewLink ?? spreadsheetUrl(existingId);
          const choice = await ui.select<'keep' | 'new'>({
            message: `Your tracking sheet: ${url}`,
            choices: [
              { name: 'Keep using it', value: 'keep' },
              { name: 'Create a new one', value: 'new' },
            ],
            default: 'keep',
          });
          if (choice === 'keep') return;
        } else {
          ui.warn("Your tracking sheet was deleted or Jobhunter can't open it anymore.");
          if (!(await offerCreate(ui))) return;
        }
      } else if (!(await offerCreate(ui))) {
        return;
      }

      const sheet = await ui.task(
        'Creating your tracking sheet…',
        () =>
          createTrackingSheet(client, {
            title: profileName === 'default' ? 'Jobhunter' : `Jobhunter – ${profileName}`,
            timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        () => 'Tracking sheet created',
      );
      await saveProfile({
        ...profile,
        sheet: {
          spreadsheetId: sheet.spreadsheetId,
          folderId: sheet.folderId,
          columns: null,
          statusMap: null,
        },
      });
      ui.success(
        `Your tracking sheet is ready in the Jobhunter folder of your Drive: ${sheet.url}`,
      );
      return;
    } catch (error) {
      if (!(error instanceof GoogleApiError || error instanceof GoogleAuthError)) throw error;
      ui.error(error.message);
      const next = await ui.select<'retry' | 'skip'>({
        message: 'What would you like to do?',
        choices: [
          { name: 'Try again', value: 'retry' },
          { name: 'Skip for now', value: 'skip' },
        ],
      });
      if (next === 'skip') {
        ui.info('Skipped. Run `jobhunter init` again to create your tracking sheet.');
        return;
      }
    }
  }
}

async function offerCreate(ui: Ui): Promise<boolean> {
  const choice = await ui.select<'create' | 'existing' | 'skip'>({
    message: 'Tracking sheet',
    choices: [
      { name: 'Create a new tracking sheet', value: 'create' },
      { name: 'Use an existing sheet', value: 'existing', disabled: 'coming soon' },
      { name: 'Skip for now', value: 'skip' },
    ],
    default: 'create',
  });
  if (choice === 'skip')
    ui.info('Skipped. Run `jobhunter init` again to create your tracking sheet.');
  return choice === 'create';
}
