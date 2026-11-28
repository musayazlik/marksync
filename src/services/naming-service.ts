import { findTreeNode, folderPath, type ChatMessage, type SortTreeNode } from '../core/ai-sort';
import {
  buildNamingPrompt,
  buildResearchNamingPrompt,
  cleanName,
  NAMING_BATCH,
  NAMING_MAX,
  parseSingleName,
  singleNameSchema,
} from '../core/naming';
import { isOpenable } from '../core/search';
import { chunk, estimateCost, parseTitlesReply, titleItems, titlesSchema, tokensOf, type TidyProposal, type TitleItem } from '../core/tidy';
import { t } from '../shared/i18n';
import { aiModelsItem, aiNamingItem, getSettings, type TidyJob } from '../shared/state';
import { detectSpecialRoots } from '../sync/local-tree';
import { aiRunner, assertPermission, type AiRunner } from './ai-client';
import { overBudget, recordSpend, usageSoon } from './sorter-service';
import { localBookmarks } from './sync-service';
import { applyProposals, jobUpdater, type TidyApplyResult } from './tidy-service';

/**
 * "Name bookmarks with AI" (core/naming.ts): proposals wait in
 * `local:aiNaming`; the user edits and ticks them, then applies (with a
 * backup first, and Undo for each rename on the log page, like tidy-up).
 */

const FATAL = new Set(['auth', 'credits', 'permission', 'unavailable']);
/** Rough sizes for the estimate. */
const RESEARCH_PROMPT_TOKENS = 7000;
const RESEARCH_ANSWER_TOKENS = 400;
const ANSWER_TOKENS_PER_ITEM = 40;

const updateJob = jobUpdater(aiNamingItem);

export interface NamingOptions {
  folderIds: string[];
  subfolders: boolean;
  research: boolean;
  /** Write the titles in the UI language (otherwise in each page's own). */
  uiLanguage: boolean;
}

interface Target {
  id: string;
  title: string;
  url: string;
  folderPath: string;
}

async function targets(opts: NamingOptions): Promise<{ tree: SortTreeNode[]; list: Target[] }> {
  const api = localBookmarks();
  const [tree, special] = await Promise.all([api.getTree(), detectSpecialRoots(api)]);
  const exclude = new Set(special.exclude);
  const seen = new Set<string>();
  const list: Target[] = [];
  const walk = (node: SortTreeNode, path: string, depth: number) => {
    for (const c of node.children ?? []) {
      if (list.length >= NAMING_MAX || exclude.has(c.id)) continue;
      if (c.url !== undefined) {
        if (!isOpenable(c.url) || seen.has(c.id)) continue;
        seen.add(c.id);
        list.push({ id: c.id, title: c.title, url: c.url, folderPath: path });
      } else if (opts.subfolders && depth < 100) walk(c, `${path} / ${c.title}`, depth + 1);
    }
  };
  for (const id of opts.folderIds) {
    const hit = findTreeNode(tree, id);
    if (!hit || hit.node.url !== undefined) continue;
    walk(hit.node, folderPath(tree, id) ?? hit.node.title, 0);
  }
  return { tree, list };
}

function language(opts: NamingOptions, runner: AiRunner): string | undefined {
  return opts.uiLanguage ? runner.language : undefined;
}

export interface NamingEstimate {
  bookmarks: number;
  requests: number;
  /** The model reads every page (OpenRouter with a tool-capable model). */
  research: boolean;
  usd?: number;
  provider: AiRunner['provider'];
}

export async function estimateNaming(opts: NamingOptions): Promise<NamingEstimate> {
  const s = await getSettings();
  const runner = await aiRunner(s);
  const { list } = await targets(opts);
  const research = opts.research && runner.canResearch;
  const items = titleItems(list);
  const requests = research
    ? items.map(() => ({ promptTokens: RESEARCH_PROMPT_TOKENS, completionTokens: RESEARCH_ANSWER_TOKENS }))
    : chunk(items, NAMING_BATCH).map((part) => ({
        promptTokens: tokensOf(buildNamingPrompt(part, language(opts, runner))),
        completionTokens: part.length * ANSWER_TOKENS_PER_ITEM,
      }));
  const model = runner.budgeted ? (await aiModelsItem.getValue())?.models.find((m) => m.id === runner.model) : undefined;
  return {
    bookmarks: list.length,
    requests: requests.length,
    research,
    ...(runner.budgeted ? { usd: estimateCost(requests, model) } : { usd: 0 }),
    provider: runner.provider,
  };
}

