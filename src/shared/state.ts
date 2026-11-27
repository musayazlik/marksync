import { storage } from '#imports';
import type { SiteInfo } from '../core/ai-sort';
import { AI_PROVIDERS, ENDPOINT_MODEL, parseEndpoint, type AiProvider } from '../core/ai-provider';
import type { Spend } from '../core/budget';
import type { TagEntry, TagMap } from '../core/tags';
import type { TidyProposal } from '../core/tidy';
import type { LinkReason, Snapshot } from '../core/links';
import type { KeyUsage, ModelInfo } from '../core/openrouter-data';
import type { LocalState } from '../sync/engine';

export interface Settings {
  syncEnabled: boolean;
  /** Minutes between background syncs (bookmark changes also trigger a sync). */
  syncIntervalMin: number;
  autoBackup: boolean;
  backupIntervalHours: number;
  /** How many backups to keep in Drive. */
  backupRetention: number;
  /** Name of this browser in backups and import lists; empty = detected. */
  deviceName: string;
  /** AI sorting: bookmarks added to the inbox folder in this browser are filed by a model. */
  aiSortEnabled: boolean;
  /** Who runs the model: OpenRouter, an OpenAI-compatible endpoint, or the browser's built-in model. */
  aiProvider: AiProvider;
  /** Base URL of the OpenAI-compatible endpoint, e.g. "http://localhost:11434/v1"; empty = none. */
  aiEndpoint: string;
  /** Model name on that endpoint, e.g. "llama3.2:3b"; empty = none. */
  aiEndpointModel: string;
  /** Local ID of the inbox folder in this browser; empty = none chosen. */
  aiInboxFolderId: string;
  /** OpenRouter model ID, e.g. "google/gemini-3.5-flash-lite". */
  aiModel: string;
  /** Let the model create a new folder when none of the existing ones fits. */
  aiAllowNewFolders: boolean;
  /** Let the model read the page and search the web before deciding (slower, small extra cost). */
  aiResearch: boolean;
  /** Monthly cap in USD for AI sorting in this browser; 0 = no cap. */
  aiMonthlyBudget: number;
}

/** Strong at research and judgement; any OpenRouter model ID can be entered in Settings. */
export const DEFAULT_AI_MODEL = 'anthropic/claude-opus-5.5';
/** Offered in Settings next to the free-text model field. */
export const SUGGESTED_AI_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'google/gemini-3.8-flash',
  'google/gemini-3.5-flash-lite',
] as const;

export const DEFAULT_SETTINGS: Settings = {
  syncEnabled: true,
  syncIntervalMin: 1,
  autoBackup: true,
  backupIntervalHours: 24,
  backupRetention: 30,
  deviceName: '',
  aiSortEnabled: false,
  aiProvider: 'openrouter',
  aiEndpoint: '',
  aiEndpointModel: '',
  aiInboxFolderId: '',
  aiModel: DEFAULT_AI_MODEL,
  aiAllowNewFolders: false,
  aiResearch: true,
  aiMonthlyBudget: 0,
};

export type ErrorCode = 'auth' | 'mass-delete' | 'config' | 'network' | 'locked' | 'unknown';

export interface Status {
  connected: boolean;
  email?: string;
  syncing: boolean;
  lastSyncAt?: number;
  lastBackupAt?: number;
  total?: number;
  /** Items this browser cannot show (e.g. javascript: links in Firefox). */
  skipped?: number;
  error?: {
    code: ErrorCode;
    message: string;
    deletions?: number;
    total?: number;
    /** For 'mass-delete': where the deletions came from. */
    source?: 'local' | 'remote';
  };
}

export interface Token {
  accessToken: string;
  expiresAt: number;
}

export interface DriveIds {
  folderId?: string;
  backupsFolderId?: string;
  browsersFolderId?: string;
  stateFileId?: string;
  encryptionFileId?: string;
  tagsFileId?: string;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});
