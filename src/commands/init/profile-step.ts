import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cvFile,
  instructionsFile,
  profileDir,
  readProfile,
  saveProfile,
  type Derived,
} from '../../config/index.js';
import { writeFileAtomic } from '../../config/fs.js';
import { getAdapterName, type LLMAdapter } from '../../llm/index.js';
import { extractCvFacts } from '../../profile/facts.js';
import { generateInstructions } from '../../profile/instructions.js';
import { CancelledError, dim, type Ui } from '../../ui/index.js';
import { askPreferences } from './preferences-step.js';

export interface ProfileStepDeps {
  ui: Ui;
  llm: LLMAdapter;
}

/**
 * Read the facts from cv.md, ask the preference questions, then write instructions.md.
 * Returns `false` when there's no CV to work from yet.
 */
export async function updateProfile(deps: ProfileStepDeps, profileName: string): Promise<boolean> {
  const { ui, llm } = deps;
  const profile = await readProfile(profileName);
  if (!profile?.cv) {
    ui.info('Import your CV first; your preferences and candidate profile are based on it.');
    return false;
  }
  const cv = await readFile(cvFile(profileName), 'utf8');

  ui.info(
    dim(`Your CV is sent to ${getAdapterName(llm)} to read your roles, seniority and skills.`),
  );
  const facts = await ui.task(
    'Reading your CV…',
    () => extractCvFacts(cv, llm),
    () => 'Read your CV',
  );
  showFacts(ui, facts.derived);

  const preferences = await askPreferences(ui, {
    ...(profile.preferences ? { saved: profile.preferences } : {}),
    suggestions: facts.suggestions,
  });
  await saveProfile({ ...profile, derived: facts.derived, preferences });
  ui.success('Preferences saved');

  await writeCandidateProfile(deps, profileName, cv, facts.derived);
  return true;
}

/** Generate instructions.md on a draft, let the user review it, then save. */
async function writeCandidateProfile(
  { ui, llm }: ProfileStepDeps,
  profileName: string,
  cv: string,
  derived: Derived,
): Promise<void> {
  const draft = join(profileDir(profileName), 'instructions.draft.md');
  try {
    let generate = true;
    for (;;) {
      if (generate) {
        const { markdown } = await ui.task(
          'Writing your candidate profile…',
          () => generateInstructions(cv, derived, llm),
          () => 'Candidate profile written',
        );
        await writeFileAtomic(draft, markdown);
      }
      showInstructions(ui, await readFile(draft, 'utf8'));

      const choice = await ui.select<'ok' | 'edit' | 'regenerate' | 'cancel'>({
        message: 'This is how the AI will see you when scoring jobs. Does it look right?',
        choices: [
          { name: 'Yes, save it', value: 'ok' },
          { name: 'Edit it in my editor', value: 'edit' },
          { name: 'Write it again', value: 'regenerate' },
          { name: 'Cancel', value: 'cancel' },
        ],
        default: 'ok',
      });
      if (choice === 'cancel') throw new CancelledError();
      if (choice === 'ok') break;
      if (choice === 'edit') await ui.editFile(draft);
      generate = choice === 'regenerate';
    }
    await rename(draft, instructionsFile(profileName));
    ui.success(`Candidate profile saved to ${instructionsFile(profileName)}`);
  } finally {
    await rm(draft, { force: true });
  }
}

function showFacts(ui: Ui, derived: Derived): void {
  const list = (items: string[]) => (items.length > 0 ? items.join(', ') : dim('none found'));
  ui.info('');
  ui.info(`  Roles:      ${list(derived.roles)}`);
  ui.info(`  Seniority:  ${derived.seniority} · ${String(derived.yearsOfExperience)} years`);
  ui.info(`  Stack:      ${list(derived.tech.primary)}`);
  ui.info(`  Domains:    ${list(derived.domains)}`);
  ui.info('');
}

/** Show the profile's "## Summary" section and the other section names. */
function showInstructions(ui: Ui, markdown: string): void {
  const sections = markdown.split(/^## /m).slice(1);
  const summary = sections.find((section) => section.startsWith('Summary'));
  const summaryText = summary?.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  ui.info('');
  if (summaryText) ui.info(`  ${summaryText}`);
  ui.info(
    dim(
      `  Sections: ${sections.map((section) => section.split('\n')[0]?.trim() ?? '').join(', ')}`,
    ),
  );
  ui.info('');
}
