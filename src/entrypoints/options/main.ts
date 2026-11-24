import { browser } from 'wxt/browser';
import { errorText, localizePage, t, tn } from '../../shared/i18n';
import { send } from '../../shared/messages';
import {
  DEFAULT_AI_MODEL,
  getSettings,
  SUGGESTED_AI_MODELS,
  openRouterKeyItem,
  settingsItem,
  statusItem,
  type Settings,
  type Status,
} from '../../shared/state';
import { OPENROUTER_ORIGIN } from '../../platform/openrouter';
import { $, emblemState, RELEASES_URL, setEmblem, showToast, statusTone, timeAgo, withBusy } from '../../shared/ui';
import { detectBrowser } from '../../platform/browser-info';
import type { BackupInfo } from '../../services/backup-service';
import type { ImportMode, ImportResult } from '../../sync/importer';

localizePage();

// The version comes from package.json (set by release-please) and links to
// that release's notes on GitHub.
const version = browser.runtime.getManifest().version;
const versionLink = $<HTMLAnchorElement>('#version');
versionLink.textContent = t('version', version);
versionLink.href = `${RELEASES_URL}/tag/v${version}`;
const actionError = $('#action-error');
/** The page opened right after installing (see background.ts). */
const welcome = location.hash === '#welcome';

let syncEnabled = true;
let lastStatus: Status = { connected: false, syncing: false };

function renderStatus(s: Status) {
  lastStatus = s;
  setEmblem($('#emblem'), emblemState(s, syncEnabled));
  $('#welcome').hidden = !welcome || s.connected;
  $('#account-text').textContent = s.connected ? (s.email ? t('connectedAs', s.email) : t('connected')) : t('notConnected');
  $('#connect').hidden = s.connected && s.error?.code !== 'auth';
  $('#connect').textContent = t(s.connected ? 'reconnect' : 'connectDrive');
  $('#disconnect').hidden = !s.connected;
  $('#sync-text').textContent = !s.connected
    ? t('popupIntro')
    : !syncEnabled
      ? t('syncOff')
      : s.syncing
        ? t('syncing')
        : t('lastSync', timeAgo(s.lastSyncAt));
  const error = $('#sync-error');
  error.hidden = !s.connected || !s.error;
  error.className = `notice small hero-error ${statusTone(s) === 'warn' ? 'warn' : 'error'}`;
  if (s.error) error.textContent = errorText(s.error);
}

// ---------- section rail ----------

/** Marks the section in view on the rail; the ribbon slides to it. */
function initRail() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.rail a')];
  const ribbon = $('.rail-ribbon');
  const sections = links.map((a) => document.querySelector<HTMLElement>(a.hash)!);
  const mark = (index: number) => {
    links.forEach((a, i) => a.setAttribute('aria-current', String(i === index)));
    const link = links[index]!;
    ribbon.style.setProperty('--ribbon-y', `${link.offsetTop + (link.offsetHeight - 22) / 2}px`);
  };
  const update = () => {
    // The last section whose top has passed a third of the window.
    const line = window.innerHeight / 3;
    let index = 0;
    sections.forEach((sec, i) => {
      if (sec.getBoundingClientRect().top <= line) index = i;
    });
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) index = sections.length - 1;
    mark(index);
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ---------- settings ----------

const fields = {
  syncEnabled: 'checkbox',
  autoBackup: 'checkbox',
  syncIntervalMin: 'number',
  backupIntervalHours: 'number',
  backupRetention: 'number',
  deviceName: 'text',
  aiModel: 'text',
  aiAllowNewFolders: 'checkbox',
  aiResearch: 'checkbox',
} as const satisfies Partial<Record<keyof Settings, string>>;

async function loadSettings() {
  const s = await getSettings();
  $<HTMLInputElement>('#deviceName').placeholder = detectBrowser();
  for (const [key, kind] of Object.entries(fields) as [keyof typeof fields, string][]) {
    const el = $<HTMLInputElement>(`#${key}`);
    if (kind === 'checkbox') el.checked = s[key] as boolean;
    else el.value = String(s[key]);
    el.addEventListener('change', async () => {
      const value = kind === 'checkbox' ? el.checked : kind === 'number' ? Number(el.value) : el.value.trim();
      await settingsItem.setValue({ ...(await getSettings()), [key]: value });
      await send({ type: 'settingsChanged' });
    });
  }
}

