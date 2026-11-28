import { browser } from 'wxt/browser';
import { t } from './i18n';
import type { KeyUsage, ModelInfo } from '../core/openrouter-data';
import type { BackupInfo } from '../services/backup-service';
import type { BackupDiff, BackupHit, PartialRestoreResult } from '../services/history-service';
import type { DuplicateGroup } from '../core/dedupe';
import type { RemoveDuplicatesResult } from '../services/dedupe-service';
import type { BulkLinkResult, LinkAction } from '../services/links-service';
import type { BrowserInfo } from '../services/import-service';
import type { BulkApplyResult } from '../services/bulk-service';
import type { SortNowResult } from '../services/sorter-service';
import type { BulkJob, EncryptionStatus, TidyJob } from './state';
import type { TidyApplyResult, TidyEstimate } from '../services/tidy-service';
import type { NamingEstimate, NamingOptions } from '../services/naming-service';
import type { AssistantCheck } from '../services/assistant-service';
import type { DigestAction, DigestEntry } from '../services/digest-service';
import type { SemanticStatus } from '../services/semantic-service';
import type { BuiltinState } from '../platform/builtin-ai';
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
  | { type: 'historyCompare'; id: string }
  | { type: 'historyRestore'; id: string; ids: string[] }
  | { type: 'historySearch'; query: string }
  | { type: 'listBrowsers' }
  | { type: 'removeBrowser'; fileId: string }
  | { type: 'importFromBrowser'; fileId: string; mode: ImportMode }
  | { type: 'importHtml'; html: string; mode: ImportMode; label: string }
  | { type: 'exportHtml' }
  | { type: 'getRedirectUrl' }
  | { type: 'settingsChanged' }
  | { type: 'aiListFolders' }
  | { type: 'aiTestKey' }
  | { type: 'aiListModels'; refresh?: boolean }
  | { type: 'aiUsage' }
  | { type: 'aiEndpointModels' }
  | { type: 'tagsGet' }
  | { type: 'digestGet' }
  | { type: 'semStatus' }
  | { type: 'semBuild' }
  | { type: 'semStop' }
  | { type: 'semDelete' }
  | { type: 'semSearch'; query: string }
  | { type: 'semReady' }
  | { type: 'digestAct'; id: string; action: DigestAction }
  | { type: 'tagsSet'; id: string; tags: string[] }
  | { type: 'aiBuiltinStatus' }
  | { type: 'aiBulkStart'; folderId: string; research: boolean }
  | { type: 'aiBulkCancel' }
  | { type: 'aiBulkApply'; bookmarkIds: string[] }
  | { type: 'aiBulkDiscard' }
  | { type: 'aiNamingEstimate'; options: NamingOptions }
  | { type: 'aiNamingStart'; options: NamingOptions }
  | { type: 'aiNamingCancel' }
  | { type: 'aiNamingEdit'; id: string; title: string }
  | { type: 'aiNamingApply'; ids: string[] }
  | { type: 'aiNamingDiscard' }
  | { type: 'aiAssistantCheck' }
  | { type: 'aiTidyEstimate'; scopeId: string }
  | { type: 'aiTidyStart'; scopeId: string }
  | { type: 'aiTidyCancel' }
  | { type: 'aiTidyApply'; ids: string[] }
  | { type: 'aiTidyDiscard' }
  | { type: 'encStatus' }
  | { type: 'encEnable'; passphrase: string }
  | { type: 'encUnlock'; passphrase: string }
  | { type: 'encLock' }
  | { type: 'encDisable' }
  | { type: 'encReset' }
  | { type: 'aiSortNow' }
  | { type: 'aiUndo'; id: string }
  | { type: 'aiClearLog' }
  | { type: 'dupScan' }
  | { type: 'dupRemove'; expected: Record<string, string> }
  | { type: 'linkScan'; resume?: boolean }
  | { type: 'linkStop' }
  | { type: 'linkFix'; id: string; action: LinkAction }
  | { type: 'linkFixAll'; kind: 'remove-dead' | 'update-redirects' };

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
  historyCompare: BackupDiff;
  historyRestore: PartialRestoreResult;
  historySearch: BackupHit[];
  listBrowsers: BrowserInfo[];
  removeBrowser: void;
  importFromBrowser: ImportResult;
  importHtml: ImportResult;
  exportHtml: string;
  getRedirectUrl: string;
  settingsChanged: void;
  aiListFolders: { id: string; path: string }[];
  aiTestKey: string;
  aiListModels: ModelInfo[];
  aiUsage: KeyUsage;
  aiEndpointModels: string[];
  tagsGet: { byId: Record<string, string[]>; all: { tag: string; count: number }[] };
  tagsSet: string[];
  digestGet: DigestEntry[] | null;
  semStatus: SemanticStatus;
  semBuild: void;
  semStop: void;
  semDelete: void;
  semSearch: { id: string; score: number }[];
  semReady: boolean;
  digestAct: void;
  aiBuiltinStatus: BuiltinState;
  aiBulkStart: BulkJob;
  aiBulkCancel: void;
  aiBulkApply: BulkApplyResult;
  aiBulkDiscard: void;
  aiNamingEstimate: NamingEstimate;
  aiNamingStart: TidyJob;
  aiNamingCancel: void;
  aiNamingEdit: string;
  aiNamingApply: TidyApplyResult;
  aiNamingDiscard: void;
  aiAssistantCheck: AssistantCheck;
  aiTidyEstimate: TidyEstimate;
  aiTidyStart: TidyJob;
  aiTidyCancel: void;
  aiTidyApply: TidyApplyResult;
  aiTidyDiscard: void;
  encStatus: EncryptionStatus;
  encEnable: EncryptionStatus;
  encUnlock: EncryptionStatus;
  encLock: EncryptionStatus;
  encDisable: EncryptionStatus;
  encReset: { deleted: number };
  aiSortNow: SortNowResult;
  aiUndo: void;
  aiClearLog: void;
  dupScan: DuplicateGroup[];
  dupRemove: RemoveDuplicatesResult;
  linkScan: void;
  linkStop: void;
  linkFix: void;
  linkFixAll: BulkLinkResult;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export async function send<R extends Request>(req: R): Promise<ResponseData[R['type']]> {
  const res = (await browser.runtime.sendMessage(req)) as Envelope<ResponseData[R['type']]> | undefined;
  if (!res) throw new Error(t('errNoAnswer'));
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
