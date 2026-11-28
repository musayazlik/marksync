import type { DriveFile } from './drive';

/**
 * Where Marksync keeps its files: Google Drive (platform/drive.ts) or a
 * WebDAV server such as Nextcloud (platform/webdav.ts). The services only
 * use this interface; it has the shape of the Drive client, so `list` takes
 * the small subset of Drive queries the services build:
 *
 *   'ID' in parents · name = 'NAME' · mimeType = / != 'application/vnd.google-apps.folder'
 *
 * joined with " and ". IDs are opaque: Drive file IDs, or paths on WebDAV.
 * `version` changes whenever a file changes (Drive's version, WebDAV's ETag).
 */
export interface FileStore {
  list(q: string, orderBy?: string, pageSize?: number): Promise<DriveFile[]>;
  findByName(name: string, parentId: string, folder?: boolean): Promise<DriveFile | undefined>;
  /** The ID of the folder `name` in `parentId` ('root' = the top), created if missing. */
  ensureFolder(name: string, parentId?: string): Promise<string>;
  getMeta(id: string): Promise<DriveFile>;
  downloadJson<T>(id: string): Promise<T>;
  createJson(name: string, parentId: string, data: unknown, appProperties?: Record<string, string>): Promise<DriveFile>;
  /**
   * Replaces a file's content. With `expectedVersion`, a store that can
   * check it atomically (WebDAV `If-Match`) refuses the write with status
   * 412 when the file changed since; Drive callers check the version first.
   */
  updateJson(id: string, data: unknown, expectedVersion?: string): Promise<DriveFile>;
  delete(id: string): Promise<void>;
}

/** Status of a write refused because the file changed meanwhile (or already exists). */
export const PRECONDITION_FAILED = 412;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** One condition of a Drive-style query, as used by the services. */
export type QueryTerm =
  | { kind: 'parent'; id: string }
  | { kind: 'name'; value: string }
  | { kind: 'mime'; folder: boolean }
  | { kind: 'trashed' };

/** Reads the query subset above; anything else is an error, so a new query never silently matches everything. */
export function parseQuery(q: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  const text = `'((?:[^'\\\\]|\\\\.)*)'`;
  const unquote = (s: string) => s.replace(/\\(.)/g, '$1');
  for (const part of q.split(' and ').map((p) => p.trim())) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(new RegExp(`^${text} in parents$`)))) out.push({ kind: 'parent', id: unquote(m[1]!) });
    else if ((m = part.match(new RegExp(`^name = ${text}$`)))) out.push({ kind: 'name', value: unquote(m[1]!) });
    else if ((m = part.match(new RegExp(`^mimeType (!?=) ${text}$`))) && unquote(m[2]!) === FOLDER_MIME) out.push({ kind: 'mime', folder: m[1] === '=' });
    else if (part === 'trashed = false') out.push({ kind: 'trashed' });
    else throw new Error(`Unsupported storage query: ${part}`);
  }
  return out;
}
