import { buildLocalRecords, liveRecords } from '../core/records';
import type { BackupFile, RecordMap } from '../core/types';
import { deviceLabel } from '../platform/browser-info';
import type { DriveFile } from '../platform/drive';
import { getSettings, patchStatus, syncStateItem } from '../shared/state';
import { readLocal } from '../sync/local-tree';
import { sanitizeRemoteRecords } from '../core/validate';
import { quote } from '../platform/drive';
import { appFolders, assertInFolder, driveClient, withFolders } from './drive-store';
import { localBookmarks, restoreRecords } from './sync-service';

export interface BackupInfo {
  id: string;
  name: string;
  createdTime: string;
  count: number;
  source: string;
  reason: BackupFile['reason'];
  size: number;
}

/** The current local tree as records, using the shared ids where known. */
export async function currentRecords(): Promise<RecordMap> {
  const state = await syncStateItem.getValue();
  const { snapshot } = await readLocal(localBookmarks(), state.menuFolderId);
  const { records } = buildLocalRecords(snapshot, state.mapping, {}, Date.now(), () => crypto.randomUUID());
  return records;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function createBackup(reason: BackupFile['reason'], opts: { protect?: string } = {}): Promise<BackupInfo> {
  const drive = driveClient();
  const records = await currentRecords();
  const source = await deviceLabel();
  const createdAt = Date.now();
  const count = liveRecords(records).length;
  const backup: BackupFile = { schema: 1, kind: 'marksync-backup', createdAt, source, reason, count, records };
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const file = await withFolders(drive, (f) =>
    drive.createJson(`marksync-backup-${stamp}-${slug(source)}.json`, f.backupsFolderId, backup, {
      count: String(count),
      source,
      reason,
    }),
  );
  await patchStatus({ lastBackupAt: createdAt });
  await pruneBackups(opts.protect);
  return toInfo(file);
}

function toInfo(f: DriveFile): BackupInfo {
  return {
    id: f.id,
    name: f.name,
    createdTime: f.createdTime ?? '',
    count: Number(f.appProperties?.count ?? 0),
    source: f.appProperties?.source ?? '',
    reason: (f.appProperties?.reason as BackupFile['reason']) ?? 'manual',
    size: Number(f.size ?? 0),
  };
}

export async function listBackups(): Promise<BackupInfo[]> {
  const drive = driveClient();
  const { backupsFolderId } = await appFolders(drive);
  const files = await drive.list(`${quote(backupsFolderId)} in parents`, 'createdTime desc');
  return files.map(toInfo);
}

/** Keeps the newest `backupRetention` backups (and `protect`) and deletes the rest. */
export async function pruneBackups(protect?: string): Promise<void> {
  const { backupRetention } = await getSettings();
  const drive = driveClient();
  const old = (await listBackups()).slice(Math.max(1, backupRetention)).filter((b) => b.id !== protect);
  for (const b of old) {
    // Another browser may have pruned the same file a moment earlier.
    await drive.delete(b.id).catch(() => undefined);
  }
}

export async function deleteBackup(id: string): Promise<void> {
  const drive = driveClient();
  await assertInFolder(drive, id, 'backups');
  await drive.delete(id);
}

/**
 * Replaces the bookmarks in every browser with a backup. The current state
 * is backed up first, so a restore can itself be undone.
 */
export async function restoreBackup(id: string): Promise<void> {
  const drive = driveClient();
  await assertInFolder(drive, id, 'backups');
  const backup = await drive.downloadJson<BackupFile>(id);
  if (typeof backup !== 'object' || backup === null || backup.kind !== 'marksync-backup' || backup.schema !== 1) {
    throw new Error('This file is not a Marksync backup.');
  }
  // Backups live in Drive too: only well-formed records are restored.
  const { records } = sanitizeRemoteRecords(backup.records, Date.now());
  await createBackup('before-restore', { protect: id });
  await restoreRecords(records);
}

/** Runs the scheduled backup if it is due. */
export async function backupIfDue(lastBackupAt: number | undefined): Promise<void> {
  const { autoBackup, backupIntervalHours } = await getSettings();
  if (!autoBackup) return;
  const due = !lastBackupAt || Date.now() - lastBackupAt >= backupIntervalHours * 3600_000 * 0.95;
  if (due) await createBackup('scheduled');
}
