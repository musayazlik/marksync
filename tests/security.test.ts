import { beforeEach, describe, expect, it } from 'vitest';
import { decodeEntities, parseNetscapeHtml, snapshotToSource, validateImportSource, MAX_IMPORT_CHARS } from '../src/core/import';
import { MAX_DEPTH, liveRecords, sanitize } from '../src/core/records';
import type { RecordMap, SyncRecord } from '../src/core/types';
import { MAX_CLOCK_SKEW_MS, sanitizeRemoteRecords } from '../src/core/validate';
import { MassDeleteError, syncOnce } from '../src/sync/engine';
import { readLocal } from '../src/sync/local-tree';
import { dump, makeBrowser, MemoryRemote, type FakeBrowser } from './fakes';

const NOW = 1_700_000_000_000;

const rec = (p: Partial<SyncRecord> & { id: string }): SyncRecord => ({
  kind: 'bookmark',
  parentId: 'toolbar',
  index: 0,
  title: p.id,
  url: `https://${p.id}.example/`,
  contentAt: 1,
  positionAt: 1,
  ...p,
});

describe('remote record validation', () => {
  it('drops malformed records instead of failing', () => {
    const json = JSON.stringify({
      ok: rec({ id: 'ok' }),
      nul: null,
      mismatch: rec({ id: 'other-id' }),
      badKind: { ...rec({ id: 'badKind' }), kind: 'script' },
      noUrl: { ...rec({ id: 'noUrl' }), url: undefined },
      negClock: rec({ id: 'negClock', contentAt: -5 }),
      selfParent: { ...rec({ id: 'selfParent' }), kind: 'folder', url: undefined, parentId: 'selfParent' },
    });
    // JSON from Drive can carry an own "__proto__" key.
    const input = JSON.parse(`{"__proto__": ${JSON.stringify(rec({ id: '__proto__' }))}, ${json.slice(1)}`);
    expect(Object.keys(input)).toContain('__proto__');
    input.inf = { ...rec({ id: 'inf' }), contentAt: Infinity };
    const { records, dropped } = sanitizeRemoteRecords(input, NOW);
    expect(Object.keys(records)).toEqual(['ok']);
    expect(dropped).toBe(8);
  });

  it('treats a null record map as empty and rejects non-objects', () => {
    expect(sanitizeRemoteRecords(null, NOW).records).toEqual({});
    expect(() => sanitizeRemoteRecords([1, 2], NOW)).toThrow();
  });

  it('pulls clocks from the far future back to now + skew', () => {
    const { records } = sanitizeRemoteRecords({ a: rec({ id: 'a', contentAt: 9e15, positionAt: 9e15 }) }, NOW);
    expect(records.a!.contentAt).toBe(NOW + MAX_CLOCK_SKEW_MS);
  });
});

describe('sync with a tampered or corrupt sync file', () => {
  let remote: MemoryRemote;
  let clock: { t: number };
  let brave: FakeBrowser;
  let firefox: FakeBrowser;
  let backups: number[];

  beforeEach(async () => {
    remote = new MemoryRemote();
    clock = { t: NOW };
    backups = [];
    brave = makeBrowser('chromium', remote, 'Brave', clock);
    firefox = makeBrowser('firefox', remote, 'Firefox', clock);
    firefox.deps.beforeRemoteMassDelete = async (n) => {
      backups.push(n);
    };
    const folder = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Work');
    for (let i = 0; i < 30; i++) await brave.bookmarks.add(folder, `#${i}`, `https://${i}.example/`);
    await syncOnce(brave.deps);
    await syncOnce(firefox.deps);
  });

  /** Simulates a writer other than a Marksync browser changing the file. */
  const tamper = (fn: (records: RecordMap) => void) => {
    fn(remote.state!.records);
    remote.version++;
  };

  it('pauses on a mass deletion that no browser confirmed, and can keep the bookmarks', async () => {
    tamper((records) => {
      for (const r of Object.values(records)) r.deletedAt = Math.max(r.contentAt, r.positionAt) + 1;
    });
    const err = await syncOnce(firefox.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MassDeleteError);
    expect((err as MassDeleteError).source).toBe('remote');
    expect(await dump(firefox)).toHaveLength(31);

    await syncOnce(firefox.deps, { keepLocal: true });
    expect(await dump(firefox)).toHaveLength(31);
    expect(liveRecords(remote.state!.records)).toHaveLength(31);
    // The other browser gets them back too.
    await syncOnce(brave.deps);
    expect(await dump(brave)).toHaveLength(31);
  });

  it('applies a mass deletion the user confirmed in another browser, after a backup', async () => {
    const [folder] = await brave.bookmarks.getChildren(brave.bookmarks.root('toolbar'));
    await brave.bookmarks.removeTree(folder!.id);
    await expect(syncOnce(brave.deps)).rejects.toBeInstanceOf(MassDeleteError);
    await syncOnce(brave.deps, { allowMassDelete: true });

    await syncOnce(firefox.deps);
    expect(await dump(firefox)).toEqual([]);
    expect(backups).toEqual([31]);
  });

  it('survives a null record and repairs the file', async () => {
    tamper((records) => {
      (records as Record<string, unknown>).broken = null;
    });
    await syncOnce(firefox.deps);
    expect(Object.keys(remote.state!.records)).not.toContain('broken');
    expect(await dump(firefox)).toHaveLength(31);
  });

  it('survives an infinite clock and keeps later edits working', async () => {
    tamper((records) => {
      const first = Object.values(records)[0]!;
      first.contentAt = Infinity;
    });
    await syncOnce(firefox.deps);
    for (const r of Object.values(remote.state!.records)) {
      expect(Number.isFinite(r.contentAt) && Number.isFinite(r.positionAt)).toBe(true);
    }
    const [folder] = await firefox.bookmarks.getChildren('toolbar_____');
    await firefox.bookmarks.update(folder!.id, { title: 'Renamed' });
    await syncOnce(firefox.deps);
    await syncOnce(brave.deps);
    expect((await dump(brave))[0]).toBe('toolbar/Renamed/');
  });
});

