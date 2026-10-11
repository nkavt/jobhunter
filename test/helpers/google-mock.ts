import { http, HttpResponse, passthrough } from 'msw';
import type { SetupServer } from 'msw/node';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** A credentials file as downloaded from Google Cloud Console (Desktop app). */
export const CREDENTIALS_FILE = {
  installed: {
    client_id: 'test-client.apps.googleusercontent.com',
    project_id: 'jobhunter-test',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: 'test-secret',
    redirect_uris: ['http://localhost'],
  },
};

/** An unsigned ID token carrying just the email (we only decode it for display). */
export function idToken(email: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ email })}.sig`;
}

/** Let tests talk to the local callback server even though msw blocks unknown requests. */
export const allowLoopback = http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough());

/** Fake Google token endpoint; records every form it receives. */
export function tokenEndpoint(
  server: SetupServer,
  answer: (form: URLSearchParams) => Response = () =>
    HttpResponse.json({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
      id_token: idToken('alex@example.com'),
    }),
) {
  const forms: URLSearchParams[] = [];
  server.use(
    allowLoopback,
    http.post(TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      forms.push(form);
      return answer(form);
    }),
  );
  return forms;
}

/**
 * Plays the user's browser: opens the sign-in URL by calling the local redirect with the
 * given query (Google's answer). Returns the callback page's response.
 */
export function fakeBrowser(query: (state: string) => Record<string, string>) {
  const visits: Promise<Response>[] = [];
  const open = (url: string) => {
    const auth = new URL(url);
    const redirect = new URL(auth.searchParams.get('redirect_uri') ?? '');
    for (const [key, value] of Object.entries(query(auth.searchParams.get('state') ?? ''))) {
      redirect.searchParams.set(key, value);
    }
    visits.push(fetch(redirect));
  };
  return { open, visits };
}
