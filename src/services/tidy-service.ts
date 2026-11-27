import { findTreeNode, folderPath, type ChatMessage, type SortTreeNode } from '../core/ai-sort';
import {
  buildStructurePrompt,
  buildTitlesPrompt,
  chunk,
  emptyFolders,
  estimateCost,
  parseStructureReply,
  parseTitlesReply,
  structureSchema,
  tidyFolders,
  TIDY_TITLES_PER_REQUEST,
  titleItems,
  titlesSchema,
  tokensOf,
  type TidyProposal,
} from '../core/tidy';
import { isOpenable } from '../core/search';
import { t } from '../shared/i18n';
import { aiModelsItem, aiTidyItem, getSettings, statusItem, type TidyJob } from '../shared/state';
import { detectSpecialRoots } from '../sync/local-tree';
import { applyTidy } from '../sync/tidy';
import { aiRunner, assertPermission, type AiRunner } from './ai-client';
import { createBackup } from './backup-service';
import { addLog, overBudget, recordSpend, usageSoon } from './sorter-service';
import { exclusive, localBookmarks, runSync } from './sync-service';

/**
 * "Tidy up the library": one request about the folder structure (merge,
 * rename), a few about cryptic titles, and the empty folders found without
 * the model. Proposals wait in `local:aiTidy` until the user applies the ones
 * they tick; every applied change goes to the sorting log with Undo.
 */

/** Answer tokens assumed for the estimate. */
const STRUCTURE_ANSWER_TOKENS = 1500;
const TITLES_ANSWER_TOKENS = 1200;
const FATAL = new Set(['auth', 'credits', 'permission', 'unavailable']);
/** Applied in this order: titles and names first, folders disappear last. */
const ORDER: Record<TidyProposal['kind'], number> = { retitle: 0, rename: 1, merge: 2, remove: 3 };

type JobItem = typeof aiTidyItem;
const queues = new WeakMap<JobItem, Promise<unknown>>();

/** Read-modify-write of a job, one at a time (tidy-up and naming each have their own). */
export function jobUpdater(item: JobItem) {
  return (change: (job: TidyJob) => TidyJob | void): Promise<TidyJob | null> => {
    const run = (queues.get(item) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const job = await item.getValue();
        if (!job) return null;
        const next = change(job) ?? job;
        await item.setValue(next);
        return next;
      });
    queues.set(item, run);
    return run;
  };
}
const updateJob = jobUpdater(aiTidyItem);

interface Scope {
  tree: SortTreeNode[];
  exclude: string[];
  /** Never merged, renamed or removed: top-level folders, the inbox, the scope. */
  fixed: string[];
  scopeId: string;
  bookmarks: { id: string; title: string; url?: string; folderPath: string }[];
}

async function readScope(scopeId: string): Promise<Scope> {
  const api = localBookmarks();
  const [tree, special, s] = await Promise.all([api.getTree(), detectSpecialRoots(api), getSettings()]);
  if (scopeId && !findTreeNode(tree, scopeId)) throw new Error(t('tidyScopeGone'));
  const tops = (tree[0]?.children ?? []).map((c) => c.id);
  const fixed = [...tops, ...(s.aiInboxFolderId ? [s.aiInboxFolderId] : []), ...(scopeId ? [scopeId] : [])];
  const exclude = [...special.exclude];
  const bookmarks: Scope['bookmarks'] = [];
  const walk = (nodes: SortTreeNode[], path: string) => {
    for (const n of nodes) {
      if (exclude.includes(n.id)) continue;
      if (n.url !== undefined) {
        if (isOpenable(n.url)) bookmarks.push({ id: n.id, title: n.title, url: n.url, folderPath: path });
      } else if (n.children) walk(n.children, path ? `${path} / ${n.title}` : n.title);
    }
  };
  const start = scopeId ? findTreeNode(tree, scopeId)!.node : tree[0];
  if (start) walk(start.children ?? [], scopeId ? (folderPath(tree, scopeId) ?? '') : '');
  return { tree, exclude, fixed, scopeId, bookmarks };
}

function prompts(scope: Scope, language: string, maxFolders?: number) {
  const folders = tidyFolders(scope.tree, { exclude: scope.exclude, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), ...(maxFolders ? { max: maxFolders } : {}) });
  const items = titleItems(scope.bookmarks);
  return {
    folders,
    items,
    structure: buildStructurePrompt(folders, language),
    titles: chunk(items, TIDY_TITLES_PER_REQUEST).map((part) => ({ part, messages: buildTitlesPrompt(part, language) })),
  };
}

export interface TidyEstimate {
  requests: number;
  folders: number;
  bookmarks: number;
  /** USD on OpenRouter; undefined when the model's price is unknown; 0 for free models and other providers. */
  usd?: number;
  provider: AiRunner['provider'];
  model: string;
}

