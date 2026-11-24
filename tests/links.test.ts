import { describe, expect, it } from 'vitest';
import {
  classify,
  hostOf,
  isCheckable,
  isMeaningfulRedirect,
  listCheckable,
  parseWayback,
  shouldRetryWithGet,
  waybackLookupUrl,
  type LinkTreeNode,
} from '../src/core/links';

describe('classify', () => {
  const url = 'https://example.com/page';

  it('treats a missing or removed page as dead', () => {
    expect(classify(url, { status: 404 })).toEqual({ status: 'dead', reason: 'not-found', httpStatus: 404 });
    expect(classify(url, { status: 410 })).toEqual({ status: 'dead', reason: 'gone', httpStatus: 410 });
  });

  it('treats an unreachable site as dead, but a slow one only as unclear', () => {
    expect(classify(url, { error: 'network' })).toEqual({ status: 'dead', reason: 'unreachable' });
    expect(classify(url, { error: 'timeout' })).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('never calls sign-in walls, rate limits or server errors dead', () => {
    expect(classify(url, { status: 401 }).status).toBe('unknown');
    expect(classify(url, { status: 403 }).reason).toBe('needs-sign-in');
    expect(classify(url, { status: 429 }).reason).toBe('rate-limited');
    expect(classify(url, { status: 503 })).toEqual({ status: 'unknown', reason: 'server-error', httpStatus: 503 });
    expect(classify(url, { status: 418 }).reason).toBe('other-status');
    expect(classify(url, {}).status).toBe('unknown');
  });

  it('reports a page that moved somewhere else', () => {
    expect(classify(url, { status: 200, finalUrl: 'https://example.org/new-home' })).toEqual({
      status: 'redirected',
      reason: 'moved',
      httpStatus: 200,
      finalUrl: 'https://example.org/new-home',
    });
  });

  it('ignores redirects that only add https, a slash or tracking', () => {
    expect(classify('http://example.com/page', { status: 200, finalUrl: 'https://example.com/page/' })).toEqual({
      status: 'ok',
      httpStatus: 200,
    });
    expect(classify(url, { status: 200, finalUrl: `${url}?utm_source=x` }).status).toBe('ok');
    expect(classify(url, { status: 204 }).status).toBe('ok');
  });
});

describe('isMeaningfulRedirect', () => {
  it('compares normalized addresses', () => {
    expect(isMeaningfulRedirect('https://a.com/x', undefined)).toBe(false);
    expect(isMeaningfulRedirect('https://a.com/x', 'https://a.com/x')).toBe(false);
    expect(isMeaningfulRedirect('https://www.a.com/x', 'https://a.com/x#top')).toBe(false);
    expect(isMeaningfulRedirect('https://a.com/x', 'https://a.com/login')).toBe(true);
  });
});

describe('shouldRetryWithGet', () => {
  it('retries answers that HEAD often gets wrong', () => {
    for (const status of [400, 403, 404, 405, 501, 500, 502]) expect(shouldRetryWithGet({ status })).toBe(true);
    expect(shouldRetryWithGet({ error: 'network' })).toBe(true);
  });

  it('accepts clear answers', () => {
    for (const status of [200, 301, 401, 410, 429]) expect(shouldRetryWithGet({ status })).toBe(false);
    expect(shouldRetryWithGet({ error: 'timeout' })).toBe(false);
  });
});

describe('isCheckable', () => {
  it('checks ordinary web pages', () => {
    expect(isCheckable('https://example.com/')).toBe(true);
    expect(isCheckable('http://8.8.8.8/')).toBe(true);
    expect(isCheckable('https://fcbarcelona.com/')).toBe(true);
    expect(isCheckable('https://[2001:db8::1]/')).toBe(true);
  });

  it('skips anything that is not a web page', () => {
    for (const url of [undefined, '', 'not a url', 'javascript:alert(1)', 'file:///etc/hosts', 'chrome://settings', 'ftp://example.com/']) {
      expect(isCheckable(url)).toBe(false);
    }
  });

  it('never probes this computer or the local network', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://printer.local/',
      'https://wiki.corp.internal/',
      'http://nas/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.20.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.1.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(isCheckable(url), url).toBe(false);
    }
    expect(isCheckable('http://172.32.0.1/')).toBe(true);
  });
});

