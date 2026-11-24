import { storage } from '#imports';
import type { SiteInfo } from '../core/ai-sort';
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
  /** AI sorting: bookmarks added to the inbox folder in this browser are filed by a model on OpenRouter. */
  aiSortEnabled: boolean;
  /** Local ID of the inbox folder in this browser; empty = none chosen. */
  aiInboxFolderId: string;
  /** OpenRouter model ID, e.g. "google/gemini-3.5-flash-lite". */
  aiModel: string;
  /** Let the model create a new folder when none of the existing ones fits. */
  aiAllowNewFolders: boolean;
  /** Let the model read the page and search the web before deciding (slower, small extra cost). */
  aiResearch: boolean;
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
  aiInboxFolderId: '',
  aiModel: DEFAULT_AI_MODEL,
  aiAllowNewFolders: false,
  aiResearch: true,
};

export type ErrorCode = 'auth' | 'mass-delete' | 'config' | 'network' | 'unknown';

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

/** One AI sorting decision, shown on the sorting log page. */
export interface SortLogEntry {
  id: string;
  at: number;
  /** Local bookmark ID in this browser. */
  bookmarkId: string;
  title: string;
  url?: string;
  status: 'moved' | 'created' | 'kept' | 'error';
  fromId?: string;
  fromPath?: string;
  toId?: string;
  toPath?: string;
  reason?: string;
  confidence?: number;
  model: string;
  error?: string;
  /** 'auth' | 'credits' | 'rate-limit' | 'model' | 'permission' | 'network' | 'reply' | 'unknown'. */
  errorCode?: string;
  /** Set when the user moved the bookmark back with Undo. */
  undoneAt?: number;
  /** What the model found out about the site. */
  site?: SiteInfo;
  /** Web pages the model used (http/https only). */
  sources?: { url: string; title?: string }[];
  /** OpenRouter's reported cost of the request, in USD. */
  cost?: number;
  /** True when the model was allowed to read the page and search the web. */
  researched?: boolean;
}


/** Newest first; written only by the background script. */
export const sortLogItem = storage.defineItem<SortLogEntry[]>('local:sortLog', { fallback: [] });
export const SORT_LOG_MAX = 500;

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
    aiInboxFolderId:
      typeof s.aiInboxFolderId === 'string' && s.aiInboxFolderId.length <= 100 ? s.aiInboxFolderId : d.aiInboxFolderId,
    aiModel: typeof s.aiModel === 'string' && s.aiModel.length <= 100 && MODEL_ID.test(s.aiModel.trim()) ? s.aiModel.trim() : d.aiModel,
    aiAllowNewFolders: typeof s.aiAllowNewFolders === 'boolean' ? s.aiAllowNewFolders : d.aiAllowNewFolders,
    aiResearch: typeof s.aiResearch === 'boolean' ? s.aiResearch : d.aiResearch,
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
  await snapshotMetaItem.setValue({});
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
