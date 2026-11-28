import { findTreeNode, folderPath, type SortTreeNode } from '../core/ai-sort';
import { PROPOSALS_FILE, sanitizeProposalsFile, type ProposalsFile } from '../core/proposals';
import { isRootKey, type RootKey } from '../core/types';
import type { TidyProposal } from '../core/tidy';
import { DriveError } from '../platform/drive';
import { t } from '../shared/i18n';
import { aiTidyItem, statusItem, syncStateItem, type TidyJob } from '../shared/state';
import { readLocal } from '../sync/local-tree';
import { driveClient, withFolders } from './drive-store';
import { localBookmarks } from './sync-service';

/**
 * Proposals from AI assistants (the Marksync MCP server, mcp/): read from
 * `Marksync/proposals.json`, turned into an ordinary tidy-up review with this
 * browser's bookmark IDs, and removed from Drive once taken over. Nothing is
 * applied without the user's approval in Settings.
 */

/** Proposals referring to bookmarks or folders this browser has, as tidy-up proposals. */
export function toTidyProposals(
  items: ProposalsFile['items'],
  tree: SortTreeNode[],
  local: (recordOrRoot: string) => string | undefined,
): TidyProposal[] {
  const out: TidyProposal[] = [];
  const path = (id: string) => folderPath(tree, id) ?? '';
  for (const p of items) {
    if (p.kind === 'move' || p.kind === 'retitle') {
      const id = local(p.recordId);
      const hit = id ? findTreeNode(tree, id) : undefined;
      if (!id || !hit || !hit.parentId) continue;
      if (p.kind === 'retitle') {
        if (hit.node.url === undefined || hit.node.title === p.title) continue;
        out.push({ id: p.id, kind: 'retitle', bookmarkId: id, title: hit.node.title, newTitle: p.title, ...(hit.node.url ? { url: hit.node.url } : {}), folderPath: path(hit.parentId) });
        continue;
      }
      const into = local(p.toFolderId);
      const target = into ? findTreeNode(tree, into) : undefined;
      if (!into || !target || target.node.url !== undefined || hit.parentId === into) continue;
      out.push({
        id: p.id,
        kind: 'move',
        bookmarkId: id,
        title: hit.node.title,
        ...(hit.node.url ? { url: hit.node.url } : {}),
        fromId: hit.parentId,
        folderPath: path(hit.parentId),
        intoId: into,
        intoPath: path(into),
        ...(p.reason ? { reason: p.reason } : {}),
      });
      continue;
    }
    const id = local(p.folderId);
    const hit = id ? findTreeNode(tree, id) : undefined;
    // Top-level folders are never renamed or merged away.
    if (!id || !hit || hit.node.url !== undefined || !hit.parentId || hit.parentId === tree[0]?.id) continue;
    if (p.kind === 'rename') {
      if (hit.node.title === p.name) continue;
      out.push({ id: p.id, kind: 'rename', folderId: id, title: hit.node.title, folderPath: path(id), name: p.name, ...(p.reason ? { reason: p.reason } : {}) });
    } else {
      const into = local(p.intoId);
      const target = into ? findTreeNode(tree, into) : undefined;
      if (!into || !target || target.node.url !== undefined || into === id || findTreeNode(hit.node.children ?? [], into)) continue;
      out.push({
        id: p.id,
        kind: 'merge',
        folderId: id,
        title: hit.node.title,
        folderPath: path(id),
        intoId: into,
        intoPath: path(into),
        count: hit.node.children?.length ?? 0,
        ...(p.reason ? { reason: p.reason } : {}),
      });
    }
  }
  return out;
}

export interface AssistantCheck {
  /** Proposals now waiting in the tidy-up review. */
  imported: number;
  /** Proposals left in Drive because a tidy-up review is still open. */
  waiting: number;
}

/**
 * Takes over the proposals waiting in Drive, when there are any and no
 * tidy-up review is open. Called when Settings opens.
 */
export async function checkAssistantProposals(): Promise<AssistantCheck> {
  if (!(await statusItem.getValue()).connected) return { imported: 0, waiting: 0 };
  const drive = driveClient();
  const file = await withFolders(drive, (f) => drive.findByName(PROPOSALS_FILE, f.folderId));
  if (!file) return { imported: 0, waiting: 0 };
  let items: ProposalsFile['items'];
  try {
    items = sanitizeProposalsFile(await drive.downloadJson<unknown>(file.id));
  } catch (err) {
    if (err instanceof DriveError && err.status === 404) return { imported: 0, waiting: 0 };
    throw err;
  }
  const job = await aiTidyItem.getValue();
  if (job && job.state !== 'done' && job.proposals.some((p) => !p.appliedAt)) return { imported: 0, waiting: items.length };

  const api = localBookmarks();
  const [state, tree] = await Promise.all([syncStateItem.getValue(), api.getTree()]);
  const { snapshot } = await readLocal(api, state.menuFolderId);
  const byRecord = new Map(Object.entries(state.mapping).map(([localId, recordId]) => [recordId, localId]));
  const local = (ref: string) => (isRootKey(ref) ? snapshot.roots[ref as RootKey] : byRecord.get(ref));
  const proposals = toTidyProposals(items, tree, local);
  if (proposals.length) {
    const from = [...new Set(items.map((p) => p.from).filter(Boolean))].join(', ');
    const next: TidyJob = {
      id: crypto.randomUUID(),
      mode: 'tidy',
      scopeId: '',
      scopePath: t('assistantScope', from || 'MCP'),
      model: from || 'MCP',
      provider: 'openrouter',
      state: 'ready',
      step: 1,
      steps: 1,
      proposals,
      startedAt: Date.now(),
      cost: 0,
    };
    await aiTidyItem.setValue(next);
  }
  // Taken over (or no longer applicable): the file is done.
  await drive.delete(file.id).catch(() => undefined);
  return { imported: proposals.length, waiting: 0 };
}
