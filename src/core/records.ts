import {
  isRootKey,
  type IdMapping,
  type LocalSnapshot,
  type RecordMap,
  type SyncRecord,
} from './types';

/** Tombstones older than this are dropped from the sync file. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Deepest folder nesting kept in sync. Anything deeper is moved to "other".
 * Real bookmark trees are far shallower; the cap keeps every tree walk
 * bounded even if a sync file is crafted or corrupted.
 */
export const MAX_DEPTH = 200;

export function isLive(r: SyncRecord | undefined): r is SyncRecord {
  return !!r && r.deletedAt === undefined;
}

export function liveRecords(records: RecordMap): SyncRecord[] {
  return Object.values(records).filter(isLive);
}

/** Highest clock value in a set of records; used to keep clocks moving forward. */
export function maxClock(...maps: (RecordMap | undefined)[]): number {
  let max = 0;
  for (const map of maps) {
    if (!map) continue;
    for (const r of Object.values(map)) {
      for (const c of [r.contentAt, r.positionAt, r.deletedAt ?? 0]) {
        if (Number.isFinite(c) && c > max) max = c;
      }
    }
  }
  return max;
}

/** Live children grouped by parent and sorted by index. */
export function childrenByParent(
  records: RecordMap,
  skip?: ReadonlySet<string>,
): Map<string, SyncRecord[]> {
  const groups = new Map<string, SyncRecord[]>();
  for (const r of liveRecords(records)) {
    if (skip?.has(r.id)) continue;
    const list = groups.get(r.parentId) ?? [];
    list.push(r);
    groups.set(r.parentId, list);
  }
  for (const list of groups.values()) list.sort(compareSiblings);
  return groups;
}

/** Same index: the most recently placed item goes first, then by id. */
function compareSiblings(a: SyncRecord, b: SyncRecord): number {
  return a.index - b.index || b.positionAt - a.positionAt || (a.id < b.id ? -1 : 1);
}

function withUrl<T extends object>(base: T, url: string | undefined): T & { url?: string } {
  return url === undefined ? base : { ...base, url };
}

/**
 * Turns the local tree into records by comparing it with the mirror (the
 * state after the last successful sync). Changed fields get the clock `now`;
 * unchanged fields keep their old clock; items that are gone get a tombstone.
 *
 * `keep` lists record ids this browser could not create (for example a
 * `javascript:` bookmark in Firefox). They are missing locally on purpose,
 * so they are carried over instead of being deleted everywhere.
 */
export function buildLocalRecords(
  snap: LocalSnapshot,
  mapping: IdMapping,
  mirror: RecordMap,
  now: number,
  newId: () => string,
  keep: ReadonlySet<string> = new Set(),
): { records: RecordMap; mapping: IdMapping } {
  const localToSync = new Map<string, string>();
  for (const [key, localId] of Object.entries(snap.roots)) {
    if (localId) localToSync.set(localId, key);
  }
  for (const [localId, key] of Object.entries(snap.aliases ?? {})) localToSync.set(localId, key);
  const nextMapping: IdMapping = {};
  for (const n of snap.nodes) {
    const syncId = mapping[n.localId] ?? newId();
    localToSync.set(n.localId, syncId);
    nextMapping[n.localId] = syncId;
  }

  // Index each mirror record would have locally, ignoring items we keep but
  // cannot show. Without this, every sibling after a kept item looks moved.
  const mirrorRank = new Map<string, number>();
  for (const siblings of childrenByParent(mirror, keep).values()) {
    siblings.forEach((r, i) => mirrorRank.set(r.id, i));
  }

  const records: RecordMap = {};
  for (const n of snap.nodes) {
    const id = localToSync.get(n.localId)!;
    const parentId = localToSync.get(n.parentLocalId);
    if (!parentId) continue;
    const base = withUrl(
      { id, kind: n.kind, parentId, index: n.index, title: n.title },
      n.url,
    );
    const prev = mirror[id];
    if (!isLive(prev)) {
      records[id] = { ...base, contentAt: now, positionAt: now };
      continue;
    }
    const contentChanged = prev.title !== n.title || (prev.url ?? '') !== (n.url ?? '');
    const positionChanged = prev.parentId !== parentId || mirrorRank.get(id) !== n.index;
    records[id] = {
      ...base,
      contentAt: contentChanged ? now : prev.contentAt,
      positionAt: positionChanged ? now : prev.positionAt,
      ...(positionChanged ? {} : { index: prev.index }),
    };
  }

  for (const [id, prev] of Object.entries(mirror)) {
    if (records[id]) continue;
    records[id] = !isLive(prev) || keep.has(id) ? prev : { ...prev, deletedAt: now };
  }
  return { records, mapping: nextMapping };
}

