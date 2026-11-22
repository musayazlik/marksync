import { browser } from 'wxt/browser';
import type { BackupInfo } from '../services/backup-service';
import type { BrowserInfo } from '../services/import-service';
import type { ImportMode, ImportResult } from '../sync/importer';

/** Requests from the popup and options page to the background script. */
export type Request =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'syncNow'; allowMassDelete?: boolean }
  | { type: 'checkNow' }
  | { type: 'resyncFromDrive' }
  | { type: 'keepLocal' }
  | { type: 'backupNow' }
  | { type: 'listBackups' }
  | { type: 'restoreBackup'; id: string }
  | { type: 'deleteBackup'; id: string }
  | { type: 'listBrowsers' }
  | { type: 'removeBrowser'; fileId: string }
  | { type: 'importFromBrowser'; fileId: string; mode: ImportMode }
  | { type: 'importHtml'; html: string; mode: ImportMode; label: string }
  | { type: 'exportHtml' }
  | { type: 'getRedirectUrl' }
  | { type: 'settingsChanged' };

export interface ResponseData {
  connect: string;
  disconnect: void;
  syncNow: void;
  checkNow: void;
  resyncFromDrive: void;
  keepLocal: void;
  backupNow: BackupInfo;
  listBackups: BackupInfo[];
  restoreBackup: void;
  deleteBackup: void;
  listBrowsers: BrowserInfo[];
  removeBrowser: void;
  importFromBrowser: ImportResult;
  importHtml: ImportResult;
  exportHtml: string;
  getRedirectUrl: string;
  settingsChanged: void;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export async function send<R extends Request>(req: R): Promise<ResponseData[R['type']]> {
  const res = (await browser.runtime.sendMessage(req)) as Envelope<ResponseData[R['type']]> | undefined;
  if (!res) throw new Error('The background script did not answer.');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
