import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../config/fs.js';
import { googleTokenFile } from '../config/paths.js';
import type { GoogleClient } from './credentials.js';
import { GoogleAuthError } from './errors.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  // Only files Jobhunter creates (or the user picks); never the rest of their Drive.
  'https://www.googleapis.com/auth/drive.file',
] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
/** Refresh a little before expiry so a request never starts with an about-to-expire token. */
const REFRESH_MARGIN_MS = 60 * 1000;

export const GoogleTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
  scope: z.string(),
  email: z.string().optional(),
});
export type GoogleToken = z.infer<typeof GoogleTokenSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/** PKCE (S256): the verifier stays here; Google only ever sees its hash until the exchange. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    state: options.state,
    // A refresh token, so the user doesn't sign in again every hour.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface LoginOptions {
  /** Called with the sign-in URL once the local server is listening. */
  onUrl: (url: string) => void;
  timeoutMs?: number;
}

/**
 * Sign in with Google through the browser and save the token. A local server on a random
 * port receives Google's redirect; it accepts only the one callback it's waiting for.
 */
export async function login(client: GoogleClient, options: LoginOptions): Promise<GoogleToken> {
  const { verifier, challenge } = createPkce();
  const state = base64url(randomBytes(16));

  const { server, port, callback, fail } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${String(port)}`;
  const timeout = setTimeout(() => {
    fail(
      new GoogleAuthError('Timed out waiting for Google sign-in. Run it again when you are ready.'),
    );
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);

  try {
    options.onUrl(buildAuthUrl({ clientId: client.clientId, redirectUri, challenge, state }));
    const code = await callback;
    const token = await exchangeCode(client, { code, verifier, redirectUri });
    await saveToken(token);
    return token;
  } finally {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
}

async function startCallbackServer(expectedState: string): Promise<{
  server: Server;
  port: number;
  /** Resolves with the authorization code, or rejects if sign-in fails. */
  callback: Promise<string>;
  /** Reject the callback from outside, e.g. on timeout. */
  fail: (error: Error) => void;
}> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Avoid an unhandled rejection if the login is aborted before anyone awaits the callback.
  callback.catch(() => undefined);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (url.pathname !== '/' || (!code && !error)) {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      respond(response, 400, 'This sign-in link is not valid', 'Start again from the terminal.');
      rejectCode(new GoogleAuthError('The sign-in response did not match this login. Try again.'));
      return;
    }
    if (error) {
      respond(response, 200, 'Google sign-in was cancelled', 'You can close this tab.');
      rejectCode(
        new GoogleAuthError(
          error === 'access_denied'
            ? 'Google sign-in was cancelled. If Google said "access blocked", add your Google account under Test users on the OAuth consent screen.'
            : `Google sign-in failed: ${error}`,
        ),
      );
      return;
    }
    respond(
      response,
      200,
      '✅ Jobhunter is connected to Google',
      'You can close this tab and go back to the terminal.',
    );
    resolveCode(code ?? '');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, callback, fail: rejectCode };
}

function respond(
  response: import('node:http').ServerResponse,
  status: number,
  title: string,
  text: string,
): void {
  response
    .writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(
      `<!doctype html><meta charset="utf-8"><title>Jobhunter</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;text-align:center"><h1>${title}</h1><p>${text}</p></body>`,
    );
}

async function exchangeCode(
  client: GoogleClient,
  options: { code: string; verifier: string; redirectUri: string },
): Promise<GoogleToken> {
  const data = await postToken({
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (!data.refresh_token) {
    throw new GoogleAuthError('Google did not return a refresh token. Sign in again.');
  }
  const email = data.id_token ? emailFromIdToken(data.id_token) : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? GOOGLE_SCOPES.join(' '),
    ...(email ? { email } : {}),
  };
}

/** A valid access token, refreshed when it's about to expire. */
export async function getAccessToken(client: GoogleClient): Promise<string> {
  const token = await loadToken();
  if (!token) throw new GoogleAuthError('Not signed in to Google. Run `jobhunter init` → Google.');
  if (token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token.accessToken;

  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const refreshed: GoogleToken = {
    ...token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
  };
  await saveToken(refreshed);
  return refreshed.accessToken;
}

async function postToken(
  form: Record<string, string>,
): Promise<z.infer<typeof TokenResponseSchema>> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch (error) {
    throw new GoogleAuthError("Couldn't reach Google. Check your connection and try again.", {
      cause: error,
    });
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    if (body.error === 'invalid_grant') {
      throw new GoogleAuthError(
        'Your Google sign-in has expired or was revoked. Run `jobhunter init` → Google to sign in again. (Apps in "Testing" mode on the OAuth consent screen expire sign-ins after 7 days; publishing the app avoids that.)',
      );
    }
    if (body.error === 'invalid_client') {
      throw new GoogleAuthError(
        'Google rejected the OAuth client. Check the credentials file, or create a new Desktop app client.',
      );
    }
    throw new GoogleAuthError(`Google sign-in failed (${body.error ?? String(response.status)}).`);
  }
  const parsed = TokenResponseSchema.safeParse(body);
  if (!parsed.success) throw new GoogleAuthError('Google returned an unexpected response.');
  return parsed.data;
}

/** The account email from the ID token, for display only (the token came straight from Google over TLS). */
function emailFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const { email } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof email === 'string' ? email : undefined;
  } catch {
    return undefined;
  }
}

export async function loadToken(): Promise<GoogleToken | undefined> {
  return readJsonFile(googleTokenFile(), GoogleTokenSchema);
}

async function saveToken(token: GoogleToken): Promise<void> {
  await writeJsonFile(googleTokenFile(), token, { secret: true });
}

/** Revoke the token at Google (best effort) and forget it locally. */
export async function logout(): Promise<void> {
  const token = await loadToken();
  if (token) {
    await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: token.refreshToken }).toString()}`, {
      method: 'POST',
    }).catch(() => undefined);
  }
  await rm(googleTokenFile(), { force: true });
}
