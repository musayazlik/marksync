import { isLive } from '../core/records';
import { isOpenable } from '../core/search';
import {
  dequantize,
  EMBED_BATCH,
  hashText,
  nearest,
  normalise,
  quantize,
  sanitizeIndexFile,
  semanticText,
  textTokens,
  type IndexEntry,
  type SemanticIndexFile,
} from '../core/semantic';
import { customEndpoint } from './ai-client';
import { DriveError, quote } from '../platform/drive';
import { embed, fetchEmbeddingModels, OpenRouterError } from '../platform/openrouter';
import { t } from '../shared/i18n';
import {
  DEFAULT_EMBEDDING_MODEL,
  driveIdsItem,
  endpointKeyItem,
  getSettings,
  openRouterKeyItem,
  semanticIndexItem,
  semanticJobItem,
  sortLogItem,
  statusItem,
  syncStateItem,
  type SemanticJob,
  type Settings,
} from '../shared/state';
import type { BookmarkNode } from '../sync/bookmarks-api';
import { driveClient, withFolders } from './drive-store';
import { overBudget, recordSpend } from './sorter-service';
import { localBookmarks } from './sync-service';
import { tagsByLocalId } from './tags-service';

/**
 * Search by meaning (core/semantic.ts). Opt-in: nothing is sent before the
 * user builds the index. The index is keyed by shared record ID, kept in
 * `local:semanticIndex` and in Drive (semantic-index.json, encrypted like
 * the other files), so other browsers on the account can search without
 * embedding again. Updating embeds only bookmarks whose text changed.
 */
export const SEMANTIC_FILE = 'semantic-index.json';

interface Embedder {
  model: string;
  budgeted: boolean;
  run(input: string[]): Promise<{ vectors: number[][]; cost?: number }>;
}

/** Embeddings go to OpenRouter or the user's own server; the on-device model has none. */
async function embedder(s: Settings): Promise<Embedder> {
  if (s.aiProvider === 'builtin') throw new Error(t('semNoBuiltin'));
  if (s.aiProvider === 'custom') {
    const endpoint = customEndpoint(s);
    if (!endpoint) throw new Error(t('aiNoEndpoint'));
    if (!s.semanticModel) throw new Error(t('semNoModel'));
    const apiKey = (await endpointKeyItem.getValue()) || undefined;
    return { model: s.semanticModel, budgeted: false, run: (input) => embed({ endpoint, apiKey, model: s.semanticModel, input }) };
  }
  const apiKey = await openRouterKeyItem.getValue();
  if (!apiKey) throw new Error(t('aiNoKey'));
  const model = s.semanticModel || DEFAULT_EMBEDDING_MODEL;
  return { model, budgeted: true, run: (input) => embed({ apiKey, model, input }) };
}

const friendly = (err: unknown): Error => {
  if (err instanceof OpenRouterError && err.code === 'permission') return new Error(t('aiPermissionMissing'));
  if (err instanceof OpenRouterError && err.code === 'auth') return new Error(t('aiKeyRejected'));
  return err instanceof Error ? err : new Error(String(err));
};

/** Every synced, openable bookmark of this browser with the text it is indexed by. */
async function indexTexts(): Promise<{ recordId: string; localId: string; text: string }[]> {
  const [tree, state, tags, log] = await Promise.all([localBookmarks().getTree(), syncStateItem.getValue(), tagsByLocalId(), sortLogItem.getValue()]);
  const site = new Map<string, NonNullable<(typeof log)[number]['site']>>();
  for (const e of log ?? []) if (e.site && !site.has(e.bookmarkId)) site.set(e.bookmarkId, e.site);
  const out: { recordId: string; localId: string; text: string }[] = [];
  const walk = (nodes: BookmarkNode[], depth: number) => {
    if (depth > 100) return;
    for (const n of nodes) {
      if (n.url !== undefined) {
        const recordId = state.mapping[n.id];
        if (!recordId || !isOpenable(n.url)) continue;
        out.push({ recordId, localId: n.id, text: semanticText({ title: n.title, url: n.url, site: site.get(n.id), tags: tags[n.id] }) });
      } else if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

export interface SemanticStatus {
  enabled: boolean;
  model: string;
  indexed: number;
  total: number;
  /** Bookmarks to embed (new or changed). */
  pending: number;
  tokens: number;
  /** USD on OpenRouter when the model's price is known; 0 for the user's own server. */
  usd?: number;
  job?: SemanticJob;
  /** Why indexing cannot run (no key, the on-device model...). */
  problem?: string;
}

/** For Settings: how much is indexed, what an update would embed and cost. */
export async function semanticStatus(): Promise<SemanticStatus> {
  const s = await getSettings();
  const model = s.semanticModel || (s.aiProvider === 'openrouter' ? DEFAULT_EMBEDDING_MODEL : '');
  const [index, texts, job] = await Promise.all([semanticIndexItem.getValue(), indexTexts(), semanticJobItem.getValue()]);
  const items = index?.model === model ? index.items : {};
  const pending = texts.filter((x) => items[x.recordId]?.h !== hashText(x.text));
  let problem: string | undefined;
  let usd: number | undefined;
  try {
    await embedder(s);
  } catch (err) {
    problem = friendly(err).message;
  }
  const tokens = textTokens(pending.map((x) => x.text));
  if (!problem && s.aiProvider === 'openrouter') {
    const price = (await fetchEmbeddingModels().catch(() => [])).find((m) => m.id === model)?.prompt;
    if (price !== undefined) usd = Math.round((tokens * price) / 1e6 * 1e6) / 1e6;
  } else if (!problem) usd = 0;
  return {
    enabled: s.semanticEnabled,
    model,
    indexed: texts.filter((x) => items[x.recordId]).length,
    total: texts.length,
    pending: pending.length,
    tokens,
    ...(usd !== undefined ? { usd } : {}),
    ...(job ? { job } : {}),
    ...(problem ? { problem } : {}),
  };
}

// ---------- Drive copy ----------

async function fileId(): Promise<string | undefined> {
  const ids = await driveIdsItem.getValue();
  if (ids.semanticFileId) return ids.semanticFileId;
  const drive = driveClient();
  const file = await withFolders(drive, (f) => drive.findByName(SEMANTIC_FILE, f.folderId));
  if (file) await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), semanticFileId: file.id });
  return file?.id;
}

