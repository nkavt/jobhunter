import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { googleTokenFile } from '../../src/config/index.js';
import {
  buildAuthUrl,
  createPkce,
  getAccessToken,
  GoogleAuthError,
  loadToken,
  login,
  logout,
  type GoogleClient,
} from '../../src/google/index.js';
import { useMockServer } from '../helpers/anthropic-mock.js';
import { allowLoopback, fakeBrowser, REVOKE_URL, tokenEndpoint } from '../helpers/google-mock.js';
import { isWindows, useTempHome } from '../helpers/temp-home.js';

const client: GoogleClient = { clientId: 'client-1', clientSecret: 'secret-1' };

describe('PKCE and the sign-in URL', () => {
  it('derives the challenge from the verifier with SHA-256', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('asks only for email and files Jobhunter creates, with a refresh token', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:5000',
        challenge: 'ch',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'c',
      redirect_uri: 'http://127.0.0.1:5000',
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
      access_type: 'offline',
      prompt: 'consent',
    });
  });
});

describe('Google sign-in through the local server', () => {
  useTempHome();
  const server = useMockServer();

  it('exchanges the code from the browser redirect and saves the token privately', async () => {
    const forms = tokenEndpoint(server);
    const browser = fakeBrowser((state) => ({ code: 'code-1', state }));
    let signInUrl = '';

    const token = await login(client, {
      onUrl: (url) => {
        signInUrl = url;
        browser.open(url);
      },
    });

    expect(token).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      email: 'alex@example.com',
    });
    expect(await loadToken()).toEqual(token);
    if (!isWindows) expect((await stat(googleTokenFile())).mode & 0o777).toBe(0o600);

    const page = await browser.visits[0];
    expect(page?.status).toBe(200);
    expect(await page?.text()).toContain('Jobhunter is connected to Google');

    const redirectUri = new URL(signInUrl).searchParams.get('redirect_uri') ?? '';
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const form = forms[0];
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('code')).toBe('code-1');
    expect(form?.get('redirect_uri')).toBe(redirectUri);
    expect(
      createHash('sha256')
        .update(form?.get('code_verifier') ?? '')
        .digest('base64url'),
    ).toBe(new URL(signInUrl).searchParams.get('code_challenge'));
  });

  it('ignores stray requests like /favicon.ico', async () => {
    tokenEndpoint(server);
    let stray: Response | undefined;
    const browser = fakeBrowser((state) => ({ code: 'code-1', state }));

    await login(client, {
      onUrl: (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
        void fetch(new URL('/favicon.ico', redirect)).then((response) => {
          stray = response;
          browser.open(url);
        });
      },
    });

    expect(stray?.status).toBe(404);
  });

  it('rejects a callback with the wrong state', async () => {
    tokenEndpoint(server);
    const browser = fakeBrowser(() => ({ code: 'code-1', state: 'forged' }));
    await expect(login(client, { onUrl: browser.open })).rejects.toThrow(
      'did not match this login',
    );
    expect((await browser.visits[0])?.status).toBe(400);
  });

  it('explains a cancelled or blocked sign-in', async () => {
    server.use(allowLoopback);
    const browser = fakeBrowser((state) => ({ error: 'access_denied', state }));
    await expect(login(client, { onUrl: browser.open })).rejects.toThrow(
      'add your Google account under Test users',
    );
  });

  it('gives up after the timeout', async () => {
    await expect(login(client, { onUrl: () => undefined, timeoutMs: 20 })).rejects.toThrow(
      'Timed out waiting for Google sign-in',
    );
  });

  it('needs a refresh token', async () => {
    tokenEndpoint(server, () => HttpResponse.json({ access_token: 'a', expires_in: 3600 }));
    const browser = fakeBrowser((state) => ({ code: 'c', state }));
    await expect(login(client, { onUrl: browser.open })).rejects.toThrow(
      'did not return a refresh token',
    );
  });
});

describe('access tokens', () => {
  useTempHome();
  const server = useMockServer();

  async function signedIn(expiresIn: number) {
    tokenEndpoint(server, () =>
      HttpResponse.json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: expiresIn,
      }),
    );
    const browser = fakeBrowser((state) => ({ code: 'c', state }));
    await login(client, { onUrl: browser.open });
  }

  it('reuses a token that is still valid', async () => {
    await signedIn(3600);
    expect(await getAccessToken(client)).toBe('access-1');
  });

  it('refreshes a token that is about to expire, keeping the refresh token', async () => {
    await signedIn(30);
    const forms = tokenEndpoint(server, () =>
      HttpResponse.json({ access_token: 'access-2', expires_in: 3600 }),
    );

    expect(await getAccessToken(client)).toBe('access-2');
    expect(forms[0]?.get('grant_type')).toBe('refresh_token');
    expect(forms[0]?.get('refresh_token')).toBe('refresh-1');
    expect(await loadToken()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' });
  });

  it('explains an expired or revoked sign-in', async () => {
    await signedIn(0);
    tokenEndpoint(server, () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }));
    const error = await getAccessToken(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleAuthError);
    expect((error as Error).message).toContain('expired or was revoked');
    expect((error as Error).message).toContain('7 days');
  });

  it('asks to sign in when there is no token', async () => {
    await expect(getAccessToken(client)).rejects.toThrow('Not signed in to Google');
  });

  it('logs out by revoking at Google and deleting the token', async () => {
    await signedIn(3600);
    const revoked: string[] = [];
    server.use(
      http.post(REVOKE_URL, ({ request }) => {
        revoked.push(new URL(request.url).searchParams.get('token') ?? '');
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await logout();

    expect(revoked).toEqual(['refresh-1']);
    await expect(access(googleTokenFile())).rejects.toThrow();
  });
});
