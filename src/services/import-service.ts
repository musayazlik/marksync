import { countSource, parseNetscapeHtml, snapshotToSource, validateImportSource, type ImportSource } from '../core/import';
import { deviceLabel } from '../platform/browser-info';
import { DriveError, quote } from '../platform/drive';
import { deviceIdItem, snapshotMetaItem, syncStateItem } from '../shared/state';
import { importIntoLocal, type ImportMode, type ImportResult } from '../sync/importer';
import { readLocal } from '../sync/local-tree';
import { appFolders, assertInFolder, driveClient, withFolders } from './drive-store';
import { exclusive, localBookmarks } from './sync-service';

/**
 * Every connected browser keeps a copy of its own bookmark tree in
 * `Marksync/browsers/<device id>.json`. Any other browser can import it,
 * even when sync is turned off in one of them.
 */
export interface BrowserSnapshotFile {
  schema: 1;
  kind: 'marksync-browser';
  deviceId: string;
  label: string;
  updatedAt: number;
  count: number;
  source: ImportSource;
}

export interface BrowserInfo {
  fileId: string;
  label: string;
  count: number;
  updatedAt: string;
  /** True for the browser this page runs in. */
  self: boolean;
}

/** FNV-1a; only used to skip uploads when nothing changed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function localSource(): Promise<ImportSource> {
  const { menuFolderId } = await syncStateItem.getValue();
  const { snapshot } = await readLocal(localBookmarks(), menuFolderId);
  return snapshotToSource(snapshot);
}

/** Uploads this browser's tree if it changed since the last upload. */
export async function publishSnapshot(): Promise<void> {
  const source = await localSource();
  const label = await deviceLabel();
  const digest = hash(label + JSON.stringify(source));
  const meta = await snapshotMetaItem.getValue();
  if (meta.hash === digest && meta.fileId) return;

  const deviceId = await deviceIdItem.getValue();
  const count = countSource(source);
  const file: BrowserSnapshotFile = {
    schema: 1,
    kind: 'marksync-browser',
    deviceId,
    label,
    updatedAt: Date.now(),
    count,
    source,
  };
  const drive = driveClient();
  const name = `${deviceId}.json`;
  const fileId = await withFolders(drive, async (f) => {
    const existing = meta.fileId ? { id: meta.fileId } : await drive.findByName(name, f.browsersFolderId);
    if (existing) {
      try {
        return (await drive.updateJson(existing.id, file)).id;
      } catch (err) {
        // The file was deleted (e.g. "Remove" in another browser): create it again.
        if (!(err instanceof DriveError && err.status === 404)) throw err;
      }
    }
    const appProperties = { deviceId, label, count: String(count) };
    return (await drive.createJson(name, f.browsersFolderId, file, appProperties)).id;
  });
  await snapshotMetaItem.setValue({ fileId, hash: digest });
}

export async function listBrowsers(): Promise<BrowserInfo[]> {
  const drive = driveClient();
  const { browsersFolderId } = await appFolders(drive);
  const deviceId = await deviceIdItem.getValue();
  const files = await drive.list(`${quote(browsersFolderId)} in parents`, 'modifiedTime desc');
  return files.map((f) => ({
    fileId: f.id,
    label: f.appProperties?.label ?? f.name,
    count: Number(f.appProperties?.count ?? 0),
    updatedAt: f.modifiedTime ?? '',
    self: f.appProperties?.deviceId === deviceId,
  }));
}

/** Removes a browser you no longer use from the list. */
export async function removeBrowser(fileId: string): Promise<void> {
  const drive = driveClient();
  await assertInFolder(drive, fileId, 'browsers');
  await drive.delete(fileId);
  const meta = await snapshotMetaItem.getValue();
  if (meta.fileId === fileId) await snapshotMetaItem.setValue({});
}

async function importSource(source: ImportSource, mode: ImportMode, label: string): Promise<ImportResult> {
  if (countSource(source) === 0) throw new Error('No bookmarks found to import.');
  return exclusive(async () => {
    const state = await syncStateItem.getValue();
    const result = await importIntoLocal(localBookmarks(), source, {
      mode,
      label,
      ...(state.menuFolderId ? { menuFolderId: state.menuFolderId } : {}),
    });
    if (result.menuFolderId) {
      await syncStateItem.setValue({ ...(await syncStateItem.getValue()), menuFolderId: result.menuFolderId });
    }
    return result;
  });
}

export async function importFromBrowser(fileId: string, mode: ImportMode): Promise<ImportResult> {
  const drive = driveClient();
  await assertInFolder(drive, fileId, 'browsers');
  const file = await drive.downloadJson<BrowserSnapshotFile>(fileId);
  if (typeof file !== 'object' || file === null || file.kind !== 'marksync-browser' || file.schema !== 1) {
    throw new Error('This is not a Marksync browser file.');
  }
  const label = typeof file.label === 'string' && file.label.trim() ? file.label.slice(0, 60) : 'another browser';
  return importSource(validateImportSource(file.source), mode, label);
}

/** Imports an HTML bookmarks file exported by any browser. Works without a Google account. */
export function importHtml(html: string, mode: ImportMode, label: string): Promise<ImportResult> {
  if (typeof html !== 'string') throw new Error('No file content.');
  return importSource(parseNetscapeHtml(html), mode, String(label).slice(0, 60));
}
