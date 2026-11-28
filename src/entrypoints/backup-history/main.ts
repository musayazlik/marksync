import type { ChangeKind, FolderPath, HistoryChange } from '../../core/history';
import type { RootKey } from '../../core/types';
import { initI18n, locale, localizePage, t, tn } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { $, showToast, withBusy } from '../../shared/ui';
import type { BackupInfo } from '../../services/backup-service';
import type { BackupDiff } from '../../services/history-service';

/**
 * Version history: pick a backup, see what changed since (removed, moved,
 * renamed, added), grouped by the folder it was in, and bring back only the
 * items you tick. The background script does the comparing and restoring.
 */
await initI18n(() => location.reload());
localizePage();
const actionError = $('#action-error');
const picker = $<HTMLSelectElement>('#backup');
const restoreBtn = $<HTMLButtonElement>('#restore');
const filterText = $<HTMLInputElement>('#filter-text');

type Filter = 'all' | ChangeKind;
let backups: BackupInfo[] = [];
let diff: BackupDiff | undefined;
let filter: Filter = 'all';
const chosen = new Set<string>();

const rootKey: Record<RootKey, string> = {
  toolbar: 'rootToolbar',
  menu: 'rootMenu',
  other: 'rootOther',
  mobile: 'rootMobile',
};
const kindKey: Record<ChangeKind, string> = {
  removed: 'historyKindRemoved',
  moved: 'historyKindMoved',
  renamed: 'historyKindRenamed',
  added: 'historyKindAdded',
};

const pathText = (p: FolderPath) => [t(rootKey[p.root]), ...p.folders].join(' / ');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const backupLabel = (b: BackupInfo) =>
  [new Date(b.createdTime).toLocaleString(locale()), b.source, tn('historyItems', b.count)].filter(Boolean).join(' · ');

function matches(c: HistoryChange): boolean {
  if (filter === 'renamed' && !(c.kind === 'renamed' || c.before)) return false;
  if (filter !== 'all' && filter !== 'renamed' && c.kind !== filter) return false;
  const q = filterText.value.trim().toLocaleLowerCase();
  if (!q) return true;
  return [c.title, c.url, c.before?.title, c.before?.url, pathText(c.folder), c.movedTo && pathText(c.movedTo)].some((v) =>
    v?.toLocaleLowerCase().includes(q),
  );
}

function updateRestore() {
  const n = chosen.size;
  restoreBtn.textContent = tn('historyRestoreSelected', n);
  restoreBtn.disabled = n === 0;
}

function row(c: HistoryChange): HTMLLIElement {
  const li = el('li');
  const label = el('label', `change ${c.kind}`);
  const box = el('input', 'tick');
  box.type = 'checkbox';
  box.disabled = !c.restorable;
  box.checked = chosen.has(c.id);
  box.setAttribute('aria-label', t('historyChoose', c.title || c.url || ''));
  box.addEventListener('change', () => {
    if (box.checked) chosen.add(c.id);
    else chosen.delete(c.id);
    updateRestore();
  });
  const text = el('span', 'change-text');
  const title = el('span', 'change-title', c.title || c.url || t('historyUntitled'));
  if (c.nodeKind === 'folder') title.prepend(el('span', 'folder-mark', '▸ '));
  text.append(title);
  const meta = el('span', 'change-meta muted small');
  if (c.url && c.url !== c.title) meta.append(el('span', 'change-url', c.url));
  if (c.inside) meta.append(el('span', undefined, tn(c.kind === 'added' ? 'historyInsideAdded' : 'historyInside', c.inside)));
  if (c.movedTo) meta.append(el('span', undefined, t('historyNowIn', pathText(c.movedTo))));
  if (c.before) {
    if (c.before.title !== c.title) meta.append(el('span', undefined, t('historyWasTitle', c.before.title)));
    if (c.before.url !== c.url && c.before.url) meta.append(el('span', undefined, t('historyWasUrl', c.before.url)));
  }
  if (meta.childElementCount) text.append(meta);
  const tags = el('span', 'tags');
  tags.append(el('span', `tag ${c.kind}`, t(kindKey[c.kind])));
  if (c.kind === 'moved' && c.before) tags.append(el('span', 'tag renamed', t(kindKey.renamed)));
  label.append(box, text, tags);
  if (!c.restorable) label.title = t('historyAddedHint');
  li.append(label);
  return li;
}

