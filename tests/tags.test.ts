import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { listFolderOptions, parseSortReply } from '../src/core/ai-sort';
import { flattenBookmarks, searchBookmarks } from '../src/core/search';
import {
  cleanTag,
  mergeTags,
  parseTagInput,
  pruneTags,
  sanitizeTagsFile,
  tagCounts,
  tagMapsEqual,
  type TagMap,
} from '../src/core/tags';
import { setTags, syncTags, tagsByLocalId } from '../src/services/tags-service';
import { statusItem, syncStateItem, tagsItem, tokenItem } from '../src/shared/state';
import { FakeDrive } from './fake-drive';

describe('tag rules', () => {
  it('cleans tags and reads a comma separated list', () => {
    expect(cleanTag('  #Italian   Food ')).toBe('italian food');
    expect(cleanTag('a\u0000b')).toBe('a b');
    expect(cleanTag('   ')).toBeUndefined();
    expect(cleanTag('x'.repeat(50))).toHaveLength(32);
    expect(parseTagInput('Recipe, recipe, , quick,#dinner')).toEqual(['recipe', 'quick', 'dinner']);
  });

  it('keeps the newest edit of each bookmark, whichever side merges first', () => {
    const chrome: TagMap = { a: { tags: ['work'], at: 10 }, b: { tags: ['news'], at: 5 } };
    const firefox: TagMap = { a: { tags: ['docs'], at: 20 }, c: { tags: ['games'], at: 7 } };
    const merged = mergeTags(chrome, firefox);
    expect(merged).toEqual({ a: { tags: ['docs'], at: 20 }, b: { tags: ['news'], at: 5 }, c: { tags: ['games'], at: 7 } });
    expect(tagMapsEqual(merged, mergeTags(firefox, chrome))).toBe(true);
  });

  it('picks the same winner on equal clocks', () => {
    const x: TagMap = { a: { tags: ['one'], at: 3 } };
    const y: TagMap = { a: { tags: ['two'], at: 3 } };
    expect(mergeTags(x, y)).toEqual(mergeTags(y, x));
  });

  it('spreads a removal (empty list) and forgets it after a while', () => {
    const merged = mergeTags({ a: { tags: ['old'], at: 1 } }, { a: { tags: [], at: 2 } });
    expect(merged.a!.tags).toEqual([]);
    const later = 2 + 91 * 24 * 3600_000;
    expect(pruneTags(merged, new Set(['a']), later)).toEqual({});
  });

  it('drops tags of bookmarks that are gone', () => {
    expect(pruneTags({ a: { tags: ['x'], at: 1 }, gone: { tags: ['y'], at: 1 } }, new Set(['a']), 5)).toEqual({ a: { tags: ['x'], at: 1 } });
  });

  it('only trusts well-formed tag files', () => {
    const now = 1_000;
    expect(sanitizeTagsFile({ kind: 'other', schema: 1, items: {} }, now)).toEqual({});
    const items = JSON.parse('{"__proto__": {"tags": ["x"], "at": 1}, "a": {"tags": ["OK", 5, "ok"], "at": 99999999999}, "b": {"tags": "x", "at": 1}}');
    expect(sanitizeTagsFile({ kind: 'marksync-tags', schema: 1, items }, now)).toEqual({ a: { tags: ['ok'], at: now + 86_400_000 } });
  });

  it('counts tags, most used first', () => {
    expect(tagCounts([['b', 'a'], ['a'], []])).toEqual([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 1 },
    ]);
  });
});