// ---------- backups ----------

const reasonKey: Record<BackupInfo['reason'], string | undefined> = {
  manual: undefined,
  scheduled: 'backupReasonScheduled',
  'before-restore': 'backupReasonBeforeRestore',
  'before-remote-delete': 'backupReasonBeforeRemoteDelete',
  'before-cleanup': 'backupReasonBeforeCleanup',
};

function backupDate(b: BackupInfo): string {
  const date = new Date(b.createdTime).toLocaleString();
  const key = reasonKey[b.reason];
  return key ? `${date} (${t(key)})` : date;
}

async function loadBackups() {
  const status = await statusItem.getValue();
  const tbody = $('#backups tbody');
  tbody.replaceChildren();
  $('#backups').hidden = !status.connected;
  if (!status.connected) return;
  const backups = await send({ type: 'listBackups' });
  $('#backups-empty').hidden = backups.length > 0;
  for (const b of backups) {
    const tr = document.createElement('tr');
    const cells = [
      backupDate(b),
      b.source,
      b.count.toLocaleString(),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement('td');
    const restore = document.createElement('button');
    restore.textContent = t('restore');
    restore.addEventListener('click', () => {
      if (!confirm(t('confirmRestore', cells[0]!))) return;
      void withBusy(restore, () => send({ type: 'restoreBackup', id: b.id }).then(loadBackups), actionError);
    });
    const del = document.createElement('button');
    del.textContent = t('delete');
    del.className = 'danger';
    del.addEventListener('click', () => {
      if (!confirm(t('confirmDeleteBackup'))) return;
      void withBusy(del, () => send({ type: 'deleteBackup', id: b.id }).then(loadBackups), actionError);
    });
    actions.append(restore, ' ', del);
    tr.append(actions);
    tbody.append(tr);
  }
}

// ---------- AI sorting ----------

const aiEnabled = $<HTMLInputElement>('#aiSortEnabled');
const aiInbox = $<HTMLSelectElement>('#aiInboxFolderId');
const aiKeyInput = $<HTMLInputElement>('#ai-key');
/** OpenRouter keys look like "sk-or-v1-…"; anything else is rejected before saving. */
const KEY_FORMAT = /^[\w-]{20,200}$/;
let aiFolders: { id: string; path: string }[] = [];

async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await settingsItem.setValue({ ...(await getSettings()), [key]: value });
  await send({ type: 'settingsChanged' });
}

/**
 * Asks for openrouter.ai, and in Firefox 140+ for consent to send bookmark
 * data. Must be called directly in the click handler: browsers only show a
 * permission prompt in response to a user action.
 */
function requestAiPermission(): Promise<boolean> {
  const origins = [OPENROUTER_ORIGIN];
  if (import.meta.env.FIREFOX) {
    const withConsent = { origins, data_collection: ['bookmarksInfo'] } as Parameters<typeof browser.permissions.request>[0];
    // Firefox before 140 does not know data_collection.
    return browser.permissions.request(withConsent).catch(() => browser.permissions.request({ origins }));
  }
  return browser.permissions.request({ origins });
}

async function renderAiStatus() {
  const s = await getSettings();
  const key = await openRouterKeyItem.getValue();
  const status = $('#ai-status');
  const inbox = aiFolders.find((f) => f.id === s.aiInboxFolderId);
  let text = '';
  if (s.aiSortEnabled) {
    if (!(await browser.permissions.contains({ origins: [OPENROUTER_ORIGIN] }))) text = t('aiPermissionMissing');
    else if (!s.aiInboxFolderId) text = t('aiChooseInbox');
    else if (!inbox) text = t('aiInboxMissing');
    else if (!key) text = t('aiNoKey');
    else text = t('aiReady', inbox.path);
  }
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('warn', !!text && !(inbox && key));
  $<HTMLButtonElement>('#ai-sort-now').disabled = !(s.aiSortEnabled && inbox && key);

  $('#ai-key-state').textContent = key ? t('aiKeySaved', `${key.slice(0, 6)}…${key.slice(-4)}`) : t('aiKeyNone');
  $('#ai-key-remove').hidden = !key;
  $<HTMLButtonElement>('#ai-key-test').disabled = !key;
}

