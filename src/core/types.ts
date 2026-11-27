/**
 * Shared data model. Nothing in src/core touches a browser API, so all of it
 * runs in unit tests.
 */

/**
 * The four top-level bookmark folders, named the same in every browser.
 *
 * | key     | Chrome / Brave / Edge          | Firefox            |
 * |---------|--------------------------------|--------------------|
 * | toolbar | Bookmarks bar                  | Bookmarks Toolbar  |
 * | menu    | (a "Bookmarks Menu" folder)    | Bookmarks Menu     |
 * | other   | Other bookmarks                | Other Bookmarks    |
 * | mobile  | Mobile bookmarks               | Mobile Bookmarks   |
 */
export const ROOT_KEYS = ['toolbar', 'menu', 'other', 'mobile'] as const;
export type RootKey = (typeof ROOT_KEYS)[number];

export function isRootKey(id: string): id is RootKey {
  return (ROOT_KEYS as readonly string[]).includes(id);
}

export type NodeKind = 'folder' | 'bookmark';

/**
 * One bookmark or folder in the shared sync file.
 *
 * `id` is a random UUID that is the same in every browser. Each browser keeps
 * its own map from its local bookmark ID to this ID.
 *
 * Two clocks decide conflicts field by field: renaming a bookmark in Chrome
 * and moving the same bookmark in Firefox both survive.
 */
export interface SyncRecord {
  id: string;
  kind: NodeKind;
  /** A RootKey or the id of another folder record. */
  parentId: string;
  /** Position among the synced children of the parent, starting at 0 (derived from `pos`). */
  index: number;
  /**
   * Fractional position key (schema 2, see core/position.ts): siblings are
   * ordered by it. Missing in schema 1 files and old backups; sanitize()
   * assigns keys from `index` then.
   */
  pos?: string;
  title: string;
  url?: string;
  /** Clock of the last title or URL change. */
  contentAt: number;
  /** Clock of the last parent or index change. */
  positionAt: number;
  /** Set when the item was deleted. Wins over edits that are older than it. */
  deletedAt?: number;
}

export type RecordMap = Record<string, SyncRecord>;

/**
 * Version of the sync file format. 2 added the fractional position keys
 * (`SyncRecord.pos`); versions before 0.7 refuse a file with schema 2 and
 * ask to update, and 0.7+ reads schema 1 files and writes them back as 2.
 */
export const SYNC_SCHEMA = 2;

/** The JSON file stored in Google Drive and shared by all browsers. */
export interface SyncState {
  schema: 1 | 2;
  records: RecordMap;
  updatedAt: number;
  /** Label of the browser that wrote the file, e.g. "Brave on Windows". */
  updatedBy: string;
  /**
   * Clock of the last mass deletion (or restore) a user confirmed in some
   * browser. Other browsers apply large remote deletions without asking
   * again only when they are not newer than this.
   */
  confirmedDeletionAt?: number;
  /**
   * Generation of the file: a new random ID whenever the file is created from
   * scratch (the Marksync folder was deleted in Drive, or encryption was
   * reset). Browsers that remember another generation match their bookmarks
   * again instead of uploading them twice. Files from before 0.3 have none.
   */
  epoch?: string;
}

/** A backup file in Google Drive. */
export interface BackupFile {
  schema: 1;
  kind: 'marksync-backup';
  createdAt: number;
  source: string;
  reason: 'manual' | 'scheduled' | 'before-restore' | 'before-remote-delete' | 'before-cleanup';
  count: number;
  /** Live records only; clocks are ignored on restore. */
  records: RecordMap;
}

/** A local bookmark after the platform layer has normalised it. */
export interface LocalNode {
  localId: string;
  parentLocalId: string;
  kind: NodeKind;
  title: string;
  url?: string;
  /** Position among the synced siblings (separators etc. are not counted). */
  index: number;
}

/** The local bookmark tree in a browser-neutral form. */
export interface LocalSnapshot {
  /** Local ID of each top-level folder that exists in this browser. */
  roots: Partial<Record<RootKey, string>>;
  /** Every synced node below the roots, parents before children. */
  nodes: LocalNode[];
  /**
   * Extra local folders that belong to a root (e.g. Chrome's "only on this
   * device" bookmarks bar next to the account one, Opera's Unsorted).
   */
  aliases?: Record<string, RootKey>;
}

/** Local bookmark ID → shared record ID. */
export type IdMapping = Record<string, string>;
