/**
 * An in-memory Google Drive v3, enough for DriveClient: list with simple
 * `q` filters, metadata, download, multipart create, media update, delete.
 * Installed as `fetch`; every file's stored text can be inspected.
 */
export interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content: string;
  version: number;
  createdTime: string;
  appProperties?: Record<string, string>;
}

/** IDs are unique across instances, like real Drive IDs. */
let nextId = 1;

export class FakeDrive {
  files = new Map<string, FakeFile>();
  private clock = Date.parse('2026-11-24T10:00:00Z');

  private add(f: Omit<FakeFile, 'id' | 'version' | 'createdTime'>): FakeFile {
    const file: FakeFile = { ...f, id: `file${nextId++}xx`, version: 1, createdTime: new Date((this.clock += 1000)).toISOString() };
    this.files.set(file.id, file);
    return file;
  }

  byName(name: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.name === name);
  }

  json(id: string): unknown {
    return JSON.parse(this.files.get(id)!.content);
  }

  private meta(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      version: String(f.version),
      createdTime: f.createdTime,
      parents: f.parents,
      ...(f.appProperties ? { appProperties: f.appProperties } : {}),
    };
  }

  private matches(f: FakeFile, q: string): boolean {
    for (const part of q.split(' and ')) {
      let m: RegExpMatchArray | null;
      if ((m = part.match(/^name = '(.*)'$/))) {
        if (f.name !== m[1]) return false;
      } else if ((m = part.match(/^'(.*)' in parents$/))) {
        if (!f.parents.includes(m[1]!)) return false;
      } else if ((m = part.match(/^mimeType (!?=) '(.*)'$/))) {
        if ((f.mimeType === m[2]) !== (m[1] === '=')) return false;
      } else if (part !== 'trashed = false') throw new Error(`fake drive: unknown query ${part}`);
    }
    return true;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const notFound = () => new Response('not found', { status: 404 });
    const path = url.pathname.replace(/^\/(upload\/)?drive\/v3\/files\/?/, '');

    if (method === 'GET' && !path) {
      const q = url.searchParams.get('q') ?? '';
      const files = [...this.files.values()].filter((f) => this.matches(f, q));
      files.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      return ok({ files: files.map((f) => this.meta(f)) });
    }
    if (method === 'POST' && !path && url.pathname.startsWith('/upload/')) {
      const body = String(init.body);
      const parts = body.split(/--marksync-[^\r\n]+/).filter((p) => p.includes('\r\n\r\n'));
      const meta = JSON.parse(parts[0]!.split('\r\n\r\n')[1]!.trim()) as { name: string; parents: string[]; mimeType: string; appProperties?: Record<string, string> };
      const content = parts[1]!.split('\r\n\r\n')[1]!.replace(/\r\n$/, '');
      return ok(this.meta(this.add({ ...meta, content })));
    }
    if (method === 'POST' && !path) {
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[]; mimeType: string };
      return ok(this.meta(this.add({ ...meta, content: '' })));
    }
    const file = this.files.get(path);
    if (!file) return notFound();
    if (method === 'DELETE') {
      this.files.delete(file.id);
      return new Response(null, { status: 204 });
    }
    if (method === 'PATCH') {
      file.content = String(init.body);
      file.version++;
      return ok(this.meta(file));
    }
    if (url.searchParams.get('alt') === 'media') return new Response(file.content, { status: 200 });
    return ok(this.meta(file));
  };
}
