import { browser } from 'wxt/browser';
import { toNetscapeHtml } from '../core/netscape';
import { deviceLabel } from '../platform/browser-info';
import { connect, disconnect, redirectUrl } from '../platform/identity';
import {
  backupIfDue,
  createBackup,
  currentRecords,
  deleteBackup,
  listBackups,
  restoreBackup,
} from '../services/backup-service';
import {
  importFromBrowser,
  importHtml,
  listBrowsers,
  publishSnapshot,
  removeBrowser,
} from '../services/import-service';
import { updateBadge } from '../services/badge';
import { removeDuplicates, scanDuplicates } from '../services/dedupe-service';
import { fixAllLinks, fixLink, markInterruptedScan, startLinkScan, stopLinkScan } from '../services/links-service';
import { applyBulk, cancelBulk, discardBulk, resumeBulk, startBulk } from '../services/bulk-service';
// Also installs the encryption codec for every Drive client (see drive-store.ts).
import {
  disableEncryption,
  enableEncryption,
  encryptionStatus,
  lockEncryption,
  resetEncryption,
  unlockEncryption,
} from '../services/encryption-service';
import {
  clearSortLog,
  listFolderChoices,
  listModels,
  refreshUsage,
  onBookmarkChanged,
  onBookmarkCreated,
  onBookmarkMoved,
  onBookmarkRemoved,
  sortInboxNow,
  testOpenRouter,
  undoSortEntry,
} from '../services/sorter-service';
import { isApplying, keepLocalBookmarks, resyncFromDrive, runSync, syncIfRemoteChanged } from '../services/sync-service';
import type { Envelope, Request } from '../shared/messages';
import { t } from '../shared/i18n';
import { getSettings, patchStatus, settingsItem, statusItem } from '../shared/state';

const SYNC_ALARM = 'marksync-sync';
const BACKUP_ALARM = 'marksync-backup';
/** Short wait after a bookmark change, so the star dialog's follow-up edits go in one upload. */
const EVENT_DEBOUNCE_MS = 1000;
/** After switching to this browser: check now, and again in case the other browser is still uploading. */
const FOCUS_CHECKS_MS = [0, 5_000, 15_000];