/** The index from Drive, when connected and it exists. */
async function remoteIndex(): Promise<SemanticIndexFile | undefined> {
  if (!(await statusItem.getValue()).connected) return undefined;
  const id = await fileId();
  if (!id) return undefined;
  try {
    return sanitizeIndexFile(await driveClient().downloadJson<unknown>(id));
  } catch (err) {
    if (err instanceof DriveError && err.status === 404) {
      const { semanticFileId: _gone, ...rest } = await driveIdsItem.getValue();
      await driveIdsItem.setValue(rest);
      return undefined;
    }
    throw err;
  }
}

async function uploadIndex(index: SemanticIndexFile): Promise<void> {
  if (!(await statusItem.getValue()).connected) return;
  const drive = driveClient();
  const id = await fileId();
  if (id) {
    await drive.updateJson(id, index);
    return;
  }
  const made = await withFolders(drive, async (f) => {
    const file = await drive.createJson(SEMANTIC_FILE, f.folderId, index);
    const all = await drive.list(`name = ${quote(SEMANTIC_FILE)} and ${quote(f.folderId)} in parents`, 'createdTime');
    const oldest = all[0] ?? file;
    if (oldest.id !== file.id) {
      await drive.delete(file.id).catch(() => undefined);
      await drive.updateJson(oldest.id, index);
    }
    return oldest;
  });
  await driveIdsItem.setValue({ ...(await driveIdsItem.getValue()), semanticFileId: made.id });
}

/** Local and Drive entries of the same model together; for each bookmark the entry whose text is current wins. */
function mergeIndex(model: string, dims: number, parts: (SemanticIndexFile | undefined)[], current: Map<string, string>): SemanticIndexFile {
  const items: Record<string, IndexEntry> = {};
  for (const part of parts) {
    if (!part || part.model !== model || (dims && part.dims !== dims)) continue;
    for (const [id, e] of Object.entries(part.items)) {
      const want = current.get(id);
      if (!want) continue;
      if (!items[id] || (items[id]!.h !== want && e.h === want)) items[id] = e;
    }
  }
  return { schema: 1, kind: 'marksync-semantic', model, dims, items, updatedAt: Date.now() };
}

// ---------- indexing ----------

let running: Promise<void> | undefined;

