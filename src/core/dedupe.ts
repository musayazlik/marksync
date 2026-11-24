/**
 * Duplicate bookmarks: pure helpers, no browser APIs.
 *
 * Two bookmarks are duplicates when their addresses point to the same page
 * once the differences that never change the page are removed (see
 * `normalizeUrl`). The finder only proposes; nothing is deleted here.
 */

/** The part of a bookmark tree node the finder reads (matches BookmarkNode). */
export interface DedupeTreeNode {
  id: string;
  title: string;
  url?: string;
  /** Firefox: 'bookmark' | 'folder' | 'separator'. */
  type?: string;
  /** Milliseconds since the epoch. */
  dateAdded?: number;
  /** Chromium managed (policy) bookmarks cannot be removed. */
  unmodifiable?: string;
  children?: DedupeTreeNode[];
}

export interface DuplicateItem {
  id: string;
  title: string;
  url: string;
  /** "Bookmarks bar / Work" — the folder the bookmark is in. */
  folderPath: string;
  dateAdded?: number;
}

export interface DuplicateGroup {
  /** The normalized address shared by every item. */
  key: string;
  /** Suggested copy to keep first, then the others. */
  items: DuplicateItem[];
}

/**
 * Query parameters that only say where a click came from. They are dropped
 * before comparing, so "page?utm_source=x" and "page" are the same bookmark.
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'ref_src',
]);
const isTracking = (name: string) => name.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(name.toLowerCase());

const PATH_SEPARATOR = ' / ';

/**
 * The comparable form of a web address, or undefined for anything that is not
 * an http(s) page (javascript:, place:, data:, file:, …), which is never
 * reported as a duplicate.
 *
 * - http and https count as the same page, and so do default ports;
 * - the host is compared without case;
 * - a trailing slash is ignored (but "/" alone stays);
 * - tracking parameters are dropped and the rest sorted;
 * - the fragment is dropped, except app routes like "#/inbox" or "#!/page".
 */
export function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
  const params = [...u.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const hash = /^#!?\//.test(u.hash) ? u.hash : '';
  return `${host}${port}${path}${query}${hash}`;
}

function isFolder(node: DedupeTreeNode): boolean {
  if (node.type) return node.type === 'folder';
  return node.url === undefined;
}

/**
 * Groups the bookmarks that point to the same page. Folders listed in
 * `exclude` (Opera's Trash and Speed Dial) are skipped with everything in
 * them, and so are managed bookmarks, which cannot be removed.
 *
 * In each group the suggested copy to keep comes first: the oldest one, and
 * among equally old ones the one in the deepest folder (it was filed with
 * more care), then the first in tree order.
 */
export function findDuplicates(tree: DedupeTreeNode[], opts: { exclude?: Iterable<string> } = {}): DuplicateGroup[] {
  const exclude = new Set(opts.exclude ?? []);
  const groups = new Map<string, (DuplicateItem & { depth: number; order: number })[]>();
  let order = 0;

  const walk = (node: DedupeTreeNode, path: string[]) => {
    for (const child of node.children ?? []) {
      if (exclude.has(child.id) || child.unmodifiable || child.type === 'separator') continue;
      if (isFolder(child)) {
        walk(child, [...path, child.title.trim() || '(untitled)']);
        continue;
      }
      const key = normalizeUrl(child.url);
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push({
        id: child.id,
        title: child.title,
        url: child.url!,
        folderPath: path.join(PATH_SEPARATOR),
        dateAdded: child.dateAdded,
        depth: path.length,
        order: order++,
      });
      groups.set(key, list);
    }
  };
  for (const root of tree) walk(root, []);

  const out: DuplicateGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        (a.dateAdded ?? Infinity) - (b.dateAdded ?? Infinity) || b.depth - a.depth || a.order - b.order,
    );
    out.push({ key, items: list.map(({ depth: _d, order: _o, ...item }) => item) });
  }
  // Biggest groups first, then alphabetically for a stable list.
  return out.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** How many bookmarks would go if one copy of every group were kept. */
export function extraCopies(groups: DuplicateGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length - 1, 0);
}