describe('Wayback Machine', () => {
  it('builds the lookup address', () => {
    expect(waybackLookupUrl('https://a.com/x?y=1&z=2')).toBe(
      'https://archive.org/wayback/available?url=https%3A%2F%2Fa.com%2Fx%3Fy%3D1%26z%3D2',
    );
  });

  it('reads the closest working snapshot', () => {
    const body = {
      archived_snapshots: {
        closest: {
          available: true,
          status: '200',
          url: 'http://web.archive.org/web/20190102030405/https://a.com/x',
          timestamp: '20190102030405',
        },
      },
    };
    expect(parseWayback(body)).toEqual({
      url: 'https://web.archive.org/web/20190102030405/https://a.com/x',
      at: Date.UTC(2019, 0, 2, 3, 4, 5),
    });
  });

  it('rejects missing, broken or foreign snapshots', () => {
    expect(parseWayback(null)).toBeUndefined();
    expect(parseWayback({ archived_snapshots: {} })).toBeUndefined();
    const snap = (extra: Record<string, unknown>) => ({
      archived_snapshots: {
        closest: { available: true, status: '200', url: 'https://web.archive.org/web/2019/https://a.com', ...extra },
      },
    });
    expect(parseWayback(snap({ available: false }))).toBeUndefined();
    expect(parseWayback(snap({ status: '404' }))).toBeUndefined();
    expect(parseWayback(snap({ url: 'https://evil.example/web/2019/https://a.com' }))).toBeUndefined();
    expect(parseWayback(snap({ url: 'not a url' }))).toBeUndefined();
    expect(parseWayback(snap({}))).toEqual({ url: 'https://web.archive.org/web/2019/https://a.com' });
  });
});

describe('hostOf', () => {
  it('returns the lower-case host or nothing', () => {
    expect(hostOf('https://Example.COM/x')).toBe('example.com');
    expect(hostOf('nope')).toBe('');
  });
});

describe('listCheckable', () => {
  const tree: LinkTreeNode[] = [
    {
      id: 'root',
      title: '',
      children: [
        {
          id: 'bar',
          title: 'Bookmarks bar',
          children: [
            { id: 'a', title: 'A', url: 'https://a.com/' },
            { id: 'sep', title: '', type: 'separator', url: 'data:' },
            { id: 'js', title: 'Bookmarklet', url: 'javascript:void(0)' },
            { id: 'lan', title: 'Router', url: 'http://192.168.1.1/' },
            {
              id: 'dev',
              title: ' Dev ',
              children: [{ id: 'b', title: 'B', url: 'https://b.com/' }],
            },
            { id: 'inbox', title: 'Inbox', children: [{ id: 'c', title: 'C', url: 'https://c.com/' }] },
            { id: 'empty', title: '', children: [{ id: 'd', title: 'D', url: 'https://d.com/' }] },
          ],
        },
        { id: 'managed', title: 'Managed', unmodifiable: 'managed', children: [{ id: 'm', title: 'M', url: 'https://m.com/' }] },
      ],
    },
  ];

  it('lists web bookmarks with their folder path', () => {
    expect(listCheckable(tree, { exclude: ['inbox'] })).toEqual([
      { id: 'a', title: 'A', url: 'https://a.com/', folderPath: 'Bookmarks bar' },
      { id: 'b', title: 'B', url: 'https://b.com/', folderPath: 'Bookmarks bar / Dev' },
      { id: 'd', title: 'D', url: 'https://d.com/', folderPath: 'Bookmarks bar / (untitled)' },
    ]);
  });
});
