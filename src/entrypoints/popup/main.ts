import { browser } from 'wxt/browser';
import { send } from '../../shared/messages';
import { errorText, localizePage, t, tn } from '../../shared/i18n';
import { aiModelsItem, aiSpendItem, aiUsageItem, sortLogItem, getSettings, settingsItem, statusItem, type Settings, type Status } from '../../shared/state';
import { maskEmail } from '../../core/mask';
import { flattenBookmarks, matchRanges, searchBookmarks, type SearchItem } from '../../core/search';
import { budgetState, currentSpend, nextMonthStart } from '../../core/budget';
import { formatUsd, usageGauge, type KeyUsage } from '../../core/openrouter-data';
import { OPENROUTER_ORIGIN } from '../../platform/openrouter';
import { $, emblemState, revealOnClick, setEmblem, timeAgo, withBusy } from '../../shared/ui';

localizePage();
const actionError = $('#action-error');

let status: Status = { connected: false, syncing: false };
let emailShown = false;
let syncEnabled = true;

function render() {
  const s = status;
  setEmblem($('#emblem'), emblemState(s, syncEnabled));
  $('#disconnected').hidden = s.connected;
  $('#connected').hidden = !s.connected;
  // The address is masked; a click shows it in full (and hides it again).
  const email = $('#email');
  email.textContent = s.connected ? (s.email ? (emailShown ? s.email : maskEmail(s.email)) : t('connected')) : t('notConnected');
  email.title = s.connected && s.email ? t(emailShown ? 'emailHide' : 'emailShow') : '';
  email.classList.toggle('revealable', !!(s.connected && s.email));
  email.setAttribute('aria-pressed', String(emailShown));
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
  // Locked: the passphrase is entered in Settings.
  error.className = `notice small ${s.error?.code === 'locked' ? 'warn' : 'error'}`;
  error.classList.toggle('revealable', s.error?.code === 'locked');
  error.onclick =
    s.error?.code === 'locked'
      ? () => {
          void browser.tabs.create({ url: browser.runtime.getURL('/options.html#sec-encryption') });
          window.close();
        }
      : null;
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

revealOnClick($('#email'), () => {
  if (!status.email) return;
  emailShown = !emailShown;
  render();
});
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
$('#open-dupes').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/duplicates.html') });
  window.close();
});
$('#open-log').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/sorter-log.html') });
  window.close();
});

// ---------- OpenRouter usage ----------

let usage: KeyUsage | undefined;
let usageError = '';
let refreshing = false;
let aiModel = '';
let modelName = '';

const usd = (n: number | undefined) => (n === undefined ? '—' : formatUsd(n));

function resetText(reset: string | undefined): string {
  switch (reset) {
    case 'daily':
      return t('usageResetDaily');
    case 'weekly':
      return t('usageResetWeekly');
    case 'monthly':
      return t('usageResetMonthly');
    default:
      return '';
  }
}

function renderUsage() {
  const u = usage;
  const gaugeEl = $('#usage-gauge');
  const fill = $('#usage-gauge .gauge-fill');
  const big = $('#usage-big');
  const source = $('#usage-source');
  $('#usage').classList.toggle('loading', !u);
  $('#usage-refresh').classList.toggle('spinning', refreshing);
  $<HTMLButtonElement>('#usage-refresh').disabled = refreshing;
  $('#usage-refresh').title = u ? t('usageUpdated', timeAgo(u.checkedAt)) : t('usageRefresh');
  $('#usage-model').textContent = aiModel ? t('usageModel', modelName || aiModel) : '';
  $('#usage-model').title = aiModel;

  const note = $('#usage-note');
  note.hidden = !usageError && !u?.freeTier;
  note.className = `usage-note small notice ${usageError ? 'error' : 'warn'}`;
  note.textContent = usageError ? t('usageFailed', usageError) : u?.freeTier ? t('usageFreeTier') : '';

  if (!u) {
    big.textContent = '—';
    $('#usage-big-label').textContent = refreshing ? t('usageLoading') : '';
    source.hidden = true;
    gaugeEl.hidden = true;
    $('#usage-line').textContent = '';
    $('#usage-periods').hidden = true;
    return;
  }

  const g = usageGauge(u);
  source.hidden = false;
  source.textContent = g.source === 'key' ? t('usageKeyLimit') : g.source === 'account' ? t('usageAccount') : t('usagePayg');
  $('#usage-periods').hidden = u.daily === undefined && u.weekly === undefined && u.monthly === undefined;
  $('#usage-today').textContent = usd(u.daily);
  $('#usage-week').textContent = usd(u.weekly);
  $('#usage-month').textContent = usd(u.monthly);

  if (g.left === undefined || g.total === undefined) {
    // No limit and no readable balance: show what was spent.
    big.textContent = formatUsd(u.usage);
    $('#usage-big-label').textContent = t('usageSpentTotal');
    gaugeEl.hidden = true;
    $('#usage-line').textContent = t('usageNoLimit');
    return;
  }

  const pct = Math.max(0, Math.min(100, (g.left / g.total) * 100));
  big.textContent = formatUsd(g.left);
  $('#usage-big-label').textContent = t('usageLeft');
  gaugeEl.hidden = false;
  gaugeEl.dataset.tone = pct < 10 ? 'low' : pct < 25 ? 'warn' : 'ok';
  gaugeEl.setAttribute('aria-valuenow', String(Math.round(pct)));
  gaugeEl.setAttribute('aria-valuetext', t('usageLeftOf', formatUsd(g.left), formatUsd(g.total)));
  // Next frame, so the bar grows from where it was (or from empty on open).
  requestAnimationFrame(() => fill.style.setProperty('--pct', `${pct}%`));
  const parts = [t('usageSpentOf', formatUsd(g.used), formatUsd(g.total))];
  const reset = g.source === 'key' ? resetText(u.reset) : '';
  if (reset) parts.push(reset);
  $('#usage-line').textContent = parts.join(' · ');
}

