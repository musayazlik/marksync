import type { SyncState } from '../core/types';
import { DriveClient, DriveError, quote } from '../platform/drive';
import { getAccessToken, invalidateToken } from '../platform/identity';
import { driveIdsItem } from '../shared/state';
import { ConflictError, type RemoteStore } from '../sync/engine';

/**
 * Layout in the user's Google Drive:
 *
 *   My Drive/
 *     Marksync/
 *       sync-state.json        shared state, read and written by every browser
 *       backups/
 *         marksync-backup-2026-11-22T09-30-00Z-brave-on-windows.json
 *       browsers/
 *         <device id>.json     each browser's own tree, for "Import from another browser"
 *
 * Folder and file IDs are cached, so a routine change check is one small
 * request. If a cached ID stops working (the user deleted the folder), the
 * cache is cleared and the folders are looked up or created again.
 */
export const APP_FOLDER = 'Marksync';
export const BACKUPS_FOLDER = 'backups';
export const BROWSERS_FOLDER = 'browsers';
export const STATE_FILE = 'sync-state.json';

export interface AppFolders {
  folderId: string;
  backupsFolderId: string;
  browsersFolderId: string;
}

export function driveClient(): DriveClient {
  return new DriveClient(getAccessToken, invalidateToken);
}

const isNotFound = (err: unknown) => err instanceof DriveError && err.status === 404;

export async function appFolders(drive: DriveClient): Promise<AppFolders> {
  const ids = await driveIdsItem.getValue();
  if (ids.folderId && ids.backupsFolderId && ids.browsersFolderId) {
    return { folderId: ids.folderId, backupsFolderId: ids.backupsFolderId, browsersFolderId: ids.browsersFolderId };
  }
  const folderId = await drive.ensureFolder(APP_FOLDER);
  const backupsFolderId = await drive.ensureFolder(BACKUPS_FOLDER, folderId);
  const browsersFolderId = await drive.ensureFolder(BROWSERS_FOLDER, folderId);
  const folders = { folderId, backupsFolderId, browsersFolderId };
  await driveIdsItem.setValue(folders);
  return folders;
}

/** Runs `task` with the app folders; if a cached folder is gone, looks them up again once. */
export async function withFolders<T>(drive: DriveClient, task: (f: AppFolders) => Promise<T>): Promise<T> {
  try {
    return await task(await appFolders(drive));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await driveIdsItem.setValue({});
    return task(await appFolders(drive));
  }
}

/**
 * Requests from the UI name Drive files by ID. Before acting on one, check
 * it really is in the expected Marksync folder, so a stray or crafted ID can
 * never delete or restore an unrelated file (such as sync-state.json).
 */
export async function assertInFolder(drive: DriveClient, fileId: string, folder: 'backups' | 'browsers'): Promise<void> {
  const folders = await appFolders(drive);
  const expected = folder === 'backups' ? folders.backupsFolderId : folders.browsersFolderId;
  const meta = await drive.getMeta(fileId);
  if (!meta.parents?.includes(expected)) {
    throw new Error(folder === 'backups' ? 'This file is not a Marksync backup.' : 'This file is not a Marksync browser snapshot.');
  }
}

export class DriveRemoteStore implements RemoteStore {
  constructor(private readonly drive: DriveClient) {}

  /** ID of sync-state.json, or undefined if no browser has created it yet. */
  private async stateFileId(): Promise<string | undefined> {
    const ids = await driveIdsItem.getValue();
    if (ids.stateFileId) return ids.stateFileId;
    const file = await withFolders(this.drive, (f) => this.drive.findByName(STATE_FILE, f.folderId));
    if (file) await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), stateFileId: file.id });
    return file?.id;
  }

  private async forgetStateFile() {
    const { stateFileId: _drop, ...rest } = await driveIdsItem.getValue();
    await driveIdsItem.setValue(rest);
  }

  /** Current version of the sync file: one small request. Null if it does not exist. */
  async currentVersion(): Promise<string | null> {
    const id = await this.stateFileId();
    if (!id) return null;
    try {
      return (await this.drive.getMeta(id)).version ?? null;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.forgetStateFile();
      return null;
    }
  }

  async load(): Promise<{ state: SyncState; version: string } | null> {
    const id = await this.stateFileId();
    if (!id) return null;
    try {
      // Read the version before the content: if the file changes in between,
      // the check in save() fails and the sync runs again.
      const meta = await this.drive.getMeta(id);
      const state = await this.drive.downloadJson<SyncState>(id);
      if (typeof state !== 'object' || state === null || state.schema !== 1) {
        throw new Error('The sync file in Google Drive was written by a newer Marksync. Update the extension.');
      }
      return { state, version: meta.version ?? '' };
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.forgetStateFile();
      return null;
    }
  }

  async save(state: SyncState, expectedVersion: string | null): Promise<string> {
    const id = await this.stateFileId();
    if (!id) {
      if (expectedVersion !== null) throw new ConflictError();
      const { created, oldest } = await withFolders(this.drive, async (f) => {
        const file = await this.drive.createJson(STATE_FILE, f.folderId, state);
        // Two browsers connecting for the first time at once can each create
        // the file. The oldest one wins; the other browser drops its copy and
        // merges into the winner on the retry.
        const all = await this.drive.list(`name = ${quote(STATE_FILE)} and ${quote(f.folderId)} in parents`, 'createdTime');
        return { created: file, oldest: all[0] ?? file };
      });
      await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), stateFileId: oldest.id });
      if (oldest.id !== created.id) {
        await this.drive.delete(created.id).catch(() => undefined);
        throw new ConflictError();
      }
      return created.version ?? '';
    }
    if (expectedVersion === null) throw new ConflictError();
    const meta = await this.drive.getMeta(id);
    if (meta.version !== expectedVersion) throw new ConflictError();
    return (await this.drive.updateJson(id, state)).version ?? '';
  }
}
