import { beforeEach, describe, expect, it } from 'vitest';
import { keyBetween, keysBetween, placeKeys, stableMask } from '../src/core/position';
import { childrenByParent, ensurePositions, mergeRecords, sanitize } from '../src/core/records';
import type { RecordMap, SyncRecord } from '../src/core/types';
import { sanitizeRemoteRecords } from '../src/core/validate';
import { syncOnce } from '../src/sync/engine';
import { dump, makeBrowser, MemoryRemote, type FakeBrowser } from './fakes';

describe('position keys', () => {
  it('finds a key between any two keys, and spreads many keys short', () => {
    expect(keyBetween(null, null)).toBe('i');
    expect(keyBetween('a', 'b') > 'a' && keyBetween('a', 'b') < 'b').toBe(true);
    expect(() => keyBetween('b', 'a')).toThrow();
    const keys = keysBetween(null, null, 2000);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(2000);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(3);
  });

  it('keeps the keys of the longest run still in order', () => {
    // b moved to the front: only b is unstable.
    expect(stableMask(['b', 'a', 'c', 'd'])).toEqual([false, true, true, true]);
    expect(stableMask([undefined, 'a', 'b'])).toEqual([false, true, true]);
  });

  it('gives moved and new items keys between their neighbours', () => {
    const out = placeKeys(['m', undefined, 'c', 't']);
    // In order, and two of the three old keys kept (the longest run still in order).
    expect([...out].sort()).toEqual(out);
    expect(out.filter((k) => ['m', 'c', 't'].includes(k))).toHaveLength(2);
    expect(out[3]).toBe('t');
  });
});

const rec = (id: string, parentId: string, index: number, extra: Partial<SyncRecord> = {}): SyncRecord => ({
  id,
  kind: 'bookmark',
  parentId,
  index,
  title: id,
  url: `https://${id}.example/`,
  contentAt: 1,
  positionAt: 1,
  ...extra,
});

