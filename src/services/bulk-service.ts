import { folderPath } from '../core/ai-sort';
import { isOpenable } from '../core/search';
import { aiBulkItem, getSettings, type BulkJob, type BulkProposal } from '../shared/state';
import { t } from '../shared/i18n';
import { detectSpecialRoots } from '../sync/local-tree';
import { aiRunner, assertPermission } from './ai-client';
import { allTags, setTags } from './tags-service';
import { applyPlanned, sortOne } from '../sync/sorter';
import { addLog, overBudget, recordSpend, usageSoon } from './sorter-service';
import { localBookmarks } from './sync-service';

/**
 * Bulk sorting: the model proposes a folder for each bookmark already in a
 * folder, nothing moves until the user approves the proposals in Settings.
 *
 * The run lives in `local:aiBulk`, so Settings can close and reopen, and a
 * restarted service worker carries on where it stopped (see resumeBulk).
 */

/** At most this many bookmarks per run. */
export const BULK_MAX = 100;
/** Errors that fail every bookmark the same way: planning stops. */
const FATAL = new Set(['auth', 'credits', 'permission', 'unavailable']);

let writes: Promise<unknown> = Promise.resolve();
/** Read-modify-write of the job, one at a time. */
function updateJob(change: (job: BulkJob) => BulkJob | void): Promise<BulkJob | null> {
  const run = writes
    .catch(() => undefined)
    .then(async () => {
      const job = await aiBulkItem.getValue();
      if (!job) return null;
      const next = change(job) ?? job;
      await aiBulkItem.setValue(next);
      return next;
    });
  writes = run;
  return run;
}

/** The settings and model for a run; a run keeps the provider and model it started with. */
async function settingsForRun(job?: BulkJob) {
  const s = await getSettings();
  const runner = await aiRunner(s, job ? { provider: job.provider ?? 'openrouter', model: job.model } : undefined);
  await assertPermission(runner, s);
  return { s, runner, budget: runner.budgeted ? s.aiMonthlyBudget : 0 };
}

export async function startBulk(folderId: string, research: boolean): Promise<BulkJob> {
  const current = await aiBulkItem.getValue();
  if (current && (current.state === 'planning' || current.state === 'applying')) throw new Error(t('aiBulkBusy'));
  const { s, runner, budget } = await settingsForRun();
  if (await overBudget({ budget })) throw new Error(t('aiErrBudget'));
  const bookmarks = localBookmarks();
  const tree = await bookmarks.getTree();
  const children = await bookmarks.getChildren(folderId);
  const queue = children
    .filter((c) => c.url !== undefined && isOpenable(c.url))
    .slice(0, BULK_MAX)
    .map((c) => c.id);
  if (!queue.length) throw new Error(t('aiBulkEmpty'));
  const job: BulkJob = {
    id: crypto.randomUUID(),
    folderId,
    folderPath: folderPath(tree, folderId) ?? '',
    model: runner.model,
    provider: runner.provider,
    research: research && runner.canResearch,
    allowNewFolders: s.aiAllowNewFolders,
    state: 'planning',
    queue,
    total: queue.length,
    proposals: [],
    startedAt: Date.now(),
    cost: 0,
  };
  await aiBulkItem.setValue(job);
  void plan(job.id);
  return job;
}

/** The run that is asking the model, by job: a new job never waits for a stopped one. */
const planning = new Map<string, Promise<void>>();

