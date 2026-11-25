/**
 * OpenRouter's model list and key usage, parsed into the small shapes the
 * extension keeps. Pure functions: no browser APIs, so they are unit tested.
 *
 * https://openrouter.ai/docs/api-reference/list-available-models
 * https://openrouter.ai/docs/api-reference/limits
 */

export interface ModelInfo {
  /** e.g. "anthropic/claude-opus-5.5". */
  id: string;
  /** e.g. "Anthropic: Claude Opus 5.5". */
  name: string;
  /** Context window in tokens (0 if unknown). */
  context: number;
  /** USD per 1M input tokens, or undefined if OpenRouter does not say. */
  prompt?: number;
  /** USD per 1M output tokens. */
  completion?: number;
  free: boolean;
  /** Accepts tools, so the "Research" option (web fetch + search) can be used. */
  tools: boolean;
  /** Unix seconds; newer models first. */
  created: number;
}

/** Spending of one API key, plus the account balance when OpenRouter shares it. */
export interface KeyUsage {
  label: string;
  /** Credit limit of the key in USD, undefined when unlimited. */
  limit?: number;
  /** USD left under the key's limit, undefined when unlimited. */
  remaining?: number;
  /** How often the key's limit resets: 'daily' | 'weekly' | 'monthly', or undefined for never. */
  reset?: string;
  /** USD spent: all time, and this UTC day, week and month. */
  usage: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  /** True until the account has bought credits. */
  freeTier: boolean;
  /** Purchased credits and total usage of the whole account, when readable with this key. */
  account?: { total: number; used: number };
  checkedAt: number;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

/** USD per token (OpenRouter's unit) to USD per million tokens; negative means "varies". */
function perMillion(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

export function parseModels(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const raw of data.slice(0, 2000)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const m = raw as Record<string, unknown>;
    const id = text(m.id, 100);
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    // Only models that answer in text can sort bookmarks.
    const outputs = (m.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
    if (Array.isArray(outputs) && outputs.length && !outputs.includes('text')) continue;
    seen.add(id);
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const prompt = perMillion(pricing.prompt);
    const completion = perMillion(pricing.completion);
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    models.push({
      id,
      name: text(m.name, 120) || id,
      context: num(m.context_length) ?? 0,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(completion !== undefined ? { completion } : {}),
      free: id.endsWith(':free') || (prompt === 0 && completion === 0),
      tools: params.includes('tools'),
      created: num(m.created) ?? 0,
    });
  }
  return models.sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
}

export type ModelFilter = 'all' | 'free' | 'tools';

/**
 * Filters by every word of the query (in the ID or the name, any order), then
 * ranks exact and prefix matches first. Without a query the list keeps its
 * newest-first order.
 */
export function searchModels(models: ModelInfo[], query: string, filter: ModelFilter = 'all'): ModelInfo[] {
  const pool = models.filter((m) => (filter === 'free' ? m.free : filter === 'tools' ? m.tools : true));
  const words = query.toLocaleLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return pool;
  const q = words.join(' ');
  const scored: { m: ModelInfo; score: number; i: number }[] = [];
  pool.forEach((m, i) => {
    const id = m.id.toLowerCase();
    const name = m.name.toLocaleLowerCase();
    const hay = `${id} ${name}`;
    if (!words.every((w) => hay.includes(w))) return;
    const model = id.slice(id.indexOf('/') + 1);
    let score = 0;
    if (id === q || model === q) score = 100;
    else if (model.startsWith(q) || id.startsWith(q)) score = 60;
    else if (name.startsWith(q) || name.includes(`: ${q}`)) score = 40;
    else if (words.every((w) => id.includes(w))) score = 20;
    scored.push({ m, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.m);
}

export function parseKeyUsage(keyBody: unknown, creditsBody?: unknown, now = Date.now()): KeyUsage {
  const d = ((keyBody as { data?: unknown } | undefined)?.data ?? {}) as Record<string, unknown>;
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining);
  const reset = typeof d.limit_reset === 'string' && /^(daily|weekly|monthly)$/.test(d.limit_reset) ? d.limit_reset : undefined;
  const daily = num(d.usage_daily);
  const weekly = num(d.usage_weekly);
  const monthly = num(d.usage_monthly);
  const usage: KeyUsage = {
    label: text(d.label, 100),
    usage: Math.max(0, num(d.usage) ?? 0),
    freeTier: d.is_free_tier === true,
    checkedAt: now,
    ...(limit !== undefined && limit >= 0 ? { limit } : {}),
    ...(remaining !== undefined ? { remaining: Math.max(0, remaining) } : {}),
    ...(reset ? { reset } : {}),
    ...(daily !== undefined ? { daily } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    ...(monthly !== undefined ? { monthly } : {}),
  };
  const c = ((creditsBody as { data?: unknown } | undefined)?.data ?? {}) as Record<string, unknown>;
  const total = num(c.total_credits);
  const used = num(c.total_usage);
  if (total !== undefined && used !== undefined && total >= 0) usage.account = { total, used: Math.max(0, used) };
  return usage;
}

/**
 * What the popup's gauge shows: the key's own limit when it has one (that is
 * what stops requests), otherwise the account balance, otherwise only spending.
 */
export function usageGauge(u: KeyUsage): { source: 'key' | 'account' | 'none'; left?: number; total?: number; used: number } {
  if (u.limit !== undefined && u.limit > 0) {
    const left = u.remaining ?? Math.max(0, u.limit - u.usage);
    return { source: 'key', left, total: u.limit, used: Math.max(0, u.limit - left) };
  }
  if (u.account && u.account.total > 0) {
    return { source: 'account', left: Math.max(0, u.account.total - u.account.used), total: u.account.total, used: u.account.used };
  }
  return { source: 'none', used: u.usage };
}

/** "$0.42", "$12", "$0.0031": enough digits that small amounts do not read as zero. */
export function formatUsd(value: number, locale?: string): string {
  const abs = Math.abs(value);
  const digits = abs === 0 || abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 2 : abs >= 0.0001 ? 4 : 6;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    // Cents stay cents: "$0.30", "$2.50" (whole dollars stay "$15").
    minimumFractionDigits: abs >= 0.01 && abs < 100 && !Number.isInteger(value) ? 2 : 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/** 200000 → "200K", 1048576 → "1M". */
export function formatTokens(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