export const statusItem = storage.defineItem<Status>('local:status', {
  fallback: { connected: false, syncing: false },
});
export const syncStateItem = storage.defineItem<LocalState>('local:syncState', {
  fallback: { mapping: {}, mirror: {}, keep: [] },
});
/** Access tokens live in session storage, so they are gone when the browser closes. */
export const tokenItem = storage.defineItem<Token>('session:token');
export const driveIdsItem = storage.defineItem<DriveIds>('local:driveIds', { fallback: {} });
/** Drive version of sync-state.json after this browser's last sync. */
export const remoteVersionItem = storage.defineItem<string>('local:remoteVersion');
/** Random id of this browser profile; names its snapshot file in Drive. */
export const deviceIdItem = storage.defineItem<string>('local:deviceId', {
  init: () => crypto.randomUUID(),
});
/**
 * The user's OpenRouter API key. Kept in this browser only (never uploaded to
 * Drive), and read only by the background script.
 */
export const openRouterKeyItem = storage.defineItem<string>('local:openRouterKey');
/** Optional API key of the OpenAI-compatible endpoint; like the OpenRouter key, never uploaded. */
export const endpointKeyItem = storage.defineItem<string>('local:aiEndpointKey');

/** OpenRouter's model list, cached so Settings opens instantly (refreshed every few hours). */
export const aiModelsItem = storage.defineItem<{ fetchedAt: number; models: ModelInfo[] }>('local:aiModels');
/**
 * The encryption key for the Drive files, once the passphrase was entered in
 * this browser (base64 of the 32-byte key). Never uploaded; cleared when the
 * account changes or encryption is turned off.
 */
export const encryptionKeyItem = storage.defineItem<{ keyId: string; key: string }>('local:encryptionKey');

/** Last known encryption state of the account, for Settings, the popup and the badge. */
export interface EncryptionStatus {
  state: 'off' | 'on' | 'locked';
  createdAt?: string;
  createdBy?: string;
}
export const encryptionStatusItem = storage.defineItem<EncryptionStatus>('local:encryptionStatus', {
  fallback: { state: 'off' },
});

/**
 * Tags of this browser's bookmarks by shared record ID, as last merged with
 * tags.json in Drive (see services/tags-service.ts). `pending`: tags set on
 * bookmarks that have no shared ID yet (not synced), by local ID.
 */
export interface TagsStore {
  items: TagMap;
  pending: Record<string, TagEntry>;
  /** Drive version of tags.json after the last merge. */
  version?: string;
}
export const tagsItem = storage.defineItem<TagsStore>('local:tags', { fallback: { items: {}, pending: {} } });

/** What AI sorting in this browser spent this month (see core/budget.ts). */
export const aiSpendItem = storage.defineItem<Spend>('local:aiSpend');
/** Last known spending and limit of the OpenRouter key, shown in the popup. */
export const aiUsageItem = storage.defineItem<KeyUsage>('local:aiUsage');

/** One AI sorting decision, shown on the sorting log page. */
export interface SortLogEntry {
  id: string;
  at: number;
  /** Local bookmark ID in this browser. */
  bookmarkId: string;
  title: string;
  url?: string;
  /** 'tidied': a change from "Tidy up the library" (see `tidy`). */
  status: 'moved' | 'created' | 'kept' | 'error' | 'tidied';
  fromId?: string;
  fromPath?: string;
  toId?: string;
  toPath?: string;
  reason?: string;
  confidence?: number;
  model: string;
  /** Who ran the model; missing in entries from before 0.5 (OpenRouter). */
  provider?: AiProvider;
  error?: string;
  /** 'auth' | 'credits' | 'rate-limit' | 'model' | 'permission' | 'network' | 'unavailable' | 'reply' | 'unknown'. */
  errorCode?: string;
  /** Set when the user moved the bookmark back with Undo. */
  undoneAt?: number;
  /** What the model found out about the site. */
  site?: SiteInfo;
  /** Topic tags the model proposed (given to the bookmark if it had none). */
  tags?: string[];
  /** Web pages the model used (http/https only). */
  sources?: { url: string; title?: string }[];
  /** OpenRouter's reported cost of the request, in USD (other providers report none). */
  cost?: number;
  /** True when the model was allowed to read the page and search the web. */
  researched?: boolean;
  /** For 'tidied' entries: what changed, and what Undo needs. */
  tidy?: TidyChange;
}

/** One applied tidy-up change (sync/tidy.ts). `bookmarkId` of the log entry is the bookmark or folder. */
export interface TidyChange {
  action: 'retitle' | 'rename' | 'merge' | 'remove';
  /** Title or folder name before. */
  before: string;
  after?: string;
  /** Merge and remove: where the folder was, to bring it back. */
  parentId?: string;
  index?: number;
  /** Merge: the items moved into `targetId`. */
  moved?: string[];
  targetId?: string;
}


