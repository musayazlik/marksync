import { findTreeNode, folderPath } from '../core/ai-sort';
import { sanitizeRemoteRecords } from '../core/validate';
import { SYNC_SCHEMA, type SyncState } from '../core/types';
import { DriveClient, DriveError } from '../platform/drive';
import { getAccessToken, invalidateToken } from '../platform/identity';
import { PRECONDITION_FAILED } from '../platform/store';
import { t } from '../shared/i18n';
import { backendItem, sharesItem, statusItem, type ShareEntry, type SharesStore } from '../shared/state';
import { readLocal } from '../sync/local-tree';
import { ConflictError, syncOnce, type RemoteStore } from '../sync/engine';
import { scopedBookmarks, ScopeGoneError } from '../sync/scoped-bookmarks';
import { deviceLabel } from '../platform/browser-info';
import { appFolders } from './drive-store';
import { afterSyncHooks, describeError, exclusive, localBookmarks, runSync } from './sync-service';

/**
 * Shared folders: a folder synced with other Google accounts through its own
 * file in the owner's Drive (`Marksync/shared/shared-<id>.json`), shared with
 * Drive permissions; there is no Marksync server. Locally a shared folder
 * lives in the "Marksync Shared" folder, which the personal sync leaves out,
 * and the ordinary sync engine syncs it through a view that shows only that
 * folder (sync/scoped-bookmarks.ts). Editors' changes reach everyone; a
 * viewer's own changes are put back at every sync. The mass-delete guard
 * applies per shared folder. Shared files are not end-to-end encrypted (the
 * other members could not read them); Settings says so.
 */

export const SHARED_KIND = 'marksync-shared';
const SHARED_DRIVE_FOLDER = 'shared';

