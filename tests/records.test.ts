import { describe, expect, it } from 'vitest';
import { mergeRecords, sanitize } from '../src/core/records';
import type { SyncRecord } from '../src/core/types';

const rec = (p: Partial<SyncRecord> & { id: string }): SyncRecord => ({
  kind: 'bookmark',
  parentId: 'toolbar',
  index: 0,
  title: p.id,
  url: `https://${p.id}.example`,
  contentAt: 1,
  positionAt: 1,
  ...p,
});

describe('mergeRecords', () => {
  it('takes the newer title and the newer position separately', () => {
    const local = { a: rec({ id: 'a', title: 'renamed', contentAt: 5 }) };
    const remote = { a: rec({ id: 'a', parentId: 'other', positionAt: 7 }) };
    const m = mergeRecords(local, remote).a!;
    expect([m.title, m.parentId]).toEqual(['renamed', 'other']);
  });

  it('lets a deletion win over an older edit', () => {
    const local = { a: rec({ id: 'a', title: 'edited', contentAt: 2 }) };
    const remote = { a: rec({ id: 'a', deletedAt: 3 }) };
    expect(mergeRecords(local, remote).a!.deletedAt).toBe(3);
  });

  it('brings an item back when it was edited after the deletion', () => {
    const local = { a: rec({ id: 'a', title: 'edited', contentAt: 9 }) };
    const remote = { a: rec({ id: 'a', deletedAt: 3 }) };
    const m = mergeRecords(local, remote).a!;
    expect([m.deletedAt, m.title]).toEqual([undefined, 'edited']);
  });
});

describe('sanitize', () => {
  it('moves items whose folder was deleted to "other"', () => {
    const out = sanitize(
      {
        f: rec({ id: 'f', kind: 'folder', url: undefined, deletedAt: 5 }),
        a: rec({ id: 'a', parentId: 'f' }),
      },
      10,
    );
    expect(out.a!.parentId).toBe('other');
  });

  it('breaks a cycle made by two moves', () => {
    const out = sanitize(
      {
        x: rec({ id: 'x', kind: 'folder', url: undefined, parentId: 'y' }),
        y: rec({ id: 'y', kind: 'folder', url: undefined, parentId: 'x' }),
      },
      10,
    );
    expect([out.x!.parentId, out.y!.parentId]).toEqual(['other', 'x']);
  });

  it('numbers siblings from 0 and drops old tombstones', () => {
    const now = 200 * 24 * 3600 * 1000;
    const out = sanitize(
      {
        a: rec({ id: 'a', index: 4 }),
        b: rec({ id: 'b', index: 9 }),
        old: rec({ id: 'old', deletedAt: 1 }),
      },
      now,
    );
    expect([out.a!.index, out.b!.index, out.old]).toEqual([0, 1, undefined]);
  });
});