async function modelLabel(s: Settings) {
  aiModel = s.aiModel;
  const found = (await aiModelsItem.getValue())?.models.find((m) => m.id === s.aiModel);
  const name = found?.name ?? '';
  modelName = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name;
}

/** Marksync's own spending this month in this browser, against the monthly cap. */
async function renderBudget() {
  const [s, stored] = await Promise.all([getSettings(), aiSpendItem.getValue()]);
  const b = budgetState(currentSpend(stored).usd, s.aiMonthlyBudget);
  const gauge = $('#usage-budget-gauge');
  const note = $('#usage-budget-note');
  $('#usage-budget-text').textContent =
    b.state === 'off' ? t('usageBudgetNone', formatUsd(b.spent)) : t('usageBudgetOf', formatUsd(b.spent), formatUsd(b.budget));
  gauge.hidden = b.state === 'off';
  note.hidden = b.state !== 'near' && b.state !== 'over';
  if (b.state === 'off') return;
  const pct = Math.min(100, b.ratio * 100);
  gauge.dataset.tone = b.state === 'over' ? 'low' : b.state === 'near' ? 'warn' : 'spend';
  gauge.setAttribute('aria-valuenow', String(Math.round(pct)));
  gauge.setAttribute('aria-valuetext', t('usageBudgetOf', formatUsd(b.spent), formatUsd(b.budget)));
  requestAnimationFrame(() => gauge.querySelector<HTMLElement>('.gauge-fill')!.style.setProperty('--pct', `${pct}%`));
  note.className = `notice small ${b.state === 'over' ? 'error' : 'warn'}`;
  note.textContent =
    b.state === 'over'
      ? t('usageBudgetOver', nextMonthStart().toLocaleDateString(undefined, { day: 'numeric', month: 'long' }))
      : t('usageBudgetNear', Math.round(pct));
}
aiSpendItem.watch(() => void renderBudget());

/** The card is shown while AI sorting is on and openrouter.ai is allowed. */
async function initUsage() {
  const s = await getSettings();
  const allowed = s.aiSortEnabled && (await browser.permissions.contains({ origins: [OPENROUTER_ORIGIN] }));
  $('#usage').hidden = !allowed;
  if (!allowed) return;
  await modelLabel(s);
  void renderBudget();
  usage = (await aiUsageItem.getValue()) ?? undefined;
  await refreshUsage();
}

async function refreshUsage() {
  refreshing = true;
  usageError = '';
  renderUsage();
  try {
    usage = await send({ type: 'aiUsage' });
  } catch (err) {
    usageError = err instanceof Error ? err.message : String(err);
  } finally {
    refreshing = false;
    renderUsage();
  }
}

$('#usage-refresh').addEventListener('click', () => void refreshUsage());
aiUsageItem.watch((u) => {
  if (refreshing) return;
  usage = u ?? undefined;
  renderUsage();
});
settingsItem.watch(() => void initUsage());
void initUsage();

// ---------- search ----------

const find = $<HTMLInputElement>('#find');
const results = $<HTMLUListElement>('#results');
/** Rows shown at most; the count says how many matched. */
const RESULTS_MAX = 40;
let items: Promise<SearchItem[]> | undefined;
let rows: HTMLLIElement[] = [];
let current = -1;