async function loadAiFolders() {
  const s = await getSettings();
  aiFolders = await send({ type: 'aiListFolders' });
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('aiInboxNone');
  const options = [none];
  for (const f of aiFolders) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.path;
    options.push(o);
  }
  if (s.aiInboxFolderId && !aiFolders.some((f) => f.id === s.aiInboxFolderId)) {
    const missing = document.createElement('option');
    missing.value = s.aiInboxFolderId;
    missing.textContent = t('aiInboxMissingOption');
    options.push(missing);
  }
  aiInbox.replaceChildren(...options);
  aiInbox.value = s.aiInboxFolderId;
  await renderAiStatus();
}

async function initAi() {
  const s = await getSettings();
  aiEnabled.checked = s.aiSortEnabled;
  $<HTMLInputElement>('#aiModel').placeholder = DEFAULT_AI_MODEL;
  $('#ai-model-help').textContent = t('aiModelHelp', DEFAULT_AI_MODEL);
  $('#ai-models').replaceChildren(
    ...SUGGESTED_AI_MODELS.map((m) => Object.assign(document.createElement('option'), { value: m })),
  );
  await loadAiFolders();
}

aiEnabled.addEventListener('change', () => {
  actionError.hidden = true;
  if (!aiEnabled.checked) {
    void saveSetting('aiSortEnabled', false).then(renderAiStatus);
    return;
  }
  // No await before this call: the permission prompt needs the user action.
  void requestAiPermission()
    .then(async (granted) => {
      if (!granted) {
        aiEnabled.checked = false;
        throw new Error(t('aiPermissionDenied'));
      }
      await saveSetting('aiSortEnabled', true);
    })
    .catch(showError)
    .finally(renderAiStatus);
});
aiInbox.addEventListener('change', () => void saveSetting('aiInboxFolderId', aiInbox.value).then(renderAiStatus));

$('#ai-key-save').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-save'),
    async () => {
      const key = aiKeyInput.value.trim();
      if (!KEY_FORMAT.test(key)) throw new Error(t('aiKeyInvalid'));
      await openRouterKeyItem.setValue(key);
      aiKeyInput.value = '';
      await renderAiStatus();
    },
    actionError,
  ),
);
aiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('#ai-key-save').click();
});
$('#ai-key-remove').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-remove'),
    async () => {
      if (!confirm(t('aiConfirmRemoveKey'))) return;
      await openRouterKeyItem.removeValue();
      await renderAiStatus();
    },
    actionError,
  ),
);
$('#ai-key-test').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-key-test'),
    async () => {
      const label = await send({ type: 'aiTestKey' });
      const result = $('#ai-result');
      result.textContent = label ? t('aiTestOkLabel', label) : t('aiTestOk');
      result.hidden = false;
    },
    actionError,
  ),
);
$('#ai-sort-now').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#ai-sort-now'),
    async () => {
      const r = await send({ type: 'aiSortNow' });
      const result = $('#ai-result');
      result.textContent = t('aiSortNowResult', r.sorted, r.kept, r.failed);
      result.hidden = false;
    },
    actionError,
  ),
);
// Folders may have changed in another tab or the bookmark manager.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadAiFolders().catch(showError);
});
settingsItem.watch(() => void renderAiStatus());

// ---------- import ----------

const importMode = (): ImportMode =>
  ($<HTMLInputElement>('input[name="import-mode"]:checked').value as ImportMode) ?? 'merge';

function showImportResult(r: ImportResult) {
  const parts = [tn('importAdded', r.added)];
  if (r.duplicates) parts.push(tn('importDuplicates', r.duplicates));
  if (r.failed) parts.push(tn('importFailed', r.failed));
  const el = $('#import-result');
  el.textContent = parts.join(' ');
  el.hidden = false;
}

