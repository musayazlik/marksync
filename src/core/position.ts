/**
 * Fractional position keys (sync file schema 2): the order of the items in a
 * folder is the order of their `pos` strings. Moving one item gives only
 * that item a new key between its new neighbours, so two browsers that move
 * different items of the same folder before syncing both keep their moves.
 *
 * Keys are base-36 fractions ("0.<key>"), compared as plain strings, and
 * never end in "0" so there is always room between two of them (the
 * midpoint algorithm of David Greenspan's fractional indexing).
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Keys longer than this get the whole folder renumbered (still in order). */
export const MAX_KEY_LENGTH = 24;
const KEY = /^[0-9a-z]{0,63}[1-9a-z]$/;

export function isPosKey(v: unknown): v is string {
  return typeof v === 'string' && KEY.test(v);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Shared prefix: the key goes below it.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  // Neighbouring digits: keep a's digit and go one level deeper.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

/** A key that sorts after `a` and before `b` (null: no bound). Throws when `a >= b`. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new RangeError(`No key between ${a} and ${b}.`);
  return midpoint(a ?? '', b);
}

/** `n` keys in order between `a` and `b`, as short as possible (spread evenly, not appended one by one). */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const left = Math.floor((n - 1) / 2);
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}

/**
 * Longest run of items that are still in order: these keep their keys, the
 * others count as moved. `keys[i]` is undefined for items that cannot keep a
 * key (new here, or moved in from another folder). Returns a mask.
 */
export function stableMask(keys: (string | undefined)[]): boolean[] {
  // Patience sorting, O(n log n): tails[k] = index of the smallest last key of a run of length k+1.
  const tails: number[] = [];
  const prev = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]!]! < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Array<boolean>(keys.length).fill(false);
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) keep[i] = true;
  return keep;
}

/**
 * Final keys for a folder in its local order: items in the stable run keep
 * theirs, every other item gets a key between its neighbours.
 */
export function placeKeys(keys: (string | undefined)[]): string[] {
  const keep = stableMask(keys);
  const out: string[] = new Array(keys.length);
  let last: string | null = null;
  let i = 0;
  while (i < keys.length) {
    if (keep[i] && (last === null || keys[i]! > last)) {
      out[i] = keys[i]!;
      last = out[i]!;
      i++;
      continue;
    }
    let j = i;
    while (j < keys.length && !(keep[j] && (last === null || keys[j]! > last))) j++;
    const fresh = keysBetween(last, j < keys.length ? keys[j]! : null, j - i);
    for (let k = 0; k < fresh.length; k++) out[i + k] = fresh[k]!;
    last = fresh.at(-1) ?? last;
    i = j;
  }
  return out;
}
