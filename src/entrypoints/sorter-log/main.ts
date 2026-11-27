import { localizePage, t } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { SORT_LOG_MAX, sortLogItem, type SortLogEntry } from '../../shared/state';
import { $, withBusy } from '../../shared/ui';

/**
 * The AI sorting log: every decision made in this browser, newest first, as a
 * timeline grouped by day. Only the background script writes the log; this
 * page reads and watches it. Entries that arrive while the page is open slide
 * in, and their route draws from the inbox to the new folder.
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
  budget: 'aiErrBudget',
  unavailable: 'aiErrUnavailable',
};
/** Entries from a local endpoint or the built-in model: the OpenRouter wording does not fit. */
const otherErrorKey: Record<string, string> = {
  auth: 'aiErrAuthEndpoint',
  'rate-limit': 'aiErrRateLimit',
  model: 'aiErrModelEndpoint',
  permission: 'aiErrPermissionEndpoint',
  network: 'aiErrNetworkEndpoint',
  reply: 'aiErrReply',
  unavailable: 'aiErrUnavailable',
};
const providerKey = { openrouter: 'aiProviderOpenRouter', custom: 'aiProviderCustom', builtin: 'aiProviderBuiltin' } as const;

let entries: SortLogEntry[] = [];
let filter: Filter = 'all';
/** IDs already on screen; anything else that appears is animated in. */
let seen: Set<string> | undefined;

const searchEl = $<HTMLInputElement>('#search');
const segments = [...document.querySelectorAll<HTMLButtonElement>('#filter [data-filter]')];

const isMoved = (e: SortLogEntry) => (e.status === 'moved' || e.status === 'created') && !e.undoneAt;
const tone = (e: SortLogEntry) => (e.undoneAt ? 'undone' : e.status === 'created' ? 'moved' : e.status);

function matches(e: SortLogEntry, f: Filter, query: string): boolean {
  if (f === 'moved' && !isMoved(e)) return false;
  if (f === 'kept' && e.status !== 'kept') return false;
  if (f === 'error' && e.status !== 'error') return false;
  if (!query) return true;
  return [e.title, e.url, e.fromPath, e.toPath, e.reason, e.site?.name, e.site?.summary, e.site?.purpose, e.site?.category].some(
    (v) => v?.toLocaleLowerCase().includes(query),
  );
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

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', undefined, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = href;
  return a;
}

/** "Bookmarks bar / Dev / Frontend" with the folder itself emphasised. */
function pathNode(path: string, className: string): HTMLSpanElement {
  const node = el('span', `node ${className}`);
  const parts = path.split(' / ');
  const last = parts.pop() ?? path;
  if (parts.length) node.append(el('span', 'node-parent', `${parts.join(' / ')} / `));
  node.append(el('span', 'node-name', last));
  node.title = path;
  return node;
}

function formatCost(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}

/** "About the site": what the model found out, its sources and the cost. */
function siteDetails(e: SortLogEntry): HTMLDetailsElement | undefined {
  const site = e.site;
  const sources = (e.sources ?? []).filter((s) => safeHref(s.url));
  if (!site?.name && !site?.purpose && !site?.summary && !sources.length) return undefined;
  const details = el('details', 'site');
  details.append(el('summary', undefined, site?.name ? `${t('aiSiteAbout')}: ${site.name}` : t('aiSiteAbout')));
  const body = el('div', 'site-body');
  const dl = el('dl');
  const item = (label: string, value: string | undefined) => {
    if (value) dl.append(el('dt', undefined, label), el('dd', undefined, value));
  };
  item(t('aiSiteWhat'), site?.summary);
  item(t('aiSitePurpose'), site?.purpose);
  if (sources.length) {
    const list = el('ul');
    for (const source of sources) {
      const li = el('li');
      li.append(link(safeHref(source.url)!, source.title || new URL(source.url).host));
      list.append(li);
    }
    const dd = el('dd');
    dd.append(list);
    dl.append(el('dt', undefined, t('aiSiteSources')), dd);
  }
  body.append(dl);
  const facts = el('div', 'facts');
  if (e.researched) facts.append(el('span', 'pill', t('aiResearched')));
  // Tags the model proposed (the bookmark got them unless it had tags already).
  for (const tag of e.tags ?? []) facts.append(el('span', 'pill', `#${tag}`));
  if (e.cost !== undefined) facts.append(el('span', 'pill', t('aiCost', formatCost(e.cost))));
  if (facts.childElementCount) body.append(facts);
  details.append(body);
  return details;
}