async function loadBrowsers() {
  const status = await statusItem.getValue();
  const tbody = $('#browsers tbody');
  tbody.replaceChildren();
  $('#browsers-offline').hidden = status.connected;
  $('#browsers').hidden = !status.connected;
  $('#browsers-empty').hidden = true;
  if (!status.connected) return;

  const browsers = await send({ type: 'listBrowsers' });
  $('#browsers-empty').hidden = browsers.some((b) => !b.self);
  for (const b of browsers) {
    const tr = document.createElement('tr');
    const cells = [
      b.self ? t('thisBrowser', b.label) : b.label,
      b.count.toLocaleString(),
      timeAgo(Date.parse(b.updatedAt)),
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    const actions = document.createElement('td');
    if (!b.self) {
      const imp = document.createElement('button');
      imp.textContent = t('import');
      imp.addEventListener('click', () =>
        withBusy(
          imp,
          async () => showImportResult(await send({ type: 'importFromBrowser', fileId: b.fileId, mode: importMode() })),
          actionError,
        ),
      );
      const remove = document.createElement('button');
      remove.textContent = t('remove');
      remove.className = 'danger';
      remove.title = t('removeBrowserHint');
      remove.addEventListener('click', () => {
        if (!confirm(t('confirmRemoveBrowser', b.label))) return;
        void withBusy(remove, () => send({ type: 'removeBrowser', fileId: b.fileId }).then(loadBrowsers), actionError);
      });
      actions.append(imp, ' ', remove);
    }
    tr.append(actions);
    tbody.append(tr);
  }
}

const fileInput = $<HTMLInputElement>('#import-file');
const fileButton = $<HTMLButtonElement>('#import-file-btn');
fileInput.addEventListener('change', () => (fileButton.disabled = !fileInput.files?.length));
fileButton.addEventListener('click', () =>
  withBusy(
    fileButton,
    async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const html = await file.text();
      showImportResult(await send({ type: 'importHtml', html, mode: importMode(), label: file.name }));
      fileInput.value = '';
    },
    actionError,
  ).then(() => (fileButton.disabled = !fileInput.files?.length)),
);

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- wiring ----------

const bind = (sel: string, action: () => Promise<unknown>) => {
  const btn = $<HTMLButtonElement>(sel);
  btn.addEventListener('click', () => withBusy(btn, action, actionError));
};

// The status watcher below reloads the account's lists after connect/disconnect.
bind('#connect', () => send({ type: 'connect' }));
bind('#disconnect', async () => {
  if (!confirm(t('confirmDisconnect'))) return;
  await send({ type: 'disconnect' });
});
bind('#backup-now', async () => {
  await send({ type: 'backupNow' });
  await loadBackups();
});
bind('#export', async () => {
  const html = await send({ type: 'exportHtml' });
  download(`bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html');
});

let wasConnected: boolean | undefined;
void statusItem.getValue().then((s) => {
  wasConnected = s.connected;
  renderStatus(s);
});
statusItem.watch((s) => {
  if (!s) return;
  renderStatus(s);
  // Connected or disconnected elsewhere (e.g. from the popup): the backup
  // and browser lists belong to the account, so load them again.
  if (wasConnected !== undefined && s.connected !== wasConnected) {
    void Promise.all([loadBackups(), loadBrowsers()]).catch(showError);
  }
  wasConnected = s.connected;
});
void loadSettings();
void initAi().catch((err: unknown) => showError(err));
// Development builds only: the OAuth redirect URI to register in Google Cloud.
// The block is removed from store builds (`wxt build`, `wxt zip`).
if (import.meta.env.MODE !== 'production') {
  void send({ type: 'getRedirectUrl' }).then((url) => {
    const box = document.createElement('section');
    box.className = 'notice stack small';
    const title = document.createElement('strong');
    title.textContent = 'Developer: OAuth redirect URI for this browser';
    const code = document.createElement('code');
    code.textContent = url;
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Add it under Authorized redirect URIs of the Web application client (docs/GOOGLE_SETUP.md). Not shown in store builds.';
    box.append(title, code, hint);
    $('main').append(box);
  });
}
const showError = (err: unknown) => showToast(actionError, err instanceof Error ? err.message : String(err));
void loadBackups().catch(showError);
void loadBrowsers().catch(showError);
initRail();
if (location.hash === '#import') $('#import').scrollIntoView();
if (location.hash === '#ai') $('#ai').scrollIntoView();
// The emblem and status line also show whether sync is off in this browser.
const refreshSyncEnabled = async () => {
  syncEnabled = (await getSettings()).syncEnabled;
  renderStatus(lastStatus);
};
void refreshSyncEnabled();
settingsItem.watch(() => void refreshSyncEnabled());