/** One proposal of a bulk sorting run (see services/bulk-service.ts). */
export type BulkProposal = Omit<SortLogEntry, 'id' | 'at'> & {
  /** A folder the model wants to create (created only when the proposal is applied). */
  newFolder?: { parentId: string; name: string };
  /** Set once the proposal was carried out, or why it could not be. */
  appliedAt?: number;
  applyError?: string;
};

/** A bulk sorting run: the model proposes a folder for each bookmark, the user approves. */
export interface BulkJob {
  id: string;
  folderId: string;
  folderPath: string;
  model: string;
  /** Missing in runs from before 0.5 (OpenRouter). */
  provider?: AiProvider;
  research: boolean;
  allowNewFolders: boolean;
  state: 'planning' | 'ready' | 'applying' | 'done';
  /** Bookmarks still to ask the model about. */
  queue: string[];
  total: number;
  proposals: BulkProposal[];
  startedAt: number;
  /** USD OpenRouter reported for this run. */
  cost: number;
  /** Why planning ended early. */
  stopped?: 'cancelled' | 'budget' | 'error';
  stopMessage?: string;
  applied?: { moved: number; failed: number };
}

/** A "Tidy up the library" run (services/tidy-service.ts). */
export interface TidyJob {
  id: string;
  /** Folder to tidy; '' = the whole library. */
  scopeId: string;
  scopePath: string;
  model: string;
  provider: AiProvider;
  state: 'planning' | 'ready' | 'applying' | 'done';
  /** Model requests done and planned, for the progress bar. */
  step: number;
  steps: number;
  proposals: (TidyProposal & { appliedAt?: number; applyError?: string })[];
  startedAt: number;
  /** USD OpenRouter reported for this run. */
  cost: number;
  /** Requests that failed (the run goes on without their proposals). */
  failures?: number;
  stopped?: 'cancelled' | 'budget' | 'error' | 'interrupted';
  stopMessage?: string;
  applied?: { done: number; failed: number; backedUp: boolean };
}
export const aiTidyItem = storage.defineItem<TidyJob>('local:aiTidy');

/** The current (or last) bulk sorting run; written only by the background script. */
export const aiBulkItem = storage.defineItem<BulkJob>('local:aiBulk');

/** Newest first; written only by the background script. */
export const sortLogItem = storage.defineItem<SortLogEntry[]>('local:sortLog', { fallback: [] });
export const SORT_LOG_MAX = 500;

/** A bookmark the link checker flagged (pages that answer normally are not kept). */
export interface LinkResult {
  id: string;
  title: string;
  /** The address that was checked. */
  url: string;
  folderPath: string;
  status: 'dead' | 'redirected' | 'unknown';
  reason?: LinkReason;
  httpStatus?: number;
  /** For redirected pages: where the page is now. */
  finalUrl?: string;
  /** For dead pages: the Wayback Machine copy; null when none was found. */
  archive?: Snapshot | null;
  /** What the user did about it. */
  done?: 'updated' | 'archived' | 'removed' | 'kept';
}

/** The latest link check in this browser; written only by the background script. */
export interface LinkScan {
  running: boolean;
  /** The last check stopped before finishing (browser closed, worker stopped, or Stop). */
  interrupted?: boolean;
  startedAt?: number;
  finishedAt?: number;
  total: number;
  checked: number;
  results: LinkResult[];
  /** Bookmarks already checked in this run, so an interrupted run can continue. */
  checkedIds: string[];
}

export const linkScanItem = storage.defineItem<LinkScan>('local:linkScan', {
  fallback: { running: false, total: 0, checked: 0, results: [], checkedIds: [] },
});

/** Drive file and content hash of this browser's last uploaded snapshot. */
export const snapshotMetaItem = storage.defineItem<{ fileId?: string; hash?: string }>('local:snapshotMeta', {
  fallback: {},
});

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** OpenRouter model IDs look like "vendor/model-name:variant". */
export const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

