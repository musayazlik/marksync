import { decryptJson, encryptJson, isEncryptionInfo, isEnvelope, unlockKey } from '../../src/core/crypto';
import { addProposals, PROPOSALS_FILE, sanitizeProposalsFile, type ProposalsFile } from '../../src/core/proposals';
import { sanitizeTagsFile } from '../../src/core/tags';
import type { SyncState } from '../../src/core/types';
import { sanitizeRemoteRecords } from '../../src/core/validate';
import { DriveClient, quote, type DriveCodec } from '../../src/platform/drive';
import { Library } from '../../src/core/library';

/**
 * Reads the Marksync folder in the user's Drive (the same files and the same
 * encryption as the extension, see src/services/drive-store.ts and
 * encryption-service.ts) and writes proposals.json. Nothing else is written.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CACHE_MS = 60_000;

export class MarksyncDrive {
  private raw: DriveClient;
  private drive?: DriveClient;
  private folderId?: string;
  private cache?: { at: number; library: Library };

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly passphrase?: string,
  ) {
    this.raw = new DriveClient(getToken, onUnauthorized);
  }

  private async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const found = await this.raw.list(`name = 'Marksync' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`);
    if (!found[0]) throw new Error('No Marksync folder in this Google Drive. Connect the Marksync extension to this account first.');
    this.folderId = found[0].id;
    return this.folderId;
  }

  /** The Drive client with the encryption codec, set up once. */
  private async client(): Promise<DriveClient> {
    if (this.drive) return this.drive;
    const folderId = await this.folder();
    const infoFile = (await this.raw.list(`name = 'encryption.json' and ${quote(folderId)} in parents`, 'createdTime'))[0];
    let codec: DriveCodec | undefined;
    if (infoFile) {
      const info = await this.raw.downloadJson<unknown>(infoFile.id);
      if (!isEncryptionInfo(info)) throw new Error('The encryption settings in Drive are not readable.');
      if (!this.passphrase) throw new Error('End-to-end encryption is on: set MARKSYNC_PASSPHRASE to your Marksync passphrase.');
      const key = await unlockKey(this.passphrase, info);
      codec = {
        encode: (data) => encryptJson(data, key, info.keyId),
        decode: async (stored) => (isEnvelope(stored) ? decryptJson(stored, key, info.keyId) : stored),
      };
    }
    this.drive = new DriveClient(this.getToken, this.onUnauthorized, codec);
    return this.drive;
  }

  private async file(name: string) {
    const folderId = await this.folder();
    return (await this.raw.list(`name = ${quote(name)} and ${quote(folderId)} in parents and trashed = false`, 'createdTime'))[0];
  }

  /** The bookmarks and tags, cached for a minute. */
  async library(refresh = false): Promise<Library> {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.library;
    const drive = await this.client();
    const stateFile = await this.file('sync-state.json');
    if (!stateFile) throw new Error('No sync-state.json yet: let the extension sync once.');
    const state = await drive.downloadJson<SyncState>(stateFile.id);
    if (!state || typeof state !== 'object' || (state.schema !== 1 && state.schema !== 2)) {
      throw new Error('The sync file has a newer format: update marksync-mcp.');
    }
    const { records } = sanitizeRemoteRecords(state.records, Date.now());
    const tagsFile = await this.file('tags.json');
    const tags = tagsFile ? sanitizeTagsFile(await drive.downloadJson<unknown>(tagsFile.id).catch(() => undefined), Date.now()) : {};
    const library = new Library(records, tags);
    this.cache = { at: Date.now(), library };
    return library;
  }

  /** Adds proposals to proposals.json (encrypted when encryption is on). */
  async addProposals(items: ProposalsFile['items']): Promise<number> {
    const drive = await this.client();
    const existing = await this.file(PROPOSALS_FILE);
    const current = existing ? sanitizeProposalsFile(await drive.downloadJson<unknown>(existing.id).catch(() => undefined)) : [];
    const next = addProposals(current, items, Date.now());
    if (existing) await drive.updateJson(existing.id, next);
    else await drive.createJson(PROPOSALS_FILE, await this.folder(), next);
    return next.items.length;
  }
}
