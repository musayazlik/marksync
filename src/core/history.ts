import { childrenByParent, isLive, liveRecords } from './records';
import { isRootKey, type NodeKind, type RecordMap, type RootKey, type SyncRecord } from './types';

/**
 * Version history: what changed between a backup and the bookmarks now, and
 * how to bring back single items from a backup. Pure logic; the service runs
 * the plan through the bookmarks API, so a partial restore is an ordinary
 * local change that syncs like any other.
 */

/** Where an item sits: a top-level folder and the folder titles below it. */
export interface FolderPath {
  root: RootKey;
  folders: string[];
}

export type ChangeKind = 'removed' | 'added' | 'moved' | 'renamed';

export interface HistoryChange {
  /** Shared record ID. */
  id: string;
  kind: ChangeKind;
  nodeKind: NodeKind;
  /** Title and address now (or, for removed items, in the backup). */
  title: string;
  url?: string;
  /** The folder the item is listed under: where it was in the backup (where it is now for added items). */
  folder: FolderPath;
  /** Moved items: where it is now. */
  movedTo?: FolderPath;
  /** Renamed (or moved and renamed) items: the title and address in the backup. */
  before?: { title: string; url?: string };
  /** Removed or added folders: how many items inside it went (or came) with it. */
  inside?: number;
  /** Removed, moved and renamed items can be brought back; added ones cannot. */
  restorable: boolean;
}

export interface HistoryDiff {
  changes: HistoryChange[];
  counts: Record<ChangeKind, number>;
}

/** Path of a record's parent folder; undefined when the chain is broken. */
export function parentPath(records: RecordMap, r: SyncRecord): FolderPath | undefined {
  const folders: string[] = [];
  let parentId = r.parentId;
  for (let guard = 0; guard < 300; guard++) {
    if (isRootKey(parentId)) return { root: parentId, folders };
    const parent = records[parentId];
    if (!isLive(parent)) return undefined;
    folders.unshift(parent.title);
    parentId = parent.parentId;
  }
  return undefined;
}

const other: FolderPath = { root: 'other', folders: [] };

/** How many live items are below `id`, at any depth. */
function countInside(byParent: Map<string, SyncRecord[]>, id: string): number {
  let n = 0;
  const stack = [...(byParent.get(id) ?? [])];
  while (stack.length) {
    const r = stack.pop()!;
    n++;
    stack.push(...(byParent.get(r.id) ?? []));
  }
  return n;
}

/**
 * Compares a backup with the current records. A removed folder is one
 * change (with the number of items inside it), not one per item; the same
 * for an added folder. Pure reorders inside a folder are not listed.
 */
export function diffBackup(backup: RecordMap, current: RecordMap): HistoryDiff {
  const then = new Map(liveRecords(backup).map((r) => [r.id, r]));
  const now = new Map(liveRecords(current).map((r) => [r.id, r]));
  const thenByParent = childrenByParent(backup);
  const nowByParent = childrenByParent(current);
  const changes: HistoryChange[] = [];
  const counts: Record<ChangeKind, number> = { removed: 0, added: 0, moved: 0, renamed: 0 };

  for (const r of then.values()) {
    const n = now.get(r.id);
    if (!n) {
      // Listed under the topmost removed folder only.
      if (!isRootKey(r.parentId) && then.has(r.parentId) && !now.has(r.parentId)) continue;
      changes.push({
        id: r.id,
        kind: 'removed',
        nodeKind: r.kind,
        title: r.title,
        ...(r.url !== undefined ? { url: r.url } : {}),
        folder: parentPath(backup, r) ?? other,
        ...(r.kind === 'folder' ? { inside: countInside(thenByParent, r.id) } : {}),
        restorable: true,
      });
      counts.removed++;
      continue;
    }
    const moved = n.parentId !== r.parentId;
    const renamed = n.title !== r.title || n.url !== r.url;
    if (!moved && !renamed) continue;
    changes.push({
      id: r.id,
      kind: moved ? 'moved' : 'renamed',
      nodeKind: n.kind,
      title: n.title,
      ...(n.url !== undefined ? { url: n.url } : {}),
      folder: parentPath(backup, r) ?? other,
      ...(moved ? { movedTo: parentPath(current, n) ?? other } : {}),
      ...(renamed ? { before: { title: r.title, ...(r.url !== undefined ? { url: r.url } : {}) } } : {}),
      restorable: true,
    });
    if (moved) counts.moved++;
    if (renamed) counts.renamed++;
  }

  for (const n of now.values()) {
    if (then.has(n.id)) continue;
    if (!isRootKey(n.parentId) && now.has(n.parentId) && !then.has(n.parentId)) continue;
    changes.push({
      id: n.id,
      kind: 'added',
      nodeKind: n.kind,
      title: n.title,
      ...(n.url !== undefined ? { url: n.url } : {}),
      folder: parentPath(current, n) ?? other,
      ...(n.kind === 'folder' ? { inside: countInside(nowByParent, n.id) } : {}),
      restorable: false,
    });
    counts.added++;
  }
  return { changes, counts };
}

