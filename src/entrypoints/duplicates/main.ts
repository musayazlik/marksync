import type { DuplicateGroup } from '../../core/dedupe';
import { localizePage, t, tn } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { statusItem } from '../../shared/state';
import { $, showToast, withBusy } from '../../shared/ui';

/**
 * Duplicate bookmarks: lists every page bookmarked more than once and removes
 * the copies the user does not keep. The background script does the scan and
 * the removal (and the backup before it).
 */
localizePage();
const actionError = $('#action-error');
const removeBtn = $<HTMLButtonElement>('#remove');

let groups: DuplicateGroup[] = [];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "example.com" in bold and "/docs/page?x=1" after it. */
function address(key: string): HTMLElement {
  const slash = key.search(/[/?#]/);
  const wrap = el('span', 'address');
  wrap.append(el('strong', undefined, slash < 0 ? key : key.slice(0, slash)));
  if (slash >= 0 && key.slice(slash) !== '/') wrap.append(el('span', 'muted', key.slice(slash)));
  return wrap;
}

/** The bookmarks the current choices would remove, with the address each was listed under. */
function selection(): Record<string, string> {
  const expected: Record<string, string> = {};
  document.querySelectorAll<HTMLElement>('.group').forEach((section, i) => {
    const group = groups[i]!;
    if (!section.querySelector<HTMLInputElement>('.include')!.checked) return;
    const keep = section.querySelector<HTMLInputElement>('input[type=radio]:checked')?.value;
    for (const item of group.items) if (item.id !== keep) expected[item.id] = group.key;
  });
  return expected;
}

function updateCount() {
  const n = Object.keys(selection()).length;
  removeBtn.textContent = tn('dupRemove', n);
  removeBtn.disabled = n === 0;
}

function renderGroup(group: DuplicateGroup, i: number): HTMLElement {
  const section = el('section', 'group');
  const head = el('div', 'group-head');
  const include = el('input', 'include');
  include.type = 'checkbox';
  include.checked = true;
  include.setAttribute('aria-label', t('dupIncludeGroup'));
  include.addEventListener('change', () => {
    section.classList.toggle('skipped', !include.checked);
    updateCount();
  });
  head.append(address(group.key), el('span', 'pill', tn('dupCopies', group.items.length)), include);
  section.append(head);

  const list = el('ul', 'copies');
  group.items.forEach((item, j) => {
    const li = el('li');
    const label = el('label', 'copy');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = `keep-${i}`;
    radio.value = item.id;
    radio.checked = j === 0;
    radio.addEventListener('change', updateCount);
    const text = el('span', 'copy-text');
    text.append(el('span', 'copy-title', item.title || item.url));
    const meta = el('span', 'copy-meta muted small');
    meta.append(el('span', 'folder', item.folderPath));
    if (item.dateAdded) meta.append(el('span', undefined, t('dupAdded', new Date(item.dateAdded).toLocaleDateString())));
    text.append(meta);
    if (item.url.replace(/\/$/, '') !== `https://${group.key}`.replace(/\/$/, '')) {
      text.append(el('span', 'copy-url muted small', item.url));
    }
    label.append(radio, text, el('span', 'tag keep', t('dupKeep')), el('span', 'tag drop', t('dupWillRemove')));
    li.append(label);
    list.append(li);
  });
  section.append(list);
  return section;
}

function render() {
  $('#groups').replaceChildren(...groups.map(renderGroup));
  $('#none').hidden = groups.length > 0;
  const extra = groups.reduce((n, g) => n + g.items.length - 1, 0);
  $('#summary').replaceChildren(
    ...(groups.length
      ? [el('span', 'pill', tn('dupGroups', groups.length)), el('span', 'pill', tn('dupExtra', extra))]
      : []),
  );
  updateCount();
}

async function scan() {
  $('#scanning').hidden = false;
  $('#groups').replaceChildren();
  $('#none').hidden = true;
  try {
    groups = await send({ type: 'dupScan' });
    render();
  } finally {
    $('#scanning').hidden = true;
  }
}

async function remove() {
  const expected = selection();
  const n = Object.keys(expected).length;
  if (!n) return;
  const connected = (await statusItem.getValue()).connected;
  if (!confirm(connected ? t('dupConfirm', n) : t('dupConfirmNoBackup', n))) return;

  // The copies being removed fold away while the background script works.
  document.querySelectorAll<HTMLInputElement>('.group input[type=radio]').forEach((radio) => {
    if (expected[radio.value]) radio.closest('li')!.classList.add('leaving');
  });
  const r = await send({ type: 'dupRemove', expected });
  const parts = [tn('dupDone', r.removed)];
  if (r.backedUp) parts.push(t('dupDoneBackup'));
  if (r.skipped) parts.push(tn('dupSkipped', r.skipped));
  const result = $('#result');
  result.textContent = parts.join(' ');
  result.hidden = false;
  await new Promise((resolve) => setTimeout(resolve, 320));
  await scan();
}

$('#rescan').addEventListener('click', () => withBusy($<HTMLButtonElement>('#rescan'), scan, actionError));
removeBtn.addEventListener('click', () => withBusy(removeBtn, remove, actionError));

void scan().catch((err: unknown) => showToast(actionError, err instanceof Error ? err.message : String(err)));