function entry(e: SortLogEntry, isNew: boolean): HTMLLIElement {
  const li = el('li', `entry${isNew ? ' is-new' : ''}`);
  li.dataset.status = tone(e);
  li.append(el('span', 'marker'));
  const body = el('div', 'entry-body');

  const head = el('div', 'entry-head');
  const title = el('div', 'entry-title');
  const href = safeHref(e.url);
  title.append(href ? link(href, e.title || href) : el('span', undefined, e.title || e.url || ''));
  if (e.site?.category) title.append(el('span', 'pill category', e.site.category));
  const time = el('time', 'muted small', new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  time.dateTime = new Date(e.at).toISOString();
  time.title = new Date(e.at).toLocaleString();
  head.append(title, time);
  body.append(head);
  if (href) body.append(el('p', 'host muted small', new URL(href).host));
  if (e.site?.summary) body.append(el('p', 'summary', e.site.summary));

  const route = el('div', 'route');
  route.append(pathNode(e.fromPath ?? '?', 'from'));
  if (e.toPath) route.append(el('span', 'wire'), pathNode(e.toPath, 'to'));
  body.append(route);

  const verdict = el('div', 'verdict');
  verdict.append(el('span', `pill status ${tone(e)}`, e.undoneAt ? t('aiStatusUndone') : t(statusKey[e.status])));
  if (e.status === 'error') {
    const keys = e.provider && e.provider !== 'openrouter' ? otherErrorKey : errorKey;
    const known = e.errorCode ? keys[e.errorCode] : undefined;
    const text = el('span', 'reason', known ? t(known) : (e.error ?? ''));
    if (e.error) text.title = e.error;
    verdict.append(text);
  } else {
    if (e.confidence !== undefined) verdict.append(el('span', 'pill', t('aiConfidence', Math.round(e.confidence * 100))));
    if (e.reason) verdict.append(el('span', 'reason', e.reason));
  }
  body.append(verdict);

  const about = siteDetails(e);
  if (about) body.append(about);

  const foot = el('div', 'entry-foot');
  // Which provider and model decided (entries from before 0.5 have no provider: OpenRouter).
  const decidedBy = el('span', 'muted small', e.model);
  if (e.provider && e.provider !== 'openrouter') decidedBy.title = t(providerKey[e.provider]);
  if (e.provider === 'custom') decidedBy.textContent = `${e.model} · ${t('aiProviderCustomShort')}`;
  foot.append(decidedBy);
  if (isMoved(e)) {
    const undo = el('button', 'quiet', t('aiUndo'));
    undo.title = t('aiUndoHint');
    undo.addEventListener('click', () => withBusy(undo, () => send({ type: 'aiUndo', id: e.id }), actionError));
    foot.append(undo);
  }
  body.append(foot);
  li.append(body);
  return li;
}

const dayKey = (ms: number) => new Date(ms).toDateString();
const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function moveThumb() {
  const active = segments.find((b) => b.dataset.filter === filter)!;
  const thumb = $('.segmented-thumb');
  thumb.style.setProperty('--x', `${active.offsetLeft}px`);
  thumb.style.setProperty('--w', `${active.offsetWidth}px`);
}

function render() {
  const query = searchEl.value.trim().toLocaleLowerCase();
  const shown = entries.filter((e) => matches(e, filter, query));
  const items: HTMLLIElement[] = [];
  let day = '';
  for (const e of shown) {
    if (dayKey(e.at) !== day) {
      day = dayKey(e.at);
      const header = el('li', 'day');
      header.append(el('h2', undefined, dayLabel(e.at)));
      items.push(header);
    }
    items.push(entry(e, !!seen && !seen.has(e.id)));
  }
  $('#log').replaceChildren(...items);
  $('#log').hidden = shown.length === 0;
  $('#empty').hidden = shown.length > 0;
  $<HTMLButtonElement>('#clear').disabled = entries.length === 0;
  seen = new Set(entries.map((e) => e.id));

  const counts: Record<Filter, number> = {
    all: entries.length,
    moved: entries.filter(isMoved).length,
    kept: entries.filter((e) => e.status === 'kept').length,
    error: entries.filter((e) => e.status === 'error').length,
  };
  for (const b of segments) {
    const f = b.dataset.filter as Filter;
    b.setAttribute('aria-checked', String(f === filter));
    b.querySelector('b')!.textContent = String(counts[f]);
  }
  moveThumb();
}

for (const b of segments) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter as Filter;
    render();
  });
}
window.addEventListener('resize', moveThumb);
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
  // Fonts change the button widths once loaded.
  void document.fonts.ready.then(moveThumb);
});
sortLogItem.watch((log) => {
  entries = log ?? [];
  render();
});