describe('schema 1 migration', () => {
  it('gives every folder keys in its current order, the same in every browser', () => {
    const v1: RecordMap = { a: rec('a', 'toolbar', 1), b: rec('b', 'toolbar', 0), c: rec('c', 'other', 0) };
    const first = sanitize(v1, 10);
    const second = sanitize(structuredClone(v1), 10);
    expect(first).toEqual(second);
    const bar = childrenByParent(first).get('toolbar')!.map((r) => r.id);
    expect(bar).toEqual(['b', 'a']);
    expect(first.b!.pos! < first.a!.pos!).toBe(true);
    // Clocks stay as they were: a migration is not an edit.
    expect(first.a!.positionAt).toBe(1);
  });

  it('drops a malformed key but keeps the record', () => {
    const { records } = sanitizeRemoteRecords({ a: rec('a', 'toolbar', 0, { pos: 'NOT VALID' }), b: rec('b', 'toolbar', 1, { pos: 'b' }) }, 10);
    expect(records.a!.pos).toBeUndefined();
    expect(records.b!.pos).toBe('b');
    // The folder then gets fresh keys in index order.
    expect(childrenByParent(ensurePositions(records)).get('toolbar')!.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('renumbers a folder whose keys grew too long', () => {
    const long = 'i'.repeat(30) + 'k';
    const out = ensurePositions({ a: rec('a', 'toolbar', 0, { pos: long }), b: rec('b', 'toolbar', 1, { pos: 'z' }) });
    expect(out.a!.pos!.length).toBeLessThan(5);
    expect(out.a!.pos! < out.b!.pos!).toBe(true);
  });

  it('merges the key with the position it belongs to', () => {
    const local = { a: rec('a', 'toolbar', 0, { pos: 'c', positionAt: 5 }) };
    const remote = { a: rec('a', 'other', 3, { pos: 'x', positionAt: 2 }) };
    expect(mergeRecords(local, remote).a).toMatchObject({ parentId: 'toolbar', pos: 'c' });
  });
});

describe('concurrent reorders in two browsers', () => {
  let remote: MemoryRemote;
  let clock: { t: number };
  let brave: FakeBrowser;
  let firefox: FakeBrowser;
  const sync = (b: FakeBrowser) => syncOnce(b.deps, {});
  const titles = async (b: FakeBrowser) => (await dump(b)).map((line) => line.replace(/ <.*$/, ''));

  beforeEach(() => {
    remote = new MemoryRemote();
    clock = { t: 1_700_000_000_000 };
    brave = makeBrowser('chromium', remote, 'Brave', clock);
    firefox = makeBrowser('firefox', remote, 'Firefox', clock);
  });

  async function folderOf(b: FakeBrowser, ...names: string[]) {
    const bar = b.bookmarks.root('toolbar');
    for (const n of names) await b.bookmarks.add(bar, n, `https://${n.toLowerCase()}.example/`);
  }
  const idOf = async (b: FakeBrowser, title: string) => (await b.bookmarks.getChildren(b.bookmarks.root('toolbar'))).find((c) => c.title === title)!.id;

  it('keeps both moves when two browsers move different items of one folder offline', async () => {
    await folderOf(brave, 'A', 'B', 'C', 'D', 'E', 'F');
    await sync(brave);
    await sync(firefox);

    // Brave moves A to the end, Firefox moves F to the front. Neither has synced.
    await brave.bookmarks.move(await idOf(brave, 'A'), { parentId: brave.bookmarks.root('toolbar'), index: 6 });
    await firefox.bookmarks.move(await idOf(firefox, 'F'), { parentId: firefox.bookmarks.root('toolbar'), index: 0 });
    clock.t += 1000;
    await sync(brave);
    clock.t += 1000;
    await sync(firefox);
    await sync(brave);

    const expected = ['toolbar/F', 'toolbar/B', 'toolbar/C', 'toolbar/D', 'toolbar/E', 'toolbar/A'];
    expect(await titles(brave)).toEqual(expected);
    expect(await titles(firefox)).toEqual(expected);
  });

  it('marks only the moved item as moved, not the siblings it pushed', async () => {
    await folderOf(brave, 'A', 'B', 'C');
    await sync(brave);
    const before = structuredClone(remote.state!.records);
    await brave.bookmarks.move(await idOf(brave, 'C'), { parentId: brave.bookmarks.root('toolbar'), index: 0 });
    clock.t += 1000;
    await sync(brave);
    const after = remote.state!.records;
    const moved = Object.keys(after).filter((id) => after[id]!.positionAt !== before[id]!.positionAt);
    expect(moved.map((id) => after[id]!.title)).toEqual(['C']);
  });

  it('writes schema 2 and reads a schema 1 file', async () => {
    await folderOf(brave, 'A', 'B');
    await sync(brave);
    expect(remote.state!.schema).toBe(2);
    // An older file without keys: read, keys added, written back as 2.
    const old = remote.state!;
    for (const r of Object.values(old.records)) delete r.pos;
    old.schema = 1;
    await sync(firefox);
    expect(remote.state!.schema).toBe(2);
    expect(Object.values(remote.state!.records).every((r) => r.pos)).toBe(true);
    expect(await titles(firefox)).toEqual(['toolbar/A', 'toolbar/B']);
  });

  it('orders two items inserted at the same spot the same way everywhere', async () => {
    await folderOf(brave, 'A', 'B');
    await sync(brave);
    await sync(firefox);
    await brave.bookmarks.create({ parentId: brave.bookmarks.root('toolbar'), title: 'X', url: 'https://x.example/', index: 1 });
    await firefox.bookmarks.create({ parentId: firefox.bookmarks.root('toolbar'), title: 'Y', url: 'https://y.example/', index: 1 });
    await sync(brave);
    await sync(firefox);
    await sync(brave);
    const order = await titles(brave);
    expect(order).toEqual(await titles(firefox));
    expect(order[0]).toBe('toolbar/A');
    expect(order.at(-1)).toBe('toolbar/B');
  });
});
