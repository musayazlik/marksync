import { beforeEach, describe, expect, it } from 'vitest';
import { syncOnce } from '../src/sync/engine';
import { dump, makeBrowser, MemoryRemote } from './fakes';

let remote: MemoryRemote;
let clock: { t: number };

beforeEach(() => {
  remote = new MemoryRemote();
  clock = { t: 1_700_000_000_000 };
});

describe('Chrome signed in to a Google account (two copies of each root)', () => {
  it('syncs both copies, adds new items to the account copy and never moves local-only items', async () => {
    const chrome = makeBrowser('chromium', remote, 'Chrome', clock, { accountStorage: true });
    const firefox = makeBrowser('firefox', remote, 'Firefox', clock);
    await chrome.bookmarks.add('4', 'Account site', 'https://account.example/');
    await chrome.bookmarks.add('1', 'Local site', 'https://local.example/');

    await syncOnce(chrome.deps);
    await syncOnce(firefox.deps);
    expect(await dump(firefox)).toEqual([
      'toolbar/Account site <https://account.example/>',
      'toolbar/Local site <https://local.example/>',
    ]);

    await firefox.bookmarks.add('toolbar_____', 'From Firefox', 'https://ff.example/');
    for (let i = 0; i < 3; i++) {
      await syncOnce(firefox.deps);
      await syncOnce(chrome.deps);
    }

    expect((await chrome.bookmarks.getChildren('4')).map((n) => n.title)).toEqual(['Account site', 'From Firefox']);
    expect((await chrome.bookmarks.getChildren('1')).map((n) => n.title)).toEqual(['Local site']);
    expect(await dump(firefox)).toEqual(await dump(chrome));

    // Settled: nothing left to do on either side.
    const a = await syncOnce(chrome.deps);
    const b = await syncOnce(firefox.deps);
    expect([a.uploaded, a.localChanges, b.uploaded, b.localChanges]).toEqual([false, 0, false, 0]);
  });
});

describe('Opera', () => {
  it('syncs Unsorted bookmarks as "other" and ignores Trash and Speed Dial', async () => {
    const opera = makeBrowser('chromium', remote, 'Opera', clock, { opera: true });
    const firefox = makeBrowser('firefox', remote, 'Firefox', clock);
    await opera.bookmarks.add('7', 'Unsorted one', 'https://unsorted.example/');
    await opera.bookmarks.add('8', 'Deleted one', 'https://trash.example/');
    await opera.bookmarks.add('9', 'Dial', 'https://dial.example/');

    await syncOnce(opera.deps);
    await syncOnce(firefox.deps);
    expect(await dump(firefox)).toEqual(['other/Unsorted one <https://unsorted.example/>']);

    await firefox.bookmarks.add('unfiled_____', 'From Firefox', 'https://ff.example/');
    await syncOnce(firefox.deps);
    await syncOnce(opera.deps);
    expect((await opera.bookmarks.getChildren('2')).map((n) => n.title)).toEqual(['From Firefox']);
    expect((await opera.bookmarks.getChildren('8')).map((n) => n.title)).toEqual(['Deleted one']);
  });
});
