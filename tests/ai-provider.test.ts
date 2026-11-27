import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  builtinLanguage,
  isLocalEndpoint,
  parseEndpoint,
  parseModelIds,
  parallelFor,
} from '../src/core/ai-provider';
import { listFolderOptions, parseSortReply, sortReplySchema, type ChatMessage } from '../src/core/ai-sort';
import { chatCompletion, fetchEndpointModels, OpenRouterError } from '../src/platform/openrouter';
import { sortOne, type SorterDeps } from '../src/sync/sorter';
import { FakeBookmarks } from './fakes';

describe('parseEndpoint', () => {
  it('keeps the base address and derives a host permission without the port', () => {
    expect(parseEndpoint(' http://localhost:11434/v1/ ')).toEqual({
      base: 'http://localhost:11434/v1',
      origin: 'http://localhost/*',
      label: 'localhost:11434',
      openRouter: false,
    });
  });

  it('drops a pasted /chat/completions', () => {
    expect(parseEndpoint('https://ai.example.com/v1/chat/completions')?.base).toBe('https://ai.example.com/v1');
  });

  it('rejects other schemes, credentials, queries and fragments', () => {
    for (const bad of ['', 'localhost:11434', 'ftp://x.example/v1', 'file:///etc', 'http://u:p@x.example/v1', 'http://x.example/v1?key=1', 'http://x.example/#a', 'javascript:alert(1)']) {
      expect(parseEndpoint(bad), bad).toBeUndefined();
    }
  });

  it('recognises OpenRouter typed in as a custom endpoint', () => {
    expect(parseEndpoint('https://openrouter.ai/api/v1')?.openRouter).toBe(true);
  });

  it('tells local and private addresses from public ones', () => {
    const local = ['http://localhost:1234/v1', 'http://127.0.0.1:8080/v1', 'http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1', 'http://172.20.0.1/v1', 'http://gpu-box.local:11434/v1', 'http://[::1]:11434/v1'];
    for (const url of local) expect(isLocalEndpoint(parseEndpoint(url)!), url).toBe(true);
    for (const url of ['http://ai.example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1']) {
      expect(isLocalEndpoint(parseEndpoint(url)!), url).toBe(false);
    }
  });
});

describe('provider helpers', () => {
  it('reads model lists of OpenAI-compatible servers and of Ollama', () => {
    expect(parseModelIds({ data: [{ id: 'qwen3:8b' }, { id: 'llama3.2:3b' }, { id: 'bad id with spaces' }, { id: 7 }] })).toEqual([
      'llama3.2:3b',
      'qwen3:8b',
    ]);
    expect(parseModelIds({ models: [{ name: 'gemma3:4b' }] })).toEqual(['gemma3:4b']);
    expect(parseModelIds('nope')).toEqual([]);
  });

  it('uses a language the built-in model knows, English otherwise', () => {
    expect(builtinLanguage('de-DE')).toBe('de');
    expect(builtinLanguage('ja')).toBe('ja');
    expect(builtinLanguage('tr')).toBe('en');
  });

  it('sends fewer requests at once to local models', () => {
    expect(parallelFor('openrouter')).toBeGreaterThan(parallelFor('custom'));
    expect(parallelFor('builtin')).toBe(1);
  });
});

describe('sortReplySchema', () => {
  const tree = [
    { id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [{ id: '2', title: 'Work', children: [] }] }] },
  ];
  const folders = listFolderOptions(tree);

  it('only allows the offered folder refs', () => {
    const schema = sortReplySchema(folders, false) as { properties: Record<string, { anyOf?: { enum?: string[] }[] }>; required: string[] };
    expect(schema.properties.folder!.anyOf![0]!.enum).toEqual(['f1', 'f2']);
    expect(schema.properties.newFolder).toBeUndefined();
    expect(schema.required).toContain('folder');
  });

  it('describes the new folder only when it is allowed', () => {
    const schema = sortReplySchema(folders, true) as { properties: Record<string, unknown> };
    expect(schema.properties.newFolder).toBeDefined();
  });

  it('matches what parseSortReply accepts', () => {
    const reply = JSON.stringify({ folder: 'f2', newFolder: null, confidence: 0.8, reason: 'Work', site: { name: 'X', category: 'Tool', summary: 's', purpose: 'p' } });
    expect(parseSortReply(reply, folders, { allowNewFolders: true })).toMatchObject({ action: 'move', folder: { ref: 'f2' } });
  });
});