/**
 * Runs `work` at two sizes and checks the time grows about linearly: four
 * times the input may take at most ~9 times as long (quadratic would be 16).
 * Comparing two runs on the same machine keeps this stable on slow or busy
 * CI runners, unlike a fixed time limit.
 */
function expectLinear(work: (n: number) => void, small: number) {
  const time = (n: number) => {
    const started = performance.now();
    work(n);
    return performance.now() - started;
  };
  time(small); // warm up
  const a = time(small);
  const b = time(small * 4);
  expect(b).toBeLessThan(a * 9 + 150);
}

const chain = (n: number): RecordMap => {
  const records: RecordMap = {};
  for (let i = 0; i < n; i++) {
    records[`f${i}`] = rec({ id: `f${i}`, kind: 'folder', url: undefined, parentId: i === 0 ? 'toolbar' : `f${i - 1}` });
  }
  return records;
};

describe('bounded tree processing', () => {
  it('caps nesting depth and stays fast on a long chain', () => {
    expectLinear((n) => sanitize(chain(n), NOW), 5_000);
    const out = sanitize(chain(20_000), NOW);

    const depth = (id: string) => {
      let d = 0;
      for (let cur = out[id]!; ; cur = out[cur.parentId]!) {
        d++;
        if (!out[cur.parentId]) return d;
      }
    };
    expect(Math.max(...Object.keys(out).map(depth))).toBeLessThanOrEqual(MAX_DEPTH);
  });
});

describe('HTML import parser', () => {
  it('runs in linear time on unclosed tags', () => {
    for (const unit of ['<A HREF="x">', '<H3>', '<DL ', '<']) {
      expectLinear((n) => parseNetscapeHtml('<DL><p>' + unit.repeat(Math.floor(n / unit.length))), 500_000);
    }
  });

  it('rejects files over the size limit', () => {
    expect(() => parseNetscapeHtml(' '.repeat(MAX_IMPORT_CHARS + 1))).toThrow(/too large/);
  });

  it('leaves invalid numeric entities as text instead of failing', () => {
    expect(decodeEntities('a&#99999999;b&#xD800;c&#65;')).toBe('a&#99999999;b&#xD800;cA');
  });
});

describe('browser snapshot validation', () => {
  it('accepts a normal tree and rejects malformed or too deep ones', () => {
    const ok = validateImportSource({ roots: { toolbar: [{ kind: 'bookmark', title: 'A', url: 'https://a.example/' }] } });
    expect(ok.roots.toolbar).toHaveLength(1);
    expect(() => validateImportSource({ roots: { toolbar: [null] } })).toThrow();
    expect(() => validateImportSource({})).toThrow();

    let deep: unknown = [];
    for (let i = 0; i < MAX_DEPTH + 5; i++) deep = [{ kind: 'folder', title: 'x', children: deep }];
    expect(() => validateImportSource({ roots: { other: deep } })).toThrow(/deep/);
  });

  it('includes Chrome "only on this device" bookmarks in the shared snapshot', async () => {
    const chrome = makeBrowser('chromium', new MemoryRemote(), 'Chrome', { t: NOW }, { accountStorage: true });
    await chrome.bookmarks.add('4', 'Account', 'https://account.example/');
    await chrome.bookmarks.add('1', 'Device only', 'https://device.example/');
    const { snapshot } = await readLocal(chrome.bookmarks);
    expect(snapshotToSource(snapshot).roots.toolbar?.map((n) => n.title)).toEqual(['Account', 'Device only']);
  });
});
