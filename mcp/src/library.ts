import { childrenByParent, isLive, liveRecords } from '../../src/core/records';
import { addProposals, readProposal, type AssistantProposal, type ProposalsFile } from '../../src/core/proposals';
import { flattenBookmarks, isOpenable, searchBookmarks, type SearchNode } from '../../src/core/search';
import { isRootKey, ROOT_KEYS, type RecordMap, type RootKey, type SyncRecord } from '../../src/core/types';
import type { TagMap } from '../../src/core/tags';

/**
 * The bookmark library as the MCP tools see it: the records of
 * sync-state.json and the tags of tags.json, both from the user's Drive.
 * Read-only; changes are only ever proposals. Pure logic, unit tested.
 */

export const ROOT_NAMES: Record<RootKey, string> = {
  toolbar: 'Bookmarks bar',
  menu: 'Bookmarks menu',
  other: 'Other bookmarks',
  mobile: 'Mobile bookmarks',
};

export interface BookmarkView {
  id: string;
  title: string;
  url: string;
  folder: string;
  folderId: string;
  tags?: string[];
}

export interface FolderView {
  id: string;
  path: string;
  bookmarks: number;
  folders: number;
}

export class Library {
  private readonly byParent: Map<string, SyncRecord[]>;
  private readonly live: Map<string, SyncRecord>;

  constructor(
    readonly records: RecordMap,
    readonly tags: TagMap = {},
  ) {
    this.byParent = childrenByParent(records);
    this.live = new Map(liveRecords(records).map((r) => [r.id, r]));
  }

  /** "Bookmarks bar / Work / Docs" for a folder ID or a top-level key. */
  path(folderId: string): string {
    const parts: string[] = [];
    let id = folderId;
    for (let guard = 0; guard < 300; guard++) {
      if (isRootKey(id)) return [ROOT_NAMES[id], ...parts].join(' / ');
      const r = this.live.get(id);
      if (!r) return parts.join(' / ');
      parts.unshift(r.title || '(untitled)');
      id = r.parentId;
    }
    return parts.join(' / ');
  }

  isFolder(ref: string): boolean {
    return isRootKey(ref) || this.live.get(ref)?.kind === 'folder';
  }

  private tagsOf(id: string): string[] | undefined {
    const tags = this.tags[id]?.tags;
    return tags?.length ? tags : undefined;
  }

  bookmark(r: SyncRecord): BookmarkView {
    const tags = this.tagsOf(r.id);
    return { id: r.id, title: r.title, url: r.url ?? '', folder: this.path(r.parentId), folderId: r.parentId, ...(tags ? { tags } : {}) };
  }

  /** The tree in the shape core/search.ts walks, roots first. */
  private searchTree(): SearchNode[] {
    const node = (r: SyncRecord): SearchNode =>
      r.kind === 'folder'
        ? { id: r.id, title: r.title, children: (this.byParent.get(r.id) ?? []).map(node) }
        : { id: r.id, title: r.title, ...(r.url !== undefined ? { url: r.url } : {}) };
    return [{ id: '', title: '', children: ROOT_KEYS.map((k) => ({ id: k, title: ROOT_NAMES[k], children: (this.byParent.get(k) ?? []).map(node) })) }];
  }

  /** Words in the title, address, folder or tags; "#tag" filters by tag. */
  search(query: string, limit = 20): { total: number; results: BookmarkView[] } {
    const items = flattenBookmarks(this.searchTree(), undefined, undefined, (id) => this.tagsOf(id));
    const { hits, total } = searchBookmarks(items, query, Math.min(100, Math.max(1, limit)));
    return { total, results: hits.map((h) => this.bookmark(this.live.get(h.item.id)!)) };
  }

  folders(max = 2000): FolderView[] {
    const out: FolderView[] = [];
    const visit = (id: string) => {
      for (const c of this.byParent.get(id) ?? []) {
        if (c.kind !== 'folder' || out.length >= max) continue;
        const kids = this.byParent.get(c.id) ?? [];
        out.push({ id: c.id, path: this.path(c.id), bookmarks: kids.filter((k) => k.kind === 'bookmark').length, folders: kids.filter((k) => k.kind === 'folder').length });
        visit(c.id);
      }
    };
    for (const k of ROOT_KEYS) {
      const kids = this.byParent.get(k) ?? [];
      if (!kids.length) continue;
      out.push({ id: k, path: ROOT_NAMES[k], bookmarks: kids.filter((x) => x.kind === 'bookmark').length, folders: kids.filter((x) => x.kind === 'folder').length });
      visit(k);
    }
    return out;
  }

