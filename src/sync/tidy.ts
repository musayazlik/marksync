import { findTreeNode, folderPath } from '../core/ai-sort';
import type { TidyProposal } from '../core/tidy';
import type { SortLogEntry, TidyChange } from '../shared/state';
import type { BookmarksApi } from './bookmarks-api';
import { UndoError, type SortOutcome } from './sorter';

/**
 * Carries out an approved tidy-up proposal, after checking the bookmark or
 * folder is still as the proposal saw it (otherwise nothing is touched).
 * Returns the log entry, with what is needed to undo it.
 */
export async function applyTidy(api: BookmarksApi, p: TidyProposal, model: string): Promise<SortOutcome> {
  const tree = await api.getTree();
  const fail = (bookmarkId: string, title: string, error: string, errorCode = 'moved'): SortOutcome => ({
    bookmarkId,
    title,
    status: 'error',
    error,
    errorCode,
    model,
  });

  if (p.kind === 'retitle') {
    const hit = findTreeNode(tree, p.bookmarkId);
    if (!hit || hit.node.title !== p.title) return fail(p.bookmarkId, p.title, 'The bookmark changed meanwhile.');
    await api.update(p.bookmarkId, { title: p.newTitle });
    return {
      bookmarkId: p.bookmarkId,
      title: p.newTitle,
      ...(p.url ? { url: p.url } : {}),
      status: 'tidied',
      fromPath: p.folderPath,
      tidy: { action: 'retitle', before: p.title, after: p.newTitle },
      model,
    };
  }

  if (p.kind === 'move') {
    const item = findTreeNode(tree, p.bookmarkId);
    if (!item) return fail(p.bookmarkId, p.title, 'The bookmark was deleted meanwhile.', 'gone');
    if (item.parentId !== p.fromId) return fail(p.bookmarkId, p.title, 'The bookmark was moved meanwhile.');
    const into = findTreeNode(tree, p.intoId);
    if (!into || into.node.url !== undefined) return fail(p.bookmarkId, p.title, 'The target folder was deleted meanwhile.', 'gone');
    // A folder cannot go into itself or one of its subfolders.
    if (item.node.url === undefined && (p.intoId === p.bookmarkId || findTreeNode(item.node.children ?? [], p.intoId))) {
      return fail(p.bookmarkId, p.title, 'The target folder is inside this folder.');
    }
    const siblings = findTreeNode(tree, p.fromId)?.node.children ?? [];
    const index = siblings.findIndex((c) => c.id === p.bookmarkId);
    await api.move(p.bookmarkId, { parentId: p.intoId });
    return {
      bookmarkId: p.bookmarkId,
      title: item.node.title,
      ...(item.node.url ? { url: item.node.url } : {}),
      status: 'tidied',
      fromId: p.fromId,
      fromPath: p.folderPath,
      toId: p.intoId,
      toPath: p.intoPath,
      tidy: { action: 'move', before: item.node.title, parentId: p.fromId, ...(index >= 0 ? { index } : {}), targetId: p.intoId },
      ...(p.reason ? { reason: p.reason } : {}),
      model,
    };
  }

  const hit = findTreeNode(tree, p.folderId);
  const title = hit?.node.title ?? p.title;
  if (!hit || hit.node.url !== undefined) return fail(p.folderId, title, 'The folder was deleted meanwhile.', 'gone');
  const parentId = hit.parentId;
  const index = (tree.length && parentId ? (findTreeNode(tree, parentId)?.node.children ?? []).findIndex((c) => c.id === p.folderId) : -1);
  const place = { ...(parentId ? { parentId } : {}), ...(index >= 0 ? { index } : {}) };
  const reason = 'reason' in p && p.reason ? { reason: p.reason } : {};

  if (p.kind === 'rename') {
    if (hit.node.title !== p.title) return fail(p.folderId, title, 'The folder was renamed meanwhile.');
    await api.update(p.folderId, { title: p.name });
    return {
      bookmarkId: p.folderId,
      title: p.name,
      status: 'tidied',
      fromPath: p.folderPath,
      toPath: folderPath(await api.getTree(), p.folderId) ?? p.folderPath,
      tidy: { action: 'rename', before: hit.node.title, after: p.name },
      ...reason,
      model,
    };
  }

  if (p.kind === 'merge') {
    const into = findTreeNode(tree, p.intoId);
    if (!into || into.node.url !== undefined) return fail(p.folderId, title, 'The target folder was deleted meanwhile.', 'gone');
    // The target must not have been moved into the folder being merged away.
    if (findTreeNode(hit.node.children ?? [], p.intoId)) return fail(p.folderId, title, 'The target folder is inside this folder now.');
    const moved: string[] = [];
    for (const child of await api.getChildren(p.folderId)) {
      await api.move(child.id, { parentId: p.intoId });
      moved.push(child.id);
    }
    if (!(await api.getChildren(p.folderId)).length) await api.remove(p.folderId);
    return {
      bookmarkId: p.folderId,
      title: hit.node.title,
      status: 'tidied',
      fromPath: p.folderPath,
      toPath: p.intoPath,
      toId: p.intoId,
      tidy: { action: 'merge', before: hit.node.title, ...place, moved, targetId: p.intoId },
      ...reason,
      model,
    };
  }

  // remove: only if it is still empty (no bookmark anywhere below it).
  const hasBookmark = (n: typeof hit.node): boolean => (n.children ?? []).some((c) => c.url !== undefined || c.type === 'separator' || hasBookmark(c));
  if (hasBookmark(hit.node)) return fail(p.folderId, title, 'The folder is not empty any more.');
  await api.removeTree(p.folderId);
  return {
    bookmarkId: p.folderId,
    title: hit.node.title,
    status: 'tidied',
    fromPath: p.folderPath,
    tidy: { action: 'remove', before: hit.node.title, ...place },
    model,
  };
}

/** Takes a tidy-up change back: old title, old name, the merged folder with its items, the removed (empty) folder. */
export async function undoTidy(api: BookmarksApi, entry: SortLogEntry): Promise<void> {
  const change: TidyChange | undefined = entry.tidy;
  if (!change) throw new UndoError('no-source');
  const tree = await api.getTree();
  if (change.action === 'retitle' || change.action === 'rename') {
    const hit = findTreeNode(tree, entry.bookmarkId);
    if (!hit) throw new UndoError('gone');
    if (hit.node.title !== change.after) throw new UndoError('moved');
    await api.update(entry.bookmarkId, { title: change.before });
    return;
  }
  if (!change.parentId || !findTreeNode(tree, change.parentId)) throw new UndoError('no-source');
  if (change.action === 'move') {
    const hit = findTreeNode(tree, entry.bookmarkId);
    if (!hit) throw new UndoError('gone');
    if (hit.parentId !== change.targetId) throw new UndoError('moved');
    const count = findTreeNode(tree, change.parentId)!.node.children?.length ?? 0;
    await api.move(entry.bookmarkId, { parentId: change.parentId, ...(change.index !== undefined ? { index: Math.min(change.index, count) } : {}) });
    return;
  }
  const siblings = findTreeNode(tree, change.parentId)!.node.children ?? [];
  const folder = await api.create({
    parentId: change.parentId,
    title: change.before,
    ...(change.index !== undefined ? { index: Math.min(change.index, siblings.length) } : {}),
  });
  if (change.action === 'merge') {
    // Only what is still in the target folder goes back.
    const target = change.targetId ? new Set((await api.getChildren(change.targetId).catch(() => [])).map((c) => c.id)) : new Set<string>();
    for (const id of change.moved ?? []) if (target.has(id)) await api.move(id, { parentId: folder.id });
  }
}
