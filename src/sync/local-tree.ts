import { childrenByParent, liveRecords } from '../core/records';
import {
  isRootKey,
  ROOT_KEYS,
  type IdMapping,
  type LocalNode,
  type LocalSnapshot,
  type RecordMap,
  type RootKey,
  type SyncRecord,
} from '../core/types';
import type { BookmarkNode, BookmarksApi, BrowserFlavor } from './bookmarks-api';

/** Chromium has no Bookmarks Menu, so Firefox menu items live in this folder under "Other". */
export const MENU_FOLDER_TITLE = 'Bookmarks Menu';

const FIREFOX_ROOTS: Record<string, RootKey> = {
  toolbar_____: 'toolbar',
  menu________: 'menu',
  unfiled_____: 'other',
  mobile______: 'mobile',
};
const CHROMIUM_FOLDER_TYPES: Record<string, RootKey> = {
  'bookmarks-bar': 'toolbar',
  other: 'other',
  mobile: 'mobile',
};
/** Before Chrome 134 there was no folderType; these IDs were fixed. */
const CHROMIUM_LEGACY_IDS: Record<string, RootKey> = { '1': 'toolbar', '2': 'other', '3': 'mobile' };

/**
 * Browser-specific top-level folders that are not found by type or ID.
 * Found once per sync with `detectSpecialRoots`.
 */
export interface SpecialRoots {
  /** Extra folders whose contents belong to a root, e.g. Opera's Unsorted → other. */
  aliases: Record<string, RootKey>;
  /** Folders that are never synced, e.g. Opera's Trash and Speed Dial. */
  exclude: string[];
}

export const NO_SPECIAL_ROOTS: SpecialRoots = { aliases: {}, exclude: [] };

export async function detectSpecialRoots(api: BookmarksApi): Promise<SpecialRoots> {
  if (!api.getRootByName) return NO_SPECIAL_ROOTS;
  const id = async (name: string) => {
    try {
      return (await api.getRootByName!(name))?.id;
    } catch {
      return undefined;
    }
  };
  const [unsorted, trash, speedDial] = await Promise.all([id('unsorted'), id('trash'), id('speed_dial')]);
  return {
    aliases: unsorted ? { [unsorted]: 'other' } : {},
    exclude: [trash, speedDial].filter((x): x is string => !!x),
  };
}

export function detectFlavor(tree: BookmarkNode[]): BrowserFlavor {
  return tree[0]?.id === 'root________' ? 'firefox' : 'chromium';
}

function rootKeyOf(node: BookmarkNode, flavor: BrowserFlavor): RootKey | undefined {
  if (flavor === 'firefox') return FIREFOX_ROOTS[node.id];
  if (node.folderType) return CHROMIUM_FOLDER_TYPES[node.folderType];
  return CHROMIUM_LEGACY_IDS[node.id];
}

function isFolder(node: BookmarkNode): boolean {
  return node.type ? node.type === 'folder' : node.url === undefined;
}

/**
 * Items that are not synced: Firefox separators, Firefox smart folders
 * (`place:` queries) and Chromium managed bookmarks set by policy.
 */
export function isSyncable(node: BookmarkNode): boolean {
  if (node.type === 'separator') return false;
  if (node.url?.startsWith('place:')) return false;
  if (node.unmodifiable) return false;
  return true;
}

function findNode(node: BookmarkNode, id: string): BookmarkNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Turns the local tree into a browser-neutral snapshot.
 *
 * A root can have more than one local folder:
 * - Chrome 134+ signed in to a Google account can show an account copy and an
 *   "only on this device" copy of the bookmarks bar. The account copy
 *   (`syncing: true`) is primary: Chrome saves new bookmarks there.
 * - Opera's "Unsorted bookmarks" belongs to "other".
 * The primary folder is `roots[key]`; the others are listed in `aliases`.
 * Their items count as one list: primary first, then the others.
 */
