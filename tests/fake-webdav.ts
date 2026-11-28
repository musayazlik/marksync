/**
 * An in-memory WebDAV server, enough for WebDavClient: PROPFIND (depth 0/1),
 * GET, PUT with If-Match / If-None-Match, MKCOL, DELETE, PROPPATCH, Basic
 * auth. Installed as `fetch`. Answers use the "D:" prefix, like many servers.
 */
interface Node {
  folder: boolean;
  content: string;
  etag: string;
  created: string;
  modified: string;
  props: Record<string, string>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeWebDav {
  readonly base = 'https://dav.example/remote.php/dav/files/ana/';
  nodes = new Map<string, Node>();
  private clock = Date.parse('2026-11-24T10:00:00Z');
  private seq = 1;
  requests: string[] = [];

  constructor(
    readonly username = 'ana',
    readonly password = 'app-pass',
  ) {
    this.nodes.set('', this.node(true));
  }

  private node(folder: boolean, content = ''): Node {
    const t = new Date((this.clock += 1000)).toISOString();
    return { folder, content, etag: `"e${this.seq++}"`, created: t, modified: t, props: {} };
  }

  /** Path below the base, without slashes at the ends. */
  private pathOf(url: URL): string | undefined {
    const base = new URL(this.base).pathname;
    const p = decodeURIComponent(url.pathname);
    if (!p.startsWith(base) && `${p}/` !== base) return undefined;
    return p.slice(base.length).replace(/^\/+|\/+$/g, '');
  }

  content(path: string): string | undefined {
    return this.nodes.get(path)?.content;
  }

  private entry(path: string, n: Node): string {
    const href = new URL(path.split('/').map(encodeURIComponent).join('/') + (n.folder && path ? '/' : ''), this.base).pathname;
    const props = Object.entries(n.props)
      .map(([k, v]) => `<x:${k}>${esc(v)}</x:${k}>`)
      .join('');
    return (
      `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
      `<D:resourcetype>${n.folder ? '<D:collection/>' : ''}</D:resourcetype>` +
      `<D:getetag>${esc(n.etag)}</D:getetag><D:getlastmodified>${new Date(n.modified).toUTCString()}</D:getlastmodified>` +
      `<D:creationdate>${n.created}</D:creationdate>${n.folder ? '' : `<D:getcontentlength>${n.content.length}</D:getcontentlength>`}${props}` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    this.requests.push(`${method} ${url.pathname}`);
    const expected = `Basic ${btoa(`${this.username}:${this.password}`)}`;
    if (headers.get('Authorization') !== expected) return new Response('unauthorized', { status: 401 });
    const path = this.pathOf(url);
    if (path === undefined) return new Response('forbidden', { status: 403 });
    const node = this.nodes.get(path);
    // Strict servers (Apache mod_dav) refuse a file addressed like a folder.
    if (node && !node.folder && url.pathname.endsWith('/')) return new Response('not found', { status: 404 });
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

    if (method === 'PROPFIND') {
      if (!node) return new Response('not found', { status: 404 });
      const depth = headers.get('Depth') ?? '1';
      const list = [this.entry(path, node)];
      if (node.folder && depth === '1') {
        for (const [p, n] of this.nodes) {
          if (p && p !== path && (path ? p.startsWith(`${path}/`) : true) && !p.slice(path ? path.length + 1 : 0).includes('/')) list.push(this.entry(p, n));
        }
      }
      return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:x="https://github.com/musayazlik/marksync">${list.join('')}</D:multistatus>`, {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      });
    }
    if (method === 'MKCOL') {
      if (node) return new Response('exists', { status: 405 });
      if (!this.nodes.get(parent)?.folder) return new Response('no parent', { status: 409 });
      this.nodes.set(path, this.node(true));
      return new Response(null, { status: 201 });
    }
    if (method === 'PUT') {
      if (!this.nodes.get(parent)?.folder) return new Response('no parent', { status: 409 });
      if (headers.get('If-None-Match') === '*' && node) return new Response('exists', { status: 412 });
      const match = headers.get('If-Match');
      if (match && (!node || node.etag !== match)) return new Response('changed', { status: 412 });
      const body = String(init.body ?? '');
      if (node) {
        node.content = body;
        node.etag = `"e${this.seq++}"`;
        node.modified = new Date((this.clock += 1000)).toISOString();
      } else this.nodes.set(path, this.node(false, body));
      return new Response(null, { status: node ? 204 : 201 });
    }
    if (method === 'PROPPATCH') {
      if (!node) return new Response('not found', { status: 404 });
      for (const m of String(init.body).matchAll(/<m:(\w+)>([^<]*)<\/m:\1>/g)) node.props[m[1]!] = m[2]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      return new Response('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"/>', { status: 207 });
    }
    if (!node) return new Response('not found', { status: 404 });
    if (method === 'GET') return new Response(node.content, { status: 200 });
    if (method === 'DELETE') {
      for (const p of [...this.nodes.keys()]) if (p === path || p.startsWith(`${path}/`)) this.nodes.delete(p);
      return new Response(null, { status: 204 });
    }
    return new Response('method not allowed', { status: 405 });
  };
}
