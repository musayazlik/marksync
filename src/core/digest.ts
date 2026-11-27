/**
 * "Rediscover": a few bookmarks not opened in a long time, shown in the
 * popup once a day or once a week. Some are related to what was saved
 * recently (same tag, same kind of site or the same site), the rest are
 * random. Everything comes from data already in the browser: no network.
 * Pure logic, unit tested.
 */

export interface DigestCandidate {
  id: string;
  title: string;
  url: string;
  path: string;
  /** When it was bookmarked (ms). */
  addedAt?: number;
  /** When it was last opened (Chromium's `dateLastUsed`, or opened from Marksync). */
  usedAt?: number;
  tags?: string[];
  /** Site category from AI sorting, e.g. "Recipe". */
  category?: string;
}

export interface DigestPick {
  id: string;
  /** 'related': like a bookmark saved recently (`relatedTo` is its title). */
  reason: 'related' | 'random';
  relatedTo?: string;
}

export type DigestFrequency = 'off' | 'daily' | 'weekly';

const DAY = 24 * 60 * 60 * 1000;
/** Not opened (or added) for this long: a candidate. */
export const STALE_DAYS = 60;
/** Saves this recent are what "related" looks for. */
export const RECENT_DAYS = 14;
/** A bookmark the user chose to keep does not come back for this long. */
export const KEEP_SNOOZE_DAYS = 180;
export const DIGEST_SIZE = 5;
const RELATED_MAX = 2;

/** Small deterministic random numbers, so a digest is the same each time it is rebuilt that day. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with the seeded generator: the same order everywhere for the same seed. */
function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Is a new digest due? */
export function digestDue(frequency: DigestFrequency, createdAt: number | undefined, now: number): boolean {
  if (frequency === 'off') return false;
  if (!createdAt) return true;
  return now - createdAt >= (frequency === 'daily' ? DAY : 7 * DAY) * 0.98;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Picks the digest: stale bookmarks only (not opened nor added in
 * STALE_DAYS), none the user kept lately; up to two related to recent
 * saves, the rest at random (seeded).
 */
export function pickDigest(
  items: DigestCandidate[],
  opts: { now: number; seed: number; size?: number; kept?: Record<string, number> },
): DigestPick[] {
  const size = opts.size ?? DIGEST_SIZE;
  const kept = opts.kept ?? {};
  const lastTouch = (c: DigestCandidate) => Math.max(c.usedAt ?? 0, c.addedAt ?? 0);
  const stale = items.filter((c) => {
    const touched = lastTouch(c);
    if (touched && opts.now - touched < STALE_DAYS * DAY) return false;
    const keptAt = kept[c.id];
    return !(keptAt && opts.now - keptAt < KEEP_SNOOZE_DAYS * DAY);
  });
  const recent = items.filter((c) => c.addedAt && opts.now - c.addedAt < RECENT_DAYS * DAY);
  const random = seededRandom(opts.seed);
  const picks: DigestPick[] = [];
  const taken = new Set<string>();

  // Related: shares a tag, a category or a site with something saved recently.
  const shuffledRecent = shuffle(recent, random);
  for (const r of shuffledRecent) {
    if (picks.length >= Math.min(RELATED_MAX, size)) break;
    const tags = new Set(r.tags ?? []);
    const host = hostOf(r.url);
    const matches = stale.filter(
      (c) =>
        !taken.has(c.id) &&
        c.id !== r.id &&
        ((c.tags ?? []).some((t) => tags.has(t)) || (!!r.category && c.category === r.category) || (!!host && hostOf(c.url) === host)),
    );
    if (!matches.length) continue;
    const pick = matches[Math.floor(random() * matches.length)]!;
    taken.add(pick.id);
    picks.push({ id: pick.id, reason: 'related', relatedTo: r.title || r.url });
  }

  // The rest: random among the stale ones, oldest touched a little more likely.
  const pool = stale.filter((c) => !taken.has(c.id));
  const weighted = pool
    .map((c) => ({ c, w: random() * (1 + Math.min(3, (opts.now - (lastTouch(c) || 0)) / (365 * DAY))) }))
    .sort((a, b) => b.w - a.w);
  for (const { c } of weighted) {
    if (picks.length >= size) break;
    picks.push({ id: c.id, reason: 'random' });
  }
  return picks;
}