/** Embeds what is new or changed, in batches, then shares the index through Drive. */
export async function buildIndex(): Promise<void> {
  if (running) throw new Error(t('aiBulkBusy'));
  const s = await getSettings();
  if (!s.semanticEnabled) throw new Error(t('semOff'));
  const e = await embedder(s).catch((err: unknown) => {
    throw friendly(err);
  });
  if (e.budgeted && (await overBudget({ budget: s.aiMonthlyBudget }))) throw new Error(t('aiErrBudget'));
  const job: SemanticJob = { state: 'indexing', done: 0, total: 0, cost: 0, startedAt: Date.now() };
  await semanticJobItem.setValue(job);
  running = (async () => {
    try {
      const texts = await indexTexts();
      const current = new Map(texts.map((x) => [x.recordId, hashText(x.text)]));
      const local = await semanticIndexItem.getValue();
      const remote = await remoteIndex().catch(() => undefined);
      const dims = local?.model === e.model ? local.dims : remote?.model === e.model ? remote.dims : 0;
      let index = mergeIndex(e.model, dims, [local ?? undefined, remote], current);
      const todo = texts.filter((x) => index.items[x.recordId]?.h !== current.get(x.recordId));
      job.total = todo.length;
      await semanticJobItem.setValue({ ...job });
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        if ((await semanticJobItem.getValue())?.state !== 'indexing') break;
        if (e.budgeted && (await overBudget({ budget: s.aiMonthlyBudget }))) throw new Error(t('aiErrBudget'));
        const batch = todo.slice(i, i + EMBED_BATCH);
        const { vectors, cost } = await e.run(batch.map((x) => x.text));
        if (index.dims && vectors[0]!.length !== index.dims) throw new Error(t('semDimsChanged'));
        index = { ...index, dims: vectors[0]!.length };
        batch.forEach((x, k) => (index.items[x.recordId] = quantize(vectors[k]!, current.get(x.recordId)!)));
        if (e.budgeted) await recordSpend(cost);
        job.done += batch.length;
        job.cost = Math.round((job.cost + (cost ?? 0)) * 1e8) / 1e8;
        await semanticIndexItem.setValue(index);
        await semanticJobItem.setValue({ ...job });
      }
      await semanticIndexItem.setValue(index);
      await uploadIndex(index).catch((err) => console.warn('[marksync] semantic index upload failed', err));
      const last = await semanticJobItem.getValue();
      await semanticJobItem.setValue({ ...job, state: last?.state === 'stopped' ? 'stopped' : 'done' });
    } catch (err) {
      await semanticJobItem.setValue({ ...job, state: 'stopped', error: friendly(err).message });
    } finally {
      running = undefined;
    }
  })();
}

export async function stopIndex(): Promise<void> {
  const job = await semanticJobItem.getValue();
  if (job?.state === 'indexing') await semanticJobItem.setValue({ ...job, state: 'stopped' });
}

/** Removes the index here and in Drive. */
export async function deleteIndex(): Promise<void> {
  await stopIndex();
  await semanticIndexItem.removeValue();
  await semanticJobItem.removeValue();
  if (!(await statusItem.getValue()).connected) return;
  const id = await fileId().catch(() => undefined);
  if (id) await driveClient().delete(id).catch(() => undefined);
  const { semanticFileId: _gone, ...rest } = await driveIdsItem.getValue();
  await driveIdsItem.setValue(rest);
}

/** After a service worker restart an indexing run cannot go on. */
export async function resumeIndex(): Promise<void> {
  const job = await semanticJobItem.getValue();
  if (job?.state === 'indexing') await semanticJobItem.setValue({ ...job, state: 'stopped', error: t('semInterrupted') });
}

let vectors: { model: string; at: number; list: [string, Float32Array][] } | undefined;

/**
 * The bookmarks closest in meaning to `query` (one embedding request), as
 * local IDs with a score. Uses the index from Drive when this browser has
 * none of its own yet.
 */
export async function searchByMeaning(query: string): Promise<{ id: string; score: number }[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const s = await getSettings();
  if (!s.semanticEnabled) throw new Error(t('semOff'));
  const e = await embedder(s).catch((err: unknown) => {
    throw friendly(err);
  });
  let index = await semanticIndexItem.getValue();
  if (!index || index.model !== e.model || !Object.keys(index.items).length) {
    const remote = await remoteIndex().catch(() => undefined);
    if (remote && remote.model === e.model) {
      index = remote;
      await semanticIndexItem.setValue(remote);
    }
  }
  if (!index || index.model !== e.model || !Object.keys(index.items).length) throw new Error(t('semNoIndex'));
  if (!vectors || vectors.model !== index.model || vectors.at !== index.updatedAt) {
    vectors = { model: index.model, at: index.updatedAt, list: Object.entries(index.items).map(([id, entry]) => [id, dequantize(entry)]) };
  }
  let reply;
  try {
    reply = await e.run([q]);
  } catch (err) {
    throw friendly(err);
  }
  if (e.budgeted) await recordSpend(reply.cost);
  const hits = nearest(normalise(reply.vectors[0]!), vectors.list, 30);
  const { mapping, mirror } = await syncStateItem.getValue();
  const localOf = new Map(Object.entries(mapping).map(([localId, recordId]) => [recordId, localId]));
  return hits.flatMap((h) => {
    const localId = localOf.get(h.id);
    return localId && isLive(mirror[h.id]) ? [{ id: localId, score: Math.round(h.score * 1000) / 1000 }] : [];
  });
}

/** For the popup: whether "search by meaning" can be offered. */
export async function semanticReady(): Promise<boolean> {
  const s = await getSettings();
  if (!s.semanticEnabled || s.aiProvider === 'builtin') return false;
  const index = await semanticIndexItem.getValue();
  return !!index && Object.keys(index.items).length > 0 ? true : (await statusItem.getValue()).connected;
}

