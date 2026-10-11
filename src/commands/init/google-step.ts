import {
  GoogleAuthError,
  importCredentials,
  loadCredentials,
  loadToken,
  login,
  type GoogleClient,
  type GoogleToken,
} from '../../google/index.js';
import { CancelledError, dim, type Ui } from '../../ui/index.js';

export interface GoogleStepDeps {
  ui: Ui;
  /** Opens the sign-in page; tests replace it with a fake browser. */
  openBrowser: (url: string) => void;
}

const SETUP_GUIDE = [
  'Jobhunter writes jobs to a Google Sheet in your Drive. For that it needs your own Google',
  'OAuth client (free, about 10 minutes, once):',
  '  1. console.cloud.google.com → create a project',
  '  2. APIs & Services → Library → enable "Google Sheets API" and "Google Drive API"',
  '  3. OAuth consent screen → External → add your Google account under Test users',
  '  4. Credentials → Create credentials → OAuth client ID → Desktop app → Download JSON',
];

/**
 * Connect Google: credentials file → browser sign-in. The saved credentials and token files are
 * the whole state. Returns whether Jobhunter is connected afterwards.
 */
export async function connectGoogle(deps: GoogleStepDeps): Promise<boolean> {
  const { ui } = deps;
  const [savedClient, savedToken] = await Promise.all([loadCredentials(), loadToken()]);

  let replaceCredentials = false;
  if (savedClient && savedToken) {
    const choice = await ui.select<'keep' | 'login' | 'credentials'>({
      message: `Google: connected as ${savedToken.email ?? 'your Google account'}`,
      choices: [
        { name: 'Keep it', value: 'keep' },
        { name: 'Sign in again (e.g. with a different account)', value: 'login' },
        { name: 'Use a different credentials file', value: 'credentials' },
      ],
      default: 'keep',
    });
    if (choice === 'keep') return true;
    replaceCredentials = choice === 'credentials';
  } else {
    const choice = await ui.select<'connect' | 'skip'>({
      message:
        'Connect Google Sheets? Jobhunter tracks every job it finds in a sheet in your Drive',
      choices: [
        { name: 'Connect now', value: 'connect' },
        { name: 'Skip for now', value: 'skip' },
      ],
      default: 'connect',
    });
    if (choice === 'skip') {
      ui.info('Skipped. Run `jobhunter init` again to connect Google Sheets.');
      return false;
    }
  }

  const client = (replaceCredentials ? undefined : savedClient) ?? (await askForCredentials(ui));

  for (;;) {
    try {
      const token = await signIn(deps, client);
      ui.success(`Connected as ${token.email ?? 'your Google account'}`);
      return true;
    } catch (error) {
      if (!(error instanceof GoogleAuthError)) throw error;
      ui.error(error.message);
      const next = await ui.select<'retry' | 'skip'>({
        message: 'What would you like to do?',
        choices: [
          { name: 'Try again', value: 'retry' },
          { name: 'Skip for now', value: 'skip' },
        ],
      });
      if (next === 'skip') {
        ui.info('Skipped. Run `jobhunter init` again to connect Google Sheets.');
        return false;
      }
    }
  }
}

async function askForCredentials(ui: Ui): Promise<GoogleClient> {
  ui.info('');
  for (const line of SETUP_GUIDE) ui.info(line);
  ui.info('');
  for (;;) {
    const answer = await ui.input({
      message: 'Path to the downloaded credentials file (client_secret_….json)',
    });
    if (!answer.trim()) throw new CancelledError();
    try {
      const { client } = await importCredentials(answer);
      ui.success('Credentials saved');
      return client;
    } catch (error) {
      if (!(error instanceof GoogleAuthError)) throw error;
      ui.error(error.message);
    }
  }
}

async function signIn(deps: GoogleStepDeps, client: GoogleClient): Promise<GoogleToken> {
  const { ui } = deps;
  return login(client, {
    onUrl: (url) => {
      ui.info('Sign in with Google in your browser, then come back here.');
      ui.info(dim(`If the browser doesn't open, go to:\n${url}`));
      deps.openBrowser(url);
    },
  });
}
