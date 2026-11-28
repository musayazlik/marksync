import { isLive } from '../core/records';
import {
  cleanTags,
  mergeTags,
  pruneTags,
  sanitizeTagsFile,
  tagCounts,
  tagMapsEqual,
  type TagEntry,
  type TagMap,
  type TagsFile,
} from '../core/tags';
import type { FileStore } from '../platform/store';
import { DriveError, quote } from '../platform/drive';
import { driveIdsItem, statusItem, syncStateItem, tagsItem, type TagsStore } from '../shared/state';
import { driveClient, withFolders } from './drive-store';

/**
 * Tags live in Marksync's own records, not in the browser: `local:tags` in
 * each browser, merged with `Marksync/tags.json` in Drive after every sync
 * (and a few seconds after a tag edit). The newest edit of a bookmark's tags
 * wins (core/tags.ts).
 */
export const TAGS_FILE = 'tags.json';

let writes: Promise<unknown> = Promise.resolve();
/** Read-modify-write of the local store, one at a time. */
function update(change: (s: TagsStore) => TagsStore): Promise<TagsStore> {
  const run = writes
    .catch(() => undefined)
    .then(async () => {
      const next = change(await tagsItem.getValue());
      await tagsItem.setValue(next);
      return next;
    });
  writes = run;
  return run;
}

/** Local bookmark ID → shared record ID, from the last sync. */
async function recordIds(): Promise<Record<string, string>> {
  return (await syncStateItem.getValue()).mapping;
}

/** Tags of every bookmark of this browser, by local ID (for the popup). */
export async function tagsByLocalId(): Promise<Record<string, string[]>> {
  const [store, mapping] = await Promise.all([tagsItem.getValue(), recordIds()]);
  const out: Record<string, string[]> = {};
  for (const [localId, recordId] of Object.entries(mapping)) {
    const tags = store.items[recordId]?.tags;
    if (tags?.length) out[localId] = tags;
  }
  for (const [localId, entry] of Object.entries(store.pending)) {
    if (entry.tags.length) out[localId] = entry.tags;
    else delete out[localId];
  }
  return out;
}

/** Tags in use, most used first. */
export async function allTags(): Promise<{ tag: string; count: number }[]> {
  return tagCounts(Object.values(await tagsByLocalId()));
}

/**
 * Sets the tags of a bookmark of this browser. With `onlyIfEmpty` (AI
 * sorting) a bookmark that already has tags keeps them.
 */
export async function setTags(localId: string, tags: string[], opts: { onlyIfEmpty?: boolean } = {}): Promise<string[]> {
  const clean = cleanTags(tags);
  const mapping = await recordIds();
  const recordId = mapping[localId];
  let result = clean;
  await update((s) => {
    const current = recordId ? (s.pending[localId] ?? s.items[recordId]) : s.pending[localId];
    if (opts.onlyIfEmpty && current?.tags.length) {
      result = current.tags;
      return s;
    }
    const entry: TagEntry = { tags: clean, at: Date.now() };
    if (recordId) {
      const { [localId]: _done, ...pending } = s.pending;
      return { ...s, items: { ...s.items, [recordId]: entry }, pending };
    }
    return { ...s, pending: { ...s.pending, [localId]: entry } };
  });
  scheduleTagsSync();
  return result;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Uploads soon, so several quick edits make one write. */
export function scheduleTagsSync(delay = 3_000): void {
  clearTimeout(timer);
  timer = setTimeout(() => void syncTags().catch((err) => console.warn('[marksync] tags sync failed', err)), delay);
}

async function tagsFileId(drive: FileStore): Promise<string | undefined> {
  const ids = await driveIdsItem.getValue();
  if (ids.tagsFileId) return ids.tagsFileId;
  const file = await withFolders(drive, (f) => drive.findByName(TAGS_FILE, f.folderId));
  if (file) await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), tagsFileId: file.id });
  return file?.id;
}

let running: Promise<void> | undefined;

/**
 * Merges this browser's tags with tags.json: pending tags get their shared
 * ID, tags of bookmarks that are gone are dropped, and the file is written
 * only when something changed. A write from another browser in between is
 * noticed by the file version and merged on a second try.
 */
export function syncTags(): Promise<void> {
  running ??= (async () => {
    try {
      if (!(await statusItem.getValue()).connected) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await mergeOnce(driveClient())) return;
      }
    } finally {
      running = undefined;
    }
  })();
  return running;
}

/** One read-merge-write; false when the file changed meanwhile. */
async function mergeOnce(drive: FileStore): Promise<boolean> {
  const now = Date.now();
  const state = await syncStateItem.getValue();
  const live = new Set(Object.values(state.mirror).filter(isLive).map((r) => r.id));
  let id = await tagsFileId(drive);
  let remote: TagMap = {};
  let version: string | undefined;
  if (id) {
    try {
      version = (await drive.getMeta(id)).version;
      remote = sanitizeTagsFile(await drive.downloadJson<unknown>(id), now);
    } catch (err) {
      if (!(err instanceof DriveError && err.status === 404)) throw err;
      const { tagsFileId: _gone, ...rest } = await driveIdsItem.getValue();
      await driveIdsItem.setValue(rest);
      id = undefined;
    }
  }

  const store = await tagsItem.getValue();
  // Pending tags of bookmarks that have synced since.
  const resolved: TagMap = {};
  const pending: Record<string, TagEntry> = {};
  for (const [localId, entry] of Object.entries(store.pending)) {
    const recordId = state.mapping[localId];
    if (recordId) resolved[recordId] = entry;
    else pending[localId] = entry;
  }
  const local = mergeTags(store.items, resolved);
  // Without a sync yet there is nothing to prune against.
  const merged = live.size ? pruneTags(mergeTags(local, remote), live, now) : mergeTags(local, remote);

  if (!tagMapsEqual(merged, remote) || !id) {
    if (!id && !Object.keys(merged).length) {
      await update((s) => ({ ...s, items: {}, pending }));
      return true;
    }
    const file: TagsFile = { schema: 1, kind: 'marksync-tags', items: merged, updatedAt: now };
    if (id) {
      if ((await drive.getMeta(id)).version !== version) return false;
      try {
        version = (await drive.updateJson(id, file, version)).version;
      } catch (err) {
        // WebDAV: changed between the check and the write; merge again.
        if (err instanceof DriveError && err.status === 412) return false;
        throw err;
      }
    } else {
      const { winner, ours } = await withFolders(drive, async (f) => {
        const made = await drive.createJson(TAGS_FILE, f.folderId, file);
        // Two browsers creating it at once: the oldest file wins, the other merges into it on the retry.
        const all = await drive.list(`name = ${quote(TAGS_FILE)} and ${quote(f.folderId)} in parents`, 'createdTime');
        const oldest = all[0] ?? made;
        if (oldest.id !== made.id) await drive.delete(made.id).catch(() => undefined);
        return { winner: oldest, ours: oldest.id === made.id };
      });
      await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), tagsFileId: winner.id });
      if (!ours) return false;
      version = winner.version;
    }
  }
  // Keep edits made while this ran: merge them over the result.
  await update((s) => {
    const newer: TagMap = {};
    for (const [rid, e] of Object.entries(s.items)) if (!local[rid] || e.at > local[rid]!.at) newer[rid] = e;
    const stillPending = { ...pending };
    for (const [lid, e] of Object.entries(s.pending)) if (!store.pending[lid] || e.at > store.pending[lid]!.at) stillPending[lid] = e;
    return { items: mergeTags(merged, newer), pending: stillPending, ...(version ? { version } : {}) };
  });
  return true;
}
