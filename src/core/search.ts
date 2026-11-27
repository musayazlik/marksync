/**
 * Bookmark search for the popup: every word must appear in the title, the
 * address, the folder path, the tags or what AI sorting found out about the
 * site. A word starting with "#" must be (the start of) one of the tags.
 * Matching ignores case and accents ("istanbul" finds "İstanbul", "cafe"
 * finds "Café"). Pure functions, unit tested.
 */

export interface SearchNode {
  id: string;
  title: string;
  url?: string;
  type?: string;
  children?: SearchNode[];
}

export interface SearchItem {
  id: string;
  title: string;
  url: string;
  /** "github.com", without "www.". */
  host: string;
  /** Folder path, e.g. "Bookmarks bar / Work". */
  path: string;
  /** Site name, category and summary from AI sorting, if any. */
  about?: string;
  /** Marksync tags (see core/tags.ts). */
  tags?: string[];
}

export interface SearchHit {
  item: SearchItem;
  score: number;
}

/** Lower case without accents; "ı" counts as "i" so Turkish text matches either way. */
export function fold(text: string): string {
  return foldWithMap(text).folded;
}

/** Folded text plus, for each folded character, the index of the original character it came from. */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch
      .toLocaleLowerCase('tr')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/ı/g, 'i');
    for (const c of f) {
      folded += c;
      map.push(i);
    }
    i += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Addresses a click can open in a tab (not "javascript:" bookmarklets or browser-internal pages). */
export function isOpenable(url: string): boolean {
  return /^(https?|ftp|file):/i.test(url);
}

/** Every openable bookmark in the tree, with its folder path. */
export function flattenBookmarks(
  tree: SearchNode[],
  about?: (id: string, url: string) => string | undefined,
  max = 50_000,
  tagsOf?: (id: string) => string[] | undefined,
): SearchItem[] {
  const out: SearchItem[] = [];
  const walk = (nodes: SearchNode[], path: string[], depth: number) => {
    if (depth > 100) return;
    for (const n of nodes) {
      if (out.length >= max) return;
      if (n.url !== undefined) {
        if (!isOpenable(n.url)) continue;
        const extra = about?.(n.id, n.url);
        const tags = tagsOf?.(n.id);
        out.push({
          id: n.id,
          title: n.title || n.url,
          url: n.url,
          host: hostOf(n.url),
          path: path.join(' / '),
          ...(extra ? { about: extra } : {}),
          ...(tags?.length ? { tags } : {}),
        });
      } else if (n.children) {
        // The invisible root has no title; top-level folders start the path.
        walk(n.children, n.title ? [...path, n.title] : path, depth + 1);
      }
    }
  };
  walk(tree, [], 0);
  return out;
}

const words = (query: string) => fold(query).split(/\s+/).filter(Boolean).slice(0, 8);

interface Folded {
  title: string;
  url: string;
  host: string;
  path: string;
  about: string;
  tags: string[];
  tagText: string;
}
/** Folded fields, cached per item (the popup searches on every key press). Tags are compared by content. */
const folded = new WeakMap<SearchItem, Folded & { tagKey: string }>();
function fieldsOf(item: SearchItem): Folded {
  const tagKey = (item.tags ?? []).join('|');
  let f = folded.get(item);
  if (!f || f.tagKey !== tagKey) {
    const tags = (item.tags ?? []).map(fold);
    f = {
      title: fold(item.title),
      url: fold(item.url),
      host: fold(item.host),
      path: fold(item.path),
      about: fold(item.about ?? ''),
      tags,
      tagText: tags.join(' '),
      tagKey,
    };
    folded.set(item, f);
  }
  return f;
}

/** "#recipe pasta" → tag filters ["recipe"] and words ["pasta"]. */
export function splitQuery(query: string): { tags: string[]; words: string[] } {
  const all = words(query);
  return {
    tags: all.filter((w) => w.startsWith('#')).map((w) => w.slice(1)).filter(Boolean),
    words: all.filter((w) => !w.startsWith('#')),
  };
}

const startsWord = (text: string, word: string) => text.startsWith(word) || text.includes(` ${word}`) || text.includes(`-${word}`);

export function searchBookmarks(items: SearchItem[], query: string, max = 50): { hits: SearchHit[]; total: number } {
  const { tags: tagFilters, words: ws } = splitQuery(query);
  if (!ws.length && !tagFilters.length) return { hits: [], total: 0 };
  const hits: SearchHit[] = [];
  for (const item of items) {
    const f = fieldsOf(item);
    // "#italian-food" finds the tag "italian food" (a search word has no spaces).
    if (!tagFilters.every((t) => f.tags.some((tag) => tag.replace(/ /g, '-').startsWith(t)))) continue;
    let score = tagFilters.length * 6;
    let ok = true;
    for (const w of ws) {
      if (f.title.includes(w)) score += startsWord(f.title, w) ? 12 : 8;
      else if (f.host.includes(w)) score += f.host.startsWith(w) ? 7 : 5;
      else if (f.path.includes(w)) score += 4;
      else if (f.url.includes(w)) score += 3;
      else if (f.tagText.includes(w)) score += 3;
      else if (f.about.includes(w)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (ws.length && f.title === ws.join(' ')) score += 20;
    // Shorter titles are usually the more specific match.
    score -= Math.min(4, f.title.length / 40);
    hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return { hits: hits.slice(0, max), total: hits.length };
}

/** [start, end) ranges of `text` that match a word of the query, merged, for highlighting. */
export function matchRanges(text: string, query: string): [number, number][] {
  const ws = splitQuery(query).words;
  if (!ws.length || !text) return [];
  const { folded: f, map } = foldWithMap(text);
  const ranges: [number, number][] = [];
  for (const w of ws) {
    let from = 0;
    for (let at = f.indexOf(w, from); at >= 0 && ranges.length < 50; at = f.indexOf(w, from)) {
      ranges.push([map[at]!, map[at + w.length]!]);
      from = at + w.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