/** Stored settings, with every value checked and clamped to a safe range. */
export async function getSettings(): Promise<Settings> {
  const s: Partial<Record<keyof Settings, unknown>> = (await settingsItem.getValue()) ?? {};
  const d = DEFAULT_SETTINGS;
  return {
    syncEnabled: typeof s.syncEnabled === 'boolean' ? s.syncEnabled : d.syncEnabled,
    syncIntervalMin: clampInt(s.syncIntervalMin, 1, 1440, d.syncIntervalMin),
    autoBackup: typeof s.autoBackup === 'boolean' ? s.autoBackup : d.autoBackup,
    backupIntervalHours: clampInt(s.backupIntervalHours, 1, 24 * 30, d.backupIntervalHours),
    backupRetention: clampInt(s.backupRetention, 1, 365, d.backupRetention),
    deviceName: typeof s.deviceName === 'string' ? s.deviceName.slice(0, 60) : d.deviceName,
    aiSortEnabled: typeof s.aiSortEnabled === 'boolean' ? s.aiSortEnabled : d.aiSortEnabled,
    aiProvider: AI_PROVIDERS.includes(s.aiProvider as AiProvider) ? (s.aiProvider as AiProvider) : d.aiProvider,
    aiEndpoint: typeof s.aiEndpoint === 'string' && parseEndpoint(s.aiEndpoint) ? parseEndpoint(s.aiEndpoint)!.base : d.aiEndpoint,
    aiEndpointModel:
      typeof s.aiEndpointModel === 'string' && ENDPOINT_MODEL.test(s.aiEndpointModel.trim()) ? s.aiEndpointModel.trim() : d.aiEndpointModel,
    aiInboxFolderId:
      typeof s.aiInboxFolderId === 'string' && s.aiInboxFolderId.length <= 100 ? s.aiInboxFolderId : d.aiInboxFolderId,
    aiModel: typeof s.aiModel === 'string' && s.aiModel.length <= 100 && MODEL_ID.test(s.aiModel.trim()) ? s.aiModel.trim() : d.aiModel,
    aiAllowNewFolders: typeof s.aiAllowNewFolders === 'boolean' ? s.aiAllowNewFolders : d.aiAllowNewFolders,
    aiResearch: typeof s.aiResearch === 'boolean' ? s.aiResearch : d.aiResearch,
    aiMonthlyBudget:
      typeof s.aiMonthlyBudget === 'number' && Number.isFinite(s.aiMonthlyBudget)
        ? Math.round(Math.min(10_000, Math.max(0, s.aiMonthlyBudget)) * 100) / 100
        : d.aiMonthlyBudget,
  };
}

/**
 * Forgets everything tied to the connected Google account (Drive IDs, sync
 * history, versions), so a different account never inherits it. Bookmarks
 * are not touched; the Chromium "Bookmarks Menu" stand-in is remembered.
 */
export async function resetAccountState(): Promise<void> {
  const { menuFolderId } = await syncStateItem.getValue();
  await syncStateItem.setValue({ mapping: {}, mirror: {}, keep: [], ...(menuFolderId ? { menuFolderId } : {}) });
  await driveIdsItem.setValue({});
  await remoteVersionItem.removeValue();
  await encryptionKeyItem.removeValue();
  await encryptionStatusItem.setValue({ state: 'off' });
  await snapshotMetaItem.setValue({});
  // Tags belong to the account's bookmarks.
  await tagsItem.setValue({ items: {}, pending: {} });
}

let statusWrites: Promise<unknown> = Promise.resolve();

/**
 * Merges `patch` into the status. Writes are serialized (only the background
 * writes status), so a sync finishing at the same time as a disconnect can
 * never write back an older `connected` value.
 */
export function patchStatus(patch: Partial<Status>): Promise<Status> {
  const write = statusWrites
    .catch(() => undefined)
    .then(async () => {
      const next = { ...(await statusItem.getValue()), ...patch };
      await statusItem.setValue(next);
      return next;
    });
  statusWrites = write;
  return write;
}

/** The OAuth client ID is baked in at build time from WXT_GOOGLE_CLIENT_ID. */
export function googleClientId(): string {
  // Development builds can use a separate OAuth client, so a development
  // extension ID can never obtain tokens for the production client.
  const dev = import.meta.env.MODE !== 'production' ? (import.meta.env.WXT_GOOGLE_CLIENT_ID_DEV ?? '').trim() : '';
  return dev || (import.meta.env.WXT_GOOGLE_CLIENT_ID ?? '').trim();
}
