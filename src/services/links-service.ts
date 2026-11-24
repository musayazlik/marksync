import { browser } from 'wxt/browser';
import {
  classify,
  hostOf,
  listCheckable,
  parseWayback,
  shouldRetryWithGet,
  waybackLookupUrl,
  type Attempt,
  type CheckableBookmark,
  type Verdict,
} from '../core/links';
import { t } from '../shared/i18n';
import { linkScanItem, statusItem, type LinkResult, type LinkScan } from '../shared/state';
import { detectSpecialRoots } from '../sync/local-tree';
import { createBackup } from './backup-service';
import { localBookmarks } from './sync-service';

/**
 * Link checker (links page). Checks every bookmarked web page with HEAD (GET
 * when HEAD is refused), at most four at a time and one per site, without
 * cookies, and looks up a Wayback Machine copy for the dead ones. Results are
 * stored as the scan goes, so the page shows progress and an interrupted scan
 * can continue. Fixes go through the bookmarks API and sync like any change.
 */

/** Access to every site is optional and asked for when the user starts a check. */
export const LINK_ORIGINS = ['*://*/*'];

const CONCURRENCY = 4;
const TIMEOUT_MS = 12_000;
/** A page that looked dead is checked once more after this pause. */
const CONFIRM_DELAY_MS = 2_000;
const SAVE_EVERY_MS = 700;
const KEEPALIVE_MS = 20_000;

let running: Promise<void> | null = null;
let stopRequested = false;

// ---------- state ----------

let writes: Promise<unknown> = Promise.resolve();

function update(change: (s: LinkScan) => LinkScan): Promise<LinkScan> {
  const run = writes
    .catch(() => undefined)
    .then(async () => {
      const next = change(await linkScanItem.getValue());
      await linkScanItem.setValue(next);
      return next;
    });
  writes = run;
  return run;
}

/** Called when the background script starts: a scan that was running did not finish. */
export async function markInterruptedScan(): Promise<void> {
  if (running) return;
  const s = await linkScanItem.getValue();
  if (s.running) await update((x) => ({ ...x, running: false, interrupted: true }));
}

// ---------- one request ----------

async function request(url: string, method: 'HEAD' | 'GET'): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      // No cookies: a check must never act as the signed-in user (a bookmarked
      // "log out" or "unsubscribe" link would otherwise run).
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    // Only the status matters; do not download pages.
    void res.body?.cancel().catch(() => undefined);
    return { status: res.status, finalUrl: res.url || url };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return { error: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The verdict for one page: HEAD, then GET when needed, and a second look before calling it dead. */
export async function checkUrl(url: string): Promise<Verdict> {
  let attempt = await request(url, 'HEAD');
  if (shouldRetryWithGet(attempt)) attempt = await request(url, 'GET');
  let verdict = classify(url, attempt);
  if (verdict.status === 'dead') {
    await pause(CONFIRM_DELAY_MS);
    verdict = classify(url, await request(url, 'GET'));
  }
  return verdict;
}

async function lookupArchive(url: string): Promise<LinkResult['archive']> {
  try {
    const res = await fetch(waybackLookupUrl(url), { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined; // unknown, try again later
    return parseWayback(await res.json()) ?? null;
  } catch {
    return undefined;
  }
}

// ---------- the scan ----------

export async function hasLinkPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: LINK_ORIGINS });
}

async function listBookmarks(): Promise<CheckableBookmark[]> {
  const bookmarks = localBookmarks();
  const [tree, special] = await Promise.all([bookmarks.getTree(), detectSpecialRoots(bookmarks)]);
  return listCheckable(tree, { exclude: special.exclude });
}

/**
 * Starts a check of every bookmark, or continues the interrupted one. Returns
 * at once; progress and results are in `linkScanItem`.
 */
export async function startLinkScan(opts: { resume?: boolean } = {}): Promise<void> {
  if (running) return;
  if (!(await hasLinkPermission())) throw new Error(t('linkPermissionMissing'));
  const all = await listBookmarks();
  const previous = await linkScanItem.getValue();
  const resume = !!opts.resume && previous.interrupted && previous.checkedIds.length > 0;
  const done = new Set(resume ? previous.checkedIds : []);
  const todo = all.filter((b) => !done.has(b.id));
  await update(() => ({
    running: true,
    startedAt: resume ? previous.startedAt : Date.now(),
    total: all.length,
    checked: done.size,
    results: resume ? previous.results : [],
    checkedIds: [...done],
  }));
  stopRequested = false;
  running = runScan(todo).finally(() => {
    running = null;
  });
}

export function stopLinkScan(): void {
  stopRequested = true;
}