describe('chatCompletion with an OpenAI-compatible endpoint', () => {
  const endpoint = parseEndpoint('http://localhost:11434/v1')!;
  const messages: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'bookmark' },
  ];
  let calls: { url: string; init: RequestInit; body: Record<string, unknown> }[];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    fakeBrowser.reset();
    calls = [];
    fakeBrowser.permissions.contains = (async () => true) as typeof fakeBrowser.permissions.contains;
  });
  afterEach(() => vi.unstubAllGlobals());

  function serve(...answers: Response[]) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {} });
      const next = answers.shift();
      if (!next) throw new TypeError('Failed to fetch');
      return next;
    });
  }

  it('posts to the endpoint with the schema, the key and no OpenRouter extras', async () => {
    serve(json(200, { choices: [{ message: { content: '{"folder":"f1"}' } }] }));
    const schema = { type: 'object' };
    const reply = await chatCompletion({ endpoint, apiKey: 'secret', model: 'qwen3:8b', messages, research: true, schema });
    expect(reply).toEqual({ text: '{"folder":"f1"}', sources: [] });
    const [call] = calls;
    expect(call!.url).toBe('http://localhost:11434/v1/chat/completions');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
    expect(headers['X-OpenRouter-Title']).toBeUndefined();
    expect(call!.body.tools).toBeUndefined();
    expect(call!.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'sort_reply', strict: true, schema } });
    expect(call!.init.credentials).toBe('omit');
  });

  it('asks again without structured output when the server rejects it', async () => {
    serve(json(400, { error: 'response_format not supported' }), json(200, { choices: [{ message: { content: '{}' } }] }));
    await chatCompletion({ endpoint, model: 'm', messages, schema: { type: 'object' } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.response_format).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reports errors with the server name and plain-string error bodies', async () => {
    serve(json(404, { error: 'model "nope" not found, try pulling it first' }), json(404, { error: 'model "nope" not found' }));
    const err = await chatCompletion({ endpoint, model: 'nope', messages }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).toMatchObject({ code: 'model', message: 'model "nope" not found, try pulling it first' });
  });

  it('says which server could not be reached', async () => {
    serve();
    await expect(chatCompletion({ endpoint, model: 'm', messages })).rejects.toMatchObject({
      code: 'network',
      message: 'Could not reach localhost:11434.',
    });
  });

  it('refuses to send anything without the host permission', async () => {
    fakeBrowser.permissions.contains = (async () => false) as typeof fakeBrowser.permissions.contains;
    serve(json(200, {}));
    await expect(chatCompletion({ endpoint, model: 'm', messages })).rejects.toMatchObject({ code: 'permission' });
    expect(calls).toHaveLength(0);
  });

  it('lists the models of the endpoint', async () => {
    serve(json(200, { object: 'list', data: [{ id: 'llama3.2:3b' }] }));
    expect(await fetchEndpointModels(endpoint)).toEqual(['llama3.2:3b']);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models');
  });
});

describe('sortOne with another provider', () => {
  it('records the provider, offers at most maxFolders and passes the schema', async () => {
    const b = new FakeBookmarks('chromium');
    const inbox = await b.add('1', 'Inbox');
    for (let i = 0; i < 8; i++) await b.add('1', `Folder ${i}`);
    const id = await b.add(inbox, 'Docs', 'https://docs.example/');
    let seen: { messages: ChatMessage[]; schema: Record<string, unknown> } | undefined;
    const deps: SorterDeps = {
      bookmarks: b,
      language: 'en',
      complete: async (messages, opts) => {
        seen = { messages, schema: opts.schema };
        return '{"folder":"f2","confidence":0.9,"reason":"ok"}';
      },
    };
    const out = await sortOne(deps, { inboxId: inbox, allowNewFolders: false, model: 'llama3.2:3b', provider: 'custom', maxFolders: 4 }, id);
    expect(out).toMatchObject({ status: 'moved', provider: 'custom', model: 'llama3.2:3b' });
    expect(out!.cost).toBeUndefined();
    const offered = seen!.messages[1]!.content.split('\n').filter((l) => /^f\d+:/.test(l));
    expect(offered).toHaveLength(4);
    const folder = (seen!.schema as { properties: { folder: { anyOf: { enum: string[] }[] } } }).properties.folder;
    expect(folder.anyOf[0]!.enum).toEqual(['f1', 'f2', 'f3', 'f4']);
  });
});