export default defineBackground(() => {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let browserImporting = false;

  let lastFocusCheck = 0;

  // A link check that was running when the worker stopped can be continued from the links page.
  void markInterruptedScan().catch(() => undefined);

  /**
   * Syncs (if sync is on) and shares this browser's tree with the others
   * (whenever an account is connected, even with sync off).
   * `check` only syncs if another browser changed Drive (one small request).
   */
  async function syncAndPublish(mode: 'full' | 'check' = 'full') {
    const [settings, status] = await Promise.all([getSettings(), statusItem.getValue()]);
    if (!status.connected) return;
    if (settings.syncEnabled) {
      try {
        await (mode === 'check' ? syncIfRemoteChanged() : runSync());
      } catch (err) {
        console.warn('[marksync] sync failed', err);
        return;
      }
    }
    await publishSnapshot().catch((err) => console.warn('[marksync] snapshot upload failed', err));
  }

  /** The user came to this browser: pull what they just added in another one. */
  function checkSoon() {
    if (Date.now() - lastFocusCheck < 3000) return;
    lastFocusCheck = Date.now();
    for (const delay of FOCUS_CHECKS_MS) setTimeout(() => void syncAndPublish('check'), delay);
  }

  function onBookmarkEvent() {
    if (isApplying() || browserImporting) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncAndPublish(), EVENT_DEBOUNCE_MS);
  }

  async function scheduleAlarms() {
    const s = await getSettings();
    await browser.alarms.clear(SYNC_ALARM);
    await browser.alarms.clear(BACKUP_ALARM);
    browser.alarms.create(SYNC_ALARM, { periodInMinutes: Math.max(1, s.syncIntervalMin) });
    if (s.autoBackup) browser.alarms.create(BACKUP_ALARM, { periodInMinutes: 60 });
  }

  browser.runtime.onInstalled.addListener((details) => {
    void scheduleAlarms();
    // First install only (not updates): open Settings with a short welcome
    // and the Connect button, instead of leaving the user to find the icon.
    if (details.reason === 'install') {
      void browser.tabs.create({ url: browser.runtime.getURL('/options.html#welcome') });
    }
  });

  /** Keeps the toolbar icon's badge and tooltip in step with the sync status. */
  async function refreshBadge() {
    const [status, settings] = await Promise.all([statusItem.getValue(), getSettings()]);
    await updateBadge(status, settings).catch((err) => console.warn('[marksync] badge update failed', err));
  }
  statusItem.watch(() => void refreshBadge());
  settingsItem.watch(() => void refreshBadge());
  // Every start of the service worker: a bulk sorting run that was cut off carries on.
  void resumeBulk().catch((err) => console.warn('[marksync] bulk sorting could not resume', err));
  browser.runtime.onStartup.addListener(() => {
    void scheduleAlarms();
    void syncAndPublish();
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === SYNC_ALARM) await syncAndPublish('check');
    if (alarm.name === BACKUP_ALARM) {
      const status = await statusItem.getValue();
      if (!status.connected) return;
      await backupIfDue(status.lastBackupAt).catch((err) => console.warn('[marksync] backup failed', err));
    }
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== browser.windows.WINDOW_ID_NONE) checkSoon();
  });

  browser.bookmarks.onCreated.addListener(onBookmarkEvent);
  browser.bookmarks.onRemoved.addListener(onBookmarkEvent);
  browser.bookmarks.onChanged.addListener(onBookmarkEvent);
  browser.bookmarks.onMoved.addListener(onBookmarkEvent);

  // AI sorting reacts only to changes made in this browser, never to what
  // sync or an import writes (see services/sorter-service.ts).
  const local = () => !isApplying() && !browserImporting;
  browser.bookmarks.onCreated.addListener((id, node) => {
    if (local()) void onBookmarkCreated(id, node).catch((err) => console.warn('[marksync] AI sorting', err));
  });
  browser.bookmarks.onMoved.addListener((id, info) => {
    if (local()) void onBookmarkMoved(id, info).catch((err) => console.warn('[marksync] AI sorting', err));
  });
  browser.bookmarks.onChanged.addListener((id) => onBookmarkChanged(id));
  browser.bookmarks.onRemoved.addListener((id) => onBookmarkRemoved(id));
  // Chromium only: the browser's own "Import bookmarks" dialog.
  browser.bookmarks.onChildrenReordered?.addListener(onBookmarkEvent);
  browser.bookmarks.onImportBegan?.addListener(() => (browserImporting = true));
  browser.bookmarks.onImportEnded?.addListener(() => {
    browserImporting = false;
    onBookmarkEvent();
  });

  async function afterImport<T>(result: T): Promise<T> {
    void syncAndPublish();
    return result;
  }

  async function handle(req: Request): Promise<unknown> {
    switch (req.type) {
      case 'connect': {
        const email = await connect();
        await scheduleAlarms();
        void syncAndPublish();
        return email;
      }
      case 'disconnect':
        return disconnect();
      case 'syncNow':
        if (!(await getSettings()).syncEnabled) throw new Error(t('syncOffHint'));
        await runSync(req.allowMassDelete ? { allowMassDelete: true } : {});
        void publishSnapshot().catch(() => undefined);
        return;
      case 'checkNow':
        checkSoon();
        return;
      case 'resyncFromDrive':
        await resyncFromDrive();
        return;
      case 'keepLocal':
        await keepLocalBookmarks();
        void publishSnapshot().catch(() => undefined);
        return;
      case 'backupNow':
        return createBackup('manual');
      case 'listBackups':
        return listBackups();
      case 'restoreBackup':
        return restoreBackup(req.id);
      case 'deleteBackup':
        return deleteBackup(req.id);
      case 'listBrowsers':
        await publishSnapshot().catch(() => undefined);
        return listBrowsers();
      case 'removeBrowser':
        return removeBrowser(req.fileId);
      case 'importFromBrowser':
        return afterImport(await importFromBrowser(req.fileId, req.mode));
      case 'importHtml':
        return afterImport(await importHtml(req.html, req.mode, req.label));
      case 'exportHtml':
        return toNetscapeHtml(await currentRecords());
      case 'getRedirectUrl':
        return redirectUrl();
      case 'settingsChanged':
        return scheduleAlarms();
      case 'aiListFolders':
        return listFolderChoices();
      case 'aiTestKey':
        return testOpenRouter();
      case 'aiListModels':
        return listModels(req.refresh === true);
      case 'aiUsage':
        return refreshUsage();
      case 'aiBulkStart':
        if (typeof req.folderId !== 'string' || !req.folderId) throw new Error(t('aiBulkEmpty'));
        return startBulk(req.folderId, req.research === true);
      case 'aiBulkCancel':
        return cancelBulk();
      case 'aiBulkApply':
        if (!Array.isArray(req.bookmarkIds) || !req.bookmarkIds.every((id) => typeof id === 'string')) return { moved: 0, failed: 0 };
        return applyBulk(req.bookmarkIds.slice(0, 1000));
      case 'aiBulkDiscard':
        return discardBulk();
      case 'encStatus':
        return encryptionStatus();
      case 'encEnable': {
        const status = await enableEncryption(String(req.passphrase ?? ''), await deviceLabel());
        void syncAndPublish();
        return status;
      }
      case 'encUnlock': {
        const status = await unlockEncryption(String(req.passphrase ?? ''));
        void syncAndPublish();
        return status;
      }
      case 'encLock':
        return lockEncryption();
      case 'encDisable': {
        const status = await disableEncryption();
        void syncAndPublish();
        return status;
      }
      case 'encReset': {
        const result = await resetEncryption();
        void syncAndPublish();
        return result;
      }
      case 'aiSortNow':
        return sortInboxNow();
      case 'aiUndo':
        return undoSortEntry(req.id);
      case 'aiClearLog':
        return clearSortLog();
      case 'dupScan':
        return scanDuplicates();
      case 'dupRemove':
        return removeDuplicates(req.expected);
      case 'linkScan':
        return startLinkScan({ resume: req.resume });
      case 'linkStop':
        return stopLinkScan();
      case 'linkFix':
        return fixLink(req.id, req.action);
      case 'linkFixAll':
        return fixAllLinks(req.kind);
    }
  }

  // sendResponse + `return true` works the same in Chrome and Firefox.
  const pageOrigin = browser.runtime.getURL('');
  const knownTypes = new Set<Request['type']>([
    'connect', 'disconnect', 'syncNow', 'checkNow', 'resyncFromDrive', 'keepLocal', 'backupNow', 'listBackups',
    'restoreBackup', 'deleteBackup', 'listBrowsers', 'removeBrowser', 'importFromBrowser', 'importHtml',
    'exportHtml', 'getRedirectUrl', 'settingsChanged', 'aiListFolders', 'aiTestKey', 'aiSortNow', 'aiUndo',
    'aiClearLog', 'aiListModels', 'aiUsage', 'aiBulkStart', 'aiBulkCancel', 'aiBulkApply', 'aiBulkDiscard',
    'dupScan', 'dupRemove', 'linkScan', 'linkStop', 'linkFix', 'linkFixAll',
    'encStatus', 'encEnable', 'encUnlock', 'encLock', 'encDisable', 'encReset',
  ]);

  browser.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
    // Only this extension's own pages may send requests. The manifest exposes
    // no external messaging today; this keeps it safe if that ever changes.
    if (sender.id !== browser.runtime.id || (sender.url !== undefined && !sender.url.startsWith(pageOrigin))) {
      return false;
    }
    if (typeof req !== 'object' || req === null || !knownTypes.has(req.type)) {
      sendResponse({ ok: false, error: t('errUnknownRequest') } satisfies Envelope<unknown>);
      return false;
    }
    handle(req)
      .then((data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error } satisfies Envelope<unknown>);
      });
    return true;
  });

  // A sync left "running" by a killed service worker should not block the UI.
  void patchStatus({ syncing: false }).then(refreshBadge);
});