/** Records that were live in the mirror and are deleted in `local`. */
export function countNewDeletions(mirror: RecordMap, local: RecordMap): number {
  let n = 0;
  for (const [id, prev] of Object.entries(mirror)) {
    if (isLive(prev) && !isLive(local[id])) n++;
  }
  return n;
}

/**
 * Deletions that come from the remote file: items this browser still has
 * (live in the mirror and locally) that the merge would remove.
 */
export function remoteDeletions(mirror: RecordMap, local: RecordMap, merged: RecordMap): SyncRecord[] {
  const out: SyncRecord[] = [];
  for (const [id, prev] of Object.entries(mirror)) {
    if (isLive(prev) && isLive(local[id]) && !isLive(merged[id])) out.push(merged[id] ?? prev);
  }
  return out;
}

/**
 * "Keep my bookmarks": items deleted remotely but still present here come
 * back as a local edit made now, which wins over the remote deletion in
 * every browser.
 */
export function reviveRemoteDeletions(merged: RecordMap, local: RecordMap, mirror: RecordMap, now: number): RecordMap {
  const out: RecordMap = { ...merged };
  for (const [id, prev] of Object.entries(mirror)) {
    const l = local[id];
    if (isLive(prev) && isLive(l) && !isLive(merged[id])) {
      out[id] = { ...l, contentAt: now, positionAt: now };
    }
  }
  return out;
}

/**
 * First sync of a browser that already has bookmarks: instead of uploading
 * duplicates, local items that match a remote item (same folder, same URL for
 * bookmarks, same title for folders) take over the remote id. Matched items
 * keep the remote version, so nothing is reported as changed.
 */
export function adoptRemote(
  local: RecordMap,
  remote: RecordMap,
  mapping: IdMapping,
): { records: RecordMap; mapping: IdMapping } {
  const keyOf = (parentId: string, r: SyncRecord) =>
    `${parentId}\u0000${r.kind}\u0000${r.kind === 'bookmark' ? r.url : r.title}`;

  const candidates = new Map<string, string[]>();
  for (const r of childrenByParent(remote).values()) {
    for (const rec of r) {
      const k = keyOf(rec.parentId, rec);
      const list = candidates.get(k);
      if (list) list.push(rec.id);
      else candidates.set(k, [rec.id]);
    }
  }

  const rename = new Map<string, string>();
  const out: RecordMap = {};
  // Parents first, so a child looks for matches inside the adopted folder.
  const byParent = childrenByParent(local);
  const roots = [...byParent.keys()].filter(isRootKey);
  const visit = (parentId: string) => {
    for (const rec of byParent.get(parentId) ?? []) {
      const parent = rename.get(rec.parentId) ?? rec.parentId;
      const match = candidates.get(keyOf(parent, rec))?.shift();
      if (match) {
        rename.set(rec.id, match);
        out[match] = remote[match]!;
      } else {
        out[rec.id] = { ...rec, parentId: parent };
      }
      visit(rec.id);
    }
  };
  roots.forEach(visit);
  // Tombstones and anything unreachable stay as they are.
  for (const [id, rec] of Object.entries(local)) {
    if (!out[id] && !rename.has(id)) out[id] = rec;
  }

  const nextMapping: IdMapping = {};
  for (const [localId, syncId] of Object.entries(mapping)) {
    nextMapping[localId] = rename.get(syncId) ?? syncId;
  }
  return { records: out, mapping: nextMapping };
}

/**
 * Merges two versions field by field. The newer title/URL wins and the newer
 * position wins. A deletion wins over edits made before it; an edit or
 * restore made after it brings the item back.
 * On equal clocks the remote side wins, so all browsers end up the same.
 */
