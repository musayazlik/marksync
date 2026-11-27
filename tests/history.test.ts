import { describe, expect, it } from 'vitest';
import { diffBackup, findInBackup, planRestore } from '../src/core/history';
import type { RecordMap, SyncRecord } from '../src/core/types';
import { runRestorePlan } from '../src/services/history-service';
import { FakeBookmarks } from './fakes';

const rec = (id: string, parentId: string, index: number, title: string, url?: string, deletedAt?: number): SyncRecord => ({
  id,
  kind: url === undefined ? 'folder' : 'bookmark',
  parentId,
  index,
  title,
  ...(url !== undefined ? { url } : {}),
  contentAt: 1,
  positionAt: 1,
  ...(deletedAt !== undefined ? { deletedAt } : {}),
});

const map = (...records: SyncRecord[]): RecordMap => Object.fromEntries(records.map((r) => [r.id, r]));

/**
 * Backup: Bar / Work (docs, wiki), Bar / Recipes (pasta, soup), Bar / news.
 * Now: Recipes is gone, wiki moved to the bar, docs renamed, news reordered,
 * a new folder "Games" with one bookmark.
 */
function fixture() {
  const backup = map(
    rec('work', 'toolbar', 0, 'Work'),
    rec('docs', 'work', 0, 'Docs', 'https://docs.example/'),
    rec('wiki', 'work', 1, 'Wiki', 'https://wiki.example/'),
    rec('recipes', 'toolbar', 1, 'Recipes'),
    rec('pasta', 'recipes', 0, 'Pasta', 'https://food.example/pasta'),
    rec('soup', 'recipes', 1, 'Soup', 'https://food.example/soup'),
    rec('news', 'toolbar', 2, 'News', 'https://news.example/'),
  );
  const current = map(
    rec('work', 'toolbar', 0, 'Work'),
    rec('docs', 'work', 0, 'Docs (old)', 'https://docs.example/v2'),
    rec('wiki', 'toolbar', 3, 'Wiki', 'https://wiki.example/'),
    rec('news', 'toolbar', 0, 'News', 'https://news.example/'),
    rec('games', 'other', 0, 'Games'),
    rec('chess', 'games', 0, 'Chess', 'https://chess.example/'),
    // Deleted records (tombstones) count as gone.
    rec('recipes', 'toolbar', 1, 'Recipes', undefined, 5),
  );
  return { backup, current };
}

describe('diffBackup', () => {
  it('lists removed, moved, renamed and added items, with folders collapsed', () => {
    const { backup, current } = fixture();
    const { changes, counts } = diffBackup(backup, current);
    expect(counts).toEqual({ removed: 1, moved: 1, renamed: 1, added: 1 });
    const by = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(Object.keys(by).sort()).toEqual(['docs', 'games', 'recipes', 'wiki']);
    expect(by.recipes).toMatchObject({ kind: 'removed', nodeKind: 'folder', inside: 2, folder: { root: 'toolbar', folders: [] } });
    expect(by.wiki).toMatchObject({ kind: 'moved', folder: { root: 'toolbar', folders: ['Work'] }, movedTo: { root: 'toolbar', folders: [] } });
    expect(by.docs).toMatchObject({ kind: 'renamed', title: 'Docs (old)', before: { title: 'Docs', url: 'https://docs.example/' } });
    expect(by.games).toMatchObject({ kind: 'added', inside: 1, restorable: false });
  });

  it('does not list a pure reorder', () => {
    const { backup, current } = fixture();
    expect(diffBackup(backup, current).changes.some((c) => c.id === 'news')).toBe(false);
  });

  it('marks an item both moved and renamed', () => {
    const backup = map(rec('a', 'toolbar', 0, 'A'), rec('x', 'a', 0, 'X', 'https://x.example/'));
    const current = map(rec('a', 'toolbar', 0, 'A'), rec('x', 'toolbar', 1, 'X2', 'https://x.example/'));
    const [change] = diffBackup(backup, current).changes;
    expect(change).toMatchObject({ kind: 'moved', before: { title: 'X' } });
    expect(diffBackup(backup, current).counts).toMatchObject({ moved: 1, renamed: 1 });
  });
});

