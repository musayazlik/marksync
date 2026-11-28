import type { DriveCodec, DriveFile } from './drive';
import { DriveError } from './drive';
import { FOLDER_MIME, parseQuery, type FileStore } from './store';

/**
 * Marksync's files on a WebDAV server (Nextcloud, ownCloud, a NAS, any
 * RFC 4918 server). File IDs are paths below the configured base address,
 * e.g. "Marksync/backups/x.json"; the ETag is the version, and writes that
 * must not overwrite a newer file use If-Match / If-None-Match.
 *
 * Errors use DriveError (status + text) like the Drive client, so the rest
 * of the extension treats both the same.
 */

export interface WebDavConfig {
  /** Base folder, e.g. "https://cloud.example.org/remote.php/dav/files/ana/". */
  url: string;
  username: string;
  password: string;
}

const NS = 'https://github.com/musayazlik/marksync';
/** Custom properties stored with backups and browser snapshots (Drive's appProperties). */
const PROP_KEYS = ['count', 'source', 'reason', 'deviceId', 'label'] as const;

/** The base address in canonical form (with a trailing slash), or undefined when it cannot be used. */
export function parseWebDavUrl(input: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

function base64(text: string): string {
  let s = '';
  for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b);
  return btoa(s);
}

const xmlDecode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const xmlEncode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DavEntry {
  href: string;
  etag?: string;
  lastModified?: string;
  created?: string;
  size?: string;
  folder: boolean;
  props: Record<string, string>;
}

