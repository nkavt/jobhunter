import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, sep } from 'node:path';
import { readProfile, saveProfile, type Profile } from '../../config/index.js';
import { createLocalSheet, inspectLocalSheet } from '../../tracker/index.js';
import { resolveUserPath } from '../../util/user-path.js';
import { connectGoogle, type GoogleStepDeps } from './google-step.js';
import { setupSheet } from './sheet-step.js';

export interface TrackingStepDeps extends GoogleStepDeps {
  now?: () => Date;
}

type Where = 'local' | 'google' | 'skip';

/** Ask where jobs are tracked: a local .xlsx file (default) or a Google Sheet. */
export async function setupTracking(deps: TrackingStepDeps, profileName: string): Promise<void> {
  const { ui } = deps;
  const profile = await loadOrNew(profileName);
  const current: Where = profile.localSheet ? 'local' : profile.sheet ? 'google' : 'local';

  const where = await ui.select<Where>({
    message: 'Where should Jobhunter track jobs?',
    choices: [
      {
        name: 'In a spreadsheet file on this computer (.xlsx)',
        value: 'local',
        description: 'Open it in LibreOffice or Excel. No Google setup needed.',
      },
      {
        name: 'In a Google Sheet',
        value: 'google',
        description: 'Needs your own Google Cloud project (about 10 minutes, once).',
      },
      { name: 'Skip for now', value: 'skip' },
    ],
    default: current,
  });
  if (where === 'skip') {
    ui.info('Skipped. Run `jobhunter init` again to set up your tracking sheet.');
    return;
  }
  if (where === 'local') {
    await chooseLocalSheet(deps, profileName);
    return;
  }

  if (!(await connectGoogle(deps))) return;
  await setupSheet({ ui }, profileName);
  // A Google Sheet replaces the local file, if there was one.
  const updated = await loadOrNew(profileName);
  if (updated.sheet && updated.localSheet) {
    const withoutLocal: Profile = { ...updated };
    delete withoutLocal.localSheet;
    await saveProfile(withoutLocal);
  }
}

/** `~/Documents/jobhunter.xlsx`, or `jobhunter-<profile>.xlsx` for other profiles. */
export function defaultSheetPath(profileName: string): string {
  const file = profileName === 'default' ? 'jobhunter.xlsx' : `jobhunter-${profileName}.xlsx`;
  return join(homedir(), 'Documents', file);
}

/** Show paths under the home folder as `~/…`. */
export function shortPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Turn what the user typed into the sheet's file path: a folder gets `jobhunter.xlsx` inside it,
 * a name without extension gets `.xlsx`. Returns an error message for other file types.
 */
export async function resolveSheetPath(
  input: string,
  fileName: string,
): Promise<{ path: string } | { error: string }> {
  let path = resolveUserPath(input);
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) path = join(path, fileName);
  const extension = extname(path).toLowerCase();
  if (extension === '') path += '.xlsx';
  else if (extension !== '.xlsx') {
    return {
      error: `Jobhunter keeps your sheet as an .xlsx file, which LibreOffice and Excel open. Use a name ending in .xlsx.`,
    };
  }
  return { path };
}

async function chooseLocalSheet(deps: TrackingStepDeps, profileName: string): Promise<void> {
  const { ui } = deps;
  const profile = await loadOrNew(profileName);
  const current = profile.localSheet?.path;
  const fallback = defaultSheetPath(profileName);

  for (;;) {
    const answer = await ui.input({
      message: 'Where should the file live? (a file or folder)',
      default: shortPath(current ?? fallback),
    });
    const resolved = await resolveSheetPath(answer, fallback.split(sep).pop() ?? 'jobhunter.xlsx');
    if ('error' in resolved) {
      ui.error(resolved.error);
      continue;
    }
    const { path } = resolved;

    const state = await inspectLocalSheet(path);
    if (state === 'other') {
      ui.warn(
        `${shortPath(path)} already exists and isn't a Jobhunter tracking sheet. Jobhunter won't overwrite it, so choose another name.`,
      );
      continue;
    }
    if (state === 'jobhunter') {
      if (path !== current) {
        const reuse = await ui.confirm({
          message: `${shortPath(path)} is already a Jobhunter tracking sheet. Use it and keep its jobs?`,
          default: true,
        });
        if (!reuse) continue;
      }
    } else {
      const folder = dirname(path);
      if (!(await stat(folder).catch(() => undefined))) {
        const create = await ui.confirm({
          message: `The folder ${shortPath(folder)} doesn't exist. Create it?`,
          default: true,
        });
        if (!create) continue;
        await mkdir(folder, { recursive: true });
      }
      await ui.task(
        'Creating your tracking sheet…',
        () => createLocalSheet(path, deps.now?.() ?? new Date()),
        () => `Tracking sheet created: ${shortPath(path)}`,
      );
    }

    await saveProfile({ ...(await loadOrNew(profileName)), localSheet: { path } });
    if (state === 'jobhunter') ui.success(`Tracking jobs in ${shortPath(path)}`);
    ui.info('Close the file before running `jobhunter hunt`, so the new jobs can be added.');
    return;
  }
}

async function loadOrNew(profileName: string): Promise<Profile> {
  return (await readProfile(profileName)) ?? { version: 1, name: profileName };
}
