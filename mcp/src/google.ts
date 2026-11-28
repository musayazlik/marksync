import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Google sign-in for the MCP server: the OAuth flow for installed apps
 * (PKCE, a redirect to 127.0.0.1), scope `drive.file` only. The refresh
 * token is kept in the user's config folder, readable only by the user.
 *
 * The OAuth client must be a "Desktop app" client in the same Google Cloud
 * project as the extension's client: `drive.file` gives access to the files
 * the project's apps created, so this client sees the Marksync folder.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface ClientConfig {
  clientId: string;
  clientSecret?: string;
}

interface Stored {
  refreshToken: string;
  clientId: string;
}

export function configDir(): string {
  if (process.env.MARKSYNC_MCP_HOME) return process.env.MARKSYNC_MCP_HOME;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'marksync-mcp');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'marksync-mcp');
}

const credentialsFile = () => join(configDir(), 'credentials.json');

export function clientFromEnv(): ClientConfig {
  const clientId = process.env.MARKSYNC_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error('Set MARKSYNC_GOOGLE_CLIENT_ID (and MARKSYNC_GOOGLE_CLIENT_SECRET) to the "Desktop app" OAuth client of your Marksync Google Cloud project.');
  }
  const clientSecret = process.env.MARKSYNC_GOOGLE_CLIENT_SECRET?.trim();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The address is printed too.
  }
}

async function tokenRequest(client: ClientConfig, params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}) };
}

/** Interactive sign-in (`marksync-mcp login`): opens the browser, waits for Google's redirect, stores the refresh token. */
export async function login(client: ClientConfig, log: (line: string) => void): Promise<void> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const err = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || (!got && !err)) {
        res.writeHead(400).end('Unexpected request.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(err ? `Sign-in failed: ${err}` : 'Marksync MCP is signed in. You can close this tab.');
      server.close();
      if (err) reject(new Error(`Google sign-in failed: ${err}`));
      else resolve({ code: got!, redirectUri });
    });
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      const url = `${AUTH}?${new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state,
      })}`;
      log(`Opening Google sign-in. If no browser opens, visit:\n${url}`);
      openBrowser(url);
    });
    setTimeout(() => {
      server.close();
      reject(new Error('Sign-in timed out after 5 minutes.'));
    }, 5 * 60_000).unref();
  });
  const tokens = await tokenRequest(client, { code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; run login again.');
  await mkdir(configDir(), { recursive: true });
  const stored: Stored = { refreshToken: tokens.refresh_token, clientId: client.clientId };
  await writeFile(credentialsFile(), JSON.stringify(stored), { mode: 0o600 });
  await chmod(credentialsFile(), 0o600).catch(() => undefined);
  cached = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}

export async function logout(): Promise<void> {
  await rm(credentialsFile(), { force: true });
  cached = undefined;
}

let cached: { token: string; expiresAt: number } | undefined;

/** A valid access token from the stored refresh token. */
export async function accessToken(client: ClientConfig): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  let stored: Stored;
  try {
    stored = JSON.parse(await readFile(credentialsFile(), 'utf8')) as Stored;
  } catch {
    throw new Error('Not signed in. Run `npx marksync-mcp login` once.');
  }
  if (stored.clientId !== client.clientId) throw new Error('Signed in with another OAuth client. Run `npx marksync-mcp login` again.');
  const tokens = await tokenRequest(client, { refresh_token: stored.refreshToken, grant_type: 'refresh_token' });
  cached = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  return cached.token;
}

export function forgetAccessToken(): void {
  cached = undefined;
}
