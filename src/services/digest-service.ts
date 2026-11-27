import { findTreeNode } from '../core/ai-sort';
import { digestDue, pickDigest, type DigestCandidate, type DigestPick } from '../core/digest';
import { isOpenable } from '../core/search';
import { t } from '../shared/i18n';
import { digestItem, getSettings, sortLogItem, type DigestState } from '../shared/state';
import type { BookmarkNode, BookmarksApi } from '../sync/bookmarks-api';
import { detectSpecialRoots, readLocal } from '../sync/local-tree';
import { localBookmarks } from './sync-service';
import { tagsByLocalId } from './tags-service';

/**
 * "Rediscover" in the popup (core/digest.ts): built when the popup opens and
 * a new digest is due; the user opens, keeps, archives or deletes each pick.
 */

export interface DigestEntry extends DigestPick {
  title: string;
  url: string;
  path: string;
  addedAt?: number;
  done?: DigestState['done'][string];
}

/** Keep the memory of kept/opened bookmarks bounded. */
const MEMORY_MAX = 5_000;

let writes: Promise<unknown> = Promise.resolve();
function update(change: (s: DigestState) => DigestState): Promise<DigestState> {
  const run = writes
    .catch(() => undefined)
    .then(async () => {
      const next = change(await digestItem.getValue());
      await digestItem.setValue(next);
      return next;
    });
  writes = run;
  return run;
}

const trim = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, MEMORY_MAX));

async function candidates(api: BookmarksApi, opened: Record<string, number>): Promise<Map<string, DigestCandidate>> {
  const [tree, special, tags, log] = await Promise.all([api.getTree(), detectSpecialRoots(api), tagsByLocalId(), sortLogItem.getValue()]);
  const exclude = new Set(special.exclude);
  const category = new Map<string, string>();
  for (const e of log ?? []) if (e.site?.category && !category.has(e.bookmarkId)) category.set(e.bookmarkId, e.site.category);
  const out = new Map<string, DigestCandidate>();
  const walk = (nodes: BookmarkNode[], path: string[], depth: number) => {
    if (depth > 100) return;
    for (const n of nodes) {
      if (exclude.has(n.id)) continue;
      if (n.url !== undefined) {
        if (!isOpenable(n.url)) continue;
        const usedAt = Math.max(n.dateLastUsed ?? 0, opened[n.id] ?? 0) || undefined;
        out.set(n.id, {
          id: n.id,
          title: n.title || n.url,
          url: n.url,
          path: path.join(' / '),
          ...(n.dateAdded ? { addedAt: n.dateAdded } : {}),
          ...(usedAt ? { usedAt } : {}),
          ...(tags[n.id] ? { tags: tags[n.id] } : {}),
          ...(category.has(n.id) ? { category: category.get(n.id) } : {}),
        });
      } else if (n.children) walk(n.children, n.title ? [...path, n.title] : path, depth + 1);
    }
  };
  walk(tree, [], 0);
  return out;
}

/** The digest to show now, or null when it is off. A new one is made when due. */
export async function getDigest(now = Date.now()): Promise<DigestEntry[] | null> {
  const { digestFrequency } = await getSettings();
  if (digestFrequency === 'off') return null;
  const api = localBookmarks();
  let state = await digestItem.getValue();
  const all = await candidates(api, state.opened);
  if (digestDue(digestFrequency, state.createdAt, now)) {
    const picks = pickDigest([...all.values()], { now, seed: Math.floor(now / 86_400_000), kept: state.kept });
    state = await update((s) => ({ ...s, createdAt: now, picks, done: {} }));
  }
  return state.picks.flatMap((p) => {
    const c = all.get(p.id);
    const done = state.done[p.id];
    // A pick deleted or moved away meanwhile is simply left out (unless the digest did it).
    if (!c && done !== 'deleted') return [];
    return [{ ...p, title: c?.title ?? '', url: c?.url ?? '', path: c?.path ?? '', ...(c?.addedAt ? { addedAt: c.addedAt } : {}), ...(done ? { done } : {}) }];
  });
}

/** The "Archive" folder under Other bookmarks, created on first use. */
async function archiveFolder(api: BookmarksApi): Promise<string> {
  const { snapshot } = await readLocal(api);
  const other = snapshot.roots.other ?? snapshot.roots.toolbar;
  if (!other) throw new Error(t('historyNoRoot'));
  const name = t('digestArchiveFolder');
  const existing = (await api.getChildren(other)).find((c) => c.url === undefined && c.title === name);
  return existing?.id ?? (await api.create({ parentId: other, title: name })).id;
}

export type DigestAction = 'open' | 'keep' | 'archive' | 'delete';

/** What the user did with a pick. Opening the tab is the popup's job; this records it. */
export async function actOnDigest(id: string, action: DigestAction, now = Date.now()): Promise<void> {
  const state = await digestItem.getValue();
  if (!state.picks.some((p) => p.id === id)) throw new Error(t('digestGone'));
  const api = localBookmarks();
  if (action === 'archive' || action === 'delete') {
    const tree = await api.getTree();
    const hit = findTreeNode(tree, id);
    if (!hit || hit.node.url === undefined) throw new Error(t('digestGone'));
    if (action === 'archive') await api.move(id, { parentId: await archiveFolder(api) });
    else await api.remove(id);
  }
  const done = ({ open: 'opened', keep: 'kept', archive: 'archived', delete: 'deleted' } as const)[action];
  await update((s) => ({
    ...s,
    done: { ...s.done, [id]: done },
    ...(action === 'keep' ? { kept: trim({ ...s.kept, [id]: now }) } : {}),
    ...(action === 'open' ? { opened: trim({ ...s.opened, [id]: now }) } : {}),
  }));
}