describe('planRestore', () => {
  it('recreates a removed folder with its contents, parents first', () => {
    const { backup, current } = fixture();
    const ops = planRestore(backup, current, ['recipes']);
    expect(ops.map((o) => [o.op, o.id])).toEqual([
      ['create', 'recipes'],
      ['create', 'pasta'],
      ['create', 'soup'],
    ]);
    expect(ops[0]).toMatchObject({ parent: { root: 'toolbar' }, index: 1 });
    expect(ops[1]).toMatchObject({ parent: { created: 'recipes' }, url: 'https://food.example/pasta' });
  });

  it('does not create a chosen item twice when its folder is chosen too', () => {
    const { backup, current } = fixture();
    const ops = planRestore(backup, current, ['soup', 'recipes', 'pasta']);
    expect(ops.filter((o) => o.op === 'create')).toHaveLength(3);
  });

  it('puts an item whose folder is gone into the fallback folder', () => {
    const { backup, current } = fixture();
    expect(planRestore(backup, current, ['soup'])).toEqual([
      { op: 'create', id: 'soup', kind: 'bookmark', title: 'Soup', url: 'https://food.example/soup', parent: { fallback: true }, index: 1 },
    ]);
  });

  it('moves back and renames back, and skips added items', () => {
    const { backup, current } = fixture();
    expect(planRestore(backup, current, ['wiki', 'docs', 'games', 'chess', 'unknown'])).toEqual([
      { op: 'update', id: 'docs', title: 'Docs', url: 'https://docs.example/' },
      { op: 'move', id: 'wiki', parent: { record: 'work' }, index: 1 },
    ]);
  });
});

describe('findInBackup', () => {
  it('finds bookmarks by title or address, with their folder', () => {
    const { backup } = fixture();
    expect(findInBackup(backup, 'FOOD.example')).toEqual([
      { title: 'Pasta', url: 'https://food.example/pasta', folder: { root: 'toolbar', folders: ['Recipes'] } },
      { title: 'Soup', url: 'https://food.example/soup', folder: { root: 'toolbar', folders: ['Recipes'] } },
    ]);
    expect(findInBackup(backup, '  ')).toEqual([]);
  });
});

describe('runRestorePlan', () => {
  it('carries out a plan in a browser without touching anything else', async () => {
    const b = new FakeBookmarks('chromium');
    const work = await b.add('1', 'Work');
    const docs = await b.add(work, 'Docs (old)', 'https://docs.example/v2');
    const wiki = await b.add('1', 'Wiki', 'https://wiki.example/');
    const keep = await b.add('2', 'Untouched', 'https://keep.example/');
    const { backup, current } = fixture();
    const ops = planRestore(backup, current, ['recipes', 'wiki', 'docs']);
    const result = await runRestorePlan(b, ops, {
      local: new Map([
        ['work', work],
        ['docs', docs],
        ['wiki', wiki],
      ]),
      roots: { toolbar: '1', other: '2' },
      fallbackTitle: 'Restored',
    });
    expect(result).toEqual({ restored: 5, failed: 0 });

    const bar = await b.getChildren('1');
    expect(bar.map((n) => n.title)).toEqual(['Work', 'Recipes']);
    const recipes = bar.find((n) => n.title === 'Recipes')!;
    expect((await b.getChildren(recipes.id)).map((n) => n.title)).toEqual(['Pasta', 'Soup']);
    expect((await b.getChildren(work)).map((n) => [n.title, n.url])).toEqual([
      ['Docs', 'https://docs.example/'],
      ['Wiki', 'https://wiki.example/'],
    ]);
    expect((await b.getChildren('2')).map((n) => n.id)).toEqual([keep]);
  });

  it('creates the fallback folder once, under Other bookmarks', async () => {
    const b = new FakeBookmarks('chromium');
    const { backup, current } = fixture();
    const ops = planRestore(backup, current, ['soup', 'pasta']);
    const result = await runRestorePlan(b, ops, { local: new Map(), roots: { toolbar: '1', other: '2' }, fallbackTitle: 'Restored' });
    expect(result).toEqual({ restored: 2, failed: 0, fallbackFolder: 'Restored' });
    const other = await b.getChildren('2');
    expect(other.map((n) => n.title)).toEqual(['Restored']);
    expect((await b.getChildren(other[0]!.id)).map((n) => n.title).sort()).toEqual(['Pasta', 'Soup']);
  });

  it('counts items it cannot restore', async () => {
    const b = new FakeBookmarks('chromium');
    const { backup, current } = fixture();
    // "wiki" is not in this browser.
    const result = await runRestorePlan(b, planRestore(backup, current, ['wiki']), {
      local: new Map([['work', '1']]),
      roots: { toolbar: '1', other: '2' },
      fallbackTitle: 'Restored',
    });
    expect(result).toEqual({ restored: 0, failed: 1 });
  });
});