function render() {
  const counts = diff?.counts ?? { removed: 0, moved: 0, renamed: 0, added: 0 };
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#filters .chip')) {
    const f = chip.dataset.filter as Filter;
    const n = f === 'all' ? (diff?.changes.length ?? 0) : counts[f];
    chip.textContent = `${t(f === 'all' ? 'historyFilterAll' : kindKey[f])} ${n.toLocaleString(locale())}`;
    chip.setAttribute('aria-pressed', String(f === filter));
    chip.disabled = f !== 'all' && n === 0;
  }
  const shown = (diff?.changes ?? []).filter(matches);
  const byFolder = new Map<string, HistoryChange[]>();
  for (const c of shown) {
    const key = pathText(c.folder);
    byFolder.set(key, [...(byFolder.get(key) ?? []), c]);
  }
  const sections = [...byFolder]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, list]) => {
      const section = el('section', 'group');
      const head = el('div', 'group-head');
      head.append(el('span', 'group-path', path), el('span', 'pill', tn('historyChanges', list.length)));
      const restorable = list.filter((c) => c.restorable);
      if (restorable.length > 1) {
        const all = el('button', 'quiet small-button', t('historySelectFolder'));
        all.type = 'button';
        all.addEventListener('click', () => {
          const every = restorable.every((c) => chosen.has(c.id));
          for (const c of restorable) {
            if (every) chosen.delete(c.id);
            else chosen.add(c.id);
          }
          render();
        });
        head.append(all);
      }
      const ul = el('ul', 'changes');
      ul.append(...list.map(row));
      section.append(head, ul);
      return section;
    });
  $('#groups').replaceChildren(...sections);
  const none = $('#none');
  none.hidden = !diff || shown.length > 0;
  $('#none-text').textContent = diff?.changes.length ? t('historyNoMatch') : t('historyNoChanges');
  updateRestore();
}

async function compare() {
  const id = picker.value;
  if (!id) return;
  chosen.clear();
  diff = undefined;
  $('#groups').replaceChildren();
  $('#none').hidden = true;
  $('#loading').hidden = false;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  try {
    diff = await send({ type: 'historyCompare', id });
  } finally {
    $('#loading').hidden = true;
    render();
  }
}

async function loadBackups() {
  backups = await send({ type: 'listBackups' });
  picker.replaceChildren(
    ...backups.map((b) => Object.assign(document.createElement('option'), { value: b.id, textContent: backupLabel(b) })),
  );
  if (!backups.length) {
    $('#none-text').textContent = t('historyNoBackups');
    $('#none').hidden = false;
    return;
  }
  const wanted = new URLSearchParams(location.search).get('id');
  picker.value = backups.some((b) => b.id === wanted) ? wanted! : backups[0]!.id;
  await compare();
}

async function restore() {
  const ids = [...chosen];
  if (!ids.length || !diff) return;
  const when = new Date(diff.createdAt).toLocaleString(locale());
  if (!confirm(t('historyConfirm', ids.length, when))) return;
  const r = await send({ type: 'historyRestore', id: picker.value, ids });
  const parts = [tn('historyDone', r.restored)];
  if (r.fallbackFolder) parts.push(t('historyDoneFallback', r.fallbackFolder));
  if (r.failed) parts.push(tn('historyFailed', r.failed));
  parts.push(t('historyDoneUndo'));
  const result = $('#result');
  result.textContent = parts.join(' ');
  result.hidden = false;
  await compare();
}

// ---------- find in backups ----------

async function find() {
  const query = $<HTMLInputElement>('#find').value.trim();
  const status = $('#find-status');
  const hits = $('#hits');
  hits.replaceChildren();
  if (query.length < 2) {
    status.textContent = t('historyFindShort');
    status.hidden = false;
    return;
  }
  status.textContent = t('historyFinding');
  status.hidden = false;
  const found = await send({ type: 'historySearch', query });
  status.textContent = found.length ? tn('historyFound', found.length) : t('historyFoundNone');
  hits.append(
    ...found.map((h) => {
      const li = el('li', 'hit');
      const head = el('div', 'hit-head');
      head.append(el('strong', undefined, new Date(h.createdTime).toLocaleString(locale())), el('span', 'muted small', h.source));
      const open = el('button', 'quiet small-button', t('historyFindOpen'));
      open.type = 'button';
      open.addEventListener('click', () => {
        picker.value = h.id;
        filterText.value = query;
        void compare().catch(showError);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      head.append(open);
      const list = el('ul', 'hit-matches');
      for (const m of h.matches) {
        const item = el('li', 'small');
        item.append(el('span', 'change-title', m.title || m.url || ''), el('span', 'muted', ` · ${pathText(m.folder)}`));
        if (m.url) item.title = m.url;
        list.append(item);
      }
      li.append(head, list);
      return li;
    }),
  );
}

// ---------- wiring ----------

const showError = (err: unknown) => showToast(actionError, err instanceof Error ? err.message : String(err));

picker.addEventListener('change', () => void compare().catch(showError));
filterText.addEventListener('input', render);
for (const chip of document.querySelectorAll<HTMLButtonElement>('#filters .chip')) {
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter as Filter;
    render();
  });
}
restoreBtn.addEventListener('click', () => withBusy(restoreBtn, restore, actionError));
$('#find-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void withBusy($<HTMLButtonElement>('#find-btn'), find, actionError);
});

updateRestore();
void loadBackups().catch(showError);