/** Where a restored item goes. */
export type RestoreParent =
  /** A top-level folder. */
  | { root: RootKey }
  /** A folder that exists now (shared record ID). */
  | { record: string }
  /** A folder created earlier in the same plan (its record ID in the backup). */
  | { created: string }
  /** The original folder is gone: a "Restored" folder. */
  | { fallback: true };

export type RestoreOp =
  | { op: 'create'; id: string; kind: NodeKind; title: string; url?: string; parent: RestoreParent; index: number }
  | { op: 'move'; id: string; parent: RestoreParent; index: number }
  | { op: 'update'; id: string; title: string; url?: string };

function depthIn(records: RecordMap, r: SyncRecord): number {
  let d = 0;
  for (let p = r.parentId; !isRootKey(p) && records[p] && d < 300; p = records[p]!.parentId) d++;
  return d;
}

/**
 * The steps that bring the chosen items back as they were in the backup,
 * without touching anything else:
 * - a removed bookmark or folder (with everything that was in it) is created
 *   again in its old folder, or in a "Restored" folder when that is gone too;
 * - a moved item is moved back;
 * - a renamed item gets its old title and address back.
 * Items that were added since the backup are skipped. Parents come before
 * their children.
 */
export function planRestore(backup: RecordMap, current: RecordMap, ids: Iterable<string>): RestoreOp[] {
  const then = new Map(liveRecords(backup).map((r) => [r.id, r]));
  const now = new Map(liveRecords(current).map((r) => [r.id, r]));
  const byParent = childrenByParent(backup);
  const created = new Set<string>();
  const ops: RestoreOp[] = [];

  const parentFor = (r: SyncRecord): RestoreParent => {
    if (isRootKey(r.parentId)) return { root: r.parentId };
    if (created.has(r.parentId)) return { created: r.parentId };
    const parent = now.get(r.parentId);
    if (parent && parent.kind === 'folder') return { record: r.parentId };
    return { fallback: true };
  };

  const recreate = (top: SyncRecord) => {
    const stack: SyncRecord[] = [top];
    while (stack.length) {
      const r = stack.shift()!;
      if (created.has(r.id) || now.has(r.id)) continue;
      ops.push({
        op: 'create',
        id: r.id,
        kind: r.kind,
        title: r.title,
        ...(r.url !== undefined ? { url: r.url } : {}),
        parent: parentFor(r),
        index: r.index,
      });
      created.add(r.id);
      if (r.kind === 'folder') stack.push(...(byParent.get(r.id) ?? []));
    }
  };

  // Shallow items first, so a chosen folder is created before a chosen item in it.
  const chosen = [...new Set(ids)]
    .map((id) => then.get(id))
    .filter((r): r is SyncRecord => !!r)
    .sort((a, b) => depthIn(backup, a) - depthIn(backup, b) || a.index - b.index);

  for (const r of chosen) {
    const n = now.get(r.id);
    if (!n) {
      recreate(r);
      continue;
    }
    if (n.parentId !== r.parentId) ops.push({ op: 'move', id: r.id, parent: parentFor(r), index: r.index });
    if (n.title !== r.title || n.url !== r.url) {
      ops.push({ op: 'update', id: r.id, title: r.title, ...(r.kind === 'bookmark' && r.url !== undefined ? { url: r.url } : {}) });
    }
  }
  return ops;
}

/** Items of a backup whose title or address contains `query` (case-insensitive), with their folder. */
export function findInBackup(backup: RecordMap, query: string, max = 20): { title: string; url?: string; folder: FolderPath }[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const out: { title: string; url?: string; folder: FolderPath }[] = [];
  for (const r of liveRecords(backup)) {
    if (r.kind !== 'bookmark') continue;
    if (!r.title.toLocaleLowerCase().includes(q) && !(r.url ?? '').toLocaleLowerCase().includes(q)) continue;
    out.push({ title: r.title, ...(r.url !== undefined ? { url: r.url } : {}), folder: parentPath(backup, r) ?? other });
    if (out.length >= max) break;
  }
  return out;
}
