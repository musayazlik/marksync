import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  dequantize,
  dot,
  hashText,
  nearest,
  normalise,
  parseEmbeddings,
  quantize,
  sanitizeIndexFile,
  semanticText,
} from '../src/core/semantic';
import { buildIndex, searchByMeaning, semanticStatus } from '../src/services/semantic-service';
import { DEFAULT_SETTINGS, openRouterKeyItem, semanticIndexItem, semanticJobItem, settingsItem, statusItem, syncStateItem } from '../src/shared/state';
import { FakeBookmarks } from './fakes';

describe('semantic index helpers', () => {
  it('indexes title, address without the query, site notes and tags', () => {
    const text = semanticText({
      title: 'Bread basics',
      url: 'https://bake.example/bread?session=secret',
      site: { name: 'Bake', category: 'Recipe', summary: 'How to bake bread.' },
      tags: ['baking', 'bread'],
    });
    expect(text).toContain('bake.example/bread');
    expect(text).not.toContain('secret');
    expect(text).toContain('How to bake bread.');
    expect(text).toContain('baking, bread');
  });

  it('notices changed text by hash', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
  });

  it('stores vectors in one byte per dimension and keeps their direction', () => {
    const v = Array.from({ length: 256 }, (_, i) => Math.sin(i * 1.3) * 3);
    const e = quantize(v, 'h');
    expect(e.v.length).toBe(Math.ceil(256 / 3) * 4);
    expect(dot(dequantize(e), normalise(v))).toBeGreaterThan(0.999);
  });

  it('ranks the closest vectors first and drops weak matches', () => {
    const q = normalise([1, 0, 0]);
    const hits = nearest(q, [
      ['far', normalise([0, 1, 0])],
      ['close', normalise([0.9, 0.1, 0])],
      ['closest', normalise([1, 0.01, 0])],
    ]);
    expect(hits.map((h) => h.id)).toEqual(['closest', 'close']);
  });

  it('checks the embeddings answer', () => {
    expect(parseEmbeddings({ data: [{ index: 1, embedding: [3] }, { index: 0, embedding: [2] }], usage: { cost: 0.01 } }, 2)).toEqual({
      vectors: [[2], [3]],
      cost: 0.01,
    });
    expect(() => parseEmbeddings({ data: [{ embedding: [1] }] }, 2)).toThrow();
    expect(() => parseEmbeddings({ data: [{ embedding: [1, 2] }, { embedding: [1] }] }, 2)).toThrow();
    expect(() => parseEmbeddings({ data: [{ embedding: ['x'] }] }, 1)).toThrow();
  });

  it('only trusts well-formed index files', () => {
    const good = quantize([1, 2, 3], 'h');
    const file = sanitizeIndexFile({ schema: 1, kind: 'marksync-semantic', model: 'm', dims: 3, items: { a: good, b: { ...good, v: 'short' }, c: { h: 1 } }, updatedAt: 5 });
    expect(Object.keys(file!.items)).toEqual(['a']);
    expect(sanitizeIndexFile({ kind: 'other' })).toBeUndefined();
  });
});

describe('indexing and searching', () => {
  // A toy embedding: counts of a few topic words, so related texts point the same way.
  const topics = ['bread', 'dough', 'bake', 'code', 'git', 'news'];
  const vectorOf = (text: string) => {
    const lower = text.toLowerCase();
    const synonyms: Record<string, string> = { rise: 'bread', yeast: 'bread', repository: 'git' };
    const words = lower.split(/\W+/).map((w) => synonyms[w] ?? w);
    return topics.map((t) => words.filter((w) => w.startsWith(t)).length + 0.01);
  };
  let calls: string[][];

  beforeEach(async () => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    calls = [];
    fakeBrowser.permissions.contains = (async () => true) as typeof fakeBrowser.permissions.contains;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      calls.push(input);
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })), usage: { cost: 0.0001 } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const b = new FakeBookmarks('chromium');
    (fakeBrowser as unknown as { bookmarks: FakeBookmarks }).bookmarks = b;
    const bread = await b.add('1', 'Bread baking basics', 'https://bake.example/bread');
    const git = await b.add('1', 'Pro Git book', 'https://git-scm.example/book');
    await syncStateItem.setValue({ mapping: { [bread]: 'rb', [git]: 'rg' }, mirror: { rb: rec('rb'), rg: rec('rg') }, keep: [] });
    await statusItem.setValue({ connected: false, syncing: false });
    await openRouterKeyItem.setValue('sk-or-test-key-123456789');
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, semanticEnabled: true });
  });
  const rec = (id: string) => ({ id, kind: 'bookmark' as const, parentId: 'toolbar', index: 0, title: id, url: `https://${id}/`, contentAt: 1, positionAt: 1 });

  const waitIndexed = async () => {
    for (let i = 0; i < 100 && (await semanticJobItem.getValue())?.state === 'indexing'; i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('indexes once, then only what changed, and finds by meaning without shared words', async () => {
    expect((await semanticStatus()).pending).toBe(2);
    await buildIndex();
    await waitIndexed();
    expect((await semanticJobItem.getValue())?.state).toBe('done');
    expect(calls).toHaveLength(1);
    expect(Object.keys((await semanticIndexItem.getValue())!.items).sort()).toEqual(['rb', 'rg']);

    // Nothing changed: nothing to embed.
    expect((await semanticStatus()).pending).toBe(0);

    // "how does yeast make it rise" shares no word with "Bread baking basics".
    const hits = await searchByMeaning('how does yeast make it rise');
    expect(hits[0]?.id).toBe(Object.keys((await syncStateItem.getValue()).mapping)[0]);
  });

  it('is opt-in', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS);
    await expect(buildIndex()).rejects.toThrow('semOff');
    expect(calls).toHaveLength(0);
  });

  it('refuses the on-device model', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, semanticEnabled: true, aiProvider: 'builtin' });
    expect((await semanticStatus()).problem).toBe('semNoBuiltin');
  });
});