describe('tags in search and AI sorting', () => {
  const tree = [
    {
      id: '0',
      title: '',
      children: [
        { id: '1', title: 'Pasta', url: 'https://food.example/pasta' },
        { id: '2', title: 'Soup', url: 'https://food.example/soup' },
        { id: '3', title: 'Docs', url: 'https://docs.example/' },
      ],
    },
  ];
  const tags: Record<string, string[]> = { '1': ['recipe', 'italian food'], '2': ['recipe'] };
  const items = flattenBookmarks(tree, undefined, undefined, (id) => tags[id]);

  it('filters by #tag, also by its start and with hyphens for spaces', () => {
    expect(searchBookmarks(items, '#recipe').hits.map((h) => h.item.title).sort()).toEqual(['Pasta', 'Soup']);
    expect(searchBookmarks(items, '#rec soup').hits.map((h) => h.item.title)).toEqual(['Soup']);
    expect(searchBookmarks(items, '#italian-food').hits.map((h) => h.item.title)).toEqual(['Pasta']);
    expect(searchBookmarks(items, '#nothing').total).toBe(0);
  });

  it('finds plain words in tags too', () => {
    expect(searchBookmarks(items, 'italian').hits.map((h) => h.item.title)).toEqual(['Pasta']);
  });

  it('reads up to three tags from the model', () => {
    const folders = listFolderOptions([{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [] }] }]);
    const d = parseSortReply('{"folder":"f1","confidence":0.9,"reason":"ok","tags":["Recipe","#Quick","a","b"]}', folders, { allowNewFolders: false });
    expect(d.tags).toEqual(['recipe', 'quick', 'a']);
  });
});

describe('tags sync through tags.json', () => {
  let drive: FakeDrive;
  const mirror = (ids: string[]) =>
    Object.fromEntries(ids.map((id, i) => [id, { id, kind: 'bookmark' as const, parentId: 'toolbar', index: i, title: id, url: `https://${id}.example/`, contentAt: 1, positionAt: 1 }]));

  /** A browser on the account where local bookmark `L<id>` is record `<id>`. */
  async function browserWith(ids: string[]) {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    await statusItem.setValue({ connected: true, syncing: false });
    await tokenItem.setValue({ accessToken: 'token', expiresAt: Date.now() + 3_600_000 });
    await syncStateItem.setValue({ mapping: Object.fromEntries(ids.map((id) => [`L${id}`, id])), mirror: mirror(ids), keep: [] });
  }

  beforeEach(() => {
    vi.useRealTimers();
    drive = new FakeDrive();
    vi.stubGlobal('fetch', drive.fetch);
  });

  it('carries tags to another browser and merges edits from both', async () => {
    await browserWith(['a', 'b']);
    await setTags('La', ['work']);
    await syncTags();
    expect(drive.byName('tags.json')).toHaveLength(1);

    // Second browser: sees the tag, adds its own.
    await browserWith(['a', 'b']);
    await syncTags();
    expect(await tagsByLocalId()).toEqual({ La: ['work'] });
    await setTags('Lb', ['news']);
    await syncTags();

    const file = JSON.parse(drive.byName('tags.json')[0]!.content) as { items: TagMap };
    expect(Object.keys(file.items).sort()).toEqual(['a', 'b']);
  });

  it('keeps tags of a bookmark that is not synced yet until it gets its shared ID', async () => {
    await browserWith(['a']);
    await setTags('Lnew', ['later']);
    await syncTags();
    expect((await tagsItem.getValue()).pending).toHaveProperty('Lnew');
    // The next sync gave the bookmark an ID.
    await syncStateItem.setValue({ mapping: { La: 'a', Lnew: 'n' }, mirror: mirror(['a', 'n']), keep: [] });
    await syncTags();
    const store = await tagsItem.getValue();
    expect(store.pending).toEqual({});
    expect(store.items.n!.tags).toEqual(['later']);
  });

  it('lets AI sorting fill tags only when the bookmark has none', async () => {
    await browserWith(['a']);
    await setTags('La', ['mine']);
    expect(await setTags('La', ['model'], { onlyIfEmpty: true })).toEqual(['mine']);
    expect(await tagsByLocalId()).toEqual({ La: ['mine'] });
  });

  it('does not write the file when nothing changed', async () => {
    await browserWith(['a']);
    await setTags('La', ['x']);
    await syncTags();
    const version = drive.byName('tags.json')[0]!.version;
    await syncTags();
    expect(drive.byName('tags.json')[0]!.version).toBe(version);
  });
});
