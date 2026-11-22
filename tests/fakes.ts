import type { SyncState } from '../src/core/types';
import type { BookmarkNode, BookmarksApi, BrowserFlavor } from '../src/sync/bookmarks-api';
import { ConflictError, type LocalState, type LocalStore, type RemoteStore, type SyncDeps } from '../src/sync/engine';
import { readLocal } from '../src/sync/local-tree';

interface Stored {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  type?: string;
  folderType?: string;
  syncing?: boolean;
  children?: string[];
}

export interface FakeOptions {
  /** Chrome 134+ signed in: an account copy and a local copy of each root. */
  accountStorage?: boolean;
  /** Opera: Unsorted, Trash and Speed Dial roots, found with getRootByName. */
  opera?: boolean;
}

/** In-memory bookmarks with Chromium or Firefox roots and quirks. */
export class FakeBookmarks implements BookmarksApi {
  private nodes = new Map<string, Stored>();
  private seq = 100;
  readonly rootId: string;
  getRootByName?: (name: string) => Promise<BookmarkNode | undefined>;

  constructor(
    readonly flavor: BrowserFlavor,
    readonly options: FakeOptions = {},
  ) {
    if (flavor === 'chromium') {
      this.rootId = '0';
      this.put({ id: '0', title: '', children: [] });
      this.put({ id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] });
      this.put({ id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [] });
      this.put({ id: '3', parentId: '0', title: 'Mobile bookmarks', folderType: 'mobile', syncing: false, children: [] });
      if (options.accountStorage) {
        this.put({ id: '4', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: true, children: [] });
        this.put({ id: '5', parentId: '0', title: 'Other bookmarks', folderType: 'other', syncing: true, children: [] });
        this.put({ id: '6', parentId: '0', title: 'Mobile bookmarks', folderType: 'mobile', syncing: true, children: [] });
      }
      if (options.opera) {
        const extra: Record<string, string> = { unsorted: '7', trash: '8', speed_dial: '9' };
        this.put({ id: '7', parentId: '0', title: 'Unsorted bookmarks', children: [] });
        this.put({ id: '8', parentId: '0', title: 'Trash', children: [] });
        this.put({ id: '9', parentId: '0', title: 'Speed Dial', children: [] });
        this.getRootByName = async (name) => (extra[name] ? this.view(extra[name]!, false) : undefined);
      }
    } else {
      this.rootId = 'root________';
      this.put({ id: 'root________', title: '', type: 'folder', children: [] });
      for (const [id, title] of [
        ['menu________', 'Bookmarks Menu'],
        ['toolbar_____', 'Bookmarks Toolbar'],
        ['unfiled_____', 'Other Bookmarks'],
        ['mobile______', 'Mobile Bookmarks'],
      ] as const) {
        this.put({ id, parentId: 'root________', title, type: 'folder', children: [] });
      }
    }
  }

  /** Local ID of a top-level folder: 'toolbar' | 'other' | 'menu' | 'mobile'. */
  root(key: 'toolbar' | 'other' | 'menu' | 'mobile'): string {
    const chromium = this.options.accountStorage
      ? { toolbar: '4', other: '5', mobile: '6', menu: '' }
      : { toolbar: '1', other: '2', mobile: '3', menu: '' };
    const firefox = { toolbar: 'toolbar_____', other: 'unfiled_____', mobile: 'mobile______', menu: 'menu________' };
    return (this.flavor === 'chromium' ? chromium : firefox)[key];
  }

  private put(n: Stored) {
    this.nodes.set(n.id, n);
    if (n.parentId) this.nodes.get(n.parentId)!.children!.push(n.id);
  }

  private get(id: string): Stored {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`No node ${id}`);
    return n;
  }

  private view(id: string, deep: boolean): BookmarkNode {
    const n = this.get(id);
    const parent = n.parentId ? this.get(n.parentId) : undefined;
    return {
      id: n.id,
      title: n.title,
      ...(n.parentId ? { parentId: n.parentId, index: parent!.children!.indexOf(n.id) } : {}),
      ...(n.url !== undefined ? { url: n.url } : {}),
      ...(n.type ? { type: n.type } : {}),
      ...(n.folderType ? { folderType: n.folderType } : {}),
      ...(n.syncing !== undefined ? { syncing: n.syncing } : {}),
      ...(n.children && deep ? { children: n.children.map((c) => this.view(c, true)) } : {}),
    };
  }

  async getTree() {
    return [this.view(this.rootId, true)];
  }

  async getChildren(id: string) {
    return this.get(id).children!.map((c) => this.view(c, false));
  }

  async create(d: { parentId: string; title: string; url?: string; index?: number }) {
    const parent = this.get(d.parentId);
    if (!parent.children) throw new Error('Parent is not a folder');
    if (this.flavor === 'firefox' && d.url?.startsWith('javascript:')) throw new Error('Invalid URL');
    const id = this.flavor === 'firefox' ? `ff-${this.seq++}` : String(this.seq++);
    const n: Stored = {
      id,
      parentId: d.parentId,
      title: d.title,
      ...(d.url !== undefined ? { url: d.url } : { children: [] }),
      ...(this.flavor === 'firefox' ? { type: d.url !== undefined ? 'bookmark' : 'folder' } : {}),
    };
    this.nodes.set(id, n);
    const at = d.index ?? parent.children.length;
    parent.children.splice(at, 0, id);
    return this.view(id, false);
  }

  /** Firefox-only helper for tests. */
  separator(parentId: string) {
    const id = `sep-${this.seq++}`;
    this.put({ id, parentId, title: '', type: 'separator' });
    return id;
  }

  async update(id: string, c: { title?: string; url?: string }) {
    const n = this.get(id);
    if (c.title !== undefined) n.title = c.title;
    if (c.url !== undefined) n.url = c.url;
    return this.view(id, false);
  }

  async move(id: string, dest: { parentId?: string; index?: number }) {
    const n = this.get(id);
    const newParentId = dest.parentId ?? n.parentId!;
    for (let p: Stored | undefined = this.get(newParentId); p; p = p.parentId ? this.get(p.parentId) : undefined) {
      if (p.id === id) throw new Error("Can't move a folder into itself");
    }
    const oldParent = this.get(n.parentId!);
    const oldIndex = oldParent.children!.indexOf(id);
    oldParent.children!.splice(oldIndex, 1);
    const newParent = this.get(newParentId);
    let index = dest.index ?? newParent.children!.length;
    // Chromium counts the index before the item is taken out.
    if (this.flavor === 'chromium' && newParent === oldParent && dest.index !== undefined && index > oldIndex) index--;
    newParent.children!.splice(index, 0, id);
    n.parentId = newParentId;
    return this.view(id, false);
  }

  async remove(id: string) {
    const n = this.get(id);
    if (n.children?.length) throw new Error('Folder is not empty');
    this.detach(n);
  }

  async removeTree(id: string) {
    const n = this.get(id);
    for (const c of [...(n.children ?? [])]) await this.removeTree(c);
    this.detach(n);
  }

  private detach(n: Stored) {
    if (!n.parentId || this.get(n.parentId).id === this.rootId) throw new Error('Cannot remove a root');
    const parent = this.get(n.parentId);
    parent.children!.splice(parent.children!.indexOf(n.id), 1);
    this.nodes.delete(n.id);
  }

  async add(parentId: string, title: string, url?: string) {
    return (await this.create({ parentId, title, ...(url !== undefined ? { url } : {}) })).id;
  }
}