/** Asks the model about the queued bookmarks, a few at a time, until done or stopped. */
function plan(jobId: string): Promise<void> {
  const running = planning.get(jobId);
  if (running) return running;
  const run = (async () => {
    try {
      const started = await aiBulkItem.getValue();
      if (!started || started.id !== jobId) return;
      const { s, runner, budget } = await settingsForRun(started);
      const bookmarks = localBookmarks();
      const special = await detectSpecialRoots(bookmarks);
      const taken = new Set<string>();
      const existingTags = (await allTags()).map((x) => x.tag);

      const next = async (): Promise<string | undefined> => {
        const job = await aiBulkItem.getValue();
        if (!job || job.id !== jobId || job.state !== 'planning') return undefined;
        return job.queue.find((id) => !taken.has(id));
      };

      const worker = async () => {
        for (let id = await next(); id; id = await next()) {
          taken.add(id);
          const job = await aiBulkItem.getValue();
          // Discarded or replaced meanwhile: this worker is done.
          if (!job || job.id !== jobId) return;
          const blocked = (await overBudget({ budget })) ? true : undefined;
          if (blocked) {
            await updateJob((j) => {
              if (j.id === jobId && j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'budget', stopMessage: t('aiErrBudget') });
            });
            return;
          }
          const outcome = await sortOne(
            {
              bookmarks,
              exclude: special.exclude,
              language: runner.language,
              existingTags,
              complete: (messages, opts) => runner.complete(messages, opts),
            },
            {
              inboxId: job.folderId,
              // The inbox is for new arrivals; bulk sorting never files into it.
              skip: s.aiInboxFolderId ? [s.aiInboxFolderId] : [],
              allowNewFolders: job.allowNewFolders,
              model: job.model,
              provider: runner.provider,
              research: job.research,
              ...(runner.maxFolders ? { maxFolders: runner.maxFolders } : {}),
              plan: true,
            },
            id,
          );
          if (outcome && runner.budgeted) await recordSpend(outcome.cost);
          await updateJob((j) => {
            if (j.id !== jobId) return;
            j.queue = j.queue.filter((q) => q !== id);
            if (outcome) {
              j.proposals.push(outcome as BulkProposal);
              j.cost = Math.round((j.cost + (outcome.cost ?? 0)) * 1e8) / 1e8;
              if (outcome.status === 'error' && FATAL.has(outcome.errorCode ?? '') && j.state === 'planning') {
                j.state = 'ready';
                j.stopped = 'error';
                j.stopMessage = outcome.error;
              }
            }
            if (!j.queue.length && j.state === 'planning') j.state = 'ready';
          });
        }
      };
      await Promise.all(Array.from({ length: runner.parallel }, worker));
      // Something taken but never answered (worker stopped early): planning is over either way.
      await updateJob((j) => {
        if (j.id === jobId && j.state === 'planning' && !j.queue.some((q) => !taken.has(q))) j.state = 'ready';
      });
      if (runner.budgeted) usageSoon();
    } catch (err) {
      await updateJob((j) => {
        if (j.id === jobId && j.state === 'planning') {
          Object.assign(j, { state: 'ready', stopped: 'error', stopMessage: err instanceof Error ? err.message : String(err) });
        }
      });
    } finally {
      planning.delete(jobId);
    }
  })();
  planning.set(jobId, run);
  return run;
}

/** "Stop": proposals so far stay and can be applied. */
export async function cancelBulk(): Promise<void> {
  await updateJob((j) => {
    if (j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'cancelled' });
  });
}

/** "Discard": forgets the run (nothing was moved by it unless applied). */
export async function discardBulk(): Promise<void> {
  const job = await aiBulkItem.getValue();
  if (job?.state === 'applying') throw new Error(t('aiBulkBusy'));
  if (job?.state === 'planning') await cancelBulk();
  await writes.catch(() => undefined);
  await aiBulkItem.removeValue();
}

export interface BulkApplyResult {
  moved: number;
  failed: number;
}

/** Carries out the approved proposals and logs each move, so it can be undone on the log page. */
export async function applyBulk(bookmarkIds: string[]): Promise<BulkApplyResult> {
  const job = await aiBulkItem.getValue();
  if (!job || job.state !== 'ready') throw new Error(t('aiBulkNotReady'));
  const wanted = new Set(bookmarkIds);
  await updateJob((j) => void (j.state = 'applying'));
  const bookmarks = localBookmarks();
  const created = new Map<string, string>();
  const result: BulkApplyResult = { moved: 0, failed: 0 };
  try {
    for (const p of job.proposals) {
      if (!wanted.has(p.bookmarkId) || p.appliedAt || (p.status !== 'moved' && p.status !== 'created')) continue;
      const { appliedAt: _a, applyError: _e, ...proposal } = p;
      const outcome = await applyPlanned(bookmarks, proposal, job.folderId, created);
      const ok = outcome.status === 'moved' || outcome.status === 'created';
      if (ok) {
        result.moved++;
        await addLog(outcome);
        if (outcome.tags?.length) await setTags(p.bookmarkId, outcome.tags, { onlyIfEmpty: true });
      } else result.failed++;
      await updateJob((j) => {
        const target = j.proposals.find((x) => x.bookmarkId === p.bookmarkId);
        if (!target) return;
        if (ok) target.appliedAt = Date.now();
        else target.applyError = outcome.error;
      });
    }
  } finally {
    await updateJob((j) => {
      j.state = 'done';
      j.applied = result;
    });
  }
  return result;
}

/** After a service worker restart: continue a run that was still asking the model. */
export async function resumeBulk(): Promise<void> {
  const job = await aiBulkItem.getValue();
  if (job?.state === 'planning') void plan(job.id);
  // Applying is quick and was cut off: what was applied is marked; let the user apply the rest.
  if (job?.state === 'applying') await updateJob((j) => void (j.state = 'ready'));
}
