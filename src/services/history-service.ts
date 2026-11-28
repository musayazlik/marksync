import {
  diffBackup,
  findInBackup,
  planRestore,
  type FolderPath,
  type HistoryDiff,
  type RestoreOp,
  type RestoreParent,
} from '../core/history';
import type { RecordMap, RootKey } from '../core/types';
import { locale, t } from '../shared/i18n';
import { syncStateItem } from '../shared/state';
import type { BookmarksApi } from '../sync/bookmarks-api';
import { readLocal } from '../sync/local-tree';
import { createBackup, currentRecords, listBackups, loadBackup } from './backup-service';
import { exclusive, localBookmarks, runSync } from './sync-service';

/**
 * Version history (Settings → Backups → History): compare a backup with the
 * bookmarks now, and bring back single items or folders from it. Restored
 * items are ordinary local changes: they sync to every browser.
 */

export interface BackupDiff extends HistoryDiff {
  createdAt: number;
  source: string;
}

export function compareBackup(id: string): Promise<BackupDiff> {
  return loadBackup(id).then(async ({ records, createdAt, source }) => ({
    ...diffBackup(records, await currentRecords()),
    createdAt,
    source,
  }));
}

export interface PartialRestoreResult {
  restored: number;
  failed: number;
  /** Title of the folder that took items whose original folder is gone. */
  fallbackFolder?: string;
}

/** Runs a restore plan against the bookmarks API; pure enough to test with the fake bookmarks. */
export async function runRestorePlan(
  api: BookmarksApi,
  ops: RestoreOp[],
  where: {
    /** Shared record ID → local ID. */
    local: Map<string, string>;
    roots: Partial<Record<RootKey, string>>;
    fallbackTitle: string;
  },
): Promise<PartialRestoreResult> {
  const made = new Map<string, string>();
  let fallbackId: string | undefined;
  const result: PartialRestoreResult = { restored: 0, failed: 0 };

  const parentId = async (p: RestoreParent): Promise<string | undefined> => {
    if ('root' in p) return where.roots[p.root] ?? where.roots.other;
    if ('record' in p) return where.local.get(p.record) ?? (await fallback());
    if ('created' in p) return made.get(p.created) ?? (await fallback());
    return fallback();
  };
  const fallback = async () => {
    if (!fallbackId) {
      const root = where.roots.other ?? where.roots.toolbar;
      if (!root) throw new Error(t('historyNoRoot'));
      fallbackId = (await api.create({ parentId: root, title: where.fallbackTitle })).id;
      result.fallbackFolder = where.fallbackTitle;
    }
    return fallbackId;
  };
  /** The bookmarks API rejects an index past the end. */
  const clamp = async (parent: string, index: number) => Math.min(index, (await api.getChildren(parent)).length);

  for (const op of ops) {
    try {
      if (op.op === 'create') {
        const parent = await parentId(op.parent);
        if (!parent) throw new Error('no parent');
        const node = await api.create({
          parentId: parent,
          title: op.title,
          index: await clamp(parent, op.index),
          ...(op.kind === 'bookmark' && op.url !== undefined ? { url: op.url } : {}),
        });
        made.set(op.id, node.id);
      } else if (op.op === 'move') {
        const local = where.local.get(op.id);
        const parent = await parentId(op.parent);
        if (!local || !parent) throw new Error('gone');
        await api.move(local, { parentId: parent, index: await clamp(parent, op.index) });
      } else {
        const local = where.local.get(op.id);
        if (!local) throw new Error('gone');
        await api.update(local, { title: op.title, ...(op.url !== undefined ? { url: op.url } : {}) });
      }
      result.restored++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

/**
 * Brings the chosen items back from a backup. The current bookmarks are
 * backed up first (the source backup is kept), so this can be undone with a
 * full restore of that backup.
 */
export async function restoreFromBackup(id: string, ids: string[]): Promise<PartialRestoreResult> {
  const { records, createdAt } = await loadBackup(id);
  const result = await exclusive(async () => {
    const current = await currentRecords();
    const ops = planRestore(records, current, ids);
    if (!ops.length) return { restored: 0, failed: 0 };
    await createBackup('before-restore', { protect: id });
    const state = await syncStateItem.getValue();
    const { snapshot } = await readLocal(localBookmarks(), state.menuFolderId);
    const local = new Map(Object.entries(state.mapping).map(([localId, recordId]) => [recordId, localId]));
    return runRestorePlan(localBookmarks(), ops, {
      local,
      roots: snapshot.roots,
      fallbackTitle: t('historyRestoredFolder', new Date(createdAt || Date.now()).toLocaleDateString(locale())),
    });
  });
  // The restored items are local changes now: send them to Drive.
  if (result.restored) void runSync().catch(() => undefined);
  return result;
}

export interface BackupHit {
  id: string;
  createdTime: string;
  source: string;
  matches: { title: string; url?: string; folder: FolderPath }[];
}

/** Searches at most this many backups, newest first. */
const SEARCH_MAX_BACKUPS = 60;

/** "Which backup still had …?": the backups with a bookmark whose title or address contains `query`. */
export async function searchBackups(query: string): Promise<BackupHit[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const hits: BackupHit[] = [];
  for (const b of (await listBackups()).slice(0, SEARCH_MAX_BACKUPS)) {
    let records: RecordMap;
    try {
      records = (await loadBackup(b.id)).records;
    } catch {
      continue;
    }
    const matches = findInBackup(records, q, 5);
    if (matches.length) hits.push({ id: b.id, createdTime: b.createdTime, source: b.source, matches });
  }
  return hits;
}