export function readSnapshot(
  tree: BookmarkNode[],
  opts: { menuFolderId?: string; special?: SpecialRoots } = {},
): { snapshot: LocalSnapshot; flavor: BrowserFlavor } {
  const flavor = detectFlavor(tree);
  const special = opts.special ?? NO_SPECIAL_ROOTS;
  const exclude = new Set(special.exclude);
  const root = tree[0];
  const roots: LocalSnapshot['roots'] = {};
  const aliases: Record<string, RootKey> = {};
  const nodes: LocalNode[] = [];
  if (!root) return { snapshot: { roots, nodes, aliases }, flavor };

  const folders: Partial<Record<RootKey, BookmarkNode[]>> = {};
  const addRoot = (key: RootKey, node: BookmarkNode) => {
    const list = (folders[key] ??= []);
    if (node.syncing && list[0] && !list[0].syncing) list.unshift(node);
    else list.push(node);
  };
  const top = (root.children ?? []).filter((n) => !exclude.has(n.id));
  // Real roots first, so a browser-specific extra folder never becomes primary.
  for (const node of top) {
    const key = rootKeyOf(node, flavor);
    if (key) addRoot(key, node);
  }
  for (const node of top) {
    const key = special.aliases[node.id];
    if (key && !rootKeyOf(node, flavor)) addRoot(key, node);
  }
  if (flavor === 'chromium' && opts.menuFolderId) {
    const menu = findNode(root, opts.menuFolderId);
    if (menu && isFolder(menu) && !exclude.has(menu.id)) folders.menu = [menu];
  }
  for (const key of ROOT_KEYS) {
    const list = folders[key];
    if (!list?.length) continue;
    roots[key] = list[0]!.id;
    for (const extra of list.slice(1)) aliases[extra.id] = key;
  }

  const walk = (folder: BookmarkNode, start: number): number => {
    let index = start;
    for (const child of folder.children ?? []) {
      if (!isSyncable(child) || child.id === roots.menu || exclude.has(child.id)) continue;
      const kind = isFolder(child) ? 'folder' : 'bookmark';
      nodes.push({
        localId: child.id,
        parentLocalId: folder.id,
        kind,
        title: child.title,
        ...(kind === 'bookmark' && child.url !== undefined ? { url: child.url } : {}),
        index: index++,
      });
      if (kind === 'folder') walk(child, 0);
    }
    return index;
  };
  for (const key of ROOT_KEYS) {
    let index = 0;
    for (const folder of folders[key] ?? []) index = walk(folder, index);
  }
  return { snapshot: { roots, nodes, aliases }, flavor };
}

/** Reads the local tree, including browser-specific folders. */
export async function readLocal(api: BookmarksApi, menuFolderId?: string, exclude: readonly string[] = []) {
  const found = await detectSpecialRoots(api);
  // Folders synced elsewhere (shared folders) are left out like Opera's Trash.
  const special = exclude.length ? { ...found, exclude: [...found.exclude, ...exclude] } : found;
  const result = readSnapshot(await api.getTree(), { ...(menuFolderId ? { menuFolderId } : {}), special });
  return { ...result, special };
}

export interface ApplyResult {
  mapping: IdMapping;
  /** Record ids that could not be created or updated in this browser. */
  skipped: Set<string>;
  menuFolderId?: string;
  changes: number;
}

/**
 * Makes the local bookmark tree match `merged`:
 * 1. create, update and move items, parents first,
 * 2. remove local items that are deleted in `merged`,
 * 3. fix the order inside each folder.
 * Every step is idempotent, so a failed run is repaired by the next one.
 *
 * Items in a root's extra folder (see readSnapshot) stay where they are:
 * Marksync never moves "only on this device" bookmarks into the Google
 * account copy, or the other way round.
 */
