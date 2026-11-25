import { beforeEach, describe, expect, it } from 'vitest';
import { syncOnce, MassDeleteError } from '../src/sync/engine';
import { liveRecords } from '../src/core/records';
import { dump, makeBrowser, MemoryRemote, type FakeBrowser } from './fakes';

let remote: MemoryRemote;
let clock: { t: number };
let brave: FakeBrowser;
let firefox: FakeBrowser;

beforeEach(() => {
  remote = new MemoryRemote();
  clock = { t: 1_700_000_000_000 };
  brave = makeBrowser('chromium', remote, 'Brave', clock);
  firefox = makeBrowser('firefox', remote, 'Firefox', clock);
});

const sync = (b: FakeBrowser, opts = {}) => syncOnce(b.deps, opts);

async function expectSame() {
  expect(await dump(firefox)).toEqual(await dump(brave));
}

describe('sync between Brave and Firefox', () => {
  it('copies a new tree to the other browser with the right top-level folders', async () => {
    const dev = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Dev');
    await brave.bookmarks.add(dev, 'GitHub', 'https://github.com');
    await brave.bookmarks.add(dev, 'MDN', 'https://developer.mozilla.org');
    await brave.bookmarks.add(brave.bookmarks.root('other'), 'News', 'https://news.ycombinator.com');

    await sync(brave);
    await sync(firefox);

    expect(await dump(firefox)).toEqual([
      'toolbar/Dev/',
      'toolbar/Dev/GitHub <https://github.com>',
      'toolbar/Dev/MDN <https://developer.mozilla.org>',
      'other/News <https://news.ycombinator.com>',
    ]);
    // Firefox stores them under its own root IDs.
    const tree = await firefox.bookmarks.getChildren('toolbar_____');
    expect(tree.map((n) => n.title)).toEqual(['Dev']);
  });

  it('keeps both a rename and a move made in different browsers', async () => {
    const dev = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Dev');
    const gh = await brave.bookmarks.add(brave.bookmarks.root('other'), 'GitHub', 'https://github.com');
    await sync(brave);
    await sync(firefox);

    // Brave moves GitHub into Dev; Firefox renames it. Neither has synced yet.
    await brave.bookmarks.move(gh, { parentId: dev });
    const ffGh = (await firefox.bookmarks.getChildren('unfiled_____'))[0]!.id;
    await firefox.bookmarks.update(ffGh, { title: 'GitHub (work)' });

    await sync(brave);
    await sync(firefox);
    await sync(brave);

    expect(await dump(brave)).toEqual(['toolbar/Dev/', 'toolbar/Dev/GitHub (work) <https://github.com>']);
    await expectSame();
  });

  it('removes deleted bookmarks everywhere', async () => {
    const a = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'A', 'https://a.example');
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'B', 'https://b.example');
    await sync(brave);
    await sync(firefox);

    await brave.bookmarks.remove(a);
    await sync(brave);
    await sync(firefox);

    expect(await dump(firefox)).toEqual(['toolbar/B <https://b.example>']);
  });

  it('does not duplicate bookmarks both browsers already had', async () => {
    for (const b of [brave, firefox]) {
      const f = await b.bookmarks.add(b.bookmarks.root('toolbar'), 'Dev');
      await b.bookmarks.add(f, 'GitHub', 'https://github.com');
    }
    await firefox.bookmarks.add(firefox.bookmarks.root('toolbar'), 'Only in Firefox', 'https://ff.example');

    await sync(brave);
    await sync(firefox);
    await sync(brave);

    expect(await dump(brave)).toEqual([
      'toolbar/Dev/',
      'toolbar/Dev/GitHub <https://github.com>',
      'toolbar/Only in Firefox <https://ff.example>',
    ]);
    await expectSame();
  });

  it('shows the Firefox Bookmarks Menu as a folder in Chromium and syncs it both ways', async () => {
    await firefox.bookmarks.add('menu________', 'Docs', 'https://docs.example');
    await sync(firefox);
    await sync(brave);

    const other = await brave.bookmarks.getChildren(brave.bookmarks.root('other'));
    expect(other.map((n) => n.title)).toEqual(['Bookmarks Menu']);
    expect(await dump(brave)).toEqual(['menu/Docs <https://docs.example>']);

    await brave.bookmarks.add(other[0]!.id, 'Wiki', 'https://wiki.example');
    await sync(brave);
    await sync(firefox);
    expect(await dump(firefox)).toEqual(['menu/Docs <https://docs.example>', 'menu/Wiki <https://wiki.example>']);
  });

  it('keeps bookmarks one browser cannot create instead of deleting them', async () => {
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Bookmarklet', 'javascript:alert(1)');
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Site', 'https://site.example');
    await sync(brave);
    await sync(firefox); // Firefox rejects javascript: URLs
    await sync(firefox);
    await sync(brave);

    expect(await dump(firefox)).toEqual(['toolbar/Site <https://site.example>']);
    expect(await dump(brave)).toEqual([
      'toolbar/Bookmarklet <javascript:alert(1)>',
      'toolbar/Site <https://site.example>',
    ]);
  });

  it('syncs the order of items and ignores Firefox separators', async () => {
    const tb = brave.bookmarks.root('toolbar');
    const ids = [];
    for (const t of ['1', '2', '3', '4']) ids.push(await brave.bookmarks.add(tb, t, `https://${t}.example`));
    await sync(brave);
    firefox.bookmarks.separator('toolbar_____');
    await sync(firefox);

    await brave.bookmarks.move(ids[3]!, { parentId: tb, index: 0 }); // 4 1 2 3
    await brave.bookmarks.move(ids[1]!, { parentId: tb, index: 4 }); // 4 1 3 2
    await sync(brave);
    await sync(firefox);

    expect((await dump(firefox)).map((l) => l.split(' ')[0])).toEqual([
      'toolbar/4',
      'toolbar/1',
      'toolbar/3',
      'toolbar/2',
    ]);
  });

  it('a second sync with no changes does nothing', async () => {
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'A', 'https://a.example');
    await sync(brave);
    await sync(firefox);
    const saves = remote.saves;
    const r1 = await sync(brave);
    const r2 = await sync(firefox);
    expect([r1.uploaded, r1.localChanges, r2.uploaded, r2.localChanges]).toEqual([false, 0, false, 0]);
    expect(remote.saves).toBe(saves);
    // Both report the version that is in Drive, so a cheap version check can skip the next sync.
    expect([r1.remoteVersion, r2.remoteVersion]).toEqual([String(remote.version), String(remote.version)]);
  });

  it('stops before deleting most bookmarks until the user confirms', async () => {
    const folder = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Big');
    for (let i = 0; i < 30; i++) await brave.bookmarks.add(folder, `#${i}`, `https://${i}.example`);
    await sync(brave);

    await brave.bookmarks.removeTree(folder);
    await expect(sync(brave)).rejects.toBeInstanceOf(MassDeleteError);
    await sync(brave, { allowMassDelete: true });
    expect(liveRecords(remote.state!.records)).toHaveLength(0);
  });

  it('restoring a backup brings the old tree back in every browser', async () => {
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Old', 'https://old.example');
    await sync(brave);
    await sync(firefox);
    const backup = structuredClone(remote.state!.records);

    const ffOld = (await firefox.bookmarks.getChildren('toolbar_____'))[0]!.id;
    await firefox.bookmarks.remove(ffOld);
    await firefox.bookmarks.add('toolbar_____', 'New', 'https://new.example');
    await sync(firefox);
    await sync(brave);
    expect(await dump(brave)).toEqual(['toolbar/New <https://new.example>']);

    await sync(brave, { restore: backup });
    await sync(firefox);
    expect(await dump(firefox)).toEqual(['toolbar/Old <https://old.example>']);
    await expectSame();
  });
});

