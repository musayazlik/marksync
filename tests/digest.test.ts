import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { digestDue, pickDigest, seededRandom, type DigestCandidate } from '../src/core/digest';
import { actOnDigest, getDigest } from '../src/services/digest-service';
import { digestItem, settingsItem, DEFAULT_SETTINGS } from '../src/shared/state';
import { FakeBookmarks } from './fakes';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-28T10:00:00Z');

const item = (id: string, daysAgo: number, extra: Partial<DigestCandidate> = {}): DigestCandidate => ({
  id,
  title: id,
  url: `https://${id}.example/`,
  path: 'Bar',
  addedAt: NOW - daysAgo * DAY,
  ...extra,
});

describe('picking the digest', () => {
  it('is due by frequency', () => {
    expect(digestDue('off', undefined, NOW)).toBe(false);
    expect(digestDue('daily', undefined, NOW)).toBe(true);
    expect(digestDue('daily', NOW - 23 * 3600_000, NOW)).toBe(false);
    expect(digestDue('daily', NOW - DAY, NOW)).toBe(true);
    expect(digestDue('weekly', NOW - 3 * DAY, NOW)).toBe(false);
    expect(digestDue('weekly', NOW - 7 * DAY, NOW)).toBe(true);
  });

  it('only picks bookmarks neither added nor opened lately, and skips kept ones', () => {
    const items = [
      item('fresh', 10),
      item('openedLately', 400, { usedAt: NOW - 5 * DAY }),
      item('old1', 400),
      item('old2', 200),
      item('kept', 300),
    ];
    const picks = pickDigest(items, { now: NOW, seed: 1, kept: { kept: NOW - 30 * DAY } });
    expect(picks.map((p) => p.id).sort()).toEqual(['old1', 'old2']);
  });

  it('mixes in bookmarks related to recent saves', () => {
    const items = [
      item('newRecipe', 2, { tags: ['recipe'] }),
      item('oldRecipe', 500, { tags: ['recipe'] }),
      ...Array.from({ length: 20 }, (_, i) => item(`other${i}`, 300 + i)),
    ];
    const picks = pickDigest(items, { now: NOW, seed: 7, size: 5 });
    expect(picks).toHaveLength(5);
    expect(picks[0]).toEqual({ id: 'oldRecipe', reason: 'related', relatedTo: 'newRecipe' });
    expect(new Set(picks.map((p) => p.id)).size).toBe(5);
  });

  it('relates by category and by site too', () => {
    const items = [
      item('new', 1, { category: 'Recipe', url: 'https://food.example/new' }),
      item('sameSite', 400, { url: 'https://www.food.example/old' }),
    ];
    expect(pickDigest(items, { now: NOW, seed: 3 })[0]).toMatchObject({ id: 'sameSite', reason: 'related' });
  });

  it('is the same for the same seed', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`b${i}`, 100 + i));
    expect(pickDigest(items, { now: NOW, seed: 42 })).toEqual(pickDigest(items, { now: NOW, seed: 42 }));
    expect(seededRandom(1)()).toBe(seededRandom(1)());
  });
});

describe('the digest in a browser', () => {
  let b: FakeBookmarks;
  let old: string;

  beforeEach(async () => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    b = new FakeBookmarks('chromium');
    old = await b.add('1', 'Old page', 'https://old.example/');
    await b.add('1', 'Another', 'https://another.example/');
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 400 * DAY);
    // The services use the browser's bookmarks: point them at the fake.
    (fakeBrowser as unknown as { bookmarks: FakeBookmarks }).bookmarks = b;
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, digestFrequency: 'weekly' });
  });

  it('is off by default', async () => {
    await settingsItem.setValue(DEFAULT_SETTINGS);
    expect(await getDigest()).toBeNull();
  });

  it('archives a pick into an Archive folder and remembers kept ones', async () => {
    const entries = await getDigest();
    expect(entries!.map((e) => e.title).sort()).toEqual(['Another', 'Old page']);
    await actOnDigest(old, 'archive');
    const other = await b.getChildren('2');
    expect(other.map((c) => c.title)).toEqual(['digestArchiveFolder']);
    expect((await b.getChildren(other[0]!.id)).map((c) => c.id)).toEqual([old]);

    const another = entries!.find((e) => e.title === 'Another')!.id;
    await actOnDigest(another, 'keep');
    const state = await digestItem.getValue();
    expect(state.done).toEqual({ [old]: 'archived', [another]: 'kept' });
    expect(state.kept[another]).toBeDefined();
    // Done picks stay visible until the next digest.
    expect((await getDigest())!.find((e) => e.id === old)!.done).toBe('archived');
  });

  it('refuses to act on a bookmark that is not in the digest', async () => {
    await getDigest();
    await expect(actOnDigest('nope', 'delete')).rejects.toThrow('digestGone');
  });
});