export class MemoryRemote implements RemoteStore {
  state: SyncState | null = null;
  version = 0;
  saves = 0;

  async load() {
    return this.state ? { state: structuredClone(this.state), version: String(this.version) } : null;
  }

  async save(state: SyncState, expected: string | null) {
    const current = this.state ? String(this.version) : null;
    if (current !== expected) throw new ConflictError();
    this.state = structuredClone(state);
    this.version++;
    this.saves++;
    return String(this.version);
  }
}

export class MemoryLocal implements LocalStore {
  state: LocalState = { mapping: {}, mirror: {}, keep: [] };
  async load() {
    return structuredClone(this.state);
  }
  async save(s: LocalState) {
    this.state = structuredClone(s);
  }
}

export interface FakeBrowser {
  bookmarks: FakeBookmarks;
  local: MemoryLocal;
  deps: SyncDeps;
}

export function makeBrowser(
  flavor: BrowserFlavor,
  remote: MemoryRemote,
  label: string,
  clock: { t: number },
  options: FakeOptions = {},
): FakeBrowser {
  const bookmarks = new FakeBookmarks(flavor, options);
  const local = new MemoryLocal();
  return {
    bookmarks,
    local,
    deps: { bookmarks, remote, local, deviceLabel: label, now: () => (clock.t += 1000) },
  };
}

/** Browser-neutral listing, e.g. "toolbar/Dev/GitHub <https://github.com>". */
export async function dump(b: FakeBrowser): Promise<string[]> {
  const { snapshot } = await readLocal(b.bookmarks, b.local.state.menuFolderId);
  const path = new Map<string, string>();
  for (const [key, id] of Object.entries(snapshot.roots)) path.set(id!, key);
  for (const [id, key] of Object.entries(snapshot.aliases ?? {})) path.set(id, key);
  const lines: string[] = [];
  for (const n of snapshot.nodes) {
    const p = `${path.get(n.parentLocalId)}/${n.title}`;
    path.set(n.localId, p);
    lines.push(n.kind === 'folder' ? `${p}/` : `${p} <${n.url}>`);
  }
  return lines;
}
