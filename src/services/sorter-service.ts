import { browser } from 'wxt/browser';
import { listFolderOptions } from '../core/ai-sort';
import { chatCompletion, checkKey, hasOpenRouterPermission, OpenRouterError } from '../platform/openrouter';
import { t } from '../shared/i18n';
import {
  getSettings,
  openRouterKeyItem,
  SORT_LOG_MAX,
  sortLogItem,
  type SortLogEntry,
} from '../shared/state';
import { detectSpecialRoots } from '../sync/local-tree';
import { sortOne, undoSort, UndoError, type SortOutcome } from '../sync/sorter';
import { isApplying, localBookmarks } from './sync-service';

/**
 * AI sorting: a bookmark added to the inbox folder *in this browser* is filed
 * into a matching folder by a model on OpenRouter, a few seconds later.
 *
 * Only local additions are handled (never bookmarks that arrive through
 * sync), so two browsers with AI sorting turned on never sort the same
 * bookmark twice. The move itself is an ordinary local change and syncs to
 * every browser.
 */

/** Wait after a bookmark lands in the inbox: the star dialog may still rename or move it. */
const SORT_DELAY_MS = 5_000;
/** "Sort inbox now" handles at most this many bookmarks per click. */
const SORT_NOW_MAX = 50;

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Bookmarks Marksync itself moves into the inbox (Undo); their move event is not a new arrival. */
const ignoreMoves = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.catch(() => undefined).then(task);
  queue = run;
  return run;
}

// ---------- log ----------

let logWrites: Promise<unknown> = Promise.resolve();

function writeLog(change: (log: SortLogEntry[]) => SortLogEntry[]): Promise<SortLogEntry[]> {
  const write = logWrites
    .catch(() => undefined)
    .then(async () => {
      const next = change((await sortLogItem.getValue()) ?? []).slice(0, SORT_LOG_MAX);
      await sortLogItem.setValue(next);
      return next;
    });
  logWrites = write;
  return write;
}

function addLog(outcome: SortOutcome): Promise<SortLogEntry[]> {
  const entry: SortLogEntry = { id: crypto.randomUUID(), at: Date.now(), ...outcome };
  return writeLog((log) => [entry, ...log]);
}

export function clearSortLog(): Promise<unknown> {
  return writeLog(() => []);
}

// ---------- sorting ----------

interface Ready {
  inboxId: string;
  apiKey: string;
  model: string;
  allowNewFolders: boolean;
}

/** The settings needed to sort, or null when AI sorting is off or incomplete. */
async function readiness(): Promise<Ready | null> {
  const [s, apiKey] = await Promise.all([getSettings(), openRouterKeyItem.getValue()]);
  if (!s.aiSortEnabled || !s.aiInboxFolderId || !apiKey) return null;
  return { inboxId: s.aiInboxFolderId, apiKey, model: s.aiModel, allowNewFolders: s.aiAllowNewFolders };
}

async function waitWhileSyncApplies() {
  for (let i = 0; i < 20 && isApplying(); i++) await new Promise((r) => setTimeout(r, 500));
}

async function sortBookmark(id: string, ready: Ready): Promise<SortOutcome | null> {
  await waitWhileSyncApplies();
  const bookmarks = localBookmarks();
  const special = await detectSpecialRoots(bookmarks);
  const outcome = await sortOne(
    {
      bookmarks,
      exclude: special.exclude,
      language: browser.i18n.getUILanguage(),
      complete: (messages) => chatCompletion({ apiKey: ready.apiKey, model: ready.model, messages }),
    },
    { inboxId: ready.inboxId, allowNewFolders: ready.allowNewFolders, model: ready.model },
    id,
  );
  if (outcome) await addLog(outcome);
  return outcome;
}

function schedule(id: string) {
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      void serial(async () => {
        const ready = await readiness();
        if (ready) await sortBookmark(id, ready);
      }).catch((err) => console.warn('[marksync] AI sorting failed', err));
    }, SORT_DELAY_MS),
  );
}

// ---------- bookmark events (called by the background script for local changes only) ----------

export async function onBookmarkCreated(id: string, node: { parentId?: string; url?: string }): Promise<void> {
  if (node.url === undefined || !node.parentId) return;
  const s = await getSettings();
  if (s.aiSortEnabled && node.parentId === s.aiInboxFolderId) schedule(id);
}

