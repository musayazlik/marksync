import { describe, expect, it } from 'vitest';
import { extraCopies, findDuplicates, normalizeUrl, type DedupeTreeNode } from '../src/core/dedupe';
import { removeCopies } from '../src/sync/dedupe';
import { FakeBookmarks } from './fakes';

describe('normalizeUrl', () => {
  it('treats the differences that never change the page as equal', () => {
    const same = [
      'https://Example.com/docs/',
      'http://example.com/docs',
      'https://example.com:443/docs?utm_source=newsletter&utm_medium=email',
      'https://example.com/docs#intro',
      'https://example.com/docs?fbclid=abc&gclid=x',
      'https://example.com./docs',
    ];
    expect(new Set(same.map(normalizeUrl))).toEqual(new Set(['example.com/docs']));
  });

  it('keeps what can change the page', () => {
    expect(normalizeUrl('https://example.com/docs?page=2')).toBe('example.com/docs?page=2');
    expect(normalizeUrl('https://example.com/docs?b=2&a=1')).toBe(normalizeUrl('https://example.com/docs?a=1&b=2'));
    expect(normalizeUrl('https://example.com/Docs')).not.toBe(normalizeUrl('https://example.com/docs'));
    expect(normalizeUrl('https://example.com:8080/')).toBe('example.com:8080/');
    expect(normalizeUrl('https://www.example.com/')).not.toBe(normalizeUrl('https://example.com/'));
    // App routes live in the fragment.
    expect(normalizeUrl('https://mail.example.com/#/inbox')).not.toBe(normalizeUrl('https://mail.example.com/#/sent'));
    expect(normalizeUrl('https://example.com/#!/page')).toBe('example.com/#!/page');
    expect(normalizeUrl('https://example.com')).toBe('example.com/');
  });

  it('ignores anything that is not a web page', () => {
    for (const url of ['javascript:alert(1)', 'place:sort=8', 'data:text/plain,x', 'file:///c:/a.html', 'not a url', '', undefined]) {
      expect(normalizeUrl(url)).toBeUndefined();
    }
  });
});

const bm = (id: string, url: string, dateAdded?: number): DedupeTreeNode => ({ id, title: id, url, dateAdded });
const folder = (id: string, title: string, children: DedupeTreeNode[]): DedupeTreeNode => ({ id, title, children });

describe('findDuplicates', () => {
  const tree = [
    folder('0', '', [
      folder('1', 'Bookmarks bar', [
        bm('a', 'https://example.com/docs', 300),
        folder('w', 'Work', [folder('d', 'Docs', [bm('b', 'http://example.com/docs/', 300)])]),
        bm('c', 'https://other.example/', 50),
      ]),
      folder('2', 'Other bookmarks', [
        bm('e', 'https://example.com/docs?utm_source=x', 100),
        bm('f', 'https://other.example', 10),
        bm('g', 'javascript:void(0)'),
        bm('h', 'javascript:void(0)'),
        { id: 'm', title: 'Managed', url: 'https://other.example/', unmodifiable: 'managed' },
      ]),
      folder('8', 'Trash', [bm('t', 'https://example.com/docs', 1)]),
    ]),
  ];

  it('groups copies of the same page, biggest first, oldest copy suggested to keep', () => {
    const groups = findDuplicates(tree, { exclude: ['8'] });
    expect(groups.map((g) => g.key)).toEqual(['example.com/docs', 'other.example/']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['e', 'b', 'a']);
    expect(groups[0]!.items[1]!.folderPath).toBe('Bookmarks bar / Work / Docs');
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['f', 'c']);
    expect(extraCopies(groups)).toBe(3);
  });

  it('prefers the copy filed deepest when dates are equal or unknown', () => {
    const groups = findDuplicates([
      folder('0', '', [
        folder('1', 'Bar', [bm('a', 'https://x.example/'), folder('w', 'Work', [bm('b', 'https://x.example/')])]),
      ]),
    ]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('skips excluded folders, managed bookmarks and non-web addresses', () => {
    const ids = findDuplicates(tree, { exclude: ['8'] }).flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain('t');
    expect(ids).not.toContain('m');
    expect(ids).not.toContain('g');
  });
});

describe('removeCopies', () => {
  it('removes only copies that still match what was listed', async () => {
    for (const flavor of ['chromium', 'firefox'] as const) {
      const b = new FakeBookmarks(flavor);
      const bar = b.root('toolbar');
      const keep = await b.add(bar, 'Docs', 'https://example.com/docs');
      const dupe = await b.add(b.root('other'), 'Docs again', 'http://example.com/docs/');
      const changed = await b.add(b.root('other'), 'Docs 3', 'https://example.com/docs?utm_source=x');
      const folderId = await b.add(bar, 'A folder');
      const groups = findDuplicates(await b.getTree());
      expect(groups).toHaveLength(1);
      expect(groups[0]!.items).toHaveLength(3);

      // The user edits one copy after the scan: it must survive.
      await b.update(changed, { url: 'https://example.com/other-page' });
      const result = await removeCopies(b, {
        [dupe]: 'example.com/docs',
        [changed]: 'example.com/docs',
        [folderId]: 'example.com/docs',
        missing: 'example.com/docs',
      });
      expect(result).toEqual({ removed: 1, skipped: 3 });
      const left = findDuplicates(await b.getTree());
      expect(left).toEqual([]);
      const urls = JSON.stringify(await b.getTree());
      expect(urls).toContain(keep);
      expect(urls).toContain('other-page');
    }
  });
});