/** The invitation link, through the web viewer's join page (Google's file picker gives the access). */
export function inviteLink(fileId: string): string | undefined {
  const base = (import.meta.env.WXT_VIEWER_URL ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/join.html#${encodeURIComponent(fileId)}` : undefined;
}

/** A share code from a link or the bare file ID. */
export function parseShareCode(input: string): string | undefined {
  const text = input.trim();
  const fromLink = /[#?&](?:id=)?([A-Za-z0-9_-]{5,200})\s*$/.exec(text)?.[1];
  const id = fromLink ?? text;
  return /^[A-Za-z0-9_-]{5,200}$/.test(id) ? id : undefined;
}

async function drive(): Promise<DriveClient> {
  if (!(await statusItem.getValue()).connected) throw new Error(t('errConnectFirst'));
  if ((await backendItem.getValue()).kind !== 'drive') throw new Error(t('shareNeedsDrive'));
  // Plain: the members of a shared folder do not have the owner's passphrase.
  return new DriveClient(getAccessToken, invalidateToken);
}

let writes: Promise<unknown> = Promise.resolve();
function update(change: (s: SharesStore) => SharesStore): Promise<SharesStore> {
  const run = writes
    .catch(() => undefined)
    .then(async () => {
      const next = change(await sharesItem.getValue());
      await sharesItem.setValue(next);
      return next;
    });
  writes = run;
  return run;
}
const patchShare = (fileId: string, patch: Partial<ShareEntry>) =>
  update((s) => ({ ...s, shares: s.shares.map((x) => (x.fileId === fileId ? { ...x, ...patch } : x)) }));

/** The local "Marksync Shared" folder (under Other bookmarks), created on first use. */
async function container(): Promise<string> {
  const api = localBookmarks();
  const { containerId } = await sharesItem.getValue();
  if (containerId && findTreeNode(await api.getTree(), containerId)) return containerId;
  const { snapshot } = await readLocal(api);
  const parent = snapshot.roots.other ?? snapshot.roots.toolbar;
  if (!parent) throw new Error(t('historyNoRoot'));
  const name = t('sharedContainer');
  const existing = (await api.getChildren(parent)).find((c) => c.url === undefined && c.title === name);
  const id = existing?.id ?? (await api.create({ parentId: parent, title: name })).id;
  await update((s) => ({ ...s, containerId: id }));
  return id;
}

/** The shared folder's file in Drive as a RemoteStore; a viewer never writes. */
export class SharedRemote implements RemoteStore {
  constructor(
    private readonly drive: DriveClient,
    private readonly fileId: string,
    private readonly readOnly: boolean,
  ) {}

  async load(): Promise<{ state: SyncState; version: string } | null> {
    const meta = await this.drive.getMeta(this.fileId);
    const state = await this.drive.downloadJson<SyncState>(this.fileId);
    if (!state || typeof state !== 'object' || (state.schema !== 1 && state.schema !== SYNC_SCHEMA)) throw new Error(t('errNewerSyncFile'));
    return { state, version: meta.version ?? '' };
  }

  async save(state: SyncState, expectedVersion: string | null): Promise<string> {
    if (this.readOnly) return expectedVersion ?? '';
    const meta = await this.drive.getMeta(this.fileId);
    if (meta.version !== expectedVersion) throw new ConflictError();
    try {
      return (await this.drive.updateJson(this.fileId, state, expectedVersion ?? undefined)).version ?? '';
    } catch (err) {
      if (err instanceof DriveError && err.status === PRECONDITION_FAILED) throw new ConflictError();
      throw err;
    }
  }
}

/** Syncs one shared folder with its file. */
async function syncShare(entry: ShareEntry): Promise<void> {
  const d = await drive();
  const remote = new SharedRemote(d, entry.fileId, entry.role === 'reader');
  try {
    // A viewer's local edits are put back: the shared file always wins.
    const restore = entry.role === 'reader' ? sanitizeRemoteRecords((await remote.load())?.state.records, Date.now()).records : undefined;
    const label = await deviceLabel();
    await exclusive(() =>
      syncOnce(
        {
          bookmarks: scopedBookmarks(localBookmarks(), entry.localFolderId),
          remote,
          local: {
            load: async () => (await sharesItem.getValue()).shares.find((s) => s.fileId === entry.fileId)?.state ?? entry.state,
            save: async (state) => void (await patchShare(entry.fileId, { state })),
          },
          deviceLabel: label,
        },
        restore ? { restore } : {},
      ),
    );
    await patchShare(entry.fileId, { lastSyncAt: Date.now(), error: undefined });
  } catch (err) {
    let message = describeError(err).message;
    if (err instanceof ScopeGoneError) message = t('shareFolderGone');
    else if (err instanceof DriveError && (err.status === 403 || err.status === 404)) message = t('shareLostAccess');
    await patchShare(entry.fileId, { error: message });
  }
}

let running: Promise<void> | undefined;
/** Every shared folder, one after another (after each personal sync). */
export function syncShares(): Promise<void> {
  running ??= (async () => {
    try {
      const s = await statusItem.getValue();
      if (!s.connected || (await backendItem.getValue()).kind !== 'drive') return;
      for (const entry of (await sharesItem.getValue()).shares) await syncShare(entry);
    } finally {
      running = undefined;
    }
  })();
  return running;
}
afterSyncHooks.push(() => syncShares());

/** Resolves when no shared-folder sync is running (for tests that switch browsers). */
export function sharesSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

export interface ShareView {
  fileId: string;
  name: string;
  path: string;
  role: ShareEntry['role'];
  owner?: string;
  lastSyncAt?: number;
  error?: string;
  link?: string;
}

export async function listShares(): Promise<ShareView[]> {
  const tree = await localBookmarks().getTree();
  return (await sharesItem.getValue()).shares.map((s) => {
    const link = inviteLink(s.fileId);
    return {
      fileId: s.fileId,
      name: s.name,
      path: folderPath(tree, s.localFolderId) ?? '',
      role: s.role,
      ...(s.owner ? { owner: s.owner } : {}),
      ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(link ? { link } : {}),
    };
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/** Gives people access and sends them Google's e-mail with the invitation link. */
export async function invite(fileId: string, emails: string[], role: 'writer' | 'reader'): Promise<number> {
  const bad = emails.find((e) => !EMAIL.test(e));
  if (bad) throw new Error(t('shareBadEmail', bad));
  const entry = (await sharesItem.getValue()).shares.find((s) => s.fileId === fileId);
  if (!entry) throw new Error(t('shareUnknown'));
  const d = await drive();
  const link = inviteLink(fileId);
  const message = link ? t('shareEmailMessage', entry.name, link) : t('shareEmailMessageCode', entry.name, fileId);
  for (const email of emails.slice(0, 50)) await d.share(fileId, email, role, message);
  return Math.min(emails.length, 50);
}

/**
 * Shares a folder of this browser: it moves into "Marksync Shared", gets its
 * own file in Drive, and leaves the personal sync (so it disappears from
 * this account's other browsers until they join it too).
 */
export async function createShare(folderId: string, emails: string[], role: 'writer' | 'reader'): Promise<ShareView> {
  const d = await drive();
  const api = localBookmarks();
  const tree = await api.getTree();
  const hit = findTreeNode(tree, folderId);
  if (!hit || hit.node.url !== undefined || !hit.parentId || hit.parentId === tree[0]?.id) throw new Error(t('shareChooseFolder'));
  const store = await sharesItem.getValue();
  if (store.shares.some((s) => s.localFolderId === folderId)) throw new Error(t('shareAlready'));
  if (store.containerId && (folderId === store.containerId || findTreeNode(findTreeNode(tree, store.containerId)?.node.children ?? [], folderId))) {
    throw new Error(t('shareAlready'));
  }
  const bad = emails.find((e) => !EMAIL.test(e));
  if (bad) throw new Error(t('shareBadEmail', bad));

  const folders = await appFolders(d);
  const parent = await d.ensureFolder(SHARED_DRIVE_FOLDER, folders.folderId);
  const empty: SyncState = { schema: SYNC_SCHEMA, records: {}, updatedAt: Date.now(), updatedBy: await deviceLabel() };
  const file = await d.createJson(`shared-${crypto.randomUUID()}.json`, parent, empty, { kind: SHARED_KIND, name: hit.node.title.slice(0, 100) });

  await api.move(folderId, { parentId: await container() });
  const entry: ShareEntry = { fileId: file.id, name: hit.node.title, localFolderId: folderId, role: 'owner', state: { mapping: {}, mirror: {}, keep: [] } };
  await update((s) => ({ ...s, shares: [...s.shares, entry] }));
  // The folder left the personal sync on purpose: that is not an accident to guard against.
  await runSync({ allowMassDelete: true }).catch(() => undefined);
  await syncShare(entry);
  if (emails.length) await invite(file.id, emails, role);
  return (await listShares()).find((s) => s.fileId === file.id)!;
}

/** Joins a folder someone shared (after their invitation link gave Marksync access to it). */
export async function joinShare(code: string): Promise<ShareView> {
  const fileId = parseShareCode(code);
  if (!fileId) throw new Error(t('shareBadCode'));
  if ((await sharesItem.getValue()).shares.some((s) => s.fileId === fileId)) throw new Error(t('shareAlreadyJoined'));
  const d = await drive();
  let access;
  try {
    access = await d.access(fileId);
  } catch (err) {
    if (err instanceof DriveError && (err.status === 403 || err.status === 404)) throw new Error(t('shareNoAccess'));
    throw err;
  }
  if (access.appProperties.kind !== SHARED_KIND) throw new Error(t('shareNotMarksync'));
  const name = (access.appProperties.name || t('sharedFolderDefault')).slice(0, 100);
  const local = await localBookmarks().create({ parentId: await container(), title: name });
  const entry: ShareEntry = {
    fileId,
    name,
    localFolderId: local.id,
    role: access.ownedByMe ? 'owner' : access.canEdit ? 'writer' : 'reader',
    ...(access.owner ? { owner: access.owner } : {}),
    state: { mapping: {}, mirror: {}, keep: [] },
  };
  await update((s) => ({ ...s, shares: [...s.shares, entry] }));
  await syncShare(entry);
  return (await listShares()).find((s) => s.fileId === fileId)!;
}

/**
 * Stops syncing a shared folder in this browser. Its bookmarks stay: the
 * folder moves to Other bookmarks and becomes an ordinary (personal) folder.
 * Nothing changes for the other members.
 */
export async function leaveShare(fileId: string): Promise<void> {
  const entry = (await sharesItem.getValue()).shares.find((s) => s.fileId === fileId);
  if (!entry) throw new Error(t('shareUnknown'));
  await update((s) => ({ ...s, shares: s.shares.filter((x) => x.fileId !== fileId) }));
  const api = localBookmarks();
  if (findTreeNode(await api.getTree(), entry.localFolderId)) {
    const { snapshot } = await readLocal(api);
    const other = snapshot.roots.other ?? snapshot.roots.toolbar;
    if (other) await api.move(entry.localFolderId, { parentId: other }).catch(() => undefined);
  }
  void runSync().catch(() => undefined);
}

/** Who has access, for Settings. */
export async function sharePeople(fileId: string) {
  return (await drive()).people(fileId);
}
