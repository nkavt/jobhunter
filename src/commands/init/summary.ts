import { access } from 'node:fs/promises';
import { instructionsFile, readConfig, readProfile } from '../../config/index.js';
import { loadCredentials, loadToken } from '../../google/index.js';
import { dim, type Ui } from '../../ui/index.js';

/** The setup parts that are still missing, in the order `init` asks for them. */
export async function missingSetup(profileName: string): Promise<string[]> {
  const [config, profile, client, token, hasInstructions] = await Promise.all([
    readConfig(),
    readProfile(profileName),
    loadCredentials(),
    loadToken(),
    access(instructionsFile(profileName)).then(
      () => true,
      () => false,
    ),
  ]);

  const missing: string[] = [];
  if (!config) missing.push('AI provider and key');
  if (!profile?.cv) missing.push('CV');
  if (!profile?.preferences || !hasInstructions) missing.push('preferences and candidate profile');
  if (!profile?.localSheet) {
    if (profile?.sheet && (!client || !token)) missing.push('Google Sheets connection');
    else if (!profile?.sheet) missing.push('tracking sheet');
  }
  return missing;
}

/** Celebrate a complete setup, or say what's left. */
export async function finishInit(ui: Ui, profileName: string): Promise<void> {
  const missing = await missingSetup(profileName);
  ui.info('');
  if (missing.length === 0) {
    ui.success("You're all set. 🎉 Happy hunting! 🏹");
    ui.info(dim('Next: `jobhunter hunt` finds new jobs and scores them for you.'));
  } else {
    ui.info(`Almost there. Still to set up: ${missing.join(', ')}.`);
    ui.info(dim('Run `jobhunter init` again to finish.'));
  }
}
