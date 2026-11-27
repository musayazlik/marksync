import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildNamingPrompt, buildResearchNamingPrompt, cleanName, parseSingleName } from '../src/core/naming';
import { titleItems } from '../src/core/tidy';
import { applyNaming, editNaming, estimateNaming, startNaming } from '../src/services/naming-service';
import { aiNamingItem, DEFAULT_SETTINGS, openRouterKeyItem, settingsItem, sortLogItem, statusItem } from '../src/shared/state';
import { FakeBookmarks } from './fakes';

describe('naming prompts and replies', () => {
  const items = titleItems([
    { id: 'a', title: 'Home', url: 'https://www.postgresql.org/docs/current/sql-commands.html?x=1' },
    { id: 'b', title: 'Welcome!', url: 'https://invoiceninja.example/' },
  ]);

  it('asks for every bookmark, in the chosen language or the page’s own', () => {
    const [system, user] = buildNamingPrompt(items, 'tr');
    expect(system!.content).toContain('"tr"');
    expect(user!.content).toContain('postgresql.org/docs/current/sql-commands.html');
    expect(user!.content).not.toContain('x=1');
    expect(buildNamingPrompt(items)[0]!.content).toContain("language of the bookmark's current title");
  });

  it('asks a researching model to read the page first', () => {
    expect(buildResearchNamingPrompt(items[0]!, 'en')[0]!.content).toContain('https://www.postgresql.org/docs/current/sql-commands.html');
  });

  it('cleans titles and refuses unusable ones', () => {
    expect(cleanName('  PostgreSQL\n docs  ')).toBe('PostgreSQL docs');
    expect(cleanName('x')).toBeUndefined();
    expect(cleanName('a'.repeat(200))).toHaveLength(120);
    expect(parseSingleName('{"title":"PostgreSQL SQL commands reference","about":"Docs"}', items[0]!)).toEqual({
      title: 'PostgreSQL SQL commands reference',
      about: 'Docs',
    });
    expect(parseSingleName('{"title":"Home"}', items[0]!)).toBeUndefined();
    expect(() => parseSingleName('{"title":""}', items[0]!)).toThrow();
  });
});

describe('naming bookmarks in chosen folders', () => {
  let b: FakeBookmarks;
  let work: string;
  let recipes: string;
  let sub: string;
  let ids: Record<string, string>;
  let bodies: { messages: { content: string }[]; tools?: unknown }[];

  beforeEach(async () => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = ((key: string) => key) as typeof fakeBrowser.i18n.getMessage;
    fakeBrowser.i18n.getUILanguage = (() => 'tr') as typeof fakeBrowser.i18n.getUILanguage;
    fakeBrowser.permissions.contains = (async () => true) as typeof fakeBrowser.permissions.contains;
    b = new FakeBookmarks('chromium');
    (fakeBrowser as unknown as { bookmarks: FakeBookmarks }).bookmarks = b;
    work = await b.add('1', 'Work');
    recipes = await b.add('1', 'Recipes');
    sub = await b.add(work, 'Old');
    ids = {
      pg: await b.add(work, 'Home', 'https://postgresql.org/docs/'),
      inv: await b.add(sub, 'Welcome', 'https://invoice.example/'),
      pasta: await b.add(recipes, 'pasta', 'https://food.example/pasta'),
      other: await b.add('1', 'Untouched', 'https://other.example/'),
    };
    bodies = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[]; tools?: unknown };
      bodies.push(body);
      const user = body.messages[1]!.content;
      const refs = [...user.matchAll(/^(b\d+):/gm)].map((m) => m[1]!);
      const titles = refs.map((ref) => ({ ref, title: `Named ${ref}` }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ titles }) } }], usage: { cost: 0.001 } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    await statusItem.setValue({ connected: false, syncing: false });
    await openRouterKeyItem.setValue('sk-or-test-key-123456789');
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, aiResearch: false });
  });

  const wait = async () => {
    for (let i = 0; i < 200 && (await aiNamingItem.getValue())?.state === 'planning'; i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('names several folders, with or without subfolders', async () => {
    const without = await estimateNaming({ folderIds: [work, recipes], subfolders: false, research: false, uiLanguage: true });
    expect(without.bookmarks).toBe(2);
    const withSub = await estimateNaming({ folderIds: [work, recipes], subfolders: true, research: false, uiLanguage: true });
    expect(withSub).toMatchObject({ bookmarks: 3, requests: 1, research: false });

    await startNaming({ folderIds: [work, recipes], subfolders: true, research: false, uiLanguage: true });
    await wait();
    const job = (await aiNamingItem.getValue())!;
    expect(job.state).toBe('ready');
    expect(job.proposals.map((p) => p.kind === 'retitle' && p.bookmarkId).sort()).toEqual([ids.pg, ids.inv, ids.pasta].sort());
    // The UI language went into the prompt.
    expect(bodies[0]!.messages[0]!.content).toContain('"tr"');
  });

  it('applies the edited titles, and the log can undo them', async () => {
    await startNaming({ folderIds: [work], subfolders: false, research: false, uiLanguage: true });
    await wait();
    const job = (await aiNamingItem.getValue())!;
    const p = job.proposals[0]!;
    expect(await editNaming(p.id, '  PostgreSQL documentation  ')).toBe('PostgreSQL documentation');
    await expect(editNaming(p.id, 'x')).rejects.toThrow('namingInvalid');
    // The edit is kept with the run (Settings can be closed and reopened).
    expect((await aiNamingItem.getValue())!.proposals[0]).toMatchObject({ newTitle: 'PostgreSQL documentation' });

    const result = await applyNaming([p.id]);
    expect(result).toMatchObject({ done: 1, failed: 0 });
    expect((await b.getChildren(work)).find((c) => c.id === ids.pg)!.title).toBe('PostgreSQL documentation');
    expect((await b.getChildren('1')).find((c) => c.id === ids.other)!.title).toBe('Untouched');
    const [entry] = await sortLogItem.getValue();
    expect(entry).toMatchObject({ status: 'tidied', tidy: { action: 'retitle', before: 'Home', after: 'PostgreSQL documentation' } });
  });

  it('asks a researching model one bookmark at a time, with the web tools', async () => {
    await settingsItem.setValue({ ...DEFAULT_SETTINGS, aiResearch: true });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Read and named"}' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const estimate = await estimateNaming({ folderIds: [work], subfolders: true, research: true, uiLanguage: false });
    expect(estimate).toMatchObject({ bookmarks: 2, requests: 2, research: true });
    await startNaming({ folderIds: [work], subfolders: true, research: true, uiLanguage: false });
    await wait();
    expect(bodies).toHaveLength(2);
    expect(bodies.every((x) => Array.isArray(x.tools))).toBe(true);
    expect((await aiNamingItem.getValue())!.proposals).toHaveLength(2);
  });
});
