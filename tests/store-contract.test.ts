import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DriveClient, DriveError, quote } from '../src/platform/drive';
import { parseQuery, type FileStore } from '../src/platform/store';
import { parseMultistatus, parseWebDavUrl, WebDavClient } from '../src/platform/webdav';
import { DriveRemoteStore, useBackend, withFolders } from '../src/services/drive-store';
import { connectWebDav } from '../src/services/webdav-service';
import { ConflictError } from '../src/sync/engine';
import { backendItem, statusItem, tokenItem } from '../src/shared/state';
import { FakeDrive } from './fake-drive';
import { FakeWebDav } from './fake-webdav';

/**
 * The same behaviour from every storage backend: the services only rely on
 * what is tested here.
 */
const backends: { name: string; make: () => { store: FileStore; fetch: typeof fetch; atomic: boolean } }[] = [
  {
    name: 'Google Drive',
    make: () => {
      const drive = new FakeDrive();
      return { store: new DriveClient(async () => 'token', async () => undefined), fetch: drive.fetch as typeof fetch, atomic: false };
    },
  },
  {
    name: 'WebDAV',
    make: () => {
      const dav = new FakeWebDav();
      return { store: new WebDavClient({ url: dav.base, username: 'ana', password: 'app-pass' }), fetch: dav.fetch as typeof fetch, atomic: true };
    },
  },
];

for (const backend of backends) {
  describe(`storage contract: ${backend.name}`, () => {
    let store: FileStore;
    let atomic: boolean;

    beforeEach(() => {
      const made = backend.make();
      store = made.store;
      atomic = made.atomic;
      vi.stubGlobal('fetch', made.fetch);
    });

    it('creates folders once and finds them again', async () => {
      const a = await store.ensureFolder('Marksync');
      expect(await store.ensureFolder('Marksync')).toBe(a);
      const b = await store.ensureFolder('backups', a);
      expect((await store.findByName('backups', a, true))?.id).toBe(b);
      expect(await store.findByName('missing', a)).toBeUndefined();
    });

    it('stores JSON, lists it by folder and name, and keeps app properties', async () => {
      const folder = await store.ensureFolder('Marksync');
      const sub = await store.ensureFolder('backups', folder);
      const one = await store.createJson('one.json', folder, { n: 1 });
      await store.createJson('two.json', sub, { n: 2 }, { count: '42', source: 'Brave on Windows', reason: 'manual' });
      expect(await store.downloadJson(one.id)).toEqual({ n: 1 });
      const files = await store.list(`${quote(folder)} in parents and mimeType != 'application/vnd.google-apps.folder'`);
      expect(files.map((f) => f.name)).toEqual(['one.json']);
      const [backup] = await store.list(`${quote(sub)} in parents`, 'createdTime desc');
      expect(backup!.appProperties).toMatchObject({ count: '42', source: 'Brave on Windows', reason: 'manual' });
      expect((await store.list(`name = ${quote('one.json')} and ${quote(folder)} in parents`)).map((f) => f.id)).toEqual([one.id]);
      expect((await store.getMeta(backup!.id)).parents).toEqual([sub]);
    });

    it('changes the version on every write', async () => {
      const folder = await store.ensureFolder('Marksync');
      const f = await store.createJson('state.json', folder, { v: 1 });
      const v1 = (await store.getMeta(f.id)).version;
      await store.updateJson(f.id, { v: 2 }, v1);
      const v2 = (await store.getMeta(f.id)).version;
      expect(v2).not.toBe(v1);
      expect(await store.downloadJson(f.id)).toEqual({ v: 2 });
      // A write against an old version: refused where the store can check it atomically.
      if (atomic) await expect(store.updateJson(f.id, { v: 3 }, v1)).rejects.toMatchObject({ status: 412 });
    });

    it('deletes files', async () => {
      const folder = await store.ensureFolder('Marksync');
      const f = await store.createJson('gone.json', folder, {});
      await store.delete(f.id);
      await expect(store.getMeta(f.id)).rejects.toBeInstanceOf(DriveError);
      expect(await store.list(`${quote(folder)} in parents`)).toEqual([]);
    });

    it('lets the sync engine detect a concurrent write (DriveRemoteStore)', async () => {
      const remote = new DriveRemoteStore(store);
      const state = (n: number) => ({ schema: 2 as const, records: {}, updatedAt: n, updatedBy: 'test' });
      fakeBrowser.reset();
      const v1 = await remote.save(state(1), null);
      // Another browser writes first.
      await new DriveRemoteStore(store).save(state(2), v1);
      await expect(remote.save(state(3), v1)).rejects.toBeInstanceOf(ConflictError);
      expect((await remote.load())!.state.updatedAt).toBe(2);
    });
  });
}

describe('WebDAV details', () => {
  it('reads queries the services build, and refuses others', () => {
    expect(parseQuery(`name = 'it\\'s.json' and 'Marksync/backups' in parents and trashed = false`)).toEqual([
      { kind: 'name', value: "it's.json" },
      { kind: 'parent', id: 'Marksync/backups' },
      { kind: 'trashed' },
    ]);
    expect(() => parseQuery("fullText contains 'x'")).toThrow();
  });

  it('parses multistatus answers with any namespace prefix and skips missing properties', () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/dav/a%20b.json</href>
      <propstat><prop><getetag>"1"</getetag><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat>
      <propstat><prop><x:count xmlns:x="m"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>
      <response><href>/dav/sub/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ href: '/dav/a%20b.json', etag: '"1"', folder: false, props: {} });
    expect(entries[1]!.folder).toBe(true);
  });

  it('only accepts http(s) addresses without credentials or queries', () => {
    expect(parseWebDavUrl('https://cloud.example.org/remote.php/dav/files/ana')!.href).toBe('https://cloud.example.org/remote.php/dav/files/ana/');
    for (const bad of ['ftp://x/', 'https://u:p@x/', 'https://x/?a=1', 'nope']) expect(parseWebDavUrl(bad)).toBeUndefined();
  });

  it('never leaves the base folder', async () => {
    const dav = new FakeWebDav();
    vi.stubGlobal('fetch', dav.fetch);
    const c = new WebDavClient({ url: dav.base, username: 'ana', password: 'app-pass' });
    await expect(c.getMeta('../../etc')).rejects.toMatchObject({ status: 400 });
  });

  it('connects with the right login and switches the backend', async () => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    fakeBrowser.permissions.contains = (async () => true) as typeof fakeBrowser.permissions.contains;
    const dav = new FakeWebDav();
    vi.stubGlobal('fetch', dav.fetch);
    await expect(connectWebDav({ url: dav.base, username: 'ana', password: 'wrong' })).rejects.toThrow('webdavAuthFailed');
    expect(await connectWebDav({ url: dav.base, username: 'ana', password: 'app-pass' })).toBe('ana @ dav.example');
    expect((await backendItem.getValue()).kind).toBe('webdav');
    expect((await statusItem.getValue()).connected).toBe(true);

    // The services now write to the server, not to Drive.
    const { driveClient } = await import('../src/services/drive-store');
    const store = driveClient();
    const folders = await withFolders(store, async (f) => f);
    expect(folders.backupsFolderId).toBe('Marksync/backups');
    expect(dav.nodes.has('Marksync/browsers')).toBe(true);
    useBackend({ kind: 'drive' });
    await tokenItem.removeValue();
  });
});
