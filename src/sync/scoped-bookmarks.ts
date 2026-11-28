import type { BookmarkNode, BookmarksApi } from './bookmarks-api';

/**
 * One local folder seen as a whole bookmark tree, so the ordinary sync engine
 * can sync it with a shared folder's own file: the folder appears as the
 * "Bookmarks bar" of a Chromium-like tree. Writes outside the folder (or to
 * the folder itself) are refused, so a shared folder's sync can never touch
 * the rest of the user's bookmarks.
 */
export const SCOPE_ROOT_ID = '__marksync_scope_root';

function find(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...(n.children ?? []));
  }
  return undefined;
}

export class ScopeGoneError extends Error {
  override name = 'ScopeGoneError';
}

export function scopedBookmarks(api: BookmarksApi, folderId: string): BookmarksApi {
  const subtree = async (): Promise<BookmarkNode> => {
    const node = find(await api.getTree(), folderId);
    if (!node || node.url !== undefined) throw new ScopeGoneError('The shared folder was deleted in this browser.');
    return node;
  };
  /** True when `id` is the folder or inside it. */
  const inside = async (id: string, allowRoot: boolean) => {
    const root = await subtree();
    if (id === folderId) return allowRoot;
    return !!find(root.children ?? [], id);
  };
  const guard = async (id: string, allowRoot: boolean) => {
    if (!(await inside(id, allowRoot))) throw new Error('Outside the shared folder.');
  };
  return {
    async getTree() {
      const root = await subtree();
      return [{ id: SCOPE_ROOT_ID, title: '', children: [{ ...root, folderType: 'bookmarks-bar', syncing: false }] }];
    },
    async getChildren(id) {
      await guard(id, true);
      return api.getChildren(id);
    },
    async create(details) {
      await guard(details.parentId, true);
      return api.create(details);
    },
    async update(id, changes) {
      await guard(id, false);
      return api.update(id, changes);
    },
    async move(id, destination) {
      await guard(id, false);
      if (destination.parentId) await guard(destination.parentId, true);
      return api.move(id, destination);
    },
    async remove(id) {
      await guard(id, false);
      return api.remove(id);
    },
    async removeTree(id) {
      await guard(id, false);
      return api.removeTree(id);
    },
  };
}
