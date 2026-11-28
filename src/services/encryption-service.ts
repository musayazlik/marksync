import {
  createKey,
  decryptJson,
  DecryptError,
  encryptJson,
  fromBase64,
  isEncryptionInfo,
  isEnvelope,
  MIN_PASSPHRASE,
  toBase64,
  unlockKey,
  WrongPassphraseError,
  type EncryptionInfo,
} from '../core/crypto';
import { quote, type DriveCodec } from '../platform/drive';
import type { FileStore } from '../platform/store';
import { driveClient, rawClient, setDriveCodec, withFolders } from './drive-store';
import { LockedError } from './errors';
import { exclusive } from './sync-service';
import { t } from '../shared/i18n';
import {
  driveIdsItem,
  encryptionKeyItem,
  encryptionStatusItem,
  remoteVersionItem,
  resetAccountState,
  snapshotMetaItem,
  statusItem,
  type EncryptionStatus,
} from '../shared/state';

/**
 * Optional end-to-end encryption of everything Marksync keeps in Drive
 * (sync-state.json, backups, browser snapshots). See core/crypto.ts.
 *
 *   My Drive/Marksync/encryption.json   salt, iteration count, key ID and a check
 *                                        value: what a browser needs to turn the
 *                                        passphrase into the key. Not secret.
 *
 * Every Drive read and write goes through `codec`: with a key, files are
 * encrypted before upload and decrypted after download. A browser without the
 * key never writes plain data while encryption is on (LockedError instead),
 * so turning encryption on in one browser cannot be undone by another.
 *
 * Not encrypted: file names, dates, and the browser names and bookmark counts
 * shown in the backup and import lists (Drive file metadata).
 */

export const ENCRYPTION_FILE = 'encryption.json';
const INFO_MAX_AGE_MS = 60_000;

/** Plain Drive access, for encryption.json and for rewriting files in another format. */
function rawDrive(): FileStore {
  return rawClient();
}

/** Tied to the account's Marksync folder: after switching accounts it is not used. */
let infoCache: { at: number; folderId?: string; info: EncryptionInfo | null } | undefined;

async function cacheInfo(info: EncryptionInfo | null) {
  infoCache = { at: Date.now(), folderId: (await driveIdsItem.getValue()).folderId, info };
}

/** encryption.json from Drive (cached for a minute), or null when encryption is off. */
async function remoteInfo(fresh = false): Promise<EncryptionInfo | null> {
  if (!fresh && infoCache && Date.now() - infoCache.at < INFO_MAX_AGE_MS) {
    const { folderId } = await driveIdsItem.getValue();
    if (folderId && folderId === infoCache.folderId) return infoCache.info;
  }
  const drive = rawDrive();
  const info = await withFolders(drive, async (f) => {
    const all = await drive.list(`name = ${quote(ENCRYPTION_FILE)} and ${quote(f.folderId)} in parents`, 'createdTime');
    const first = all[0];
    if (!first) return null;
    const data = await drive.downloadJson<unknown>(first.id);
    if (!isEncryptionInfo(data)) throw new Error(t('errEncryptionFile'));
    await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), encryptionFileId: first.id });
    return data;
  });
  await cacheInfo(info);
  return info;
}

async function setStatus(next: EncryptionStatus) {
  const current = await encryptionStatusItem.getValue();
  if (JSON.stringify(current) !== JSON.stringify(next)) await encryptionStatusItem.setValue(next);
}

const statusOf = (info: EncryptionInfo, state: 'on' | 'locked'): EncryptionStatus => ({
  state,
  createdAt: info.createdAt,
  ...(info.createdBy ? { createdBy: info.createdBy } : {}),
});

async function localKey(): Promise<{ keyId: string; raw: Uint8Array<ArrayBuffer> } | null> {
  const stored = await encryptionKeyItem.getValue();
  if (!stored) return null;
  try {
    return { keyId: stored.keyId, raw: fromBase64(stored.key) };
  } catch {
    await encryptionKeyItem.removeValue();
    return null;
  }
}

const codec: DriveCodec = {
  async encode(data) {
    const [info, key] = await Promise.all([remoteInfo(), localKey()]);
    if (!info) {
      // Turned off (or reset) in another browser: forget the old key.
      if (key) await encryptionKeyItem.removeValue();
      await setStatus({ state: 'off' });
      return data;
    }
    if (!key || key.keyId !== info.keyId) {
      await setStatus(statusOf(info, 'locked'));
      throw new LockedError();
    }
    return encryptJson(data, key.raw, key.keyId);
  },
  async decode(stored) {
    if (!isEnvelope(stored)) return stored;
    const key = await localKey();
    if (!key || key.keyId !== stored.keyId) {
      const info = await remoteInfo(true).catch(() => null);
      if (info) await setStatus(statusOf(info, 'locked'));
      throw new LockedError();
    }
    try {
      return await decryptJson(stored, key.raw, key.keyId);
    } catch (err) {
      if (err instanceof DecryptError) throw new Error(t('errDecrypt'));
      throw err;
    }
  },
};

/** For Settings: checks Drive and returns the current state. */
export async function encryptionStatus(): Promise<EncryptionStatus> {
  if (!(await statusItem.getValue()).connected) return { state: 'off' };
  const [info, key] = await Promise.all([remoteInfo(true), localKey()]);
  const next: EncryptionStatus = !info ? { state: 'off' } : statusOf(info, key?.keyId === info.keyId ? 'on' : 'locked');
  if (!info && key) await encryptionKeyItem.removeValue();
  await setStatus(next);
  return next;
}

