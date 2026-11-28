import {
  adoptRemote,
  applyRestore,
  buildLocalRecords,
  countNewDeletions,
  liveRecords,
  maxClock,
  mergeRecords,
  recordsEqual,
  remoteDeletions,
  reviveRemoteDeletions,
  sanitize,
} from '../core/records';
import { optionalClock, sanitizeRemoteRecords } from '../core/validate';
import { ROOT_KEYS, SYNC_SCHEMA, type IdMapping, type RecordMap, type SyncState } from '../core/types';
import type { BookmarksApi } from './bookmarks-api';
import { applyRecords, readLocal } from './local-tree';

/** Where the shared state lives (Google Drive in the extension, memory in tests). */
export interface RemoteStore {
  load(): Promise<{ state: SyncState; version: string } | null>;
  /**
   * Must throw ConflictError if the file changed since `expectedVersion` was
   * read. Returns the new version.
   */
  save(state: SyncState, expectedVersion: string | null): Promise<string>;
}

/** Per-browser sync bookkeeping, kept in extension storage. */
export interface LocalState {
  mapping: IdMapping;
  /** The merged state after the last successful sync. */
  mirror: RecordMap;
  /** Record ids this browser cannot show; never treated as deleted. */
  keep: string[];
  /** Chromium only: local ID of the folder that stands in for Bookmarks Menu. */
  menuFolderId?: string;
  /** Generation of the sync file the mirror belongs to (see SyncState.epoch). */
  epoch?: string;
}

export interface LocalStore {
  load(): Promise<LocalState>;
  save(state: LocalState): Promise<void>;
}

export interface SyncDeps {
  bookmarks: BookmarksApi;
  remote: RemoteStore;
  local: LocalStore;
  deviceLabel: string;
  now?: () => number;
  newId?: () => string;
  /** Called around local writes so bookmark events from them can be ignored. */
  onApplying?: (applying: boolean) => void;
  /**
   * Called before a sync applies a large deletion that came from the remote
   * file (MASS_DELETE_MIN or more items), so a backup can be taken first.
   */
  beforeRemoteMassDelete?: (count: number) => Promise<void>;
  /** Local folders this sync leaves alone (shared folders have their own sync). */
  exclude?: readonly string[];
}

export interface SyncOptions {
  /** Skip the mass-delete guard after the user confirmed. */
  allowMassDelete?: boolean;
  /** Replace the bookmarks with these backup records. */
  restore?: RecordMap;
  /** Keep this browser's copies of items another browser or Drive deleted. */
  keepLocal?: boolean;
}

export interface SyncResult {
  uploaded: boolean;
  localChanges: number;
  total: number;
  skipped: number;
  /** Version of the remote file after this sync; used for cheap change checks. */
  remoteVersion: string | null;
}

export class ConflictError extends Error {
  constructor() {
    super('The sync file changed while this browser was syncing.');
  }
}

/** Thrown when a sync would delete most bookmarks; the user must confirm. */
export class MassDeleteError extends Error {
  constructor(
    readonly deletions: number,
    readonly total: number,
    /** 'local': removed in this browser; 'remote': removed elsewhere (another browser or Drive). */
    readonly source: 'local' | 'remote' = 'local',
  ) {
    super(
      source === 'remote'
        ? `${deletions} of ${total} bookmarks were deleted outside this browser.`
        : `This sync would delete ${deletions} of ${total} bookmarks.`,
    );
  }
}

export const MASS_DELETE_MIN = 20;
export const MASS_DELETE_RATIO = 0.5;

export async function syncOnce(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptSync(deps, opts);
    } catch (err) {
      if (err instanceof ConflictError && attempt < 3) continue;
      throw err;
    }
  }
}

/** Adds every live record below `rootId` to `into` (iterative, linear). */
function subtreeIds(records: RecordMap, rootId: string, into: Set<string>) {
  const children = new Map<string, string[]>();
  for (const r of liveRecords(records)) {
    const list = children.get(r.parentId);
    if (list) list.push(r.id);
    else children.set(r.parentId, [r.id]);
  }
  const stack = [rootId];
  while (stack.length) {
    for (const id of children.get(stack.pop()!) ?? []) {
      if (into.has(id)) continue;
      into.add(id);
      stack.push(id);
    }
  }
}

const isMass = (deletions: number, before: number) =>
  deletions >= MASS_DELETE_MIN && deletions > before * MASS_DELETE_RATIO;

