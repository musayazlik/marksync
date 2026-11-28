/**
 * Minimal Google Drive v3 REST client. With the `drive.file` scope the
 * extension only sees files it created itself, never the rest of the Drive.
 */

import { isDriveId } from '../core/validate';
import type { FileStore } from './store';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,version,createdTime,modifiedTime,size,appProperties,parents';
/** Upper bound on list() pages (100 files each), so a crowded folder cannot exhaust memory. */
const MAX_LIST_PAGES = 50;

export interface DriveFile {
  id: string;
  name: string;
  version?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
  parents?: string[];
  /** Set by the WebDAV store for folders (Drive lists never ask for it). */
  mimeType?: string;
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Google Drive error ${status}: ${body.slice(0, 300)}`);
  }
}

/** Quotes a value for a Drive `q` query. */
export const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Validates a Drive file ID before it is put into a URL path. */
export function fileIdPath(id: string): string {
  if (!isDriveId(id)) throw new DriveError(400, 'Invalid Drive file ID.');
  return encodeURIComponent(id);
}

/** Turns file content into what is stored in Drive and back (encryption, see services/encryption-service.ts). */
export interface DriveCodec {
  encode(data: unknown): Promise<unknown>;
  decode(stored: unknown): Promise<unknown>;
}

export class DriveClient implements FileStore {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly codec?: DriveCodec,
  ) {}

  private async request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.getToken()}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && retry) {
      await this.onUnauthorized();
      return this.request(url, init, false);
    }
    if (!res.ok) throw new DriveError(res.status, await res.text());
    return res;
  }

  async list(q: string, orderBy = 'createdTime', pageSize = 100): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        q: `${q} and trashed = false`,
        orderBy,
        pageSize: String(pageSize),
        spaces: 'drive',
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        ...(pageToken ? { pageToken } : {}),
      });
      const res = await this.request(`${API}/files?${params}`);
      const body = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
      files.push(...body.files);
      pageToken = body.nextPageToken;
    } while (pageToken && ++pages < MAX_LIST_PAGES);
    return files;
  }

  async findByName(name: string, parentId: string, folder = false): Promise<DriveFile | undefined> {
    const type = folder ? ` and mimeType = '${FOLDER_MIME}'` : '';
    const [first] = await this.list(`name = ${quote(name)} and ${quote(parentId)} in parents${type}`);
    return first;
  }

  async ensureFolder(name: string, parentId = 'root'): Promise<string> {
    const existing = await this.findByName(name, parentId, true);
    if (existing) return existing.id;
    const res = await this.request(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  async getMeta(id: string): Promise<DriveFile> {
    const res = await this.request(`${API}/files/${fileIdPath(id)}?fields=${FILE_FIELDS}`);
    return (await res.json()) as DriveFile;
  }

  async downloadJson<T>(id: string): Promise<T> {
    const res = await this.request(`${API}/files/${fileIdPath(id)}?alt=media`);
    const stored: unknown = await res.json();
    return (this.codec ? await this.codec.decode(stored) : stored) as T;
  }

  async createJson(
    name: string,
    parentId: string,
    data: unknown,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile> {
    const content = this.codec ? await this.codec.encode(data) : data;
    const boundary = `marksync-${crypto.randomUUID()}`;
    const meta = { name, parents: [parentId], mimeType: 'application/json', ...(appProperties ? { appProperties } : {}) };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n` +
      `--${boundary}--`;
    const res = await this.request(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()) as DriveFile;
  }

  /** Drive has no conditional write; callers compare the version first (see DriveRemoteStore.save). */
  async updateJson(id: string, data: unknown, _expectedVersion?: string): Promise<DriveFile> {
    const content = this.codec ? await this.codec.encode(data) : data;
    const res = await this.request(`${UPLOAD}/files/${fileIdPath(id)}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    });
    return (await res.json()) as DriveFile;
  }

  async delete(id: string): Promise<void> {
    await this.request(`${API}/files/${fileIdPath(id)}`, { method: 'DELETE' });
  }
}