export function mergeRecords(local: RecordMap, remote: RecordMap): RecordMap {
  const out: RecordMap = {};
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[id];
    const r = remote[id];
    if (!l || !r) {
      out[id] = (l ?? r)!;
      continue;
    }
    if (l.deletedAt !== undefined && r.deletedAt !== undefined) {
      out[id] = l.deletedAt > r.deletedAt ? l : r;
      continue;
    }
    if (l.deletedAt !== undefined || r.deletedAt !== undefined) {
      const [dead, alive] = l.deletedAt !== undefined ? [l, r] : [r, l];
      // A delete wins unless the other side touched the item after it
      // (an edit made later, or a restored backup).
      out[id] = dead.deletedAt! >= Math.max(alive.contentAt, alive.positionAt) ? dead : alive;
      continue;
    }
    const content = l.contentAt > r.contentAt ? l : r;
    const position = l.positionAt > r.positionAt ? l : r;
    out[id] = withUrl(
      {
        id,
        kind: content.kind,
        title: content.title,
        contentAt: content.contentAt,
        parentId: position.parentId,
        index: position.index,
        positionAt: position.positionAt,
      },
      content.url,
    );
  }
  return out;
}

/**
 * Makes a merged state valid and deterministic:
 * - drops old tombstones,
 * - moves orphans (parent deleted elsewhere) to "other" instead of losing them,
 * - breaks cycles made by two browsers moving folders into each other,
 * - moves anything nested deeper than MAX_DEPTH to "other",
 * - renumbers siblings 0..n-1.
 * Every browser computes the same result from the same input.
 * Runs in linear time: each record's depth is computed once.
 */
export function sanitize(records: RecordMap, now: number): RecordMap {
  const out: RecordMap = {};
  for (const [id, r] of Object.entries(records)) {
    if (r.deletedAt !== undefined && now - r.deletedAt > TOMBSTONE_TTL_MS) continue;
    out[id] = { ...r };
  }

  const validParent = (r: SyncRecord) =>
    isRootKey(r.parentId) || (isLive(out[r.parentId]) && out[r.parentId]!.kind === 'folder');

  const reparent = (r: SyncRecord) => {
    r.parentId = 'other';
    r.index = Number.MAX_SAFE_INTEGER;
  };

  for (const r of liveRecords(out)) if (!validParent(r)) reparent(r);

  // Depth of every live record (1 = directly under a root), with cycles broken
  // by moving the smallest id of the cycle to "other".
  const depth = new Map<string, number>();
  for (const r of liveRecords(out).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (depth.has(r.id)) continue;
    const path: SyncRecord[] = [];
    const onPath = new Map<string, number>();
    let base = 0;
    let cur: SyncRecord = r;
    for (;;) {
      const known = depth.get(cur.id);
      if (known !== undefined) {
        base = known;
        break;
      }
      const seenAt = onPath.get(cur.id);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt).map((n) => n.id).sort();
        reparent(out[cycle[0]!]!);
        path.length = 0;
        onPath.clear();
        cur = r;
        continue;
      }
      onPath.set(cur.id, path.length);
      path.push(cur);
      if (isRootKey(cur.parentId)) {
        base = 0;
        break;
      }
      cur = out[cur.parentId]!;
    }
    let d = base;
    for (let i = path.length - 1; i >= 0; i--) {
      d++;
      if (d > MAX_DEPTH) {
        reparent(path[i]!);
        d = 1;
      }
      depth.set(path[i]!.id, d);
    }
  }

  for (const siblings of childrenByParent(out).values()) {
    siblings.forEach((r, i) => (out[r.id]!.index = i));
  }
  return out;
}

/**
 * Restoring a backup is treated as a local edit made now: backup items come
 * back with their content and position, everything else is deleted.
 */
export function applyRestore(current: RecordMap, backup: RecordMap, now: number): RecordMap {
  const out: RecordMap = {};
  for (const [id, r] of Object.entries(current)) {
    out[id] = backup[id] || !isLive(r) ? r : { ...r, deletedAt: now };
  }
  for (const b of liveRecords(backup)) {
    const { deletedAt: _drop, ...rest } = b;
    out[b.id] = { ...rest, contentAt: now, positionAt: now };
  }
  return out;
}

export function recordsEqual(a: RecordMap, b: RecordMap): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const id of ak) {
    const x = a[id]!;
    const y = b[id];
    if (
      !y ||
      x.kind !== y.kind ||
      x.parentId !== y.parentId ||
      x.index !== y.index ||
      x.title !== y.title ||
      x.url !== y.url ||
      x.contentAt !== y.contentAt ||
      x.positionAt !== y.positionAt ||
      x.deletedAt !== y.deletedAt
    ) {
      return false;
    }
  }
  return true;
}