export async function applyRecords(
  api: BookmarksApi,
  merged: RecordMap,
  mapping: IdMapping,
  opts: {
    menuFolderId?: string;
    special?: SpecialRoots;
    /**
     * Saves the mapping of the items created so far: called every few
     * creations and when applying fails. Without it, an interrupted run
     * would forget which local bookmarks it created, and the next sync would
     * create them a second time.
     */
    saveMapping?: (mapping: IdMapping) => Promise<void>;
  } = {},
): Promise<ApplyResult> {
  const special = opts.special ?? (await detectSpecialRoots(api));
  const exclude = new Set(special.exclude);
  const { snapshot, flavor } = readSnapshot(await api.getTree(), { ...opts, special });
  const aliases = snapshot.aliases ?? {};
  const nodeById = new Map(snapshot.nodes.map((n) => [n.localId, n]));
  const syncToLocal = new Map<string, string>();
  for (const [localId, syncId] of Object.entries(mapping)) {
    if (nodeById.has(localId)) syncToLocal.set(syncId, localId);
  }

  const groups = childrenByParent(merged);
  const rootLocal = { ...snapshot.roots };
  let changes = 0;
  let menuFolderId = flavor === 'chromium' ? rootLocal.menu : undefined;
  if (flavor === 'chromium' && !rootLocal.menu && groups.get('menu')?.length && rootLocal.other) {
    const folder = await api.create({ parentId: rootLocal.other, title: MENU_FOLDER_TITLE });
    rootLocal.menu = menuFolderId = folder.id;
    changes++;
  }

  const skipped = new Set<string>();
  const nextMapping: IdMapping = {};
  let unsaved = 0;
  const progress = () => ({ ...mapping, ...nextMapping });
  const createdOne = async () => {
    if (opts.saveMapping && ++unsaved >= 50) {
      unsaved = 0;
      await opts.saveMapping(progress());
    }
  };
  const markSkipped = (id: string) => {
    skipped.add(id);
    for (const child of groups.get(id) ?? []) markSkipped(child.id);
  };

  const place = async (parentKey: string, localParent: string): Promise<void> => {
    for (const rec of groups.get(parentKey) ?? []) {
      let localId = syncToLocal.get(rec.id);
      try {
        const cur = localId ? nodeById.get(localId) : undefined;
        if (localId && cur) {
          nextMapping[localId] = rec.id;
          const urlChanged = rec.kind === 'bookmark' && cur.url !== rec.url;
          if (cur.title !== rec.title || urlChanged) {
            await api.update(localId, urlChanged ? { title: rec.title, url: rec.url } : { title: rec.title });
            changes++;
          }
          const sameParent =
            cur.parentLocalId === localParent || (isRootKey(parentKey) && aliases[cur.parentLocalId] === parentKey);
          if (!sameParent) {
            await api.move(localId, { parentId: localParent });
            changes++;
          }
        } else {
          const made = await api.create({
            parentId: localParent,
            title: rec.title,
            ...(rec.kind === 'bookmark' ? { url: rec.url } : {}),
          });
          localId = made.id;
          syncToLocal.set(rec.id, localId);
          nextMapping[localId] = rec.id;
          changes++;
          await createdOne();
        }
      } catch (err) {
        console.warn('[marksync] could not apply', rec, err);
        markSkipped(rec.id);
        continue;
      }
      if (rec.kind === 'folder') await place(rec.id, localId);
    }
  };

  try {
    for (const key of ROOT_KEYS) {
      const localRoot = rootLocal[key];
      if (localRoot) await place(key, localRoot);
      else for (const rec of groups.get(key) ?? []) markSkipped(rec.id);
    }

    const live = new Set(liveRecords(merged).map((r) => r.id));
    for (const n of snapshot.nodes) {
      const syncId = mapping[n.localId];
      if (!syncId || live.has(syncId)) continue;
      try {
        await (n.kind === 'folder' ? api.removeTree(n.localId) : api.remove(n.localId));
        changes++;
      } catch {
        // Already gone with a removed parent folder.
      }
    }

    // Order pass, on a fresh copy of the tree.
    const childIds = new Map<string, string[]>();
    const syncedIds = new Map<string, string[]>();
    const collect = (node: BookmarkNode) => {
      if (!node.children) return;
      childIds.set(node.id, node.children.map((c) => c.id));
      syncedIds.set(
        node.id,
        node.children.filter((c) => isSyncable(c) && c.id !== menuFolderId && !exclude.has(c.id)).map((c) => c.id),
      );
      node.children.forEach(collect);
    };
    (await api.getTree()).forEach(collect);

    /** Puts the records that are in `localParent` in the order of `records`. */
    const orderIn = async (records: SyncRecord[], localParent: string) => {
      const all = childIds.get(localParent) ?? [];
      const synced = syncedIds.get(localParent) ?? [];
      const present = new Set(synced);
      const target = records
        .filter((r) => !skipped.has(r.id))
        .map((r) => syncToLocal.get(r.id))
        .filter((id): id is string => !!id && present.has(id));
      for (let i = 0; i < target.length; i++) {
        const want = target[i]!;
        const before = synced[i];
        if (before === want || before === undefined) continue;
        try {
          await api.move(want, { parentId: localParent, index: all.indexOf(before) });
        } catch (err) {
          // A wrong order is fixed by the next sync; it must not stop this one.
          console.warn('[marksync] could not reorder', want, err);
          continue;
        }
        changes++;
        all.splice(all.indexOf(want), 1);
        all.splice(all.indexOf(before), 0, want);
        synced.splice(synced.indexOf(want), 1);
        synced.splice(i, 0, want);
      }
    };

    const reorderTree = async (parentKey: string, localFolders: string[]): Promise<void> => {
      const records = groups.get(parentKey) ?? [];
      for (const folder of localFolders) await orderIn(records, folder);
      for (const rec of records) {
        const localId = syncToLocal.get(rec.id);
        if (rec.kind === 'folder' && localId && !skipped.has(rec.id)) await reorderTree(rec.id, [localId]);
      }
    };
    for (const key of ROOT_KEYS) {
      const localRoot = rootLocal[key];
      if (!localRoot) continue;
      const extra = Object.keys(aliases).filter((id) => aliases[id] === key);
      await reorderTree(key, [localRoot, ...extra]);
    }
  } catch (err) {
    // Keep what was created, so the next sync does not create it again.
    await opts.saveMapping?.(progress()).catch(() => undefined);
    throw err;
  }

  return { mapping: nextMapping, skipped, menuFolderId, changes };
}