/** Shown before a run: how many requests, and what they should cost. */
export async function estimateTidy(scopeId: string): Promise<TidyEstimate> {
  const s = await getSettings();
  const runner = await aiRunner(s);
  const scope = await readScope(scopeId);
  const p = prompts(scope, runner.language, runner.maxFolders);
  const requests = [
    { promptTokens: tokensOf(p.structure), completionTokens: STRUCTURE_ANSWER_TOKENS },
    ...p.titles.map((x) => ({ promptTokens: tokensOf(x.messages), completionTokens: TITLES_ANSWER_TOKENS })),
  ];
  const model = runner.budgeted ? (await aiModelsItem.getValue())?.models.find((m) => m.id === runner.model) : undefined;
  return {
    requests: requests.length,
    folders: p.folders.length,
    bookmarks: p.items.length,
    ...(runner.budgeted ? { usd: estimateCost(requests, model) } : { usd: 0 }),
    provider: runner.provider,
    model: runner.model,
  };
}

export async function startTidy(scopeId: string): Promise<TidyJob> {
  const current = await aiTidyItem.getValue();
  if (current && (current.state === 'planning' || current.state === 'applying')) throw new Error(t('aiBulkBusy'));
  const s = await getSettings();
  const runner = await aiRunner(s);
  await assertPermission(runner, s);
  if (runner.budgeted && (await overBudget({ budget: s.aiMonthlyBudget }))) throw new Error(t('aiErrBudget'));
  const scope = await readScope(scopeId);
  const p = prompts(scope, runner.language, runner.maxFolders);
  const job: TidyJob = {
    id: crypto.randomUUID(),
    scopeId,
    scopePath: scopeId ? (folderPath(scope.tree, scopeId) ?? '') : '',
    model: runner.model,
    provider: runner.provider,
    state: 'planning',
    step: 0,
    steps: 1 + p.titles.length,
    proposals: [],
    startedAt: Date.now(),
    cost: 0,
  };
  await aiTidyItem.setValue(job);
  void plan(job.id, runner, scope, p, s.aiMonthlyBudget);
  return job;
}

async function plan(jobId: string, runner: AiRunner, scope: Scope, p: ReturnType<typeof prompts>, budget: number): Promise<void> {
  const still = async () => {
    const job = await aiTidyItem.getValue();
    return job?.id === jobId && job.state === 'planning';
  };
  /** Asks the model; false when the run has to stop. */
  const ask = async (messages: ChatMessage[], schema: Record<string, unknown>, take: (text: string) => TidyProposal[]): Promise<boolean> => {
    if (!(await still())) return false;
    if (runner.budgeted && (await overBudget({ budget }))) {
      await updateJob((j) => void Object.assign(j, { state: 'ready', stopped: 'budget', stopMessage: t('aiErrBudget') }));
      return false;
    }
    try {
      const reply = await runner.complete(messages, { research: false, schema });
      if (runner.budgeted) await recordSpend(reply.cost);
      let found: TidyProposal[] = [];
      try {
        found = take(reply.text);
      } catch {
        await updateJob((j) => void (j.failures = (j.failures ?? 0) + 1));
      }
      await updateJob((j) => {
        if (j.id !== jobId) return;
        j.proposals.push(...found);
        j.step++;
        j.cost = Math.round((j.cost + (reply.cost ?? 0)) * 1e8) / 1e8;
      });
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : String(err);
      await updateJob((j) => {
        if (j.id !== jobId) return;
        j.step++;
        j.failures = (j.failures ?? 0) + 1;
        if (typeof code === 'string' && FATAL.has(code)) Object.assign(j, { state: 'ready', stopped: 'error', stopMessage: message });
      });
      return !(typeof code === 'string' && FATAL.has(code));
    }
  };

  try {
    const empty = emptyFolders(scope.tree, {
      exclude: scope.exclude,
      keep: scope.fixed,
      ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
      pathOf: (id) => folderPath(scope.tree, id),
    });
    const emptyIds = new Set(empty.map((e) => e.folderId));
    const titleOf = (id: string) => findTreeNode(scope.tree, id)?.node.title ?? '';
    await updateJob((j) => {
      j.proposals.push(...empty.map((e) => ({ id: crypto.randomUUID(), kind: 'remove' as const, folderId: e.folderId, title: titleOf(e.folderId), folderPath: e.folderPath })));
    });

    const full = (id: string) => folderPath(scope.tree, id) ?? '';
    const ok = await ask(p.structure, structureSchema(p.folders), (text) => {
      const { merges, renames } = parseStructureReply(text, p.folders, {
        fixed: scope.fixed,
        siblingsOf: (id) => {
          const parent = findTreeNode(scope.tree, id)?.parentId;
          return parent ? (findTreeNode(scope.tree, parent)?.node.children ?? []).filter((c) => c.url === undefined && c.id !== id).map((c) => c.title) : [];
        },
      });
      return [
        ...merges
          .filter((m) => !emptyIds.has(m.from.localId))
          .map((m) => ({
            id: crypto.randomUUID(),
            kind: 'merge' as const,
            folderId: m.from.localId,
            title: m.from.title,
            folderPath: full(m.from.localId),
            intoId: m.into.localId,
            intoPath: full(m.into.localId),
            count: findTreeNode(scope.tree, m.from.localId)?.node.children?.length ?? 0,
            ...(m.reason ? { reason: m.reason } : {}),
          })),
        ...renames
          .filter((r) => !emptyIds.has(r.folder.localId))
          .map((r) => ({
            id: crypto.randomUUID(),
            kind: 'rename' as const,
            folderId: r.folder.localId,
            title: r.folder.title,
            folderPath: full(r.folder.localId),
            name: r.name,
            ...(r.reason ? { reason: r.reason } : {}),
          })),
      ];
    });
    if (ok) {
      const pathById = new Map(scope.bookmarks.map((b) => [b.id, b]));
      for (const { part, messages } of p.titles) {
        const go = await ask(messages, titlesSchema(part), (text) =>
          parseTitlesReply(text, part).map(({ item, title }) => ({
            id: crypto.randomUUID(),
            kind: 'retitle' as const,
            bookmarkId: item.id,
            title: pathById.get(item.id)?.title ?? item.title,
            newTitle: title,
            ...(pathById.get(item.id)?.url ? { url: pathById.get(item.id)!.url! } : {}),
            folderPath: pathById.get(item.id)?.folderPath ?? '',
          })),
        );
        if (!go) break;
      }
    }
    await updateJob((j) => {
      if (j.id === jobId && j.state === 'planning') j.state = 'ready';
    });
    if (runner.budgeted) usageSoon();
  } catch (err) {
    await updateJob((j) => {
      if (j.id === jobId && j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'error', stopMessage: err instanceof Error ? err.message : String(err) });
    });
  }
}