export async function startNaming(opts: NamingOptions): Promise<TidyJob> {
  const current = await aiNamingItem.getValue();
  if (current && (current.state === 'planning' || current.state === 'applying')) throw new Error(t('aiBulkBusy'));
  if (!opts.folderIds.length) throw new Error(t('namingChooseFolder'));
  const s = await getSettings();
  const runner = await aiRunner(s);
  await assertPermission(runner, s);
  if (runner.budgeted && (await overBudget({ budget: s.aiMonthlyBudget }))) throw new Error(t('aiErrBudget'));
  const { tree, list } = await targets(opts);
  if (!list.length) throw new Error(t('namingEmpty'));
  const research = opts.research && runner.canResearch;
  const items = titleItems(list);
  const job: TidyJob = {
    id: crypto.randomUUID(),
    mode: 'naming',
    scopeId: opts.folderIds[0]!,
    scopeIds: opts.folderIds,
    scopePath: opts.folderIds.map((id) => folderPath(tree, id) ?? '').filter(Boolean).join(', '),
    model: runner.model,
    provider: runner.provider,
    research,
    state: 'planning',
    step: 0,
    steps: research ? items.length : Math.ceil(items.length / NAMING_BATCH),
    proposals: [],
    startedAt: Date.now(),
    cost: 0,
  };
  await aiNamingItem.setValue(job);
  void plan(job.id, runner, list, items, { research, language: language(opts, runner), budget: s.aiMonthlyBudget });
  return job;
}

async function plan(
  jobId: string,
  runner: AiRunner,
  list: Target[],
  items: TitleItem[],
  opts: { research: boolean; language?: string; budget: number },
): Promise<void> {
  const byId = new Map(list.map((x) => [x.id, x]));
  const proposal = (item: TitleItem, newTitle: string): TidyProposal => {
    const target = byId.get(item.id)!;
    return { id: crypto.randomUUID(), kind: 'retitle', bookmarkId: item.id, title: target.title, newTitle, url: target.url, folderPath: target.folderPath };
  };
  const still = async () => {
    const job = await aiNamingItem.getValue();
    return job?.id === jobId && job.state === 'planning';
  };
  /** One request; false when the whole run has to stop. */
  const ask = async (messages: ChatMessage[], research: boolean, schema: Record<string, unknown>, take: (text: string) => TidyProposal[]) => {
    if (!(await still())) return false;
    if (runner.budgeted && (await overBudget({ budget: opts.budget }))) {
      await updateJob((j) => {
        if (j.id === jobId && j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'budget', stopMessage: t('aiErrBudget') });
      });
      return false;
    }
    try {
      const reply = await runner.complete(messages, { research, schema });
      if (runner.budgeted) await recordSpend(reply.cost);
      let found: TidyProposal[] = [];
      let failed = false;
      try {
        found = take(reply.text);
      } catch {
        failed = true;
      }
      await updateJob((j) => {
        if (j.id !== jobId) return;
        j.proposals.push(...found);
        j.step++;
        if (failed) j.failures = (j.failures ?? 0) + 1;
        j.cost = Math.round((j.cost + (reply.cost ?? 0)) * 1e8) / 1e8;
      });
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const fatal = typeof code === 'string' && FATAL.has(code);
      await updateJob((j) => {
        if (j.id !== jobId) return;
        j.step++;
        j.failures = (j.failures ?? 0) + 1;
        if (fatal) Object.assign(j, { state: 'ready', stopped: 'error', stopMessage: err instanceof Error ? err.message : String(err) });
      });
      return !fatal;
    }
  };

  try {
    if (opts.research) {
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const item = items[next++]!;
          const go = await ask(buildResearchNamingPrompt(item, opts.language), true, singleNameSchema(), (text) => {
            const named = parseSingleName(text, item);
            return named ? [proposal(item, named.title)] : [];
          });
          if (!go) {
            next = items.length;
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: runner.parallel }, worker));
    } else {
      for (const part of chunk(items, NAMING_BATCH)) {
        const go = await ask(buildNamingPrompt(part, opts.language), false, titlesSchema(part), (text) =>
          parseTitlesReply(text, part).map(({ item, title }) => proposal(item, cleanName(title) ?? title)),
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

/** The user's own version of a proposed title, kept with the job until applied. */
export async function editNaming(id: string, title: string): Promise<string> {
  const name = cleanName(title);
  if (!name) throw new Error(t('namingInvalid'));
  let saved = name;
  await updateJob((j) => {
    const p = j.proposals.find((x) => x.id === id);
    if (!p || p.kind !== 'retitle' || p.appliedAt || j.state === 'applying' || j.state === 'done') {
      saved = p?.kind === 'retitle' ? p.newTitle : '';
      return;
    }
    p.newTitle = name;
  });
  if (!saved) throw new Error(t('namingInvalid'));
  return saved;
}

export async function cancelNaming(): Promise<void> {
  await updateJob((j) => {
    if (j.state === 'planning') Object.assign(j, { state: 'ready', stopped: 'cancelled' });
  });
}

export async function discardNaming(): Promise<void> {
  const job = await aiNamingItem.getValue();
  if (job?.state === 'applying') throw new Error(t('aiBulkBusy'));
  if (job?.state === 'planning') await cancelNaming();
  await aiNamingItem.removeValue();
}

export function applyNaming(ids: string[]): Promise<TidyApplyResult> {
  return applyProposals(aiNamingItem, ids);
}

export async function resumeNaming(): Promise<void> {
  const job = await aiNamingItem.getValue();
  if (job?.state === 'planning') await updateJob((j) => void Object.assign(j, { state: 'ready', stopped: 'interrupted' }));
  if (job?.state === 'applying') await updateJob((j) => void (j.state = 'ready'));
}

