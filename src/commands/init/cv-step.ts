import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cvFile,
  profileDir,
  readProfile,
  saveProfile,
  type CvInfo,
  type Profile,
} from '../../config/index.js';
import { writeFileAtomic } from '../../config/fs.js';
import type { LLMAdapter } from '../../llm/index.js';
import { convertCv, CvError, loadCv, summariseCv } from '../../profile/cv.js';
import { CancelledError, dim, type Ui } from '../../ui/index.js';

export interface CvStepDeps {
  ui: Ui;
  llm: LLMAdapter;
}

/**
 * Ask for the CV, convert it to Markdown, let the user check it, then save `cv.md` and the
 * CV info in profile.json. Returns `undefined` when the user skips the step.
 */
export async function importCv(deps: CvStepDeps, profileName: string): Promise<CvInfo | undefined> {
  const { ui } = deps;
  const profile: Profile = (await readProfile(profileName)) ?? { version: 1, name: profileName };
  // Drafts are edited separately, so cancelling never overwrites an existing cv.md.
  const draft = join(profileDir(profileName), 'cv.draft.md');

  try {
    for (;;) {
      const answer = await ui.input({
        message: profile.cv
          ? 'Path to your CV (PDF, DOCX, MD or TXT)'
          : `Path to your CV (PDF, DOCX, MD or TXT) ${dim('(Enter to skip for now)')}`,
        ...(profile.cv ? { default: profile.cv.sourcePath } : {}),
      });
      if (!answer.trim()) {
        ui.info('Skipped. Run `jobhunter init` again to import your CV.');
        return undefined;
      }

      let cv;
      try {
        cv = await loadCv(answer);
      } catch (error) {
        if (!(error instanceof CvError)) throw error;
        ui.error(error.message);
        continue;
      }

      const usesAi = cv.kind === 'pdf' || cv.kind === 'docx';
      if (usesAi) ui.info(dim('Your CV is sent to Claude (Anthropic) to convert it to Markdown.'));
      const { markdown } = await ui.task(
        usesAi ? 'Converting your CV…' : 'Reading your CV…',
        () => convertCv(cv, deps.llm),
        () => (usesAi ? 'CV converted' : 'CV read'),
      );
      await writeFileAtomic(draft, markdown);

      const decision = await reviewDraft(ui, draft);
      if (decision === 'other') continue;

      await rename(draft, cvFile(profileName));
      const info: CvInfo = {
        sourcePath: cv.path,
        sha256: cv.sha256,
        parsedAt: new Date().toISOString(),
      };
      await saveProfile({ ...profile, cv: info });
      ui.success(`CV saved to ${cvFile(profileName)}`);
      return info;
    }
  } finally {
    await rm(draft, { force: true });
  }
}

/** Show what was understood; loop through edits until the user accepts or picks another file. */
async function reviewDraft(ui: Ui, draft: string): Promise<'ok' | 'other'> {
  for (;;) {
    showSummary(ui, await readFile(draft, 'utf8'));
    const choice = await ui.select<'ok' | 'edit' | 'other' | 'cancel'>({
      message: 'Does this look right?',
      choices: [
        { name: 'Yes, save it', value: 'ok' },
        { name: 'Edit it in my editor', value: 'edit' },
        { name: 'Use a different file', value: 'other' },
        { name: 'Cancel', value: 'cancel' },
      ],
      default: 'ok',
    });
    if (choice === 'cancel') throw new CancelledError();
    if (choice !== 'edit') return choice;
    await ui.editFile(draft);
  }
}

function showSummary(ui: Ui, markdown: string): void {
  const summary = summariseCv(markdown);
  ui.info('');
  ui.info(`  Name:      ${summary.name ?? dim('not found')}`);
  ui.info(
    `  Sections:  ${summary.sections.length > 0 ? summary.sections.join(', ') : dim('none found')}`,
  );
  ui.info(`  Roles:     ${String(summary.roles)}`);
  ui.info('');
}
