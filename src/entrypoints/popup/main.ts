import { browser } from 'wxt/browser';
import { send } from '../../shared/messages';
import { statusItem, type Status } from '../../shared/state';
import { $, statusTone, timeAgo, withBusy } from '../../shared/ui';

const actionError = $('#action-error');

function render(s: Status) {
  $('#dot').className = `dot ${statusTone(s)}`;
  $('#disconnected').hidden = s.connected;
  $('#connected').hidden = !s.connected;
  if (!s.connected) return;

  $('#email').textContent = s.email ? `Connected as ${s.email}` : 'Connected';
  const parts = [s.syncing ? 'Syncing…' : `Last sync ${timeAgo(s.lastSyncAt)}`];
  if (s.total !== undefined) parts.push(`${s.total.toLocaleString()} items`);
  if (s.skipped) parts.push(`${s.skipped} not supported in this browser`);
  $('#summary').textContent = parts.join(' · ');
  $('#backup-summary').textContent = `Last backup ${timeAgo(s.lastBackupAt)}`;

  const massDelete = s.error?.code === 'mass-delete';
  $('#mass-delete').hidden = !massDelete;
  const remote = massDelete && s.error?.source === 'remote';
  $('#bring-back').hidden = remote;
  $('#keep-local').hidden = !remote;
  $('#confirm-delete').textContent = remote ? 'Delete them here too' : 'Delete them everywhere';
  if (remote) {
    $('#mass-delete-text').textContent =
      `${s.error!.deletions} of ${s.error!.total} bookmarks were deleted in another browser or directly in Google Drive. ` +
      'Sync is paused until you decide. A backup is taken before anything is deleted here.';
  } else if (massDelete) {
    $('#mass-delete-text').textContent =
      `${s.error!.deletions} of ${s.error!.total} bookmarks were removed in this browser. ` +
      'Sync is paused so they are not deleted everywhere by mistake.';
  }
  const error = $('#error');
  error.hidden = !s.error || massDelete;
  error.textContent = s.error?.code === 'auth' ? `${s.error.message} Click “Connect” in Settings.` : (s.error?.message ?? '');
}

void statusItem.getValue().then(render);
// Opening the popup counts as coming back to this browser: pull fresh changes.
void send({ type: 'checkNow' }).catch(() => undefined);
statusItem.watch((s) => render(s ?? { connected: false, syncing: false }));

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
