/**
 * Monthly spending cap for AI sorting. Marksync counts what OpenRouter
 * reports for its own requests in this browser, per calendar month (local
 * time), so other apps using the same key do not use up this budget.
 */

export interface Spend {
  /** "2026-11". */
  month: string;
  /** USD reported by OpenRouter this month. */
  usd: number;
  requests: number;
}

/** "2026-11" for a date in the user's time zone. */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** This month's spending; a stored value from an earlier month counts as zero. */
export function currentSpend(stored: Spend | null | undefined, month = monthKey()): Spend {
  if (!stored || stored.month !== month || !Number.isFinite(stored.usd)) return { month, usd: 0, requests: 0 };
  return { month, usd: Math.max(0, stored.usd), requests: Math.max(0, stored.requests | 0) };
}

export function addSpend(stored: Spend | null | undefined, cost: number | undefined, month = monthKey()): Spend {
  const s = currentSpend(stored, month);
  const add = typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
  return { month, usd: Math.round((s.usd + add) * 1e8) / 1e8, requests: s.requests + 1 };
}

/** Share of the budget at which the popup and Settings start to warn. */
export const BUDGET_WARN_AT = 0.8;

export type BudgetState =
  | { state: 'off'; spent: number }
  | { state: 'ok' | 'near' | 'over'; spent: number; budget: number; left: number; ratio: number };

/** `budget` 0 (or less) means no cap. */
export function budgetState(spent: number, budget: number): BudgetState {
  if (!(budget > 0)) return { state: 'off', spent };
  const ratio = spent / budget;
  return {
    state: ratio >= 1 ? 'over' : ratio >= BUDGET_WARN_AT ? 'near' : 'ok',
    spent,
    budget,
    left: Math.max(0, budget - spent),
    ratio,
  };
}

/** The first day of next month, when the budget starts again. */
export function nextMonthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