describe('when the sync file is created again', () => {
  // Happens when the Marksync folder is deleted in Drive, or after an
  // encryption reset: browsers that remember the old file must not upload
  // their bookmarks a second time under new IDs.
  it('matches instead of duplicating, whichever browser comes first', async () => {
    const dev = await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'Dev');
    await brave.bookmarks.add(dev, 'GitHub', 'https://github.com');
    await brave.bookmarks.add(brave.bookmarks.root('other'), 'News', 'https://news.ycombinator.com');
    await sync(brave);
    await sync(firefox);
    await expectSame();

    // The file is gone and Brave starts over (reset clears its sync history).
    remote.state = null;
    brave.local.state = { mapping: {}, mirror: {}, keep: [] };
    await sync(brave);
    // Firefox still remembers the old file.
    await sync(firefox);
    await sync(brave);

    const expected = ['toolbar/Dev/', 'toolbar/Dev/GitHub <https://github.com>', 'other/News <https://news.ycombinator.com>'];
    expect(await dump(brave)).toEqual(expected);
    expect(await dump(firefox)).toEqual(expected);
    expect(liveRecords(remote.state!.records)).toHaveLength(3);
  });

  it('keeps working with older files that have no generation ID', async () => {
    await brave.bookmarks.add(brave.bookmarks.root('toolbar'), 'GitHub', 'https://github.com');
    await sync(brave);
    const { epoch: _, ...legacy } = remote.state!;
    remote.state = legacy;
    await sync(firefox);
    await firefox.bookmarks.add('toolbar_____', 'MDN', 'https://developer.mozilla.org');
    await sync(firefox);
    await sync(brave);
    await expectSame();
    expect(remote.state!.epoch).toBeUndefined();
    expect(liveRecords(remote.state!.records)).toHaveLength(2);
  });
});
