import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createShare, joinShare, leaveShare, parseEmails, parseShareCode, sharesSettled, syncShares } from '../src/services/share-service';
import { runSync } from '../src/services/sync-service';
import { scopedBookmarks } from '../src/sync/scoped-bookmarks';
import { sharesItem, statusItem, tokenItem } from '../src/shared/state';
import { FakeDrive } from './fake-drive';
import { FakeBookmarks } from './fakes';

/** One browser of one Google account: its bookmarks and its extension storage. */
interface Browser {
  bookmarks: FakeBookmarks;
  storage: Record<string, unknown>;
}

let drive: FakeDrive;
let active: Browser | undefined;

async function save() {
  // Background syncs of the previous browser finish in that browser.
  await new Promise((r) => setTimeout(r, 30));
  await sharesSettled();
  if (active) active.storage = (await fakeBrowser.storage.local.get()) as Record<string, unknown>;
}

/** Switches the fake extension to another browser (keeping the Drive). */
async function use(b: Browser) {
  await save();
  fakeBrowser.reset();
  fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
  (fakeBrowser as unknown as { bookmarks: FakeBookmarks }).bookmarks = b.bookmarks;
  await fakeBrowser.storage.local.set(b.storage);
  await tokenItem.setValue({ accessToken: 'token', expiresAt: Date.now() + 3_600_000 });
  active = b;
}

async function newBrowser(): Promise<Browser> {
  const b: Browser = { bookmarks: new FakeBookmarks('chromium'), storage: {} };
  await use(b);
  await statusItem.setValue({ connected: true, syncing: false, email: 'someone@example.org' });
  await save();
  return b;
}

const titlesIn = async (b: FakeBookmarks, folderId: string) => (await b.getChildren(folderId)).map((c) => c.title).sort();
const shared = async () => (await sharesItem.getValue()).shares[0]!;

beforeEach(() => {
  vi.useRealTimers();
  drive = new FakeDrive();
  vi.stubGlobal('fetch', drive.fetch);
  active = undefined;
});