  /** A folder by ID, top-level key or exact path (case-insensitive). */
  resolveFolder(ref: string): string | undefined {
    const r = ref.trim();
    if (this.isFolder(r)) return r;
    const lower = r.toLocaleLowerCase();
    return this.folders().find((f) => f.path.toLocaleLowerCase() === lower)?.id;
  }

  listFolder(ref: string): { id: string; path: string; folders: FolderView[]; bookmarks: BookmarkView[] } | undefined {
    const id = this.resolveFolder(ref);
    if (!id) return undefined;
    const kids = this.byParent.get(id) ?? [];
    return {
      id,
      path: this.path(id),
      folders: kids
        .filter((k) => k.kind === 'folder')
        .map((k) => {
          const inner = this.byParent.get(k.id) ?? [];
          return { id: k.id, path: this.path(k.id), bookmarks: inner.filter((x) => x.kind === 'bookmark').length, folders: inner.filter((x) => x.kind === 'folder').length };
        }),
      bookmarks: kids.filter((k) => k.kind === 'bookmark' && isOpenable(k.url ?? '')).map((k) => this.bookmark(k)),
    };
  }

  get(id: string): BookmarkView | FolderView | undefined {
    const r = this.live.get(id);
    if (!r) return undefined;
    if (r.kind === 'bookmark') return this.bookmark(r);
    return this.listFolder(id) && { id, path: this.path(id), bookmarks: (this.byParent.get(id) ?? []).filter((x) => x.kind === 'bookmark').length, folders: (this.byParent.get(id) ?? []).filter((x) => x.kind === 'folder').length };
  }

  /**
   * Checks proposals against the library: every ID must exist and be of the
   * right kind, a folder never goes into its own subtree, top-level folders
   * are never renamed or merged. Returns the good ones and why the others
   * were refused.
   */
  checkProposals(raw: unknown[], from: string, now: number): { ok: ProposalsFile['items']; refused: string[] } {
    const ok: ProposalsFile['items'] = [];
    const refused: string[] = [];
    const within = (folderId: string, ancestor: string) => {
      for (let id = folderId, guard = 0; !isRootKey(id) && guard < 300; guard++) {
        if (id === ancestor) return true;
        const r = this.live.get(id);
        if (!r) return false;
        id = r.parentId;
      }
      return false;
    };
    raw.forEach((item, i) => {
      const p = readProposal({ ...(item as object), id: crypto.randomUUID(), at: now, from });
      const why = (msg: string) => refused.push(`#${i + 1}: ${msg}`);
      if (!p) return why('not a valid change (see the tool description for the fields).');
      const check = (q: AssistantProposal): string | undefined => {
        if (q.kind === 'move') {
          const r = this.live.get(q.recordId);
          if (!r) return `no bookmark or folder with id ${q.recordId}.`;
          if (!this.isFolder(q.toFolderId)) return `no folder with id ${q.toFolderId}.`;
          if (r.parentId === q.toFolderId) return 'it is already in that folder.';
          if (r.kind === 'folder' && (q.toFolderId === r.id || within(q.toFolderId, r.id))) return 'a folder cannot go into itself or its subfolders.';
          return undefined;
        }
        if (q.kind === 'retitle') {
          const r = this.live.get(q.recordId);
          if (!r || r.kind !== 'bookmark') return `no bookmark with id ${q.recordId}.`;
          if (r.title === q.title) return 'the title is the same.';
          return undefined;
        }
        const f = this.live.get(q.folderId);
        if (!f || f.kind !== 'folder') return `no folder with id ${q.folderId} (top-level folders cannot be changed).`;
        if (q.kind === 'rename') return f.title === q.name ? 'the name is the same.' : undefined;
        if (!this.isFolder(q.intoId)) return `no folder with id ${q.intoId}.`;
        if (within(q.intoId, q.folderId)) return 'a folder cannot be merged into its own subfolder.';
        return undefined;
      };
      const problem = check(p);
      if (problem) why(problem);
      else ok.push(p);
    });
    return { ok, refused };
  }

  /** Counts for the server's instructions. */
  stats(): { bookmarks: number; folders: number } {
    let bookmarks = 0;
    let folders = 0;
    for (const r of this.live.values()) {
      if (!isLive(r)) continue;
      if (r.kind === 'bookmark') bookmarks++;
      else folders++;
    }
    return { bookmarks, folders };
  }
}

export { addProposals };
