import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/core/ai-sort';
import { applyPlanned, sortOne, type SorterDeps } from '../src/sync/sorter';
import { FakeBookmarks } from './fakes';

/** The model's reference ("f3") for a folder path in the prompt. */
const refOf = (messages: ChatMessage[], path: string) => {
  const line = messages[1]!.content.split('\n').find((l) => l.endsWith(`: ${path}`));
  return line?.trim().split(':')[0];
};

async function setup() {
  const b = new FakeBookmarks('chromium');
  const inbox = await b.add('1', 'Inbox');
  const misc = await b.add('1', 'Misc');
  const work = await b.add('1', 'Work');
  const a = await b.add(misc, 'Postgres docs', 'https://postgresql.org/docs');
  const c = await b.add(misc, 'Pasta recipe', 'https://food.example/pasta');
  const d = await b.add(misc, 'Soup recipe', 'https://food.example/soup');
  return { b, inbox, misc, work, a, c, d };
}

function model(b: FakeBookmarks, answer: (m: ChatMessage[]) => string) {
  const asked: ChatMessage[][] = [];
  const deps: SorterDeps = {
    bookmarks: b,
    language: 'en',
    complete: async (m) => {
      asked.push(m);
      return { text: answer(m), cost: 0.002 };
    },
  };
  return { deps, asked };
}

describe('bulk sorting', () => {
  it('proposes without moving anything, and never offers the inbox', async () => {
    const { b, inbox, misc, work, a } = await setup();
    const { deps, asked } = model(b, (m) => `{"folder":"${refOf(m, 'Bookmarks bar / Work')}","confidence":0.9,"reason":"Docs"}`);
    const p = await sortOne(deps, { inboxId: misc, skip: [inbox], allowNewFolders: false, model: 'm/m', plan: true }, a);
    expect(p).toMatchObject({ status: 'moved', toId: work, toPath: 'Bookmarks bar / Work', fromId: misc, cost: 0.002 });
    expect((await b.getChildren(misc)).map((n) => n.id)).toContain(a);
    expect(refOf(asked[0]!, 'Bookmarks bar / Inbox')).toBeUndefined();
    expect(refOf(asked[0]!, 'Bookmarks bar / Misc')).toBeUndefined();
  });

  it('applies approved proposals and reuses a folder created in the same batch', async () => {
    const { b, misc, c, d } = await setup();
    const { deps } = model(b, (m) => `{"folder":null,"newFolder":{"parent":"${refOf(m, 'Bookmarks bar')}","name":"Recipes"},"confidence":0.8}`);
    const run = { inboxId: misc, allowNewFolders: true, model: 'm/m', plan: true };
    const p1 = (await sortOne(deps, run, c))!;
    const p2 = (await sortOne(deps, run, d))!;
    expect(p1).toMatchObject({ status: 'created', newFolder: { parentId: '1', name: 'Recipes' } });
    // Planning created nothing.
    expect((await b.getChildren('1')).some((n) => n.title === 'Recipes')).toBe(false);

    const created = new Map<string, string>();
    const r1 = await applyPlanned(b, p1, misc, created);
    const r2 = await applyPlanned(b, p2, misc, created);
    const recipes = (await b.getChildren('1')).filter((n) => n.title === 'Recipes');
    expect(recipes).toHaveLength(1);
    expect(r1).toMatchObject({ status: 'created', toId: recipes[0]!.id });
    expect(r2).toMatchObject({ status: 'moved', toId: recipes[0]!.id });
    expect(r1).not.toHaveProperty('newFolder');
    expect((await b.getChildren(recipes[0]!.id)).map((n) => n.id)).toEqual([c, d]);
  });

  it('leaves a bookmark alone when it was moved or its target deleted meanwhile', async () => {
    const { b, misc, work, a, c } = await setup();
    const { deps } = model(b, (m) => `{"folder":"${refOf(m, 'Bookmarks bar / Work')}","confidence":0.9}`);
    const run = { inboxId: misc, allowNewFolders: false, model: 'm/m', plan: true };
    const pa = (await sortOne(deps, run, a))!;
    const pc = (await sortOne(deps, run, c))!;
    const elsewhere = await b.add('2', 'Elsewhere');
    await b.move(a, { parentId: elsewhere });
    expect(await applyPlanned(b, pa, misc, new Map())).toMatchObject({ status: 'error', errorCode: 'moved' });
    expect((await b.getChildren(elsewhere)).map((n) => n.id)).toEqual([a]);
    await b.removeTree(work);
    expect(await applyPlanned(b, pc, misc, new Map())).toMatchObject({ status: 'error' });
    expect((await b.getChildren(misc)).map((n) => n.id)).toContain(c);
  });
});
