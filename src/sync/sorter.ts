import {
  buildSortPrompt,
  findTreeNode,
  folderPath,
  InvalidReplyError,
  listFolderOptions,
  parseSortReply,
  type ChatMessage,
} from '../core/ai-sort';
import type { SortLogEntry } from '../shared/state';
import type { BookmarksApi } from './bookmarks-api';
import { isSyncable } from './local-tree';

/**
 * Files one bookmark from the inbox folder, through an interface so tests can
 * use the in-memory bookmarks and a scripted model.
 */
export interface SorterDeps {
  bookmarks: BookmarksApi;
  /** Sends the prompt to the model and returns its reply text. */
  complete(messages: ChatMessage[]): Promise<string>;
  /** Folders never offered (Opera's Trash and Speed Dial). */
  exclude?: string[];
  /** UI language, for the model's short reason. */
  language: string;
}

export interface SortRun {
  inboxId: string;
  allowNewFolders: boolean;
  model: string;
}

/** A log entry without its id and time. */
export type SortOutcome = Omit<SortLogEntry, 'id' | 'at'>;

/** Error codes shown on the log page, next to OpenRouter's own. */
export type SortErrorCode = 'reply' | 'unknown';

/**
 * Asks the model where the bookmark belongs and moves it there.
 *
 * Returns null when there is nothing to do: the bookmark is gone, is not a
 * bookmark, or is no longer in the inbox (the user moved it while waiting).
 * Model and network errors are returned as an 'error' outcome, never thrown,
 * so the bookmark simply stays in the inbox.
 */
export async function sortOne(deps: SorterDeps, run: SortRun, bookmarkId: string): Promise<SortOutcome | null> {
  const tree = await deps.bookmarks.getTree();
  const hit = findTreeNode(tree, bookmarkId);
  if (!hit || hit.node.url === undefined || hit.parentId !== run.inboxId || !isSyncable(hit.node)) return null;
  const { node } = hit;
  const base: SortOutcome = {
    bookmarkId,
    title: node.title,
    url: node.url,
    status: 'kept',
    fromId: run.inboxId,
    fromPath: folderPath(tree, run.inboxId),
    model: run.model,
  };

  const folders = listFolderOptions(tree, { exclude: deps.exclude, skip: [run.inboxId] });
  let reply: string;
  try {
    reply = await deps.complete(
      buildSortPrompt({
        title: node.title,
        url: node.url,
        folders,
        allowNewFolders: run.allowNewFolders,
        language: deps.language,
      }),
    );
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { ...base, status: 'error', error: messageOf(err), errorCode: typeof code === 'string' ? code : 'unknown' };
  }

  let decision;
  try {
    decision = parseSortReply(reply, folders, { allowNewFolders: run.allowNewFolders });
  } catch (err) {
    return { ...base, status: 'error', error: messageOf(err), errorCode: err instanceof InvalidReplyError ? 'reply' : 'unknown' };
  }
  const meta = { reason: decision.reason || undefined, confidence: decision.confidence };
  if (decision.action === 'keep') return { ...base, ...meta, status: 'kept' };

  // The model took a few seconds: look again before touching anything.
  const now = await deps.bookmarks.getTree();
  const still = findTreeNode(now, bookmarkId);
  if (!still || still.parentId !== run.inboxId) return null;

  try {
    if (decision.action === 'move') {
      if (!findTreeNode(now, decision.folder.localId)) return { ...base, ...meta, status: 'error', error: 'The chosen folder was deleted.', errorCode: 'unknown' };
      await deps.bookmarks.move(bookmarkId, { parentId: decision.folder.localId });
      return { ...base, ...meta, status: 'moved', toId: decision.folder.localId, toPath: decision.folder.path };
    }
    if (!findTreeNode(now, decision.parent.localId)) return { ...base, ...meta, status: 'error', error: 'The chosen folder was deleted.', errorCode: 'unknown' };
    const folder = await deps.bookmarks.create({ parentId: decision.parent.localId, title: decision.name });
    await deps.bookmarks.move(bookmarkId, { parentId: folder.id });
    return {
      ...base,
      ...meta,
      status: 'created',
      toId: folder.id,
      toPath: `${decision.parent.path} / ${decision.name}`,
    };
  } catch (err) {
    return { ...base, ...meta, status: 'error', error: messageOf(err), errorCode: 'unknown' };
  }
}

export class UndoError extends Error {
  override name = 'UndoError';
  constructor(readonly reason: 'gone' | 'moved' | 'no-source') {
    super(reason);
  }
}

/**
 * Moves a sorted bookmark back to where it came from (the inbox). A folder the
 * model created for it is removed again if it is now empty.
 */
export async function undoSort(bookmarks: BookmarksApi, entry: SortLogEntry): Promise<void> {
  const tree = await bookmarks.getTree();
  const hit = findTreeNode(tree, entry.bookmarkId);
  if (!hit) throw new UndoError('gone');
  if (!entry.toId || hit.parentId !== entry.toId) throw new UndoError('moved');
  if (!entry.fromId || !findTreeNode(tree, entry.fromId)) throw new UndoError('no-source');
  await bookmarks.move(entry.bookmarkId, { parentId: entry.fromId });
  if (entry.status === 'created') {
    const children = await bookmarks.getChildren(entry.toId).catch(() => undefined);
    if (children && children.length === 0) await bookmarks.remove(entry.toId).catch(() => undefined);
  }
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
