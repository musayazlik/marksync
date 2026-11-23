import { send } from '../../shared/messages';
import { getSettings, settingsItem, statusItem, type Settings, type Status } from '../../shared/state';
import { $, statusTone, timeAgo, withBusy } from '../../shared/ui';
import { detectBrowser } from '../../platform/browser-info';
import type { BackupInfo } from '../../services/backup-service';
import type { ImportMode, ImportResult } from '../../sync/importer';

const actionError = $('#action-error');

function renderStatus(s: Status) {
  $('#dot').className = `dot ${statusTone(s)}`;
  $('#account-text').textContent = s.connected
    ? `Connected as ${s.email ?? 'your Google account'}`
    : 'Not connected';
  $('#connect').hidden = s.connected && s.error?.code !== 'auth';
  $('#connect').textContent = s.connected ? 'Reconnect' : 'Connect Google Drive';
  $('#disconnect').hidden = !s.connected;
  $('#sync-text').textContent = s.connected
    ? `${s.syncing ? 'Syncing…' : `Last sync ${timeAgo(s.lastSyncAt)}`}` +
      (s.error ? ` · ${s.error.message}` : '')
    : '';
}

// ---------- settings ----------

const fields = {
  syncEnabled: 'checkbox',
  autoBackup: 'checkbox',
  syncIntervalMin: 'number',
  backupIntervalHours: 'number',
  backupRetention: 'number',
  deviceName: 'text',
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

const reasonLabel: Record<BackupInfo['reason'], string> = {
  manual: '',
  scheduled: ' (automatic)',
  'before-restore': ' (before restore)',
  'before-remote-delete': ' (before a large deletion from another browser)',
};

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
      new Date(b.createdTime).toLocaleString() + reasonLabel[b.reason],
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
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => {
      if (!confirm(`Replace the bookmarks in all browsers with the backup from ${cells[0]}?`)) return;
      void withBusy(restore, () => send({ type: 'restoreBackup', id: b.id }).then(loadBackups), actionError);
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.addEventListener('click', () => {
      if (!confirm('Delete this backup from Google Drive?')) return;
      void withBusy(del, () => send({ type: 'deleteBackup', id: b.id }).then(loadBackups), actionError);
    });
    actions.append(restore, ' ', del);
    tr.append(actions);
    tbody.append(tr);
  }
}

// ---------- import ----------

const importMode = (): ImportMode =>
  ($<HTMLInputElement>('input[name="import-mode"]:checked').value as ImportMode) ?? 'merge';

function showImportResult(r: ImportResult) {
  const parts = [`Added ${r.added.toLocaleString()} bookmarks.`];
  if (r.duplicates) parts.push(`${r.duplicates.toLocaleString()} were already here.`);
  if (r.failed) parts.push(`${r.failed} could not be added in this browser.`);
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
      b.self ? `${b.label} (this browser)` : b.label,
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
      imp.textContent = 'Import';
      imp.addEventListener('click', () =>
        withBusy(
          imp,
          async () => showImportResult(await send({ type: 'importFromBrowser', fileId: b.fileId, mode: importMode() })),
          actionError,
        ),
      );
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.className = 'danger';
      remove.title = 'Remove a browser you no longer use from this list';
      remove.addEventListener('click', () => {
        if (!confirm(`Remove ${b.label} from this list? Its bookmarks are not touched.`)) return;
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

bind('#connect', async () => {
  await send({ type: 'connect' });
  await Promise.all([loadBackups(), loadBrowsers()]);
});
bind('#disconnect', async () => {
  if (
    !confirm(
      'Stop syncing this browser? Your bookmarks, your Drive files and your other connected browsers stay as they are.\n\n' +
        'To remove Marksync\'s access to your Google account in every browser, visit myaccount.google.com/permissions.',
    )
  )
    return;
  await send({ type: 'disconnect' });
  await Promise.all([loadBackups(), loadBrowsers()]);
});
bind('#backup-now', async () => {
  await send({ type: 'backupNow' });
  await loadBackups();
});
bind('#export', async () => {
  const html = await send({ type: 'exportHtml' });
  download(`bookmarks-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html');
});

void statusItem.getValue().then(renderStatus);
statusItem.watch((s) => s && renderStatus(s));
void loadSettings();
// Development builds only: the OAuth redirect URI to register in Google Cloud.
// The block is removed from store builds (`wxt build`, `wxt zip`).
if (import.meta.env.MODE !== 'production') {
  void send({ type: 'getRedirectUrl' }).then((url) => {
    const box = document.createElement('section');
    box.className = 'card stack small';
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
const showError = (err: unknown) => {
  actionError.textContent = err instanceof Error ? err.message : String(err);
  actionError.hidden = false;
};
void loadBackups().catch(showError);
void loadBrowsers().catch(showError);
if (location.hash === '#import') $('#import').scrollIntoView();