export async function onBookmarkMoved(id: string, info: { parentId: string; oldParentId: string }): Promise<void> {
  if (ignoreMoves.delete(id)) return;
  if (info.parentId === info.oldParentId) return;
  const s = await getSettings();
  if (s.aiSortEnabled && info.parentId === s.aiInboxFolderId) schedule(id);
  // Moved out of the inbox before sorting started: leave it where the user put it.
  else if (pending.has(id)) {
    clearTimeout(pending.get(id));
    pending.delete(id);
  }
}

/** A rename while waiting (the star dialog): wait a little longer, so the model sees the final title. */
export function onBookmarkChanged(id: string): void {
  if (pending.has(id)) schedule(id);
}

export function onBookmarkRemoved(id: string): void {
  clearTimeout(pending.get(id));
  pending.delete(id);
}

// ---------- requests from Settings and the log page ----------

export interface SortNowResult {
  sorted: number;
  kept: number;
  failed: number;
}

/** Sorts the bookmarks already waiting in the inbox. */
export function sortInboxNow(): Promise<SortNowResult> {
  return serial(async () => {
    const ready = await readiness();
    if (!ready) throw new Error(t('aiNotReady'));
    if (!(await hasOpenRouterPermission())) throw new Error(t('aiPermissionMissing'));
    const children = await localBookmarks().getChildren(ready.inboxId);
    const result: SortNowResult = { sorted: 0, kept: 0, failed: 0 };
    for (const child of children.filter((c) => c.url !== undefined).slice(0, SORT_NOW_MAX)) {
      clearTimeout(pending.get(child.id));
      pending.delete(child.id);
      const outcome = await sortBookmark(child.id, ready);
      if (!outcome) continue;
      if (outcome.status === 'moved' || outcome.status === 'created') result.sorted++;
      else if (outcome.status === 'kept') result.kept++;
      else {
        result.failed++;
        // A wrong key or no credits fails every bookmark the same way: stop.
        if (['auth', 'credits', 'permission'].includes(outcome.errorCode ?? '')) break;
      }
    }
    return result;
  });
}

const undoMessages: Record<UndoError['reason'], string> = {
  gone: 'aiUndoGone',
  moved: 'aiUndoMoved',
  'no-source': 'aiUndoNoSource',
};

export function undoSortEntry(logId: string): Promise<void> {
  return serial(async () => {
    const entry = ((await sortLogItem.getValue()) ?? []).find((e) => e.id === logId);
    if (!entry || (entry.status !== 'moved' && entry.status !== 'created') || entry.undoneAt) {
      throw new Error(t('aiUndoUnavailable'));
    }
    ignoreMoves.add(entry.bookmarkId);
    try {
      await undoSort(localBookmarks(), entry);
    } catch (err) {
      ignoreMoves.delete(entry.bookmarkId);
      if (err instanceof UndoError) throw new Error(t(undoMessages[err.reason]));
      throw err;
    }
    // The move event is dispatched asynchronously; forget the marker if it never comes.
    setTimeout(() => ignoreMoves.delete(entry.bookmarkId), 5_000);
    await writeLog((log) => log.map((e) => (e.id === logId ? { ...e, undoneAt: Date.now() } : e)));
  });
}

/** Every folder of this browser, for the inbox picker in Settings. */
export async function listFolderChoices(): Promise<{ id: string; path: string }[]> {
  const bookmarks = localBookmarks();
  const [tree, special] = await Promise.all([bookmarks.getTree(), detectSpecialRoots(bookmarks)]);
  return listFolderOptions(tree, { exclude: special.exclude, max: 2000 })
    .map((f) => ({ id: f.localId, path: f.path }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** "Test" in Settings: checks the saved key with OpenRouter (no credits used). */
export async function testOpenRouter(): Promise<string> {
  const apiKey = await openRouterKeyItem.getValue();
  if (!apiKey) throw new Error(t('aiNoKey'));
  try {
    return await checkKey(apiKey);
  } catch (err) {
    if (err instanceof OpenRouterError && err.code === 'permission') throw new Error(t('aiPermissionMissing'));
    if (err instanceof OpenRouterError && err.code === 'auth') throw new Error(t('aiKeyRejected'));
    throw err;
  }
}
