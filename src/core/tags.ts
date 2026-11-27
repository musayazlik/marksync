/**
 * Tags: Marksync's own labels on bookmarks, synced through a separate Drive
 * file (tags.json). Browsers have no synced tags, and keeping them out of
 * sync-state.json means older Marksync versions (which drop unknown fields)
 * can never wipe them. Pure logic, unit tested.
 *
 * Each bookmark's tags are one value with a clock: the newest edit wins, as
 * for a title. Removing every tag stores an empty list (a tombstone), so the
 * removal reaches the other browsers too.
 */

export interface TagEntry {
  tags: string[];
  /** Clock of the last edit (ms). */
  at: number;
}

/** Shared record ID → tags. */
export type TagMap = Record<string, TagEntry>;

export interface TagsFile {
  schema: 1;
  kind: 'marksync-tags';
  items: TagMap;
  updatedAt: number;
}

export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 32;
const MAX_ENTRIES = 200_000;
/** Empty entries (removed tags) are kept this long, like deleted bookmarks. */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** A usable tag: lower case, single spaces, no "#", commas or control characters; undefined if empty. */
export function cleanTag(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const tag = input
    .replace(/[\u0000-\u001f\u007f,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
  return tag || undefined;
}

/** Clean, unique tags in the given order, at most `max`. */
export function cleanTags(input: unknown, max = MAX_TAGS): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const tag = cleanTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** "recipe, Italian food,  #quick" → ["recipe", "italian food", "quick"]. */
export function parseTagInput(text: string): string[] {
  return cleanTags(text.split(','));
}

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** The newer entry; equal clocks pick the same winner in every browser. */
function pick(a: TagEntry, b: TagEntry): TagEntry {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  const ka = a.tags.join('\n');
  const kb = b.tags.join('\n');
  return ka >= kb ? a : b;
}

/** Merges two tag maps; the result is the same whichever side is passed first. */
export function mergeTags(a: TagMap, b: TagMap): TagMap {
  const out: TagMap = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    const mine = out[id];
    out[id] = mine ? pick(mine, entry) : entry;
  }
  return out;
}

/**
 * Drops tags of bookmarks that no longer exist, and old empty entries.
 * `liveIds`: the record IDs of the bookmarks there are now.
 */
export function pruneTags(map: TagMap, liveIds: ReadonlySet<string>, now: number): TagMap {
  const out: TagMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (!liveIds.has(id)) continue;
    if (!entry.tags.length && now - entry.at > TOMBSTONE_TTL_MS) continue;
    out[id] = entry;
  }
  return out;
}

export function tagMapsEqual(a: TagMap, b: TagMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k]!;
    const y = b[k];
    return !!y && x.at === y.at && sameTags(x.tags, y.tags);
  });
}

/** A clean copy of tags.json from Drive; malformed entries are dropped, clocks in the future pulled back. */
export function sanitizeTagsFile(input: unknown, now: number): TagMap {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const file = input as Partial<TagsFile>;
  if (file.kind !== 'marksync-tags' || file.schema !== 1) return {};
  const items = file.items;
  if (typeof items !== 'object' || items === null || Array.isArray(items)) return {};
  const out: TagMap = {};
  let n = 0;
  for (const [id, raw] of Object.entries(items)) {
    if (FORBIDDEN.has(id) || id.length > 128 || !id) continue;
    if (++n > MAX_ENTRIES) break;
    const e = raw as Partial<TagEntry> | null;
    if (!e || typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0 || !Array.isArray(e.tags)) continue;
    out[id] = { tags: cleanTags(e.tags), at: Math.min(e.at, now + MAX_SKEW_MS) };
  }
  return out;
}

/** Every tag in use with how many bookmarks have it, most used first. */
export function tagCounts(tagsOf: Iterable<string[]>): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of tagsOf) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Tags AI sorting proposes: at most three, cleaned like the user's own. */
export function aiTags(proposed: unknown): string[] {
  return cleanTags(proposed, 3);
}
