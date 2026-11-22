import { MAX_DEPTH } from './records';
import { ROOT_KEYS, type LocalSnapshot, type RootKey } from './types';
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from './validate';

/**
 * A bookmark tree from somewhere else: an HTML export file or another
 * browser's snapshot in Drive. Plain titles and URLs, no ids or clocks.
 */
export type ImportNode =
  | { kind: 'folder'; title: string; children: ImportNode[] }
  | { kind: 'bookmark'; title: string; url: string };

export interface ImportSource {
  roots: Partial<Record<RootKey, ImportNode[]>>;
}

export const ROOT_TITLES: Record<RootKey, string> = {
  toolbar: 'Bookmarks bar',
  menu: 'Bookmarks Menu',
  other: 'Other bookmarks',
  mobile: 'Mobile bookmarks',
};

export function countBookmarks(nodes: ImportNode[] | undefined): number {
  let n = 0;
  for (const node of nodes ?? []) n += node.kind === 'folder' ? countBookmarks(node.children) : 1;
  return n;
}

export function countSource(source: ImportSource): number {
  return ROOT_KEYS.reduce((sum, key) => sum + countBookmarks(source.roots[key]), 0);
}

/** The local tree as an ImportSource, e.g. to share it with other browsers. */
export function snapshotToSource(snap: LocalSnapshot): ImportSource {
  const roots: ImportSource['roots'] = {};
  const lists = new Map<string, ImportNode[]>();
  for (const key of ROOT_KEYS) {
    const id = snap.roots[key];
    if (!id) continue;
    const list: ImportNode[] = [];
    roots[key] = list;
    lists.set(id, list);
  }
  for (const [aliasId, key] of Object.entries(snap.aliases ?? {})) {
    const list = roots[key];
    if (list) lists.set(aliasId, list);
  }
  // Nodes come parents first and in sibling order.
  for (const n of snap.nodes) {
    const list = lists.get(n.parentLocalId);
    if (!list) continue;
    if (n.kind === 'folder') {
      const folder: ImportNode = { kind: 'folder', title: n.title, children: [] };
      list.push(folder);
      lists.set(n.localId, folder.children);
    } else {
      list.push({ kind: 'bookmark', title: n.title, url: n.url ?? '' });
    }
  }
  for (const key of ROOT_KEYS) if (roots[key]?.length === 0) delete roots[key];
  return { roots };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Largest HTML bookmarks file accepted (characters). */
export const MAX_IMPORT_CHARS = 20_000_000;
/** Most bookmarks and folders accepted from one import. */
export const MAX_IMPORT_ITEMS = 200_000;

export class InvalidImportError extends Error {}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Removes tags in linear time; an unterminated '<' ends the scan. */
function stripTags(html: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) return out + html.slice(pos);
    out += html.slice(pos, lt);
    const gt = html.indexOf('>', lt);
    if (gt < 0) return out;
    pos = gt + 1;
  }
}

const text = (html: string) => decodeEntities(stripTags(html)).trim();

/** Lower-cases ASCII letters only, so every index stays the same as in the original. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

const isTagEnd = (c: string | undefined) => c === undefined || c === '>' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/';

/**
 * Reads a Netscape bookmark file, the HTML format every browser exports.
 *
 * - `PERSONAL_TOOLBAR_FOLDER="true"` marks the bookmarks bar (all browsers).
 * - `UNFILED_BOOKMARKS_FOLDER="true"` marks Firefox's Other Bookmarks; in such
 *   files the loose top-level items are Firefox's Bookmarks Menu.
 * - Otherwise loose top-level items go to Other bookmarks (Chrome, Edge, Safari).
 *
 * A small single-pass scanner instead of DOMParser, so it also runs in the
 * background service worker and in tests. It runs in linear time even on
 * malformed input (no backtracking regex), and limits size, item count and
 * nesting depth.
 */
