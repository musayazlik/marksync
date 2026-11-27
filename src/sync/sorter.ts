import {
  buildSortPrompt,
  findTreeNode,
  folderPath,
  InvalidReplyError,
  listFolderOptions,
  parseSortReply,
  sortReplySchema,
  type ChatMessage,
} from '../core/ai-sort';
import type { AiProvider } from '../core/ai-provider';
import type { SortLogEntry } from '../shared/state';
import type { BookmarksApi } from './bookmarks-api';
import { isSyncable } from './local-tree';

/**
 * Files one bookmark from the inbox folder, through an interface so tests can
 * use the in-memory bookmarks and a scripted model.
 */
export interface SorterDeps {
  bookmarks: BookmarksApi;
  /**
   * Sends the prompt to the model and returns its reply (text, or text with
   * sources and cost). `schema` describes the expected JSON, for providers
   * that can constrain their output.
   */
  complete(messages: ChatMessage[], opts: { research: boolean; schema: Record<string, unknown> }): Promise<string | ModelReply>;
  /** Folders never offered (Opera's Trash and Speed Dial). */
  exclude?: string[];
  /** UI language, for the model's short reason. */
  language: string;
}

export interface ModelReply {
  text: string;
  sources?: { url: string; title?: string }[];
  cost?: number;
}

export interface SortRun {
  inboxId: string;
  allowNewFolders: boolean;
  model: string;
  /** Recorded in the log entry. */
  provider?: AiProvider;
  /** At most this many folders are offered (small on-device models). */
  maxFolders?: number;
  /** Let the model read the page and search the web. */
  research?: boolean;
  /** Set when the monthly budget is used up: the model is not asked and the bookmark stays. */
  blocked?: { code: 'budget'; message: string };
  /** Only ask the model and return its proposal; nothing is moved (bulk sorting preview). */
  plan?: boolean;
  /** More folders the model is not offered (besides `inboxId`), e.g. the inbox during bulk sorting. */
  skip?: string[];
}

/** A log entry without its id and time. */
export type SortOutcome = Omit<SortLogEntry, 'id' | 'at'>;

/** A proposal from a planning run: a folder to create is described, not created. */
export type PlannedOutcome = SortOutcome & { newFolder?: { parentId: string; name: string } };

/** Error codes shown on the log page, next to OpenRouter's own. */
export type SortErrorCode = 'reply' | 'budget' | 'unknown';

/**
 * Asks the model where the bookmark belongs and moves it there.
 *
 * Returns null when there is nothing to do: the bookmark is gone, is not a
 * bookmark, or is no longer in the inbox (the user moved it while waiting).
 * Model and network errors are returned as an 'error' outcome, never thrown,
 * so the bookmark simply stays in the inbox.
 */
export async function sortOne(deps: SorterDeps, run: SortRun, bookmarkId: string): Promise<PlannedOutcome | null> {
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
    ...(run.provider ? { provider: run.provider } : {}),
    ...(run.research ? { researched: true } : {}),
  };

  if (run.blocked) {
    const { researched: _, ...rest } = base;
    return { ...rest, status: 'error', error: run.blocked.message, errorCode: run.blocked.code };
  }

  const folders = listFolderOptions(tree, {
    exclude: deps.exclude,
    skip: [run.inboxId, ...(run.skip ?? [])],
    ...(run.maxFolders ? { max: run.maxFolders } : {}),
  });
  let reply: string;
  try {
    const answer = await deps.complete(
      buildSortPrompt({
        title: node.title,
        url: node.url,
        folders,
        allowNewFolders: run.allowNewFolders,
        language: deps.language,
        research: !!run.research,
      }),
      { research: !!run.research, schema: sortReplySchema(folders, run.allowNewFolders) },
    );
    if (typeof answer === 'string') reply = answer;
    else {
      reply = answer.text;
      if (answer.sources?.length) base.sources = answer.sources.slice(0, 8);
      if (answer.cost !== undefined) base.cost = answer.cost;
    }
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
  const meta = {
    reason: decision.reason || undefined,
    confidence: decision.confidence,
    ...(decision.site ? { site: decision.site } : {}),
  };
  if (decision.action === 'keep') return { ...base, ...meta, status: 'kept' };

  if (run.plan) {
    if (decision.action === 'move') {
      return { ...base, ...meta, status: 'moved', toId: decision.folder.localId, toPath: decision.folder.path };
    }
    return {
      ...base,
      ...meta,
      status: 'created',
      toId: decision.parent.localId,
      toPath: `${decision.parent.path} / ${decision.name}`,
      newFolder: { parentId: decision.parent.localId, name: decision.name },
    };
  }

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

/**
 * Carries out a proposal from a planning run, after the user approved it.
 * The bookmark must still be in `sourceId` and the target must still exist;
 * otherwise nothing is touched. Folders created earlier in the same batch
 * (same parent and name) are reused through `created`.
 */
export async function applyPlanned(
  bookmarks: BookmarksApi,
  p: PlannedOutcome,
  sourceId: string,
  created: Map<string, string>,
): Promise<SortOutcome> {
  const { newFolder, ...outcome } = p;
  const tree = await bookmarks.getTree();
  const hit = findTreeNode(tree, p.bookmarkId);
  if (!hit) return { ...outcome, status: 'error', error: 'The bookmark was deleted.', errorCode: 'gone' };
  if (hit.parentId !== sourceId) return { ...outcome, status: 'error', error: 'The bookmark was moved meanwhile.', errorCode: 'moved' };
  try {
    if (!newFolder) {
      if (!p.toId || !findTreeNode(tree, p.toId)) {
        return { ...outcome, status: 'error', error: 'The chosen folder was deleted.', errorCode: 'unknown' };
      }
      await bookmarks.move(p.bookmarkId, { parentId: p.toId });
      return { ...outcome, status: 'moved' };
    }
    const parent = findTreeNode(tree, newFolder.parentId);
    if (!parent) return { ...outcome, status: 'error', error: 'The chosen folder was deleted.', errorCode: 'unknown' };
    const key = `${newFolder.parentId}\n${newFolder.name.toLocaleLowerCase()}`;
    let folderId = created.get(key);
    let status: 'moved' | 'created' = 'moved';
    if (!folderId || !findTreeNode(tree, folderId)) {
      // A folder of that name may exist by now (made by hand or by an earlier proposal).
      const same = (parent.node.children ?? []).find(
        (c) => c.url === undefined && c.title.toLocaleLowerCase() === newFolder.name.toLocaleLowerCase(),
      );
      folderId = same?.id ?? (await bookmarks.create({ parentId: newFolder.parentId, title: newFolder.name })).id;
      if (!same) status = 'created';
      created.set(key, folderId);
    }
    await bookmarks.move(p.bookmarkId, { parentId: folderId });
    return { ...outcome, status, toId: folderId };
  } catch (err) {
    return { ...outcome, status: 'error', error: messageOf(err), errorCode: 'unknown' };
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