describe('shared folders', () => {
  it('reads invitation codes and e-mail lists', () => {
    expect(parseShareCode('https://u.github.io/marksync/join.html#1AbCdEfGhIjK_lm-no')).toBe('1AbCdEfGhIjK_lm-no');
    expect(parseShareCode(' 1AbCdEfGhIjK_lm-no ')).toBe('1AbCdEfGhIjK_lm-no');
    expect(parseShareCode('nope')).toBeUndefined();
    expect(parseEmails('a@x.org, B@x.org;a@x.org\nc@y.org')).toEqual(['a@x.org', 'b@x.org', 'c@y.org']);
  });

  it('keeps a shared folder view inside its folder', async () => {
    const b = new FakeBookmarks('chromium');
    const f = await b.add('1', 'Family');
    const outside = await b.add('1', 'Mine', 'https://mine.example/');
    const view = scopedBookmarks(b, f);
    const [root] = await view.getTree();
    expect(root!.children!.map((c) => c.id)).toEqual([f]);
    await expect(view.remove(outside)).rejects.toThrow();
    await expect(view.remove(f)).rejects.toThrow();
    await view.create({ parentId: f, title: 'Inside', url: 'https://in.example/' });
    expect(await titlesIn(b, f)).toEqual(['Inside']);
  });

  it('shares a folder, and editors and viewers on other accounts get it', async () => {
    // The owner shares "Family" with two bookmarks.
    const owner = await newBrowser();
    const family = await owner.bookmarks.add('1', 'Family');
    await owner.bookmarks.add(family, 'School', 'https://school.example/');
    await owner.bookmarks.add(family, 'Doctor', 'https://doctor.example/');
    await owner.bookmarks.add('1', 'Private', 'https://private.example/');
    await runSync();
    const view = await createShare(family, ['kid@example.org'], 'writer');
    expect(view.role).toBe('owner');
    expect(drive.permissions.get(view.fileId)?.get('kid@example.org')).toBe('writer');
    const file = drive.json(view.fileId) as { records: Record<string, { title: string; parentId: string }> };
    expect(Object.values(file.records).map((r) => r.title).sort()).toEqual(['Doctor', 'School']);
    // The personal sync file no longer has the shared folder, but still has the rest.
    const personal = drive.json(drive.byName('sync-state.json')[0]!.id) as { records: Record<string, { title: string; deletedAt?: number }> };
    const live = Object.values(personal.records).filter((r) => r.deletedAt === undefined).map((r) => r.title);
    expect(live).toContain('Private');
    expect(live).not.toContain('Family');
    const ownerContainer = (await sharesItem.getValue()).containerId!;

    // An editor joins with the code and adds a bookmark.
    const kid = await newBrowser();
    drive.access.set(view.fileId, { canEdit: true, ownedByMe: false });
    const joined = await joinShare(view.fileId);
    expect(joined).toMatchObject({ role: 'writer', name: 'Family' });
    const kidFolder = (await shared()).localFolderId;
    expect(await titlesIn(kid.bookmarks, kidFolder)).toEqual(['Doctor', 'School']);
    await kid.bookmarks.add(kidFolder, 'Football club', 'https://club.example/');
    await syncShares();

    // The owner gets it.
    await use(owner);
    await syncShares();
    expect(await titlesIn(owner.bookmarks, family)).toEqual(['Doctor', 'Football club', 'School']);
    expect((await owner.bookmarks.getChildren(ownerContainer)).map((c) => c.id)).toEqual([family]);

    // A viewer joins; their own change is put back at the next sync.
    const grandma = await newBrowser();
    drive.access.set(view.fileId, { canEdit: false, ownedByMe: false });
    expect((await joinShare(view.fileId)).role).toBe('reader');
    const gFolder = (await shared()).localFolderId;
    await grandma.bookmarks.add(gFolder, 'Spam', 'https://spam.example/');
    await syncShares();
    expect(await titlesIn(grandma.bookmarks, gFolder)).toEqual(['Doctor', 'Football club', 'School']);
    expect(Object.values((drive.json(view.fileId) as { records: Record<string, { title: string }> }).records).map((r) => r.title)).not.toContain('Spam');

    // Leaving keeps the bookmarks as an ordinary folder.
    await leaveShare(view.fileId);
    expect((await sharesItem.getValue()).shares).toEqual([]);
    expect(await titlesIn(grandma.bookmarks, gFolder)).toEqual(['Doctor', 'Football club', 'School']);
  });

  it('keeps items whose folder was deleted meanwhile, and asks before a mass deletion', async () => {
    const owner = await newBrowser();
    const family = await owner.bookmarks.add('1', 'Family');
    const school = await owner.bookmarks.add(family, 'School');
    for (let i = 0; i < 25; i++) await owner.bookmarks.add(family, `b${i}`, `https://b${i}.example/`);
    const view = await createShare(family, [], 'writer');

    const kid = await newBrowser();
    drive.access.set(view.fileId, { canEdit: true, ownedByMe: false });
    await joinShare(view.fileId);
    const kidFolder = (await shared()).localFolderId;
    const kidSchool = (await kid.bookmarks.getChildren(kidFolder)).find((c) => c.title === 'School')!.id;
    // The kid adds into "School" while the owner deletes it, before syncing.
    await kid.bookmarks.add(kidSchool, 'New', 'https://new.example/');
    await use(owner);
    await owner.bookmarks.removeTree(school);
    await syncShares();
    await use(kid);
    await syncShares();
    // "New" is not lost in an invisible root: it is in the shared folder.
    expect(await titlesIn(kid.bookmarks, kidFolder)).toContain('New');

    // The kid deletes most bookmarks: the guard stops and asks.
    for (const c of (await kid.bookmarks.getChildren(kidFolder)).slice(0, 22)) await kid.bookmarks.remove(c.id);
    await syncShares();
    expect((await shared()).massDelete).toMatchObject({ source: 'local' });
    const { resolveShare } = await import('../src/services/share-service');
    await resolveShare(view.fileId, 'keep');
    expect((await shared()).massDelete).toBeUndefined();
    expect((await kid.bookmarks.getChildren(kidFolder)).length).toBeGreaterThan(20);
  });

  it('refuses files that are not Marksync shared folders, or that it cannot open', async () => {
    await newBrowser();
    await expect(joinShare('1AbCdEfGhIjKlmnop')).rejects.toThrow('shareNoAccess');
  });
});
