import { describe, expect, it } from 'vitest';
import { parseNetscapeHtml, snapshotToSource } from '../src/core/import';
import { toNetscapeHtml } from '../src/core/netscape';
import { importIntoLocal } from '../src/sync/importer';
import { readSnapshot } from '../src/sync/local-tree';
import { syncOnce } from '../src/sync/engine';
import { dump, FakeBookmarks, makeBrowser, MemoryRemote } from './fakes';

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1700000000">Dev &amp; Tools</H3>
        <DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub</A>
        </DL><p>
        <DT><A HREF="https://example.com/?a=1&amp;b=2">Caf&#233;</A>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com/">HN</A>
</DL><p>
`;

const FIREFOX_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://menu.example/">In the menu</A>
    <HR>
    <DT><A HREF="place:sort=8&maxResults=10">Recent tags</A>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
        <DT><A HREF="https://toolbar.example/">On the toolbar</A>
    </DL><p>
    <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://other.example/">Other</A>
    </DL><p>
</DL>
`;

describe('parseNetscapeHtml', () => {
  it('reads a Chrome export', () => {
    expect(parseNetscapeHtml(CHROME_EXPORT).roots).toEqual({
      toolbar: [
        { kind: 'folder', title: 'Dev & Tools', children: [{ kind: 'bookmark', title: 'GitHub', url: 'https://github.com/' }] },
        { kind: 'bookmark', title: 'Café', url: 'https://example.com/?a=1&b=2' },
      ],
      other: [{ kind: 'bookmark', title: 'HN', url: 'https://news.ycombinator.com/' }],
    });
  });

  it('reads a Firefox export, putting loose items in the Bookmarks Menu and skipping place: queries', () => {
    expect(parseNetscapeHtml(FIREFOX_EXPORT).roots).toEqual({
      menu: [{ kind: 'bookmark', title: 'In the menu', url: 'https://menu.example/' }],
      toolbar: [{ kind: 'bookmark', title: 'On the toolbar', url: 'https://toolbar.example/' }],
      other: [{ kind: 'bookmark', title: 'Other', url: 'https://other.example/' }],
    });
  });

  it('reads back its own export into the same folders', async () => {
    const remote = new MemoryRemote();
    const ff = makeBrowser('firefox', remote, 'Firefox', { t: 1 });
    await ff.bookmarks.add('menu________', 'M', 'https://m.example/');
    const f = await ff.bookmarks.add('toolbar_____', 'Folder <1>');
    await ff.bookmarks.add(f, 'T "quoted"', 'https://t.example/');
    await ff.bookmarks.add('unfiled_____', 'O', 'https://o.example/');
    await syncOnce(ff.deps);

    const parsed = parseNetscapeHtml(toNetscapeHtml(remote.state!.records));
    const local = snapshotToSource(readSnapshot(await ff.bookmarks.getTree()).snapshot);
    expect(parsed.roots).toEqual(local.roots);
  });
});

describe('importIntoLocal', () => {
  it('merges into the matching folders and skips duplicates', async () => {
    const b = new FakeBookmarks('chromium');
    const dev = await b.add('1', 'Dev & Tools');
    await b.add(dev, 'GitHub', 'https://github.com/');

    const result = await importIntoLocal(b, parseNetscapeHtml(CHROME_EXPORT), { mode: 'merge', label: 'Chrome' });

    expect(result).toEqual({ added: 2, duplicates: 1, failed: 0 });
    const children = await b.getChildren('1');
    expect(children.map((c) => c.title)).toEqual(['Dev & Tools', 'Café']);
    expect((await b.getChildren(dev)).map((c) => c.title)).toEqual(['GitHub']);
  });

  it('can put everything in a new folder instead', async () => {
    const b = new FakeBookmarks('chromium');
    await importIntoLocal(b, parseNetscapeHtml(FIREFOX_EXPORT), {
      mode: 'folder',
      label: 'Firefox',
      date: new Date('2026-11-22T10:00:00Z'),
    });
    const [container] = await b.getChildren('2');
    expect(container!.title).toBe('Imported from Firefox (2026-11-22)');
    expect((await b.getChildren(container!.id)).map((c) => c.title)).toEqual([
      'Bookmarks bar',
      'Bookmarks Menu',
      'Other bookmarks',
    ]);
  });

  it('puts Firefox menu items in the Chromium "Bookmarks Menu" folder, which then syncs as the menu', async () => {
    const remote = new MemoryRemote();
    const clock = { t: 1 };
    const brave = makeBrowser('chromium', remote, 'Brave', clock);
    const firefox = makeBrowser('firefox', remote, 'Firefox', clock);

    const result = await importIntoLocal(brave.bookmarks, parseNetscapeHtml(FIREFOX_EXPORT), {
      mode: 'merge',
      label: 'Firefox',
    });
    brave.local.state.menuFolderId = result.menuFolderId!;
    await syncOnce(brave.deps);
    await syncOnce(firefox.deps);

    expect(await dump(firefox)).toEqual([
      'toolbar/On the toolbar <https://toolbar.example/>',
      'menu/In the menu <https://menu.example/>',
      'other/Other <https://other.example/>',
    ]);
  });
});
