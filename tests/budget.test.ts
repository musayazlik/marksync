import { describe, expect, it } from 'vitest';
import { addSpend, budgetState, currentSpend, monthKey, nextMonthStart } from '../src/core/budget';
import { sortOne } from '../src/sync/sorter';
import type { ChatMessage } from '../src/core/ai-sort';
import { FakeBookmarks } from './fakes';

describe('monthly budget', () => {
  it('counts spending per calendar month', () => {
    expect(monthKey(new Date(2026, 10, 24))).toBe('2026-11');
    expect(monthKey(new Date(2026, 0, 1))).toBe('2026-01');
    let s = addSpend(undefined, 0.25, '2026-11');
    s = addSpend(s, 0.1, '2026-11');
    // A request without a reported cost still counts as a request.
    s = addSpend(s, undefined, '2026-11');
    expect(s).toEqual({ month: '2026-11', usd: 0.35, requests: 3 });
    // A new month starts from zero.
    expect(currentSpend(s, '2026-12')).toEqual({ month: '2026-12', usd: 0, requests: 0 });
    expect(addSpend(s, 1, '2026-12')).toEqual({ month: '2026-12', usd: 1, requests: 1 });
    expect(addSpend(s, -5, '2026-11').usd).toBe(0.35);
    expect(currentSpend({ month: '2026-11', usd: Number.NaN, requests: 2 }, '2026-11').usd).toBe(0);
  });

  it('warns at 80 % and stops at the cap', () => {
    expect(budgetState(3, 0)).toEqual({ state: 'off', spent: 3 });
    expect(budgetState(1, 5)).toMatchObject({ state: 'ok', left: 4 });
    expect(budgetState(4, 5)).toMatchObject({ state: 'near', left: 1 });
    expect(budgetState(5.2, 5)).toMatchObject({ state: 'over', left: 0 });
  });

  it('starts again on the first of next month', () => {
    expect(nextMonthStart(new Date(2026, 11, 31))).toEqual(new Date(2027, 0, 1));
  });
});

describe('sorting with the budget used up', () => {
  it('does not ask the model and keeps the bookmark in the inbox', async () => {
    const b = new FakeBookmarks('chromium');
    const inbox = await b.add('1', 'Inbox');
    await b.add('1', 'Work');
    const id = await b.add(inbox, 'Some page', 'https://example.org/');
    const asked: ChatMessage[][] = [];
    const outcome = await sortOne(
      {
        bookmarks: b,
        language: 'en',
        complete: async (m) => {
          asked.push(m);
          return '{"folder":null}';
        },
      },
      {
        inboxId: inbox,
        allowNewFolders: false,
        model: 'm/m',
        research: true,
        blocked: { code: 'budget', message: 'Budget used up' },
      },
      id,
    );
    expect(asked).toHaveLength(0);
    expect(outcome).toMatchObject({ status: 'error', errorCode: 'budget', error: 'Budget used up', title: 'Some page' });
    expect(outcome).not.toHaveProperty('researched');
    expect((await b.getChildren(inbox)).map((n) => n.id)).toEqual([id]);
  });
});
