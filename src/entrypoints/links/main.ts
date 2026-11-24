import { browser } from 'wxt/browser';
import { localizePage, t, tn } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { linkScanItem, type LinkResult, type LinkScan } from '../../shared/state';
import { $, setEmblem, showToast, withBusy } from '../../shared/ui';
import type { LinkReason } from '../../core/links';

/**
 * Link checker: start or continue a check, watch its progress, and fix what it
 * found. The background script does the checking and every change.
 */
localizePage();
const actionError = $('#action-error');
const LINK_ORIGINS = ['*://*/*'];

type Filter = LinkResult['status'];
let filter: Filter = 'dead';
let scan: LinkScan = { running: false, total: 0, checked: 0, results: [], checkedIds: [] };
/** IDs on screen, so rows that appear while checking slide in. */
let seen: Set<string> | undefined;

const segments = [...document.querySelectorAll<HTMLButtonElement>('#filter [data-filter]')];

const reasonKey: Record<LinkReason, string> = {
  'not-found': 'linkReasonNotFound',
  gone: 'linkReasonGone',
  unreachable: 'linkReasonUnreachable',
  moved: 'linkReasonMoved',
  'needs-sign-in': 'linkReasonSignIn',
  'rate-limited': 'linkReasonRateLimited',
  'server-error': 'linkReasonServerError',
  timeout: 'linkReasonTimeout',
  'other-status': 'linkReasonOther',
};
const doneKey: Record<NonNullable<LinkResult['done']>, string> = {
  updated: 'linkDoneUpdated',
  archived: 'linkDoneArchived',
  removed: 'linkDoneRemoved',
  kept: 'linkDoneKept',
};
const helpKey: Record<Filter, string> = {
  dead: 'linkHelpDead',
  redirected: 'linkHelpMoved',
  unknown: 'linkHelpUnknown',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(href: string, text: string, className?: string): HTMLAnchorElement {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = href;
  return a;
}

/**
 * Asks for access to every site (and, in Firefox 140+, consent to send
 * bookmark addresses to archive.org). Must run directly in a click handler.
 */
function requestPermission(): Promise<boolean> {
  if (import.meta.env.FIREFOX) {
    const withConsent = { origins: LINK_ORIGINS, data_collection: ['bookmarksInfo'] } as Parameters<
      typeof browser.permissions.request
    >[0];
    return browser.permissions.request(withConsent).catch(() => browser.permissions.request({ origins: LINK_ORIGINS }));
  }
  return browser.permissions.request({ origins: LINK_ORIGINS });
}

function action(label: string, act: Parameters<typeof send>[0], className = ''): HTMLButtonElement {
  const b = el('button', className, label);
  b.addEventListener('click', () => withBusy(b, () => send(act), actionError));
  return b;
}

function row(r: LinkResult, isNew: boolean): HTMLLIElement {
  const li = el('li', `link-row${isNew ? ' is-new' : ''}${r.done ? ' done' : ''}`);
  li.dataset.status = r.status;
  const body = el('div', 'link-body');
  const title = el('div', 'link-title');
  title.append(link(r.url, r.title || r.url));
  const reason = r.reason ? t(reasonKey[r.reason], r.httpStatus ?? '') : '';
  if (reason) title.append(el('span', `pill reason ${r.status}`, reason));
  body.append(title);
  body.append(el('p', 'muted small', r.folderPath));
  body.append(el('p', 'url small', r.url));
  if (r.status === 'redirected' && r.finalUrl) {
    const to = el('p', 'moved-to small');
    to.append(el('span', 'wire'), link(r.finalUrl, r.finalUrl));
    body.append(to);
  }
  if (r.status === 'dead') {
    const archive = el('p', 'archive small');
    if (r.archive) {
      archive.append(
        link(r.archive.url, r.archive.at ? t('linkArchiveFrom', new Date(r.archive.at).toLocaleDateString()) : t('linkArchiveOpen')),
      );
    } else if (r.archive === null) archive.append(el('span', 'muted', t('linkNoArchive')));
    else archive.append(el('span', 'muted', t('linkArchiveLooking')));
    body.append(archive);
  }

  const actions = el('div', 'link-actions');
  if (r.done) actions.append(el('span', 'pill done-pill', t(doneKey[r.done])));
  else {
    const fix = (a: 'update' | 'archive' | 'remove' | 'keep' | 'recheck') => ({ type: 'linkFix', id: r.id, action: a }) as const;
    if (r.status === 'redirected') actions.append(action(t('linkUseNew'), fix('update'), 'primary'));
    if (r.status === 'dead' && r.archive) actions.append(action(t('linkUseArchive'), fix('archive')));
    if (r.status === 'dead') actions.append(action(t('linkRemove'), fix('remove'), 'danger'));
    if (r.status === 'unknown') actions.append(action(t('linkRecheck'), fix('recheck')));
    actions.append(action(t('linkKeep'), fix('keep'), 'quiet'));
  }
  li.append(body, actions);
  return li;
}

function moveThumb() {
  const active = segments.find((b) => b.dataset.filter === filter)!;
  const thumb = $('.segmented-thumb');
  thumb.style.setProperty('--x', `${active.offsetLeft}px`);
  thumb.style.setProperty('--w', `${active.offsetWidth}px`);
}

function render() {
  const s = scan;
  const started = s.total > 0 || s.running;
  setEmblem($('#emblem'), s.running ? 'syncing' : 'ok');
  $('#start').hidden = started;
  $('#progress').hidden = !s.running;
  $('#interrupted').hidden = s.running || !s.interrupted;
  $('#finished').hidden = s.running || !!s.interrupted || !s.finishedAt;
  if (s.running) {
    $('#progress-text').textContent = t('linkProgress', s.checked, s.total);
    const bar = $('#bar');
    bar.setAttribute('aria-valuemax', String(s.total));
    bar.setAttribute('aria-valuenow', String(s.checked));
    (bar.firstElementChild as HTMLElement).style.width = `${s.total ? (100 * s.checked) / s.total : 0}%`;
  }
  if (s.interrupted) $('#interrupted-text').textContent = t('linkInterrupted', s.checked, s.total);
  if (s.finishedAt) {
    $('#finished-text').textContent = t('linkFinished', s.total, new Date(s.finishedAt).toLocaleString());
  }

  const counts: Record<Filter, number> = { dead: 0, redirected: 0, unknown: 0 };
  for (const r of s.results) if (!r.done) counts[r.status]++;
  for (const b of segments) {
    const f = b.dataset.filter as Filter;
    b.setAttribute('aria-checked', String(f === filter));
    b.querySelector('b')!.textContent = String(counts[f]);
  }
  $('#results-area').hidden = !started;

  const shown = s.results.filter((r) => r.status === filter);
  // Open items first, then the ones already handled.
  shown.sort((a, b) => Number(!!a.done) - Number(!!b.done));
  $('#list').replaceChildren(...shown.map((r) => row(r, !!seen && !seen.has(r.id))));
  seen = new Set(s.results.map((r) => r.id));
  $('#filter-help').textContent = t(helpKey[filter]);
  const empty = $('#empty');
  empty.hidden = shown.length > 0;
  $('#empty-text').textContent =
    !s.running && s.finishedAt && s.results.every((r) => r.done) ? tn('linkAllGood', s.total) : t('linkNothingHere');

  const bulk = $<HTMLButtonElement>('#bulk');
  const open = counts[filter];
  bulk.hidden = s.running || open === 0 || filter === 'unknown';
  bulk.textContent = filter === 'dead' ? tn('linkRemoveAll', open) : tn('linkUpdateAll', open);
  bulk.className = filter === 'dead' ? 'danger' : 'primary';
  moveThumb();
}

async function start(resume: boolean) {
  // No await before the request: the permission prompt needs the click.
  const granted = await requestPermission();
  if (!granted) throw new Error(t('linkPermissionDenied'));
  $('#bulk-result').hidden = true;
  seen = undefined;
  await send({ type: 'linkScan', resume });
}

const bind = (sel: string, fn: () => Promise<unknown>) => {
  const b = $<HTMLButtonElement>(sel);
  b.addEventListener('click', () => withBusy(b, fn, actionError));
};
bind('#start-btn', () => start(false));
bind('#again', () => start(false));
bind('#restart', () => start(false));
bind('#resume', () => start(true));
bind('#stop', () => send({ type: 'linkStop' }));
bind('#bulk', async () => {
  const dead = filter === 'dead';
  const n = scan.results.filter((r) => r.status === filter && !r.done).length;
  if (!confirm(dead ? t('linkConfirmRemoveAll', n) : t('linkConfirmUpdateAll', n))) return;
  const r = await send({ type: 'linkFixAll', kind: dead ? 'remove-dead' : 'update-redirects' });
  const parts = [dead ? tn('linkRemovedN', r.changed) : tn('linkUpdatedN', r.changed)];
  if (r.backedUp) parts.push(t('dupDoneBackup'));
  if (r.skipped) parts.push(tn('dupSkipped', r.skipped));
  const out = $('#bulk-result');
  out.textContent = parts.join(' ');
  out.hidden = false;
});
for (const b of segments) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter as Filter;
    seen = undefined;
    $('#bulk-result').hidden = true;
    render();
  });
}
window.addEventListener('resize', moveThumb);

void linkScanItem.getValue().then((s) => {
  scan = s;
  // Open on the tab that has something to do.
  if (!s.results.some((r) => r.status === 'dead' && !r.done) && s.results.some((r) => r.status === 'redirected' && !r.done)) {
    filter = 'redirected';
  }
  render();
  void document.fonts.ready.then(moveThumb);
}).catch((err: unknown) => showToast(actionError, err instanceof Error ? err.message : String(err)));
linkScanItem.watch((s) => {
  if (!s) return;
  scan = s;
  render();
});