async function runScan(todo: CheckableBookmark[]): Promise<void> {
  const keepAlive = setInterval(() => void browser.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  const busyHosts = new Set<string>();
  const queue = [...todo];
  let pendingIds: string[] = [];
  let pendingResults: LinkResult[] = [];
  let lastSave = 0;

  const flush = async (force = false) => {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    const ids = pendingIds;
    const results = pendingResults;
    pendingIds = [];
    pendingResults = [];
    if (!ids.length && !results.length) return;
    await update((s) => ({
      ...s,
      checked: s.checked + ids.length,
      checkedIds: [...s.checkedIds, ...ids],
      results: [...s.results, ...results],
    }));
  };

  /** The next bookmark whose site is not being checked right now. */
  const next = (): CheckableBookmark | undefined => {
    const i = queue.findIndex((b) => !busyHosts.has(hostOf(b.url)));
    return i < 0 ? undefined : queue.splice(i, 1)[0];
  };

  const worker = async () => {
    while (!stopRequested && queue.length) {
      const b = next();
      if (!b) {
        await pause(150);
        continue;
      }
      const host = hostOf(b.url);
      busyHosts.add(host);
      try {
        const v = await checkUrl(b.url);
        if (v.status !== 'ok') {
          pendingResults.push({
            id: b.id,
            title: b.title,
            url: b.url,
            folderPath: b.folderPath,
            status: v.status,
            ...(v.reason ? { reason: v.reason } : {}),
            ...(v.httpStatus ? { httpStatus: v.httpStatus } : {}),
            ...(v.finalUrl ? { finalUrl: v.finalUrl } : {}),
          });
        }
      } finally {
        busyHosts.delete(host);
      }
      pendingIds.push(b.id);
      await flush();
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush(true);
    // Archive copies for the dead pages, one at a time to be gentle with archive.org.
    const dead = (await linkScanItem.getValue()).results.filter((r) => r.status === 'dead' && r.archive === undefined);
    for (const r of dead) {
      if (stopRequested) break;
      const archive = await lookupArchive(r.url);
      if (archive !== undefined) {
        await update((s) => ({ ...s, results: s.results.map((x) => (x.id === r.id ? { ...x, archive } : x)) }));
      }
    }
  } finally {
    clearInterval(keepAlive);
    await flush(true);
    const stopped = stopRequested;
    await update((s) => ({
      ...s,
      running: false,
      interrupted: stopped || s.checked < s.total,
      ...(stopped ? {} : { finishedAt: Date.now() }),
    }));
  }
}

// ---------- fixes ----------

export type LinkAction = 'update' | 'archive' | 'remove' | 'keep' | 'recheck';

async function currentUrl(id: string): Promise<string | undefined> {
  try {
    const [node] = await browser.bookmarks.get(id);
    return node?.url;
  } catch {
    return undefined;
  }
}

function mark(id: string, patch: Partial<LinkResult>): Promise<LinkScan> {
  return update((s) => ({ ...s, results: s.results.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

/** One fix for one flagged bookmark. A bookmark edited since the check is left alone. */
export async function fixLink(id: string, action: LinkAction): Promise<void> {
  const result = (await linkScanItem.getValue()).results.find((r) => r.id === id);
  if (!result) throw new Error(t('linkGone'));
  if (action === 'keep') {
    await mark(id, { done: 'kept' });
    return;
  }
  const url = await currentUrl(id);
  if (url === undefined) {
    await mark(id, { done: 'removed' });
    throw new Error(t('linkGone'));
  }
  if (url !== result.url) throw new Error(t('linkChanged'));
  const bookmarks = localBookmarks();
  if (action === 'update') {
    if (!result.finalUrl) throw new Error(t('linkGone'));
    await bookmarks.update(id, { url: result.finalUrl });
    await mark(id, { done: 'updated' });
  } else if (action === 'archive') {
    if (!result.archive) throw new Error(t('linkNoArchive'));
    await bookmarks.update(id, { url: result.archive.url });
    await mark(id, { done: 'archived' });
  } else if (action === 'remove') {
    await bookmarks.remove(id);
    await mark(id, { done: 'removed' });
  } else if (action === 'recheck') {
    const v = await checkUrl(url);
    if (v.status === 'ok') {
      await update((s) => ({ ...s, results: s.results.filter((r) => r.id !== id) }));
      return;
    }
    const archive = v.status === 'dead' && result.archive === undefined ? await lookupArchive(url) : result.archive;
    await mark(id, {
      status: v.status,
      reason: v.reason,
      httpStatus: v.httpStatus,
      finalUrl: v.finalUrl,
      ...(archive !== undefined ? { archive } : {}),
    });
  }
}

export interface BulkLinkResult {
  changed: number;
  skipped: number;
  backedUp: boolean;
}

/**
 * Removes every dead bookmark still open in the list, or points every
 * redirected one at its new address. Removing takes a backup first when
 * connected to Drive.
 */
export async function fixAllLinks(kind: 'remove-dead' | 'update-redirects'): Promise<BulkLinkResult> {
  const scan = await linkScanItem.getValue();
  const status = kind === 'remove-dead' ? 'dead' : 'redirected';
  const targets = scan.results.filter((r) => r.status === status && !r.done);
  if (!targets.length) return { changed: 0, skipped: 0, backedUp: false };
  let backedUp = false;
  if (kind === 'remove-dead' && (await statusItem.getValue()).connected) {
    await createBackup('before-cleanup');
    backedUp = true;
  }
  const bookmarks = localBookmarks();
  let changed = 0;
  let skipped = 0;
  for (const r of targets) {
    const url = await currentUrl(r.id);
    if (url !== r.url) {
      skipped++;
      continue;
    }
    try {
      if (kind === 'remove-dead') {
        await bookmarks.remove(r.id);
        await mark(r.id, { done: 'removed' });
      } else if (r.finalUrl) {
        await bookmarks.update(r.id, { url: r.finalUrl });
        await mark(r.id, { done: 'updated' });
      }
      changed++;
    } catch {
      skipped++;
    }
  }
  return { changed, skipped, backedUp };
}
