import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createKey, encryptJson } from '../src/core/crypto';
import { sanitizeProposalsFile } from '../src/core/proposals';
import type { RecordMap, SyncRecord } from '../src/core/types';
import { DriveClient } from '../src/platform/drive';
import { checkAssistantProposals, toTidyProposals } from '../src/services/assistant-service';
import { aiTidyItem, statusItem, syncStateItem, tokenItem } from '../src/shared/state';
import { applyTidy, undoTidy } from '../src/sync/tidy';
import { MarksyncDrive } from '../mcp/src/drive';
import { Library } from '../src/core/library';
import { FakeDrive } from './fake-drive';
import { FakeBookmarks } from './fakes';

vi.mock('../src/core/crypto', async (load) => {
  const real = await load<typeof import('../src/core/crypto')>();
  return { ...real, createKey: (p: string, o: object = {}) => real.createKey(p, { ...o, iterations: 100_000 }) };
});

const rec = (id: string, parentId: string, index: number, title: string, url?: string): SyncRecord => ({
  id,
  kind: url === undefined ? 'folder' : 'bookmark',
  parentId,
  index,
  pos: String.fromCharCode(97 + index),
  title,
  ...(url !== undefined ? { url } : {}),
  contentAt: 1,
  positionAt: 1,
});

const records: RecordMap = Object.fromEntries(
  [
    rec('dev', 'toolbar', 0, 'Dev'),
    rec('docs', 'dev', 0, 'Docs'),
    rec('pg', 'docs', 0, 'Postgres manual', 'https://postgresql.org/docs/'),
    rec('misc', 'other', 0, 'Misc'),
    rec('pasta', 'misc', 0, 'Pasta carbonara', 'https://food.example/pasta'),
  ].map((r) => [r.id, r]),
);

describe('the MCP library', () => {
  const lib = new Library(records, { pasta: { tags: ['recipe'], at: 1 } });

  it('searches by words and tags, with folder paths', () => {
    expect(lib.search('postgres').results).toEqual([
      { id: 'pg', title: 'Postgres manual', url: 'https://postgresql.org/docs/', folder: 'Bookmarks bar / Dev / Docs', folderId: 'docs' },
    ]);
    expect(lib.search('#recipe').results.map((r) => r.id)).toEqual(['pasta']);
  });

  it('lists folders and resolves them by id, key or path', () => {
    expect(lib.folders().map((f) => f.path)).toEqual(['Bookmarks bar', 'Bookmarks bar / Dev', 'Bookmarks bar / Dev / Docs', 'Other bookmarks', 'Other bookmarks / Misc']);
    expect(lib.listFolder('bookmarks bar / dev')!.folders.map((f) => f.id)).toEqual(['docs']);
    expect(lib.listFolder('other')!.folders.map((f) => f.id)).toEqual(['misc']);
    expect(lib.listFolder('nope')).toBeUndefined();
  });

  it('accepts only proposals that make sense', () => {
    const { ok, refused } = lib.checkProposals(
      [
        { kind: 'move', recordId: 'pasta', toFolderId: 'toolbar', reason: 'Used daily' },
        { kind: 'move', recordId: 'dev', toFolderId: 'docs' },
        { kind: 'move', recordId: 'ghost', toFolderId: 'misc' },
        { kind: 'retitle', recordId: 'pg', title: 'PostgreSQL documentation' },
        { kind: 'rename', folderId: 'toolbar', name: 'Bar' },
        { kind: 'merge', folderId: 'misc', intoId: 'dev' },
        { kind: 'nonsense' },
      ],
      'Claude',
      100,
    );
    expect(ok.map((p) => p.kind)).toEqual(['move', 'retitle', 'merge']);
    expect(ok[0]).toMatchObject({ from: 'Claude', at: 100, reason: 'Used daily' });
    expect(refused).toHaveLength(4);
  });
});