export function parseNetscapeHtml(html: string): ImportSource {
  if (html.length > MAX_IMPORT_CHARS) throw new InvalidImportError('The bookmarks file is too large (over 20 MB).');
  const lower = asciiLower(html);
  const top: ImportNode[] = [];
  const toolbar: ImportNode[] = [];
  const other: ImportNode[] = [];
  let firefoxStyle = false;
  const stack: ImportNode[][] = [];
  let pending: ImportNode[] | null = null;
  let started = false;
  let items = 0;
  // Once a closing tag is not found, none exists further on either.
  const noClose: Record<string, boolean> = {};

  /** Index of the closing tag `</name` after `from`, or -1. */
  const findClose = (name: string, from: number): number => {
    if (noClose[name]) return -1;
    const needle = `</${name}`;
    let i = lower.indexOf(needle, from);
    while (i >= 0 && !isTagEnd(lower[i + needle.length])) i = lower.indexOf(needle, i + needle.length);
    if (i < 0) noClose[name] = true;
    return i;
  };

  const add = (list: ImportNode[], node: ImportNode) => {
    if (++items > MAX_IMPORT_ITEMS) throw new InvalidImportError('The bookmarks file has too many items.');
    list.push(node);
  };

  let pos = 0;
  for (;;) {
    const lt = lower.indexOf('<', pos);
    if (lt < 0) break;
    const gt = lower.indexOf('>', lt);
    if (gt < 0) break;
    let end = lt + 1;
    if (lower[end] === '/') end++;
    while (end < gt && /[a-z0-9]/.test(lower[end]!)) end++;
    const name = lower.slice(lt + 1, end);
    const attrs = html.slice(end, gt);
    pos = gt + 1;

    if (name === 'dl') {
      // Deeper nesting than MAX_DEPTH is flattened into the deepest allowed folder.
      if (stack.length >= MAX_DEPTH) stack.push(stack[stack.length - 1]!);
      else stack.push(started ? (pending ?? []) : top);
      started = true;
      pending = null;
      continue;
    }
    if (name === '/dl') {
      stack.pop();
      pending = null;
      continue;
    }
    const current = stack[stack.length - 1];
    if (name !== 'h3' && name !== 'a') continue;
    const close = findClose(name, pos);
    if (close < 0) continue;
    const body = html.slice(pos, close);
    const closeEnd = lower.indexOf('>', close);
    pos = closeEnd < 0 ? close + name.length + 2 : closeEnd + 1;
    if (!current) continue;

    if (name === 'h3') {
      if (current === top && /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(attrs)) {
        pending = toolbar;
      } else if (current === top && /UNFILED_BOOKMARKS_FOLDER\s*=\s*"true"/i.test(attrs)) {
        firefoxStyle = true;
        pending = other;
      } else {
        const folder: ImportNode = { kind: 'folder', title: text(body).slice(0, MAX_TITLE_LENGTH), children: [] };
        add(current, folder);
        pending = folder.children;
      }
      continue;
    }

    pending = null;
    const href = /\bHREF\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!href) continue;
    const url = decodeEntities(href).trim();
    if (!url || url.startsWith('place:') || url.length > MAX_URL_LENGTH) continue;
    add(current, { kind: 'bookmark', title: (text(body) || url).slice(0, MAX_TITLE_LENGTH), url });
  }

  const roots: ImportSource['roots'] = {};
  if (toolbar.length) roots.toolbar = toolbar;
  if (firefoxStyle) {
    if (top.length) roots.menu = top;
    if (other.length) roots.other = other;
  } else if (top.length || other.length) {
    roots.other = [...other, ...top];
  }
  return { roots };
}

/**
 * Checks a bookmark tree that came from Drive (another browser's snapshot)
 * and returns a clean copy. Throws if it is malformed, too large or too deep.
 * Iterative, so a deeply nested file cannot overflow the stack.
 */
export function validateImportSource(input: unknown): ImportSource {
  const fail = (why: string): never => {
    throw new InvalidImportError(`The browser snapshot is invalid: ${why}.`);
  };
  if (typeof input !== 'object' || input === null) fail('not an object');
  const rawRoots = (input as { roots?: unknown }).roots;
  if (typeof rawRoots !== 'object' || rawRoots === null || Array.isArray(rawRoots)) fail('missing roots');
  const roots: ImportSource['roots'] = {};
  let items = 0;
  const work: { src: unknown[]; dst: ImportNode[]; depth: number }[] = [];
  for (const key of ROOT_KEYS) {
    const list = (rawRoots as Record<string, unknown>)[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(`root ${key} is not a list`);
    const dst: ImportNode[] = [];
    roots[key] = dst;
    work.push({ src: list as unknown[], dst, depth: 1 });
  }
  while (work.length) {
    const { src, dst, depth } = work.pop()!;
    if (depth > MAX_DEPTH) fail('nested too deeply');
    for (const raw of src) {
      if (++items > MAX_IMPORT_ITEMS) fail('too many items');
      if (typeof raw !== 'object' || raw === null) fail('bad item');
      const n = raw as Record<string, unknown>;
      if (typeof n.title !== 'string' || n.title.length > MAX_TITLE_LENGTH) fail('bad title');
      const title = n.title as string;
      if (n.kind === 'folder') {
        if (!Array.isArray(n.children)) fail('folder without children');
        const children: ImportNode[] = [];
        dst.push({ kind: 'folder', title, children });
        work.push({ src: n.children as unknown[], dst: children, depth: depth + 1 });
      } else if (n.kind === 'bookmark') {
        if (typeof n.url !== 'string' || !n.url || n.url.length > MAX_URL_LENGTH) fail('bad url');
        dst.push({ kind: 'bookmark', title, url: n.url as string });
      } else {
        fail('unknown item kind');
      }
    }
  }
  return { roots };
}