/**
 * Reads a PROPFIND multistatus answer. Service workers have no DOMParser, so
 * this is a small, strict scanner for the elements Marksync asks for, with
 * any namespace prefix.
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
  const out: DavEntry[] = [];
  const responses = xml.match(/<(?:[\w-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) ?? [];
  for (const block of responses.slice(0, 5000)) {
    const href = block.match(tag('href'))?.[1];
    if (!href) continue;
    // Only the properties the server found (status 200).
    const found = (block.match(/<(?:[\w-]+:)?propstat(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w-]+:)?propstat>/gi) ?? []).filter((p) => /<(?:[\w-]+:)?status>[^<]*\s2\d\d\s/i.test(p)).join('');
    const value = (name: string) => {
      const m = found.match(tag(name));
      return m ? xmlDecode(m[1]!.trim()) : undefined;
    };
    const props: Record<string, string> = {};
    for (const key of PROP_KEYS) {
      const v = value(key);
      if (v !== undefined) props[key] = v.slice(0, 200);
    }
    out.push({
      href: xmlDecode(href.trim()),
      ...(value('getetag') ? { etag: value('getetag')! } : {}),
      ...(value('getlastmodified') ? { lastModified: value('getlastmodified')! } : {}),
      ...(value('creationdate') ? { created: value('creationdate')! } : {}),
      ...(value('getcontentlength') ? { size: value('getcontentlength')! } : {}),
      folder: /<(?:[\w-]+:)?collection\s*\/?>/i.test(found.match(tag('resourcetype'))?.[0] ?? '') || /<(?:[\w-]+:)?resourcetype>\s*<(?:[\w-]+:)?collection/i.test(found),
      props,
    });
  }
  return out;
}

const PROPFIND_BODY =
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:m="${NS}"><d:prop>` +
  '<d:resourcetype/><d:getetag/><d:getlastmodified/><d:creationdate/><d:getcontentlength/>' +
  PROP_KEYS.map((k) => `<m:${k}/>`).join('') +
  '</d:prop></d:propfind>';

export class WebDavClient implements FileStore {
  private readonly base: URL;

  constructor(
    private readonly config: WebDavConfig,
    private readonly codec?: DriveCodec,
  ) {
    const base = parseWebDavUrl(config.url);
    if (!base) throw new DriveError(400, 'Invalid WebDAV address.');
    this.base = base;
  }

  /** The address of a path ('' = the base folder). Every segment is encoded; ".." is refused. */
  private address(path: string, folder = false): string {
    const parts = path.split('/').filter(Boolean);
    if (parts.some((p) => p === '..' || p === '.')) throw new DriveError(400, 'Invalid path.');
    return new URL(parts.map(encodeURIComponent).join('/') + (folder && parts.length ? '/' : ''), this.base).href;
  }

  /** The path of an href from a PROPFIND answer, relative to the base; undefined when outside it. */
  private pathOf(href: string): string | undefined {
    const abs = new URL(href, this.base);
    const basePath = decodeURIComponent(this.base.pathname);
    const p = decodeURIComponent(abs.pathname);
    if (!p.startsWith(basePath)) return undefined;
    return p.slice(basePath.length).replace(/\/+$/, '');
  }

  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: string; folder?: boolean } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.address(path, init.folder), {
        method,
        credentials: 'omit',
        headers: { Authorization: `Basic ${base64(`${this.config.username}:${this.config.password}`)}`, ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      throw err instanceof TypeError ? new TypeError(`network: could not reach the WebDAV server (${err.message})`) : err;
    }
    if (!res.ok && res.status !== 207) throw new DriveError(res.status, await res.text().catch(() => ''));
    return res;
  }

  private toFile(e: DavEntry, path: string): DriveFile {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    const parent = slash < 0 ? 'root' : path.slice(0, slash);
    const time = e.created ?? (e.lastModified ? new Date(e.lastModified).toISOString() : undefined);
    return {
      id: path,
      name,
      ...(e.etag ? { version: e.etag } : {}),
      ...(time ? { createdTime: time, modifiedTime: e.lastModified ? new Date(e.lastModified).toISOString() : time } : {}),
      ...(e.size ? { size: e.size } : {}),
      ...(Object.keys(e.props).length ? { appProperties: e.props } : {}),
      parents: [parent],
      ...(e.folder ? { mimeType: FOLDER_MIME } : {}),
    };
  }

  private async propfind(path: string, depth: 0 | 1): Promise<{ entry: DavEntry; path: string }[]> {
    const res = await this.request('PROPFIND', path, {
      folder: true,
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    return parseMultistatus(await res.text()).flatMap((entry) => {
      const p = this.pathOf(entry.href);
      return p === undefined ? [] : [{ entry, path: p }];
    });
  }

  async list(q: string, orderBy = 'createdTime'): Promise<DriveFile[]> {
    const terms = parseQuery(q);
    const parent = terms.find((t) => t.kind === 'parent');
    if (!parent || parent.kind !== 'parent') throw new Error('A WebDAV listing needs a folder.');
    const folderPath = parent.id === 'root' ? '' : parent.id;
    let found: { entry: DavEntry; path: string }[];
    try {
      found = await this.propfind(folderPath, 1);
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return [];
      throw err;
    }
    const files = found
      .filter(({ path }) => path !== folderPath && path.split('/').slice(0, -1).join('/') === folderPath)
      .map(({ entry, path }) => this.toFile(entry, path))
      .filter((f) =>
        terms.every((t) => {
          if (t.kind === 'name') return f.name === t.value;
          if (t.kind === 'mime') return (f.mimeType === FOLDER_MIME) === t.folder;
          return true;
        }),
      );
    const desc = /\bdesc\b/.test(orderBy);
    const key = (f: DriveFile) => (orderBy.startsWith('modifiedTime') ? f.modifiedTime : f.createdTime) ?? '';
    files.sort((a, b) => key(a).localeCompare(key(b)) * (desc ? -1 : 1) || a.name.localeCompare(b.name));
    return files;
  }

  async findByName(name: string, parentId: string, folder = false): Promise<DriveFile | undefined> {
    const files = await this.list(`name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${parentId.replace(/'/g, "\\'")}' in parents`);
    return files.find((f) => (f.mimeType === FOLDER_MIME) === folder);
  }

  async ensureFolder(name: string, parentId = 'root'): Promise<string> {
    const path = parentId === 'root' ? name : `${parentId}/${name}`;
    try {
      await this.request('MKCOL', path, { folder: true });
    } catch (err) {
      // 405: it exists already.
      if (!(err instanceof DriveError && err.status === 405)) throw err;
    }
    return path;
  }

  async getMeta(id: string): Promise<DriveFile> {
    const [first] = await this.propfind(id, 0);
    if (!first) throw new DriveError(404, 'Not found.');
    return this.toFile(first.entry, id);
  }

  async downloadJson<T>(id: string): Promise<T> {
    const res = await this.request('GET', id);
    const stored: unknown = JSON.parse(await res.text());
    return (this.codec ? await this.codec.decode(stored) : stored) as T;
  }

  private async put(path: string, data: unknown, condition: Record<string, string>): Promise<void> {
    const content = this.codec ? await this.codec.encode(data) : data;
    await this.request('PUT', path, { headers: { 'Content-Type': 'application/json', ...condition }, body: JSON.stringify(content) });
  }

  async createJson(name: string, parentId: string, data: unknown, appProperties?: Record<string, string>): Promise<DriveFile> {
    const path = parentId === 'root' ? name : `${parentId}/${name}`;
    // Never overwrite: another browser may have created it a moment ago.
    await this.put(path, data, { 'If-None-Match': '*' });
    if (appProperties && Object.keys(appProperties).length) {
      const props = Object.entries(appProperties)
        .filter(([k]) => (PROP_KEYS as readonly string[]).includes(k))
        .map(([k, v]) => `<m:${k}>${xmlEncode(v.slice(0, 200))}</m:${k}>`)
        .join('');
      const body = `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:" xmlns:m="${NS}"><d:set><d:prop>${props}</d:prop></d:set></d:propertyupdate>`;
      // Servers without dead properties still store the file; lists then show no counts.
      await this.request('PROPPATCH', path, { headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body }).catch(() => undefined);
    }
    return this.getMeta(path);
  }

  async updateJson(id: string, data: unknown, expectedVersion?: string): Promise<DriveFile> {
    await this.put(id, data, expectedVersion ? { 'If-Match': expectedVersion } : {});
    return this.getMeta(id);
  }

  async delete(id: string): Promise<void> {
    await this.request('DELETE', id);
  }
}
