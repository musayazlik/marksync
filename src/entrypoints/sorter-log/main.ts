import { localizePage, t } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { SORT_LOG_MAX, sortLogItem, type SortLogEntry } from '../../shared/state';
import { $, withBusy } from '../../shared/ui';

/**
 * The AI sorting log: every decision made in this browser, newest first.
 * Only the background script writes the log; this page reads and watches it.
 */
localizePage();
const actionError = $('#action-error');
$('#intro').textContent = t('aiLogIntro', SORT_LOG_MAX);

type Filter = 'all' | 'moved' | 'kept' | 'error';

const statusKey: Record<SortLogEntry['status'], string> = {
  moved: 'aiStatusMoved',
  created: 'aiStatusCreated',
  kept: 'aiStatusKept',
  error: 'aiStatusError',
};
const errorKey: Record<string, string> = {
  auth: 'aiErrAuth',
  credits: 'aiErrCredits',
  'rate-limit': 'aiErrRateLimit',
  model: 'aiErrModel',
  permission: 'aiPermissionMissing',
  network: 'aiErrNetwork',
  reply: 'aiErrReply',
};

let entries: SortLogEntry[] = [];

const filterEl = $<HTMLSelectElement>('#filter');
const searchEl = $<HTMLInputElement>('#search');

function matches(e: SortLogEntry, filter: Filter, query: string): boolean {
  if (filter === 'moved' && e.status !== 'moved' && e.status !== 'created') return false;
  if (filter === 'kept' && e.status !== 'kept') return false;
  if (filter === 'error' && e.status !== 'error') return false;
  if (!query) return true;
  return [e.title, e.url, e.fromPath, e.toPath, e.reason]
    .some((v) => v?.toLocaleLowerCase().includes(query));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Only web addresses become links; anything else (javascript:, data:) is shown as text. */
function safeHref(url: string | undefined): string | undefined {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function row(e: SortLogEntry): HTMLTableRowElement {
  const tr = el('tr');

  tr.append(el('td', 'small', new Date(e.at).toLocaleString()));

  const bookmark = el('td', 'bookmark');
  const href = safeHref(e.url);
  if (href) {
    const a = el('a', undefined, e.title || href);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = href;
    bookmark.append(a);
  } else {
    bookmark.append(el('span', 'title', e.title || e.url || ''));
  }
  if (href) bookmark.append(el('span', 'muted small', new URL(href).host));
  tr.append(bookmark);

  const move = el('td', 'move small');
  move.append(el('span', undefined, e.fromPath ?? '?'));
  if (e.toPath) move.append(el('span', 'arrow', '→'), el('strong', undefined, e.toPath));
  tr.append(move);

  const reason = el('td', 'small');
  if (e.status === 'error') {
    const known = e.errorCode ? errorKey[e.errorCode] : undefined;
    reason.textContent = known ? t(known) : (e.error ?? '');
    if (e.error) reason.title = e.error;
  } else {
    reason.textContent = e.reason ?? '';
    if (e.confidence !== undefined) {
      reason.append(el('span', 'muted', ` · ${t('aiConfidence', Math.round(e.confidence * 100))}`));
    }
  }
  reason.append(el('div', 'muted', e.model));
  tr.append(reason);

  const result = el('td');
  const tone = e.undoneAt ? 'undone' : e.status === 'created' ? 'moved' : e.status;
  result.append(el('span', `pill ${tone}`, e.undoneAt ? t('aiStatusUndone') : t(statusKey[e.status])));
  tr.append(result);

  const actions = el('td');
  if ((e.status === 'moved' || e.status === 'created') && !e.undoneAt) {
    const undo = el('button', undefined, t('aiUndo'));
    undo.title = t('aiUndoHint');
    undo.addEventListener('click', () => withBusy(undo, () => send({ type: 'aiUndo', id: e.id }), actionError));
    actions.append(undo);
  }
  tr.append(actions);
  return tr;
}

function render() {
  const filter = filterEl.value as Filter;
  const query = searchEl.value.trim().toLocaleLowerCase();
  const shown = entries.filter((e) => matches(e, filter, query));
  $('#log tbody').replaceChildren(...shown.map(row));
  $('#log').hidden = shown.length === 0;
  $('#empty').hidden = shown.length > 0;
  $<HTMLButtonElement>('#clear').disabled = entries.length === 0;

  const moved = entries.filter((e) => (e.status === 'moved' || e.status === 'created') && !e.undoneAt).length;
  const kept = entries.filter((e) => e.status === 'kept').length;
  const failed = entries.filter((e) => e.status === 'error').length;
  $('#totals').textContent = entries.length ? t('aiLogTotals', moved, kept, failed) : '';
}

filterEl.addEventListener('change', render);
searchEl.addEventListener('input', render);
$('#clear').addEventListener('click', () =>
  withBusy(
    $<HTMLButtonElement>('#clear'),
    async () => {
      if (!confirm(t('aiLogConfirmClear'))) return;
      await send({ type: 'aiClearLog' });
    },
    actionError,
  ),
);

void sortLogItem.getValue().then((log) => {
  entries = log ?? [];
  render();
});
sortLogItem.watch((log) => {
  entries = log ?? [];
  render();
});
