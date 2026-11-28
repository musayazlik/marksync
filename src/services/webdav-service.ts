import { browser } from 'wxt/browser';
import { DriveError } from '../platform/drive';
import { parseWebDavUrl, WebDavClient } from '../platform/webdav';
import { t } from '../shared/i18n';
import { backendItem, patchStatus, resetAccountState, statusItem } from '../shared/state';
import { useBackend } from './drive-store';

/**
 * Connecting to a WebDAV server instead of Google Drive (Nextcloud,
 * ownCloud, a NAS...). The same files and folders are kept there
 * (Marksync/sync-state.json, backups/, browsers/...), with the same
 * encryption when it is on.
 */

export interface WebDavLogin {
  url: string;
  username: string;
  password: string;
}

/** The host permission the server needs. */
export function webDavOrigin(url: string): string | undefined {
  const u = parseWebDavUrl(url);
  return u ? `${u.protocol}//${u.hostname}/*` : undefined;
}

/** Checks the address and the login, then makes this browser use the server. Returns the label shown as "connected as". */
export async function connectWebDav(input: WebDavLogin): Promise<string> {
  const url = parseWebDavUrl(input.url);
  if (!url) throw new Error(t('webdavInvalidUrl'));
  const username = input.username.trim();
  if (!username || username.length > 200 || !input.password || input.password.length > 1000) throw new Error(t('webdavMissingLogin'));
  const origin = webDavOrigin(url.href)!;
  if (!(await browser.permissions.contains({ origins: [origin] }))) throw new Error(t('aiPermissionMissingHost', url.host));
  const config = { url: url.href, username, password: input.password };
  try {
    await new WebDavClient(config).getMeta('');
  } catch (err) {
    if (err instanceof DriveError && (err.status === 401 || err.status === 403)) throw new Error(t('webdavAuthFailed'));
    if (err instanceof DriveError && err.status === 404) throw new Error(t('webdavNotFound'));
    if (err instanceof DriveError && err.status === 405) throw new Error(t('webdavNotDav'));
    if (err instanceof TypeError) throw new Error(t('webdavUnreachable', url.host));
    throw err;
  }
  const [previous, status] = await Promise.all([backendItem.getValue(), statusItem.getValue()]);
  const same = status.connected && previous.kind === 'webdav' && previous.url === config.url && previous.username === config.username;
  // Another server or account: nothing from the old one is merged into it.
  if (!same) await resetAccountState();
  const backend = { kind: 'webdav' as const, ...config };
  await backendItem.setValue(backend);
  useBackend(backend);
  const label = `${username} @ ${url.host}`;
  await patchStatus({ connected: true, email: label, error: undefined });
  return label;
}

/** Back to Google Drive (after a Google sign-in) or after disconnecting: the WebDAV password is forgotten. */
export async function useDrive(): Promise<void> {
  await backendItem.setValue({ kind: 'drive' });
  useBackend({ kind: 'drive' });
}

/** For Settings: the storage in use, without the password. */
export async function storageInfo(): Promise<{ kind: 'drive' } | { kind: 'webdav'; url: string; username: string }> {
  const b = await backendItem.getValue();
  return b.kind === 'webdav' ? { kind: 'webdav', url: b.url, username: b.username } : { kind: 'drive' };
}