export async function cancelTidy(): Promise<void> {
  await updateJob((j) => {
    if (j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'cancelled' });
  });
}

export async function discardTidy(): Promise<void> {
  const job = await aiTidyItem.getValue();
  if (job?.state === 'applying') throw new Error(t('aiBulkBusy'));
  if (job?.state === 'planning') await cancelTidy();
  await queues.get(aiTidyItem)?.catch(() => undefined);
  await aiTidyItem.removeValue();
}

export interface TidyApplyResult {
  done: number;
  failed: number;
  backedUp: boolean;
}

/** Carries out the ticked proposals after a backup, and logs each change so it can be undone. */
export function applyTidyProposals(ids: string[]): Promise<TidyApplyResult> {
  return applyProposals(aiTidyItem, ids);
}

/** Applies ticked proposals of a job; edited titles of retitle proposals are already in the job. */
export async function applyProposals(item: JobItem, ids: string[]): Promise<TidyApplyResult> {
  const updateJob = jobUpdater(item);
  const job = await item.getValue();
  if (!job || job.state !== 'ready') throw new Error(t('aiBulkNotReady'));
  const wanted = new Set(ids);
  const chosen = job.proposals.filter((p) => wanted.has(p.id) && !p.appliedAt).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  if (!chosen.length) throw new Error(t('tidyNothingChosen'));
  await updateJob((j) => void (j.state = 'applying'));
  const result: TidyApplyResult = { done: 0, failed: 0, backedUp: false };
  try {
    if ((await statusItem.getValue()).connected) {
      await createBackup('before-cleanup');
      result.backedUp = true;
    }
    await exclusive(async () => {
      for (const p of chosen) {
        const { appliedAt: _a, applyError: _e, ...proposal } = p;
        let outcome;
        try {
          outcome = await applyTidy(localBookmarks(), proposal, job.model);
        } catch (err) {
          outcome = { status: 'error' as const, error: err instanceof Error ? err.message : String(err) };
        }
        const ok = outcome.status === 'tidied';
        if (ok) {
          result.done++;
          await addLog({ ...outcome, provider: job.provider } as Parameters<typeof addLog>[0]);
        } else result.failed++;
        await updateJob((j) => {
          const target = j.proposals.find((x) => x.id === p.id);
          if (!target) return;
          if (ok) target.appliedAt = Date.now();
          else target.applyError = outcome.error;
        });
      }
    });
  } finally {
    await updateJob((j) => {
      j.state = 'done';
      j.applied = result;
    });
  }
  if (result.done) void runSync().catch(() => undefined);
  return result;
}

/** After a service worker restart: a run that was asking the model cannot go on; keep what it found. */
export async function resumeTidy(): Promise<void> {
  const job = await aiTidyItem.getValue();
  if (job?.state === 'planning') await updateJob((j) => void Object.assign(j, { state: 'ready', stopped: 'interrupted' }));
  if (job?.state === 'applying') await updateJob((j) => void (j.state = 'ready'));
}
