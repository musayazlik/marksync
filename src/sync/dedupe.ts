import { normalizeUrl } from '../core/dedupe';
import type { BookmarkNode, BookmarksApi } from './bookmarks-api';
import { isSyncable } from './local-tree';

function index(tree: BookmarkNode[]): Map<string, BookmarkNode> {
  const map = new Map<string, BookmarkNode>();
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop()!;
    map.set(node.id, node);
    stack.push(...(node.children ?? []));
  }
  return map;
}

/**
 * Removes the listed copies. Each one must still be a removable bookmark
 * whose address normalizes to `expected[id]`, the address it was listed
 * under, so a bookmark the user changed since the scan is never removed.
 */
export async function removeCopies(
  bookmarks: BookmarksApi,
  expected: Record<string, string>,
): Promise<{ removed: number; skipped: number }> {
  const nodes = index(await bookmarks.getTree());
  let removed = 0;
  let skipped = 0;
  for (const [id, key] of Object.entries(expected)) {
    const node = nodes.get(id);
    if (!node || node.url === undefined || !isSyncable(node) || normalizeUrl(node.url) !== key) {
      skipped++;
      continue;
    }
    try {
      await bookmarks.remove(id);
      removed++;
    } catch {
      skipped++;
    }
  }
  return { removed, skipped };
}
