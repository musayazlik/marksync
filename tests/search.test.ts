import { describe, expect, it } from 'vitest';
import { flattenBookmarks, fold, isOpenable, matchRanges, searchBookmarks } from '../src/core/search';

const tree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: 'a', title: 'GitHub – Marksync', url: 'https://github.com/musayazlik/marksync' },
          {
            id: 'w',
            title: 'Work',
            children: [
              { id: 'b', title: 'Postgres indexing guide', url: 'https://www.example.com/pg-index' },
              { id: 'c', title: 'İstanbul kafe listesi', url: 'https://kafeler.example/' },
            ],
          },
          { id: 'j', title: 'Bookmarklet', url: 'javascript:alert(1)' },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [{ id: 'd', title: '', url: 'https://www.café.example/menu' }] },
    ],
  },
];

describe('bookmark search', () => {
  const items = flattenBookmarks(tree, (id) => (id === 'b' ? 'Database documentation' : undefined));

  it('flattens openable bookmarks with their folder path', () => {
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(items[1]).toMatchObject({ host: 'example.com', path: 'Bookmarks bar / Work', about: 'Database documentation' });
    expect(items[3]!.title).toBe('https://www.café.example/menu');
    expect(isOpenable('javascript:void 0')).toBe(false);
    expect(isOpenable('https://x.example/')).toBe(true);
  });

  it('needs every word, in any field, ignoring case and accents', () => {
    const ids = (q: string) => searchBookmarks(items, q).hits.map((h) => h.item.id);
    expect(ids('postgres')).toEqual(['b']);
    expect(ids('work guide')).toEqual(['b']);
    expect(ids('database')).toEqual(['b']);
    expect(ids('istanbul')).toEqual(['c']);
    expect(ids('ISTANBUL')).toEqual(['c']);
    expect(ids('cafe')).toEqual(['d']);
    expect(ids('github marksync')).toEqual(['a']);
    expect(ids('postgres nothing')).toEqual([]);
    expect(ids('   ')).toEqual([]);
  });

  it('ranks title matches above address and folder matches', () => {
    const extra = [...items, { id: 'e', title: 'Notes', url: 'https://work.example/', host: 'work.example', path: 'Other' }];
    const order = searchBookmarks(extra, 'work').hits.map((h) => h.item.id);
    // The host match comes before the two bookmarks that only sit in the Work folder.
    expect(order[0]).toBe('e');
    expect(order.slice(1).sort()).toEqual(['b', 'c']);
    const titled = [...items, { id: 'f', title: 'Work', url: 'https://f.example/', host: 'f.example', path: '' }];
    expect(searchBookmarks(titled, 'work').hits[0]!.item.id).toBe('f');
  });

  it('caps the hits but reports the total', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `${i}`, title: `Doc ${i}`, url: `https://d.example/${i}`, host: 'd.example', path: '' }));
    const r = searchBookmarks(many, 'doc', 40);
    expect(r.hits).toHaveLength(40);
    expect(r.total).toBe(120);
  });

  it('finds the ranges to highlight in the original text', () => {
    expect(fold('İSTANBUL Café')).toBe('istanbul cafe');
    expect(matchRanges('İstanbul kafe listesi', 'istanbul kafe')).toEqual([
      [0, 8],
      [9, 13],
    ]);
    expect(matchRanges('Café Café', 'cafe')).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(matchRanges('abc', '')).toEqual([]);
  });
});
