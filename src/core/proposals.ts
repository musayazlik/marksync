import { isRootKey } from './types';

/**
 * Changes an AI assistant proposed through the Marksync MCP server
 * (`marksync-mcp`, see mcp/). The server never edits the bookmarks: it adds
 * proposals to `Marksync/proposals.json` in Drive, and the extension shows
 * them in the tidy-up review, where the user approves them. IDs are shared
 * record IDs (the same in every browser); a folder can also be a top-level
 * key ("toolbar", "other", ...). Pure logic, shared by both sides.
 */

export type AssistantProposal =
  | { id: string; kind: 'move'; recordId: string; toFolderId: string; reason?: string }
  | { id: string; kind: 'retitle'; recordId: string; title: string; reason?: string }
  | { id: string; kind: 'rename'; folderId: string; name: string; reason?: string }
  | { id: string; kind: 'merge'; folderId: string; intoId: string; reason?: string };

export interface ProposalsFile {
  schema: 1;
  kind: 'marksync-proposals';
  items: (AssistantProposal & { at: number; from?: string })[];
  updatedAt: number;
}

export const PROPOSALS_FILE = 'proposals.json';
/** At most this many proposals wait in the file. */
export const MAX_PROPOSALS = 500;
const MAX_TEXT = 200;
const ID = /^[\w-]{1,128}$/;

const text = (v: unknown, max = MAX_TEXT) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isFolderRef = (v: unknown): v is string => isId(v) || (typeof v === 'string' && isRootKey(v));

/** One proposal checked for shape; undefined when it is unusable. */
export function readProposal(raw: unknown): (AssistantProposal & { at: number; from?: string }) | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = isId(o.id) ? o.id : undefined;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  if (!id) return undefined;
  const reason = text(o.reason);
  const from = text(o.from, 60);
  const extra = { at, ...(reason ? { reason } : {}), ...(from ? { from } : {}) };
  if (o.kind === 'move' && isId(o.recordId) && isFolderRef(o.toFolderId)) return { id, kind: 'move', recordId: o.recordId, toFolderId: o.toFolderId, ...extra };
  if (o.kind === 'retitle' && isId(o.recordId) && text(o.title, 120).length >= 2) return { id, kind: 'retitle', recordId: o.recordId, title: text(o.title, 120), ...extra };
  if (o.kind === 'rename' && isId(o.folderId) && text(o.name, 60).length >= 2) return { id, kind: 'rename', folderId: o.folderId, name: text(o.name, 60), ...extra };
  if (o.kind === 'merge' && isId(o.folderId) && isFolderRef(o.intoId) && o.folderId !== o.intoId) return { id, kind: 'merge', folderId: o.folderId, intoId: o.intoId, ...extra };
  return undefined;
}

export function sanitizeProposalsFile(input: unknown): ProposalsFile['items'] {
  const f = input as Partial<ProposalsFile> | null;
  if (!f || f.kind !== 'marksync-proposals' || f.schema !== 1 || !Array.isArray(f.items)) return [];
  const seen = new Set<string>();
  const out: ProposalsFile['items'] = [];
  for (const raw of f.items.slice(0, MAX_PROPOSALS)) {
    const p = readProposal(raw);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Adds new proposals; a newer proposal for the same item and kind replaces the older one. */
export function addProposals(current: ProposalsFile['items'], added: ProposalsFile['items'], now: number): ProposalsFile {
  const keyOf = (p: AssistantProposal) => `${p.kind}:${'recordId' in p ? p.recordId : p.folderId}`;
  const byKey = new Map(current.map((p) => [keyOf(p), p]));
  for (const p of added) byKey.set(keyOf(p), p);
  const items = [...byKey.values()].sort((a, b) => a.at - b.at).slice(-MAX_PROPOSALS);
  return { schema: 1, kind: 'marksync-proposals', items, updatedAt: now };
}