describe('from the MCP server to the extension', () => {
  let drive: FakeDrive;
  let b: FakeBookmarks;
  let local: Record<string, string>;

  beforeEach(async () => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    drive = new FakeDrive();
    vi.stubGlobal('fetch', drive.fetch);
    // The extension's side: connected, a synced tree.
    await statusItem.setValue({ connected: true, syncing: false });
    await tokenItem.setValue({ accessToken: 'token', expiresAt: Date.now() + 3_600_000 });
    b = new FakeBookmarks('chromium');
    (fakeBrowser as unknown as { bookmarks: FakeBookmarks }).bookmarks = b;
    const dev = await b.add('1', 'Dev');
    const docs = await b.add(dev, 'Docs');
    const pg = await b.add(docs, 'Postgres manual', 'https://postgresql.org/docs/');
    const misc = await b.add('2', 'Misc');
    const pasta = await b.add(misc, 'Pasta carbonara', 'https://food.example/pasta');
    local = { dev, docs, pg, misc, pasta };
    await syncStateItem.setValue({ mapping: Object.fromEntries(Object.entries(local).map(([rid, lid]) => [lid, rid])), mirror: records, keep: [] });
  });

  const mcpDrive = (passphrase?: string) => new MarksyncDrive(async () => 'token', async () => undefined, passphrase);

  async function writeDrive(encryptWith?: string) {
    const client = new DriveClient(async () => 'token', async () => undefined);
    const folder = await client.ensureFolder('Marksync');
    const state = { schema: 2, records, updatedAt: 1, updatedBy: 'Test' };
    if (!encryptWith) {
      await client.createJson('sync-state.json', folder, state);
      return;
    }
    const { info, raw } = await createKey(encryptWith);
    await client.createJson('encryption.json', folder, info);
    await client.createJson('sync-state.json', folder, await encryptJson(state, raw, info.keyId));
  }

  it('reads the library from Drive and leaves proposals the extension takes over', async () => {
    await writeDrive();
    const mcp = mcpDrive();
    expect((await mcp.library()).stats()).toEqual({ bookmarks: 2, folders: 3 });
    const lib = await mcp.library();
    const { ok } = lib.checkProposals([{ kind: 'move', recordId: 'pasta', toFolderId: 'dev' }, { kind: 'retitle', recordId: 'pg', title: 'PostgreSQL documentation' }], 'Claude', Date.now());
    expect(await mcp.addProposals(ok)).toBe(2);
    expect(sanitizeProposalsFile(drive.json(drive.byName('proposals.json')[0]!.id))).toHaveLength(2);

    expect(await checkAssistantProposals()).toEqual({ imported: 2, waiting: 0 });
    const job = (await aiTidyItem.getValue())!;
    expect(job.state).toBe('ready');
    expect(job.proposals.map((p) => p.kind).sort()).toEqual(['move', 'retitle']);
    expect(drive.byName('proposals.json')).toHaveLength(0);

    // Applying the move, then undoing it.
    const move = job.proposals.find((p) => p.kind === 'move')!;
    const out = await applyTidy(b, move, 'Claude');
    expect(out.status).toBe('tidied');
    expect((await b.getChildren(local.dev!)).map((c) => c.id)).toContain(local.pasta);
    await undoTidy(b, { id: 'l', at: 1, ...out });
    expect((await b.getChildren(local.misc!)).map((c) => c.id)).toEqual([local.pasta]);
  });

  it('needs the passphrase when encryption is on, and writes proposals encrypted', async () => {
    await writeDrive('mavi kedi bulut ucuyor');
    await expect(mcpDrive().library()).rejects.toThrow('MARKSYNC_PASSPHRASE');
    await expect(mcpDrive('wrong passphrase!!').library()).rejects.toThrow();
    const mcp = mcpDrive('mavi kedi bulut ucuyor');
    const lib = await mcp.library();
    const { ok } = lib.checkProposals([{ kind: 'rename', folderId: 'misc', name: 'Recipes' }], 'Claude', Date.now());
    await mcp.addProposals(ok);
    const stored = drive.files.get(drive.byName('proposals.json')[0]!.id)!.content;
    expect(stored).not.toContain('Recipes');
    expect(stored).toContain('marksyncEncrypted');
  });

  it('keeps proposals in Drive while a tidy-up review is open', async () => {
    await writeDrive();
    const mcp = mcpDrive();
    await mcp.addProposals((await mcp.library()).checkProposals([{ kind: 'move', recordId: 'pasta', toFolderId: 'dev' }], 'Claude', 1).ok);
    await aiTidyItem.setValue({ id: 'x', scopeId: '', scopePath: '', model: 'm', provider: 'openrouter', state: 'ready', step: 1, steps: 1, proposals: [{ id: 'p', kind: 'remove', folderId: 'f', title: 'F', folderPath: 'F' }], startedAt: 1, cost: 0 });
    expect(await checkAssistantProposals()).toEqual({ imported: 0, waiting: 1 });
    expect(drive.byName('proposals.json')).toHaveLength(1);
  });

  it('drops proposals about things this browser does not have', () => {
    const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [{ id: 'L1', title: 'A', url: 'https://a.example/' }] }] }];
    const got = toTidyProposals(
      [
        { id: 'p1', kind: 'retitle', recordId: 'r1', title: 'Better A', at: 1 },
        { id: 'p2', kind: 'retitle', recordId: 'missing', title: 'X', at: 1 },
        { id: 'p3', kind: 'rename', folderId: 'toolbar', name: 'Nope', at: 1 },
      ],
      tree,
      (ref) => ({ r1: 'L1', toolbar: '1' })[ref],
    );
    expect(got.map((p) => p.id)).toEqual(['p1']);
  });
});
