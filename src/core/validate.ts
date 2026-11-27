import { isPosKey } from './position';
import type { RecordMap, SyncRecord } from './types';

/**
 * Validation for data that comes from Google Drive. Drive files can be
 * written by the user's other browsers, by other apps the user gave Drive
 * access, by Drive for desktop, or be corrupted. Nothing from Drive is used
 * before it passes these checks.
 */

export const MAX_RECORDS = 200_000;
export const MAX_TITLE_LENGTH = 4_096;
export const MAX_URL_LENGTH = 65_536;
export const MAX_ID_LENGTH = 128;
/** Clocks further in the future than this are pulled back (protects conflict resolution). */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export class InvalidRemoteDataError extends Error {}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isClock = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Returns a clean copy of a remote record map. Records that do not have the
 * expected shape are dropped (not trusted, not fatal), so one bad record can
 * never stop sync. Clocks too far in the future are clamped.
 */
export function sanitizeRemoteRecords(input: unknown, now: number): { records: RecordMap; dropped: number } {
  if (input === null || input === undefined) return { records: {}, dropped: 0 };
  if (!isPlainObject(input)) throw new InvalidRemoteDataError('The sync file has an invalid format.');
  const entries = Object.entries(input);
  if (entries.length > MAX_RECORDS) throw new InvalidRemoteDataError('The sync file has too many records.');

  const maxClock = now + MAX_CLOCK_SKEW_MS;
  const clamp = (c: number) => Math.min(c, maxClock);
  const records: RecordMap = {};
  let dropped = 0;
  for (const [key, raw] of entries) {
    const rec = FORBIDDEN_KEYS.has(key) ? undefined : toRecord(key, raw);
    if (!rec) {
      dropped++;
      continue;
    }
    rec.contentAt = clamp(rec.contentAt);
    rec.positionAt = clamp(rec.positionAt);
    if (rec.deletedAt !== undefined) rec.deletedAt = clamp(rec.deletedAt);
    records[key] = rec;
  }
  return { records, dropped };
}

function toRecord(key: string, r: unknown): SyncRecord | undefined {
  if (!isPlainObject(r)) return undefined;
  const { id, kind, parentId, index, title, url, contentAt, positionAt, deletedAt, pos } = r;
  if (id !== key || typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) return undefined;
  if (kind !== 'folder' && kind !== 'bookmark') return undefined;
  if (typeof parentId !== 'string' || parentId.length === 0 || parentId.length > MAX_ID_LENGTH || parentId === id) return undefined;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
  if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) return undefined;
  if (kind === 'bookmark') {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return undefined;
  } else if (url !== undefined) {
    return undefined;
  }
  if (!isClock(contentAt) || !isClock(positionAt)) return undefined;
  if (deletedAt !== undefined && !isClock(deletedAt)) return undefined;
  return {
    id,
    kind,
    parentId,
    index,
    // A malformed key is dropped (sanitize gives the folder new ones), not the record.
    ...(isPosKey(pos) ? { pos } : {}),
    title,
    ...(kind === 'bookmark' ? { url: url as string } : {}),
    contentAt,
    positionAt,
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
}

/** Drive file and folder IDs: letters, digits, '-' and '_'. */
export function isDriveId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id);
}

export function optionalClock(v: unknown): number | undefined {
  return isClock(v) ? v : undefined;
}