/** The bookmarks of this browser, read once when the search is first used. */
function loadItems(): Promise<SearchItem[]> {
  items ??= Promise.all([browser.bookmarks.getTree(), sortLogItem.getValue()]).then(([tree, log]) => {
    // What AI sorting found out about a site is searchable too.
    const about = new Map<string, string>();
    for (const e of log ?? []) {
      if (!e.site || about.has(e.bookmarkId)) continue;
      about.set(e.bookmarkId, [e.site.name, e.site.category, e.site.summary, e.site.purpose].filter(Boolean).join(' '));
    }
    return flattenBookmarks(tree, (id) => about.get(id));
  });
  return items;
}

/** Text with the matching parts wrapped in <mark>. */
function marked(text: string, query: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, query)) {
    if (start > at) out.push(document.createTextNode(text.slice(at, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    out.push(mark);
    at = end;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** A letter in a colour of its own for each site, instead of a favicon. */
function avatar(host: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = (host.replace(/^www\./, '')[0] ?? '•').toUpperCase();
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  span.style.setProperty('--hue', String(h % 360));
  return span;
}

function select(index: number) {
  rows[current]?.classList.remove('active');
  rows[current]?.setAttribute('aria-selected', 'false');
  current = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
  const row = rows[current];
  if (!row) {
    find.removeAttribute('aria-activedescendant');
    return;
  }
  row.classList.add('active');
  row.setAttribute('aria-selected', 'true');
  find.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

/** Opens a result: in a new tab, or in the background (popup stays open), or in the current tab. */
async function openResult(url: string, how: 'tab' | 'background' | 'here') {
  if (how === 'here') {
    await browser.tabs.update({ url });
    window.close();
  } else {
    await browser.tabs.create({ url, active: how === 'tab' });
    if (how === 'tab') window.close();
  }
}

let searchRun = 0;
async function runSearch() {
  const query = find.value.trim();
  const searching = query.length > 0;
  document.body.classList.toggle('searching', searching);
  $('#find-results').hidden = !searching;
  find.setAttribute('aria-expanded', String(searching));
  if (!searching) {
    results.replaceChildren();
    rows = [];
    current = -1;
    return;
  }
  const run = ++searchRun;
  const all = await loadItems();
  if (run !== searchRun) return;
  const { hits, total } = searchBookmarks(all, query, RESULTS_MAX);
  rows = hits.map(({ item }, i) => {
    const li = document.createElement('li');
    li.id = `result-${i}`;
    li.className = 'result';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.url = item.url;
    li.title = item.url;
    const text = document.createElement('span');
    text.className = 'result-text';
    const title = document.createElement('span');
    title.className = 'result-title';
    title.append(...marked(item.title, query));
    const where = document.createElement('span');
    where.className = 'result-where';
    where.append(...marked(item.host || item.url, query));
    if (item.path) {
      const path = document.createElement('span');
      path.className = 'result-path';
      path.append(...marked(item.path, query));
      where.append(path);
    }
    text.append(title, where);
    li.append(avatar(item.host), text);
    return li;
  });
  if (rows.length) results.replaceChildren(...rows);
  else {
    const empty = document.createElement('li');
    empty.className = 'results-empty muted small';
    empty.textContent = t('findNone', query);
    results.replaceChildren(empty);
  }
  $('#results-count').textContent =
    total > hits.length ? t('findMore', hits.length, total) : total ? tn('findCount', total) : '';
  current = -1;
  select(0);
}

find.addEventListener('input', () => void runSearch());
find.addEventListener('focus', () => void loadItems());
find.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    select(current + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter') {
    const url = rows[current]?.dataset.url;
    if (!url) return;
    e.preventDefault();
    void openResult(url, e.shiftKey ? 'here' : e.ctrlKey || e.metaKey ? 'background' : 'tab');
  } else if (e.key === 'Escape' && find.value) {
    // The first Escape clears the search; the next one closes the popup as usual.
    e.preventDefault();
    find.value = '';
    void runSearch();
  }
});
results.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLLIElement>('.result');
  if (!row?.dataset.url) return;
  void openResult(row.dataset.url, e.ctrlKey || e.metaKey ? 'background' : e.shiftKey ? 'here' : 'tab');
});
results.addEventListener('auxclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLLIElement>('.result');
  if (e.button === 1 && row?.dataset.url) void openResult(row.dataset.url, 'background');
});
// "/" jumps to the search from anywhere in the popup.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== find && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    find.focus();
  }
});
// Typing right after opening the popup goes into the search.
requestAnimationFrame(() => find.focus({ preventScroll: true }));
