import { describe, expect, it } from 'vitest';
import type { SortTreeNode } from '../src/core/ai-sort';
import {
  emptyFolders,
  estimateCost,
  parseStructureReply,
  parseTitlesReply,
  tidyFolders,
  titleItems,
  type TidyProposal,
} from '../src/core/tidy';
import type { SortLogEntry } from '../src/shared/state';
import { applyTidy, undoTidy } from '../src/sync/tidy';
import { FakeBookmarks } from './fakes';

const tree: SortTreeNode[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: 'dev', title: 'Dev', children: [{ id: 'b1', title: 'MDN', url: 'https://developer.mozilla.org/' }] },
          {
            id: 'development',
            title: 'Development',
            children: [
              { id: 'b2', title: 'GitHub', url: 'https://github.com/' },
              { id: 'sub', title: 'Old', children: [{ id: 'deep', title: 'Deeper', children: [] }] },
            ],
          },
          { id: 'recipies', title: 'Recipies', children: [{ id: 'b3', title: 'https://food.example/p?id=1', url: 'https://food.example/p?id=1' }] },
          { id: 'empty', title: 'Empty', children: [] },
          { id: 'sep', title: 'Has separator', children: [{ id: 's1', title: '', type: 'separator' }] },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [] },
    ],
  },
];

const folders = tidyFolders(tree);
const refOf = (id: string) => folders.find((f) => f.localId === id)!.ref;
const siblingsOf = (id: string) => (id === 'recipies' ? ['Dev', 'Development', 'Empty', 'Has separator'] : []);

describe('tidy-up plan', () => {
  it('describes folders with counts and sample titles', () => {
    const dev = folders.find((f) => f.localId === 'development')!;
    expect(dev).toMatchObject({ path: 'Bookmarks bar / Development', bookmarks: 1, samples: ['GitHub'] });
  });

  it('limits folders to the chosen scope', () => {
    expect(tidyFolders(tree, { scopeId: 'development' }).map((f) => f.localId)).toEqual(['development', 'sub', 'deep']);
  });

  it('finds empty folders (the topmost of an empty chain), never top-level or kept ones', () => {
    const pathOf = (id: string) => id;
    expect(emptyFolders(tree, { pathOf }).map((e) => e.folderId).sort()).toEqual(['empty', 'sub']);
    expect(emptyFolders(tree, { pathOf, keep: ['empty'] }).map((e) => e.folderId)).toEqual(['sub']);
    expect(emptyFolders(tree, { pathOf, scopeId: 'development' }).map((e) => e.folderId)).toEqual(['sub']);
  });

  it('accepts sensible merges and renames and drops the rest', () => {
    const reply = JSON.stringify({
      merge: [
        { from: refOf('dev'), into: refOf('development'), reason: 'Same topic' },
        // Into its own subfolder: refused.
        { from: refOf('development'), into: refOf('sub') },
        // A top-level folder is fixed.
        { from: refOf('1'), into: refOf('2') },
        { from: 'f999', into: refOf('dev') },
        // "dev" is already merged away.
        { from: refOf('recipies'), into: refOf('dev') },
      ],
      rename: [
        { folder: refOf('recipies'), name: 'Recipes', reason: 'Typo' },
        // Already being merged.
        { folder: refOf('dev'), name: 'Code' },
        // Clashes with a sibling.
        { folder: refOf('empty'), name: 'x' },
      ],
    });
    const { merges, renames } = parseStructureReply(reply, folders, { fixed: ['1', '2'], siblingsOf });
    expect(merges.map((m) => [m.from.localId, m.into.localId, m.reason])).toEqual([['dev', 'development', 'Same topic']]);
    expect(renames.map((r) => [r.folder.localId, r.name])).toEqual([['recipies', 'Recipes']]);
  });

  it('refuses a rename that clashes with a sibling', () => {
    const reply = JSON.stringify({ merge: [], rename: [{ folder: refOf('recipies'), name: 'development' }] });
    expect(parseStructureReply(reply, folders, { siblingsOf }).renames).toEqual([]);
  });

  it('keeps only real title changes for offered bookmarks', () => {
    const items = titleItems([
      { id: 'b3', title: 'https://food.example/p?id=1', url: 'https://food.example/p?id=1' },
      { id: 'b1', title: 'MDN', url: 'https://developer.mozilla.org/' },
    ]);
    expect(items[0]!.address).toBe('food.example/p');
    // b1 is the food bookmark, b2 is MDN.
    const reply = JSON.stringify({
      titles: [
        { ref: 'b2', title: 'MDN' },
        { ref: 'b1', title: 'Pasta recipe' },
        { ref: 'b1', title: 'Again' },
        { ref: 'b9', title: 'Unknown ref' },
        { ref: 'b2', title: 'x' },
      ],
    });
    expect(parseTitlesReply(reply, items).map((r) => [r.item.id, r.title])).toEqual([['b3', 'Pasta recipe']]);
  });

  it('estimates the cost from the price per 1M tokens', () => {
    const requests = [
      { promptTokens: 10_000, completionTokens: 1_000 },
      { promptTokens: 2_000, completionTokens: 1_000 },
    ];
    expect(estimateCost(requests, { free: false, prompt: 3, completion: 15 })).toBeCloseTo(0.066, 6);
    expect(estimateCost(requests, { free: true })).toBe(0);
    expect(estimateCost(requests, { free: false })).toBeUndefined();
    expect(estimateCost(requests, undefined)).toBeUndefined();
  });
});

