import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { FakeBookmarks } from './fakes';

/**
 * Regression tests for the issues found in the review before 1.0.0.
 */

const b = new FakeBookmarks('chromium');
let calls = 0;
const waiters: (() => void)[] = [];

vi.mock('../src/services/sync-service', async (load) => ({
  ...(await load<typeof import('../src/services/sync-service')>()),
  localBookmarks: () => b,
  isApplying: () => false,
  exclusive: (f: () => unknown) => f(),
  runSync: async () => undefined,
}));
vi.mock('../src/services/ai-client', () => ({
  assertPermission: async () => undefined,
  aiRunner: async () => ({
    provider: 'custom',
    model: 'm',
    canResearch: false,
    budgeted: false,
    language: 'en',
    parallel: 1,
    complete: () => {
      calls++;
      return new Promise((resolve) => waiters.push(() => resolve({ text: '{"folder":null,"confidence":0.9}' })));
    },
  }),
}));

const { startBulk, cancelBulk } = await import('../src/services/bulk-service');
const { toTidyProposals } = await import('../src/services/assistant-service');
const { resetAccountState, aiBulkItem, syncStateItem, tagsItem, semanticIndexItem } = await import('../src/shared/state');

const tick = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
});

describe('bulk sorting', () => {
  it('plans a new run started right after Stop, instead of leaving it stuck', async () => {
    const a = await b.add('1', 'A');
    const c = await b.add('1', 'C');
    await b.add(a, 'x', 'https://x.example/');
    await b.add(c, 'y', 'https://y.example/');
    await startBulk(a, false);
    await tick();
    expect(calls).toBe(1);
    await cancelBulk();
    const second = await startBulk(c, false);
    await tick();
    // The new run asked the model without waiting for the stopped one.
    expect(calls).toBe(2);
    waiters.forEach((w) => w());
    await tick();
    await tick();
    const job = await aiBulkItem.getValue();
    expect(job?.id).toBe(second.id);
    expect(job?.state).toBe('ready');
  });
});

describe('assistant proposals', () => {
  it('never touch a sync root such as the Chromium "Bookmarks Menu" stand-in', () => {
    const tree = [
      {
        id: '0',
        title: '',
        children: [
          { id: '2', title: 'Other', children: [{ id: 'menu', title: 'Bookmarks Menu', children: [] }, { id: 'f', title: 'Folder', children: [] }] },
        ],
      },
    ];
    const local = (ref: string) => ({ menu: 'menu', rf: 'f' })[ref];
    const got = toTidyProposals(
      [
        { id: 'p1', kind: 'rename', folderId: 'menu', name: 'Mine', at: 1 },
        { id: 'p2', kind: 'merge', folderId: 'menu', intoId: 'rf', at: 1 },
        { id: 'p3', kind: 'rename', folderId: 'rf', name: 'Better', at: 1 },
      ],
      tree,
      local,
      new Set(['2', 'menu']),
    );
    expect(got.map((p) => p.id)).toEqual(['p3']);
  });
});

describe('account reset', () => {
  it('keeps tags with the local bookmarks and forgets the semantic index', async () => {
    await syncStateItem.setValue({ mapping: { L1: 'r1', L2: 'r2' }, mirror: {}, keep: [] });
    await tagsItem.setValue({ items: { r1: { tags: ['work'], at: 1 }, r9: { tags: ['gone'], at: 1 } }, pending: { L3: { tags: ['new'], at: 2 } } });
    await semanticIndexItem.setValue({ schema: 1, kind: 'marksync-semantic', model: 'm', dims: 1, items: {}, updatedAt: 1 });
    await resetAccountState();
    expect(await tagsItem.getValue()).toEqual({ items: {}, pending: { L1: { tags: ['work'], at: 1 }, L3: { tags: ['new'], at: 2 } } });
    expect(await semanticIndexItem.getValue()).toBeNull();
  });
});
