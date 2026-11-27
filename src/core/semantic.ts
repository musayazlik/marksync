import { describeBookmark, type SiteInfo } from './ai-sort';

/**
 * Search by meaning: every bookmark becomes a vector (an "embedding") of its
 * title, address, what AI sorting found out about the site and its tags; a
 * query is embedded the same way and the closest bookmarks win, even when
 * they share no word with it. Vectors are normalised and stored as int8
 * (one byte per dimension) to keep the index small. Pure logic, unit tested.
 */

/** One bookmark in the index (base64 int8 vector, its scale, and the hash of the text it came from). */
export interface IndexEntry {
  h: string;
  v: string;
  s: number;
}

export interface SemanticIndexFile {
  schema: 1;
  kind: 'marksync-semantic';
  model: string;
  dims: number;
  /** Shared record ID → entry. */
  items: Record<string, IndexEntry>;
  updatedAt: number;
}

export const MAX_TEXT = 1000;
/** Texts per embedding request. */
export const EMBED_BATCH = 64;
const MAX_DIMS = 8192;

/** The text a bookmark is indexed by. */
export function semanticText(b: { title: string; url?: string; site?: SiteInfo; tags?: string[] }): string {
  const { title, address } = describeBookmark(b.title, b.url);
  const parts = [title, address, b.site?.name, b.site?.category, b.site?.summary, b.site?.purpose, b.tags?.length ? b.tags.join(', ') : undefined];
  return parts.filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

/** FNV-1a, 32 bit: enough to notice that the text of a bookmark changed. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Normalises a vector and stores it as int8 with its scale. */
export function quantize(vector: number[], h: string): IndexEntry {
  const norm = Math.hypot(...vector) || 1;
  let max = 0;
  for (const x of vector) max = Math.max(max, Math.abs(x / norm));
  const scale = max / 127 || 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) bytes[i] = Math.round(vector[i]! / norm / scale);
  return { h, v: toBase64(new Uint8Array(bytes.buffer)), s: scale };
}

/** Back to (about) the unit vector. */
export function dequantize(e: IndexEntry): Float32Array {
  const bytes = new Int8Array(fromBase64(e.v).buffer);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! * e.s;
  return out;
}

export function normalise(vector: number[]): Float32Array {
  const norm = Math.hypot(...vector) || 1;
  return Float32Array.from(vector, (x) => x / norm);
}

/** Cosine similarity of unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** The `k` closest entries, best first; scores below `min` are left out. */
export function nearest(query: Float32Array, entries: Iterable<[string, Float32Array]>, k = 20, min = 0.2): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = [];
  for (const [id, vec] of entries) {
    const score = dot(query, vec);
    if (score >= min) out.push({ id, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Vectors from an OpenAI-compatible embeddings answer, in input order; throws when the answer does not fit. */
export function parseEmbeddings(body: unknown, count: number): { vectors: number[][]; cost?: number } {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data) || data.length !== count) throw new Error('The embeddings answer has the wrong number of vectors.');
  const vectors: number[][] = new Array(count);
  let dims = -1;
  for (const [i, raw] of data.entries()) {
    const item = raw as { index?: unknown; embedding?: unknown } | null;
    const at = typeof item?.index === 'number' ? item.index : i;
    const v = item?.embedding;
    if (!Array.isArray(v) || !v.length || v.length > MAX_DIMS || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error('The embeddings answer has an invalid vector.');
    }
    if (dims >= 0 && v.length !== dims) throw new Error('The embeddings answer mixes vector sizes.');
    dims = v.length;
    if (at < 0 || at >= count || vectors[at]) throw new Error('The embeddings answer has an invalid index.');
    vectors[at] = v as number[];
  }
  const cost = (body as { usage?: { cost?: unknown } }).usage?.cost;
  return { vectors, ...(typeof cost === 'number' && Number.isFinite(cost) ? { cost } : {}) };
}

/** A clean copy of semantic-index.json from Drive, or undefined. */
export function sanitizeIndexFile(input: unknown): SemanticIndexFile | undefined {
  const f = input as Partial<SemanticIndexFile> | null;
  if (!f || f.kind !== 'marksync-semantic' || f.schema !== 1 || typeof f.model !== 'string' || typeof f.dims !== 'number') return undefined;
  if (!f.items || typeof f.items !== 'object' || Array.isArray(f.items)) return undefined;
  const bytes = Math.ceil(f.dims / 3) * 4;
  const items: Record<string, IndexEntry> = {};
  for (const [id, e] of Object.entries(f.items)) {
    if (id === '__proto__' || id.length > 128) continue;
    if (!e || typeof e.h !== 'string' || typeof e.v !== 'string' || typeof e.s !== 'number' || !Number.isFinite(e.s)) continue;
    if (e.v.length !== bytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(e.v)) continue;
    items[id] = { h: e.h.slice(0, 16), v: e.v, s: e.s };
  }
  return { schema: 1, kind: 'marksync-semantic', model: f.model.slice(0, 200), dims: f.dims, items, updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : 0 };
}

/** Rough tokens of texts (about 4 characters each). */
export const textTokens = (texts: string[]) => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
