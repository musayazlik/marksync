import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { isEnvelope } from '../src/core/crypto';
import { driveClient, DriveRemoteStore, withFolders } from '../src/services/drive-store';
import {
  disableEncryption,
  enableEncryption,
  encryptionStatus,
  lockEncryption,
  resetEncryption,
  unlockEncryption,
} from '../src/services/encryption-service';
import { LockedError } from '../src/services/errors';
import { encryptionKeyItem, statusItem, tokenItem } from '../src/shared/state';
import { FakeDrive } from './fake-drive';

// PBKDF2 at full strength is slow in tests; the format is the same.
vi.mock('../src/core/crypto', async (load) => {
  const real = await load<typeof import('../src/core/crypto')>();
  return { ...real, createKey: (p: string, o: object = {}) => real.createKey(p, { ...o, iterations: 100_000 }) };
});

const PASS = 'mavi kedi bulut ucuyor';
const state = (n: number) => ({ schema: 1 as const, records: { r: { id: 'r', title: `Secret ${n}`, url: 'https://secret.example/' } }, updatedAt: n, updatedBy: 'Test' }) as never;

let drive: FakeDrive;

/** A second browser on the same account: same Drive, its own extension storage. */
async function otherBrowser() {
  fakeBrowser.reset();
  await signIn();
}

async function signIn() {
  // Messages come back as their keys.
  fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
  await statusItem.setValue({ connected: true, syncing: false, email: 'a@example.org' });
  await tokenItem.setValue({ accessToken: 'token', expiresAt: Date.now() + 3_600_000 });
}

async function write(n: number) {
  const store = new DriveRemoteStore(driveClient());
  const version = await store.currentVersion();
  return store.save(state(n), version);
}
const read = async () => (await new DriveRemoteStore(driveClient()).load())?.state as { updatedAt: number } | undefined;
const stateFile = () => drive.byName('sync-state.json')[0]!;

beforeEach(async () => {
  vi.useRealTimers();
  fakeBrowser.reset();
  drive = new FakeDrive();
  vi.stubGlobal('fetch', drive.fetch);
  await signIn();
  await write(1);
  // A backup written before encryption, plain.
  const d = driveClient();
  await withFolders(d, (f) => d.createJson('marksync-backup-old.json', f.backupsFolderId, { schema: 1, kind: 'marksync-backup', records: { x: { title: 'Old secret' } } }));
});

describe('end-to-end encryption', () => {
  it('encrypts every file already in Drive and keeps working', async () => {
    expect((await encryptionStatus()).state).toBe('off');
    const status = await enableEncryption(PASS, 'Brave on Windows');
    expect(status).toMatchObject({ state: 'on', createdBy: 'Brave on Windows' });

    for (const f of drive.files.values()) {
      if (f.mimeType.includes('folder') || f.name === 'encryption.json') continue;
      expect(f.content, f.name).not.toContain('Secret');
      expect(isEnvelope(JSON.parse(f.content)), f.name).toBe(true);
    }
    expect(drive.byName('encryption.json')).toHaveLength(1);
    expect(JSON.stringify(drive.json(drive.byName('encryption.json')[0]!.id))).not.toContain(PASS);

    await write(2);
    expect(stateFile().content).not.toContain('Secret 2');
    expect((await read())?.updatedAt).toBe(2);
  });

  it('locks another browser until the passphrase is entered there, and never writes plain data meanwhile', async () => {
    await enableEncryption(PASS, 'Brave');
    await otherBrowser();
    await expect(read()).rejects.toBeInstanceOf(LockedError);
    const before = stateFile().content;
    await expect(write(3)).rejects.toBeInstanceOf(LockedError);
    expect(stateFile().content).toBe(before);
    expect((await encryptionStatus()).state).toBe('locked');

    await expect(unlockEncryption('wrong passphrase!!')).rejects.toThrow();
    expect(await encryptionKeyItem.getValue()).toBeNull();
    expect((await unlockEncryption(PASS)).state).toBe('on');
    await write(4);
    expect((await read())?.updatedAt).toBe(4);

    // "Forget the passphrase here" locks only this browser.
    expect((await lockEncryption()).state).toBe('locked');
  });

  it('refuses to turn on twice', async () => {
    await enableEncryption(PASS, 'Brave');
    await otherBrowser();
    await expect(enableEncryption('another passphrase', 'Firefox')).rejects.toThrow();
    expect(drive.byName('encryption.json')).toHaveLength(1);
  });

  it('turns off for everyone: files are plain again and other browsers drop their key', async () => {
    await enableEncryption(PASS, 'Brave');
    expect((await disableEncryption()).state).toBe('off');
    expect(drive.byName('encryption.json')).toHaveLength(0);
    expect(isEnvelope(JSON.parse(stateFile().content))).toBe(false);
    expect(drive.byName('marksync-backup-old.json')[0]!.content).toContain('Old secret');
    expect(await encryptionKeyItem.getValue()).toBeNull();
    await write(5);
    expect(stateFile().content).toContain('Secret 5');
  });

  it('a browser that still has the old key writes plain once encryption was turned off elsewhere', async () => {
    await enableEncryption(PASS, 'Brave');
    const key = await encryptionKeyItem.getValue();
    await disableEncryption();
    // Simulate a browser that unlocked earlier and missed the change.
    await encryptionKeyItem.setValue(key!);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    await write(6);
    vi.useRealTimers();
    expect(stateFile().content).toContain('Secret 6');
    expect(await encryptionKeyItem.getValue()).toBeNull();
  });

  it('reset deletes the encrypted files and starts over without a passphrase', async () => {
    await enableEncryption(PASS, 'Brave');
    await otherBrowser();
    const { deleted } = await resetEncryption();
    expect(deleted).toBe(2);
    expect(drive.byName('encryption.json')).toHaveLength(0);
    expect(drive.byName('sync-state.json')).toHaveLength(0);
    expect((await encryptionStatus()).state).toBe('off');
    expect((await statusItem.getValue()).connected).toBe(true);
    await write(7);
    expect(stateFile().content).toContain('Secret 7');
  });
});
