import { browser } from 'wxt/browser';
import type { RecordMap } from '../core/types';
import { InvalidRemoteDataError } from '../core/validate';
import { deviceLabel } from '../platform/browser-info';
import { DriveError } from '../platform/drive';
import { AuthRequiredError, ConfigError } from '../platform/identity';
import { patchStatus, remoteVersionItem, sharesItem, statusItem, syncStateItem, type ErrorCode, type Status } from '../shared/state';
import type { BookmarkNode, BookmarksApi } from '../sync/bookmarks-api';
import { MassDeleteError, syncOnce, type SyncOptions, type SyncResult } from '../sync/engine';
import { createBackup } from './backup-service';
import { LockedError } from './errors';
import { DriveRemoteStore, driveClient } from './drive-store';
import { syncTags } from './tags-service';

let tail: Promise<unknown> = Promise.resolve();
let queuedSync: Promise<SyncResult> | null = null;
let ignoreEventsUntil = 0;

/** True while (or just after) Marksync writes bookmarks, so its own events are ignored. */
/** Run after every successful sync (shared folders register here, to avoid an import cycle). */
export const afterSyncHooks: (() => Promise<unknown> | void)[] = [];

async function sharedContainer(): Promise<string[]> {
  const { containerId } = await sharesItem.getValue();
  return containerId ? [containerId] : [];
}

export function isApplying(): boolean {
  return Date.now() < ignoreEventsUntil;
}

type OperaGetRoot = (name: string, callback: (node?: BookmarkNode) => void) => void;

/**
 * The browser's bookmarks API, plus Opera's callback-only `getRootByName`
 * wrapped as a promise when it exists.
 */
export function localBookmarks(): BookmarksApi {
  const b = browser.bookmarks as unknown as BookmarksApi;
  const chromeBookmarks = (globalThis as { chrome?: { bookmarks?: { getRootByName?: OperaGetRoot } } }).chrome
    ?.bookmarks;
  const getRoot = chromeBookmarks?.getRootByName;
  return {
    getTree: () => b.getTree(),
    getChildren: (id) => b.getChildren(id),
    create: (d) => b.create(d),
    update: (id, c) => b.update(id, c),
    move: (id, d) => b.move(id, d),
    remove: (id) => b.remove(id),
    removeTree: (id) => b.removeTree(id),
    ...(getRoot
      ? {
          getRootByName: (name: string) =>
            new Promise<BookmarkNode | undefined>((resolve) => getRoot.call(chromeBookmarks, name, resolve)),
        }
      : {}),
  };
}

/** Runs tasks that write bookmarks one after another, never two at once. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.catch(() => undefined).then(task);
  tail = run;
  return run;
}

/** Runs `task` with sync on hold and bookmark events ignored (used by imports). */
export function exclusive<T>(task: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    ignoreEventsUntil = Number.POSITIVE_INFINITY;
    try {
      return await task();
    } finally {
      ignoreEventsUntil = Date.now() + 2000;
    }
  });
}

export function describeError(err: unknown): NonNullable<Status['error']> {
  const message = err instanceof Error ? err.message : String(err);
  let code: ErrorCode = 'unknown';
  if (err instanceof AuthRequiredError) code = 'auth';
  else if (err instanceof LockedError) code = 'locked';
  else if (err instanceof ConfigError) code = 'config';
  else if (err instanceof MassDeleteError) {
    return { code: 'mass-delete', message, deletions: err.deletions, total: err.total, source: err.source };
  } else if (err instanceof InvalidRemoteDataError) code = 'unknown';
  else if ((err instanceof TypeError && /fetch|network/i.test(message)) || (err instanceof DriveError && err.status >= 500)) {
    code = 'network';
  }
  return { code, message };
}

async function doSync(opts: SyncOptions): Promise<SyncResult> {
  await patchStatus({ syncing: true });
  try {
    const result = await syncOnce(
      {
        bookmarks: localBookmarks(),
        remote: new DriveRemoteStore(driveClient()),
        local: {
          load: () => syncStateItem.getValue(),
          save: (s) => syncStateItem.setValue(s),
        },
        deviceLabel: await deviceLabel(),
        // Shared folders sync through their own files (services/share-service.ts).
        exclude: await sharedContainer(),
        onApplying: (on) => {
          ignoreEventsUntil = on ? Number.POSITIVE_INFINITY : Date.now() + 2000;
        },
        // A large deletion is arriving from another browser or Drive: keep a
        // copy of the current bookmarks first, so it can always be undone.
        beforeRemoteMassDelete: async () => {
          await createBackup('before-remote-delete');
        },
      },
      opts,
    );
    if (result.remoteVersion) await remoteVersionItem.setValue(result.remoteVersion);
    await patchStatus({
      syncing: false,
      lastSyncAt: Date.now(),
      total: result.total,
      skipped: result.skipped,
      error: undefined,
    });
    // Tags are a separate file: merged after the bookmarks, never blocking them.
    void syncTags().catch((err) => console.warn('[marksync] tags sync failed', err));
    for (const hook of afterSyncHooks) void Promise.resolve().then(hook).catch((err) => console.warn('[marksync] after-sync task failed', err));
    return result;
  } catch (err) {
    await patchStatus({ syncing: false, error: describeError(err) });
    throw err;
  }
}

/**
 * Queues one sync. Plain syncs requested while one is already waiting share
 * it; a request made during a running sync queues a new one, so changes
 * made in the meantime are not missed.
 */
export function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const plain = !opts.restore && !opts.allowMassDelete && !opts.keepLocal;
  if (plain && queuedSync) return queuedSync;
  const task: Promise<SyncResult> = enqueue(() => {
    if (queuedSync === task) queuedSync = null;
    return doSync(opts);
  });
  if (plain) queuedSync = task;
  return task;
}

/** A full sync runs at least this often, even if Drive did not change. */
const FULL_SYNC_EVERY_MS = 30 * 60_000;

/**
 * The cheap check behind "instant" sync: asks Drive only for the sync file's
 * version number (one small request) and syncs only when another browser
 * changed it. Returns null when nothing had to be done.
 */
export async function syncIfRemoteChanged(): Promise<SyncResult | null> {
  try {
    const [known, status] = await Promise.all([remoteVersionItem.getValue(), statusItem.getValue()]);
    const stale = !status.lastSyncAt || Date.now() - status.lastSyncAt > FULL_SYNC_EVERY_MS;
    if (known && !stale && !status.error) {
      const current = await new DriveRemoteStore(driveClient()).currentVersion();
      if (current === known) return null;
    }
  } catch (err) {
    await patchStatus({ error: describeError(err) });
    throw err;
  }
  return runSync();
}

/** "Keep my bookmarks" after a large remote deletion was paused. */
export function keepLocalBookmarks(): Promise<SyncResult> {
  return runSync({ keepLocal: true });
}

export function restoreRecords(records: RecordMap): Promise<SyncResult> {
  return runSync({ restore: records });
}

/**
 * "Undo my local deletions": forget this browser's sync history and sync
 * again as if it were new. Nothing local is deleted remotely; items that
 * exist in Drive come back.
 */
export async function resyncFromDrive(): Promise<SyncResult> {
  await exclusive(async () => {
    const { menuFolderId } = await syncStateItem.getValue();
    await syncStateItem.setValue({ mapping: {}, mirror: {}, keep: [], ...(menuFolderId ? { menuFolderId } : {}) });
  });
  return runSync();
}