describe('applying and undoing tidy-up changes', () => {
  async function setup() {
    const b = new FakeBookmarks('chromium');
    const dev = await b.add('1', 'Dev');
    const mdn = await b.add(dev, 'MDN', 'https://developer.mozilla.org/');
    const css = await b.add(dev, 'CSS', 'https://css.example/');
    const development = await b.add('1', 'Development');
    const gh = await b.add(development, 'GitHub', 'https://github.com/');
    const empty = await b.add('1', 'Empty');
    return { b, dev, mdn, css, development, gh, empty };
  }
  const entry = (o: Awaited<ReturnType<typeof applyTidy>>): SortLogEntry => ({ id: 'log', at: 1, ...o });

  it('renames a bookmark and gives the old title back on undo', async () => {
    const { b, mdn } = await setup();
    const p: TidyProposal = { id: 'p', kind: 'retitle', bookmarkId: mdn, title: 'MDN', newTitle: 'MDN Web Docs', folderPath: 'Bar / Dev' };
    const out = await applyTidy(b, p, 'm');
    expect(out).toMatchObject({ status: 'tidied', tidy: { action: 'retitle', before: 'MDN', after: 'MDN Web Docs' } });
    expect((await b.getChildren((await b.getTree())[0]!.children![0]!.children![0]!.id))[0]!.title).toBe('MDN Web Docs');
    await undoTidy(b, entry(out));
    expect((await b.getTree())[0]!.children![0]!.children![0]!.children![0]!.title).toBe('MDN');
  });

  it('leaves a bookmark alone when its title changed since the plan', async () => {
    const { b, mdn } = await setup();
    await b.update(mdn, { title: 'Renamed by hand' });
    const out = await applyTidy(b, { id: 'p', kind: 'retitle', bookmarkId: mdn, title: 'MDN', newTitle: 'X', folderPath: '' }, 'm');
    expect(out.status).toBe('error');
  });

  it('merges a folder into another, and undo brings the folder and its items back', async () => {
    const { b, dev, mdn, css, development, gh } = await setup();
    const p: TidyProposal = { id: 'p', kind: 'merge', folderId: dev, title: 'Dev', folderPath: 'Bar / Dev', intoId: development, intoPath: 'Bar / Development', count: 2 };
    const out = await applyTidy(b, p, 'm');
    expect(out.status).toBe('tidied');
    expect((await b.getChildren(development)).map((c) => c.id)).toEqual([gh, mdn, css]);
    expect((await b.getChildren('1')).map((c) => c.title)).toEqual(['Development', 'Empty']);

    await undoTidy(b, entry(out));
    const bar = await b.getChildren('1');
    expect(bar.map((c) => c.title)).toEqual(['Dev', 'Development', 'Empty']);
    expect((await b.getChildren(bar[0]!.id)).map((c) => c.id)).toEqual([mdn, css]);
    expect((await b.getChildren(development)).map((c) => c.id)).toEqual([gh]);
  });

  it('removes an empty folder only while it is empty, and undo recreates it', async () => {
    const { b, empty } = await setup();
    const p: TidyProposal = { id: 'p', kind: 'remove', folderId: empty, title: 'Empty', folderPath: 'Bar / Empty' };
    await b.add(empty, 'Now full', 'https://full.example/');
    expect((await applyTidy(b, p, 'm')).status).toBe('error');

    const { b: b2, empty: empty2 } = await setup();
    const out = await applyTidy(b2, { ...p, folderId: empty2 }, 'm');
    expect(out.status).toBe('tidied');
    expect((await b2.getChildren('1')).map((c) => c.title)).toEqual(['Dev', 'Development']);
    await undoTidy(b2, entry(out));
    expect((await b2.getChildren('1')).map((c) => c.title)).toEqual(['Dev', 'Development', 'Empty']);
  });

  it('renames a folder and refuses to undo after it was renamed again', async () => {
    const { b, dev } = await setup();
    const out = await applyTidy(b, { id: 'p', kind: 'rename', folderId: dev, title: 'Dev', folderPath: 'Bar / Dev', name: 'Code' }, 'm');
    expect(out).toMatchObject({ status: 'tidied', toPath: 'Bookmarks bar / Code' });
    await b.update(dev, { title: 'Mine' });
    await expect(undoTidy(b, entry(out))).rejects.toMatchObject({ reason: 'moved' });
  });
});
