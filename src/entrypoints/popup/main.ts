import { browser } from 'wxt/browser';
import { send } from '../../shared/messages';
import { errorText, localizePage, t, tn } from '../../shared/i18n';
import { getSettings, settingsItem, statusItem, type Status } from '../../shared/state';
import { $, emblemState, setEmblem, timeAgo, withBusy } from '../../shared/ui';

localizePage();
const actionError = $('#action-error');

let status: Status = { connected: false, syncing: false };
let syncEnabled = true;

function render() {
  const s = status;
  setEmblem($('#emblem'), emblemState(s, syncEnabled));
  $('#disconnected').hidden = s.connected;
  $('#connected').hidden = !s.connected;
  $('#email').textContent = s.connected ? (s.email ?? t('connected')) : t('notConnected');
  $('#email').title = s.connected && s.email ? t('connectedAs', s.email) : '';
  if (!s.connected) return;

  $('#summary-main').textContent = !syncEnabled ? t('syncOff') : s.syncing ? t('syncing') : t('lastSync', timeAgo(s.lastSyncAt));
  const facts: string[] = [];
  if (s.total !== undefined) facts.push(tn('items', s.total));
  if (s.skipped) facts.push(tn('skippedItems', s.skipped));
  $('#summary').replaceChildren(
    ...facts.map((text) => Object.assign(document.createElement('span'), { className: 'pill', textContent: text })),
  );
  $('#summary').hidden = facts.length === 0;
  $('#backup-summary').textContent = t('lastBackup', timeAgo(s.lastBackupAt));

  $<HTMLButtonElement>('#sync').disabled = !syncEnabled;
  $('#sync').title = syncEnabled ? '' : t('syncOffHint');

  // With sync off nothing is applied, so a paused deletion can wait.
  const massDelete = syncEnabled && s.error?.code === 'mass-delete';
  $('#mass-delete').hidden = !massDelete;
  const remote = massDelete && s.error?.source === 'remote';
  $('#bring-back').hidden = remote;
  $('#keep-local').hidden = !remote;
  $('#confirm-delete').textContent = t(remote ? 'deleteHereToo' : 'deleteEverywhere');
  if (massDelete) $('#mass-delete-text').textContent = errorText(s.error!);
  const error = $('#error');
  error.hidden = !s.error || s.error.code === 'mass-delete';
  if (s.error && s.error.code !== 'mass-delete') {
    error.textContent = s.error.code === 'auth' ? t('authHint', errorText(s.error)) : errorText(s.error);
  }
}

const refreshSettings = async () => {
  syncEnabled = (await getSettings()).syncEnabled;
  render();
};
void Promise.all([statusItem.getValue(), getSettings()]).then(([s, settings]) => {
  status = s;
  syncEnabled = settings.syncEnabled;
  render();
});
// Opening the popup counts as coming back to this browser: pull fresh changes.
void send({ type: 'checkNow' }).catch(() => undefined);
statusItem.watch((s) => {
  status = s ?? { connected: false, syncing: false };
  render();
});
settingsItem.watch(() => void refreshSettings());

const bind = (sel: string, action: () => Promise<unknown>) => {
  const btn = $<HTMLButtonElement>(sel);
  btn.addEventListener('click', () => withBusy(btn, action, actionError));
};

bind('#connect', () => send({ type: 'connect' }));
bind('#sync', () => send({ type: 'syncNow' }));
bind('#backup', () => send({ type: 'backupNow' }));
bind('#confirm-delete', () => send({ type: 'syncNow', allowMassDelete: true }));
bind('#bring-back', () => send({ type: 'resyncFromDrive' }));
bind('#keep-local', () => send({ type: 'keepLocal' }));
$('#open-options').addEventListener('click', () => void browser.runtime.openOptionsPage());
$('#import').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/options.html#import') });
  window.close();
});
$('#open-log').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/sorter-log.html') });
  window.close();
});
