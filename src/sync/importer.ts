import { ROOT_TITLES, type ImportNode, type ImportSource } from '../core/import';
import { ROOT_KEYS } from '../core/types';
import type { BookmarksApi } from './bookmarks-api';
import { MENU_FOLDER_TITLE, readLocal } from './local-tree';

export type ImportMode =
  /** Into the matching top-level folders, skipping bookmarks that already exist. */
  | 'merge'
  /** Everything into one new folder under Other bookmarks. */
  | 'folder';

export interface ImportResult {
  added: number;
  duplicates: number;
  /** Bookmarks this browser refused, e.g. `javascript:` links in Firefox. */
  failed: number;
  /** Set when a Chromium "Bookmarks Menu" folder was created for menu items. */
  menuFolderId?: string;
}

/**
 * Writes an ImportSource into the local bookmarks. The normal sync then
 * sends the new bookmarks to the other browsers.
 */
export async function importIntoLocal(
  api: BookmarksApi,
  source: ImportSource,
  opts: { mode: ImportMode; label: string; menuFolderId?: string; date?: Date },
): Promise<ImportResult> {
  const { snapshot, flavor } = await readLocal(api, opts.menuFolderId);
  const roots = { ...snapshot.roots };
  if (!roots.other) throw new Error('This browser has no "Other bookmarks" folder.');
  const result: ImportResult = { added: 0, duplicates: 0, failed: 0 };

  const addAll = async (parentId: string, items: ImportNode[], dedupe: boolean): Promise<void> => {
    const existing = dedupe ? await api.getChildren(parentId) : [];
    for (const item of items) {
      if (item.kind === 'folder') {
        const match = dedupe
          ? existing.find((c) => c.url === undefined && c.type !== 'separator' && c.title === item.title)
          : undefined;
        const folderId = match?.id ?? (await api.create({ parentId, title: item.title })).id;
        await addAll(folderId, item.children, !!match);
        continue;
      }
      if (dedupe && existing.some((c) => c.url === item.url)) {
        result.duplicates++;
        continue;
      }
      try {
        await api.create({ parentId, title: item.title, url: item.url });
        result.added++;
      } catch {
        result.failed++;
      }
    }
  };

  if (opts.mode === 'folder') {
    const day = (opts.date ?? new Date()).toISOString().slice(0, 10);
    const container = await api.create({ parentId: roots.other, title: `Imported from ${opts.label} (${day})` });
    for (const key of ROOT_KEYS) {
      const items = source.roots[key];
      if (!items?.length) continue;
      const folder = await api.create({ parentId: container.id, title: ROOT_TITLES[key] });
      await addAll(folder.id, items, false);
    }
    return result;
  }

  for (const key of ROOT_KEYS) {
    const items = source.roots[key];
    if (!items?.length) continue;
    let target = roots[key];
    if (!target && key === 'menu' && flavor === 'chromium') {
      target = (await api.create({ parentId: roots.other, title: MENU_FOLDER_TITLE })).id;
      roots.menu = result.menuFolderId = target;
    }
    await addAll(target ?? roots.other, items, true);
  }
  return result;
}