async function attemptSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncResult> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const remote = await deps.remote.load();
  const stored = await deps.local.load();
  const remoteEpoch = typeof remote?.state.epoch === 'string' ? remote.state.epoch.slice(0, 100) : undefined;
  // The sync file was created again since this browser last synced: its
  // history belongs to the old file. Start over like a first sync, so the
  // bookmarks are matched with the new file instead of uploaded twice, and
  // nothing counts as deleted.
  const restarted =
    remote !== null && remoteEpoch !== undefined && remoteEpoch !== stored.epoch && Object.keys(stored.mirror).length > 0;
  const state: LocalState = restarted
    ? { mapping: {}, mirror: {}, keep: [], ...(stored.menuFolderId ? { menuFolderId: stored.menuFolderId } : {}) }
    : stored;
  // A new file gets a new generation; an existing one keeps its own (older files have none).
  const epoch = remote ? remoteEpoch : newId();
  const { snapshot, special } = await readLocal(deps.bookmarks, state.menuFolderId, deps.exclude);
  const wallClock = (deps.now ?? Date.now)();

  // Nothing from Drive is trusted as-is: malformed records are dropped and
  // far-future clocks are clamped, so one bad record cannot break sync.
  const cleaned = remote ? sanitizeRemoteRecords(remote.state.records, wallClock) : { records: {}, dropped: 0 };
  const remoteRecords = cleaned.records;
  const confirmedAt = optionalClock(remote?.state.confirmedDeletionAt);

  // Never let the clock go backwards, even if this computer's clock is behind.
  const now = Math.max(wallClock, maxClock(remoteRecords, state.mirror) + 1);

  // A top-level folder this browser does not have (or the user deleted the
  // Chromium "Bookmarks Menu" stand-in): keep its contents, do not delete them.
  const keep = new Set(state.keep);
  for (const key of ROOT_KEYS) if (!snapshot.roots[key]) subtreeIds(state.mirror, key, keep);

  let { records, mapping } = buildLocalRecords(snapshot, state.mapping, state.mirror, now, newId, keep);
  if (Object.keys(state.mirror).length === 0 && remote) {
    ({ records, mapping } = adoptRemote(records, remoteRecords, mapping));
  }

  const confirmed = !!opts.allowMassDelete || !!opts.restore;
  const before = liveRecords(state.mirror).length;

  // Guard 1: most bookmarks were removed in this browser.
  const deletions = countNewDeletions(state.mirror, records);
  if (!confirmed && isMass(deletions, before)) throw new MassDeleteError(deletions, before, 'local');

  let merged = mergeRecords(records, remoteRecords);
  if (opts.restore) merged = applyRestore(merged, opts.restore, now);
  if (opts.keepLocal) merged = reviveRemoteDeletions(merged, records, state.mirror, now);

  // Guard 2: most bookmarks were removed elsewhere (another browser or Drive).
  // Accepted without asking only if a user confirmed that deletion in some
  // browser; a backup is taken first in every case.
  const fromRemote = remoteDeletions(state.mirror, records, merged);
  if (fromRemote.length >= MASS_DELETE_MIN) {
    const newest = Math.max(...fromRemote.map((r) => r.deletedAt ?? 0));
    const confirmedElsewhere = confirmedAt !== undefined && newest <= confirmedAt;
    if (!confirmed && !confirmedElsewhere && isMass(fromRemote.length, before)) {
      throw new MassDeleteError(fromRemote.length, before, 'remote');
    }
    // A restore already took its own "before restore" backup.
    if (!opts.restore) await deps.beforeRemoteMassDelete?.(fromRemote.length);
  }
  merged = sanitize(merged, now);

  deps.onApplying?.(true);
  let applied;
  try {
    applied = await applyRecords(deps.bookmarks, merged, mapping, {
      ...(state.menuFolderId ? { menuFolderId: state.menuFolderId } : {}),
      special,
    });
  } finally {
    deps.onApplying?.(false);
  }

  await deps.local.save({
    mapping: applied.mapping,
    mirror: merged,
    keep: [...applied.skipped],
    ...(applied.menuFolderId ? { menuFolderId: applied.menuFolderId } : {}),
    ...(epoch ? { epoch } : {}),
  });

  // Upload when anything changed, including when bad remote records were
  // dropped, so the cleaned file replaces the broken one.
  const confirmedDeletionAt = confirmed ? now : confirmedAt;
  const uploaded =
    !remote || cleaned.dropped > 0 || confirmedDeletionAt !== confirmedAt || !recordsEqual(merged, remoteRecords);
  let remoteVersion = remote?.version ?? null;
  if (uploaded) {
    remoteVersion = await deps.remote.save(
      {
        schema: SYNC_SCHEMA,
        records: merged,
        updatedAt: now,
        updatedBy: deps.deviceLabel,
        ...(confirmedDeletionAt !== undefined ? { confirmedDeletionAt } : {}),
        ...(epoch ? { epoch } : {}),
      },
      remote?.version ?? null,
    );
  }

  return {
    uploaded,
    localChanges: applied.changes,
    total: liveRecords(merged).length,
    skipped: applied.skipped.size,
    remoteVersion,
  };
}
