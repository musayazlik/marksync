import { browser } from 'wxt/browser';
import { googleClientId, patchStatus, resetAccountState, statusItem, tokenItem } from '../shared/state';

/**
 * Google sign-in with `identity.launchWebAuthFlow`, which works in Chrome,
 * Brave, Edge and Firefox. (`identity.getAuthToken` only works in Chrome
 * with a signed-in Google profile, so it is not used.)
 *
 * The token flow returns a one-hour access token and no refresh token. When
 * it expires, the same flow runs again without a window (`prompt=none`);
 * this succeeds as long as the user is still signed in to Google in this
 * browser. Otherwise the popup asks them to reconnect.
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = [DRIVE_SCOPE, 'openid', 'email'];

export class AuthRequiredError extends Error {
  constructor(message = 'Reconnect your Google account to keep syncing.') {
    super(message);
  }
}

export class ConfigError extends Error {}

/** The URL to register as an "Authorized redirect URI" in Google Cloud. */
export function redirectUrl(): string {
  return browser.identity.getRedirectURL();
}

function clientId(): string {
  const id = googleClientId();
  // Only happens in a self-made build without .env, never in a store build.
  if (!id) throw new ConfigError('This build has no Google OAuth client ID (WXT_GOOGLE_CLIENT_ID). See docs/GOOGLE_SETUP.md.');
  return id;
}

/**
 * Bumped on every disconnect. A sign-in flow that was still running when the
 * user disconnected must not store its token afterwards.
 */
let authGeneration = 0;

async function runFlow(interactive: boolean, loginHint?: string): Promise<string> {
  const generation = authGeneration;
  const state = crypto.randomUUID();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId(),
    response_type: 'token',
    redirect_uri: redirectUrl(),
    scope: SCOPES.join(' '),
    state,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();

  let result: string | undefined;
  try {
    result = await browser.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (err) {
    if (!interactive) throw new AuthRequiredError();
    throw err;
  }
  if (!result) throw new AuthRequiredError();

  const params = new URLSearchParams(new URL(result).hash.slice(1));
  const error = params.get('error');
  if (error) throw new AuthRequiredError(`Google sign-in failed: ${error}`);
  if (params.get('state') !== state) throw new Error('Google sign-in returned an unexpected state.');
  if (!params.get('scope')?.split(' ').includes(DRIVE_SCOPE)) {
    throw new AuthRequiredError('Google Drive access was not granted. Connect again and allow Drive access.');
  }

  const accessToken = params.get('access_token');
  if (!accessToken) throw new AuthRequiredError();
  if (generation !== authGeneration) throw new AuthRequiredError('Disconnected while signing in.');
  const expiresIn = Number(params.get('expires_in'));
  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 3600) : 3600;
  await tokenItem.setValue({ accessToken, expiresAt: Date.now() + lifetime * 1000 });
  return accessToken;
}

/** Email of the Google account a token belongs to, or undefined if it cannot be read. */
async function tokenEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { email?: unknown };
    return typeof info.email === 'string' ? info.email : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the Google consent window and links the account. */
export async function connect(): Promise<string> {
  const previous = (await statusItem.getValue()).email;
  const token = await runFlow(true);
  const email = await tokenEmail(token);
  // Another account (or one we cannot identify): start from a clean state so
  // nothing from the previous account's Drive is merged into this one.
  if (!email || email !== previous) await resetAccountState();
  await patchStatus({ connected: true, email, error: undefined });
  return email ?? '';
}

/** Returns a valid access token, refreshing it silently when needed. */
export async function getAccessToken(): Promise<string> {
  const { connected, email } = await statusItem.getValue();
  if (!connected) {
    await tokenItem.removeValue();
    throw new AuthRequiredError('Connect your Google account first.');
  }
  const cached = await tokenItem.getValue();
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
  const token = await runFlow(false, email);
  // login_hint is only a hint: make sure the refreshed token belongs to the
  // connected account before using it.
  const actual = await tokenEmail(token);
  if (email && actual && actual !== email) {
    await tokenItem.removeValue();
    throw new AuthRequiredError(`Google returned a different account (${actual}). Reconnect to continue.`);
  }
  return token;
}

export async function invalidateToken(): Promise<void> {
  await tokenItem.removeValue();
}

/**
 * Unlinks the account in this browser only: stops syncing, forgets the
 * access token and everything tied to the account.
 *
 * The token is deliberately not sent to Google's revoke endpoint. Revoking
 * removes Marksync's whole grant for the account, so every other connected
 * browser would fail its silent token refresh and have to reconnect. The
 * forgotten token expires on its own within an hour. Users who want to
 * remove access everywhere can do so at https://myaccount.google.com/permissions.
 */
export async function disconnect(): Promise<void> {
  authGeneration++;
  await patchStatus({ connected: false, email: undefined, error: undefined });
  await tokenItem.removeValue();
  await resetAccountState();
}
