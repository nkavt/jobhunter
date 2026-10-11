import type { GoogleClient } from './credentials.js';
import { GoogleApiError, GoogleAuthError } from './errors.js';
import { getAccessToken } from './oauth.js';

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: { activationUrl?: string; serviceTitle?: string } }[];
  };
}

/** Call a Google REST API as the signed-in user; JSON in, JSON out. */
export async function googleRequest<T>(
  client: GoogleClient,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = await getAccessToken(client);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    throw new GoogleApiError("Couldn't reach Google. Check your connection and try again.", 0, {
      cause: error,
    });
  }

  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
  throw toError(response.status, body);
}

function toError(status: number, body: GoogleErrorBody): Error {
  const message = body.error?.message ?? `HTTP ${String(status)}`;
  const disabled = body.error?.details?.find((detail) => detail.reason === 'SERVICE_DISABLED');
  if (disabled) {
    const service = disabled.metadata?.serviceTitle ?? 'A required Google API';
    const link = disabled.metadata?.activationUrl;
    return new GoogleApiError(
      `${service} isn't enabled in your Google Cloud project.${link ? ` Enable it here, wait a minute, then try again: ${link}` : ''}`,
      status,
    );
  }
  if (status === 401) {
    return new GoogleAuthError(
      'Your Google sign-in is no longer valid. Run `jobhunter init` → Google Sheets connection.',
    );
  }
  return new GoogleApiError(`Google API error: ${message}`, status);
}