/** Every Marksync file in Drive except encryption.json: the sync file, backups and browser snapshots. */
async function dataFiles(drive: FileStore): Promise<{ id: string; name: string }[]> {
  return withFolders(drive, async (f) => {
    const [top, backups, browsers] = await Promise.all([
      drive.list(`${quote(f.folderId)} in parents and mimeType != 'application/vnd.google-apps.folder'`),
      drive.list(`${quote(f.backupsFolderId)} in parents`),
      drive.list(`${quote(f.browsersFolderId)} in parents`),
    ]);
    return [...top.filter((x) => x.name !== ENCRYPTION_FILE), ...backups, ...browsers].map(({ id, name }) => ({ id, name }));
  });
}

/** Reads every file with `read` and writes it back with `write`, so it ends up in the other format. */
async function rewriteAll(read: FileStore, write: FileStore): Promise<number> {
  let n = 0;
  for (const file of await dataFiles(read)) {
    const data = await read.downloadJson<unknown>(file.id);
    await write.updateJson(file.id, data);
    n++;
  }
  return n;
}

/** Turns encryption on for the account and encrypts everything already in Drive. */
export function enableEncryption(passphrase: string, deviceName: string): Promise<EncryptionStatus> {
  return exclusive(async () => {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
      throw new Error(t('encPassphraseShort', MIN_PASSPHRASE));
    }
    if (!(await statusItem.getValue()).connected) throw new Error(t('errConnectFirst'));
    if (await remoteInfo(true)) throw new Error(t('encAlreadyOn'));
    const { info, raw } = await createKey(passphrase, { createdBy: deviceName });

    const drive = rawDrive();
    // Two browsers turning encryption on at once: the older file wins.
    const winner = await withFolders(drive, async (f) => {
      const mine = await drive.createJson(ENCRYPTION_FILE, f.folderId, info);
      const all = await drive.list(`name = ${quote(ENCRYPTION_FILE)} and ${quote(f.folderId)} in parents`, 'createdTime');
      const first = all[0] ?? mine;
      if (first.id !== mine.id) await drive.delete(mine.id).catch(() => undefined);
      return first.id === mine.id;
    });
    infoCache = undefined;
    if (!winner) throw new Error(t('encAlreadyOn'));

    await encryptionKeyItem.setValue({ keyId: info.keyId, key: toBase64(raw) });
    await cacheInfo(info);
    // Plain reads, encrypted writes.
    await rewriteAll(rawDrive(), driveClient());
    // The sync file changed: the next check must not think it is someone else's change.
    await remoteVersionItem.removeValue();
    const status = statusOf(info, 'on');
    await setStatus(status);
    return status;
  });
}

/** Enters the passphrase in this browser. */
export async function unlockEncryption(passphrase: string): Promise<EncryptionStatus> {
  const info = await remoteInfo(true);
  if (!info) {
    await setStatus({ state: 'off' });
    return { state: 'off' };
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await unlockKey(String(passphrase ?? ''), info);
  } catch (err) {
    if (err instanceof WrongPassphraseError) throw new Error(t('encWrongPassphrase'));
    throw err;
  }
  await encryptionKeyItem.setValue({ keyId: info.keyId, key: toBase64(raw) });
  const status = statusOf(info, 'on');
  await setStatus(status);
  // The browser snapshot may have been skipped while locked.
  await snapshotMetaItem.setValue({});
  return status;
}

/** Forgets the key in this browser only (it asks for the passphrase again). */
export async function lockEncryption(): Promise<EncryptionStatus> {
  await encryptionKeyItem.removeValue();
  return encryptionStatus();
}

/** Turns encryption off for the account: every file is stored in plain JSON again. */
export function disableEncryption(): Promise<EncryptionStatus> {
  return exclusive(async () => {
    const info = await remoteInfo(true);
    const key = await localKey();
    if (!info) {
      await encryptionKeyItem.removeValue();
      await setStatus({ state: 'off' });
      return { state: 'off' };
    }
    if (!key || key.keyId !== info.keyId) throw new LockedError();
    // Decrypting reads, plain writes.
    await rewriteAll(driveClient(), rawDrive());
    const drive = rawDrive();
    await withFolders(drive, async (f) => {
      for (const file of await drive.list(`name = ${quote(ENCRYPTION_FILE)} and ${quote(f.folderId)} in parents`)) {
        await drive.delete(file.id);
      }
    });
    await cacheInfo(null);
    await encryptionKeyItem.removeValue();
    await remoteVersionItem.removeValue();
    await setStatus({ state: 'off' });
    return { state: 'off' };
  });
}

/**
 * "Forgot the passphrase": deletes the encrypted files and encryption.json.
 * Bookmarks stay in every browser; this browser starts a new sync file from
 * them, and other browsers match their bookmarks with it (no duplicates, see
 * SyncState.epoch). Encrypted backups are lost.
 */
export function resetEncryption(): Promise<{ deleted: number }> {
  return exclusive(async () => {
    const drive = rawDrive();
    let deleted = 0;
    for (const file of await dataFiles(drive)) {
      const data = await drive.downloadJson<unknown>(file.id).catch(() => undefined);
      if (isEnvelope(data)) {
        await drive.delete(file.id);
        deleted++;
      }
    }
    await withFolders(drive, async (f) => {
      for (const file of await drive.list(`name = ${quote(ENCRYPTION_FILE)} and ${quote(f.folderId)} in parents`)) {
        await drive.delete(file.id);
      }
    });
    await cacheInfo(null);
    // Start this browser's sync history over; keep the account connected.
    const status = await statusItem.getValue();
    await resetAccountState();
    await statusItem.setValue({ ...status, error: undefined });
    return { deleted };
  });
}

// Every Drive client made by drive-store encrypts and decrypts from now on.
setDriveCodec(codec);
