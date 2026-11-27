import { browser } from 'wxt/browser';
import type { ChatMessage } from '../core/ai-sort';
import { OPENROUTER_ENDPOINT, parseModelIds, type Endpoint } from '../core/ai-provider';
import { parseKeyUsage, parseModels, type KeyUsage, type ModelInfo } from '../core/openrouter-data';

/**
 * Minimal client for OpenAI-compatible chat completions: OpenRouter
 * (https://openrouter.ai/docs/api-reference/overview) or an endpoint the user
 * chose (Ollama, LM Studio, vLLM, ...). OpenRouter-only parts (attribution
 * headers, server tools, cost, key usage) are used only with OpenRouter.
 */
/** Optional host permission, asked for when the user turns AI sorting on. */
export const OPENROUTER_ORIGIN = OPENROUTER_ENDPOINT.origin;
/** A model that browses can take a while; give up after this long. */
const TIMEOUT_MS = 150_000;
/**
 * Chrome stops an extension service worker that waits more than 30 s for a
 * fetch() response, or sits idle for 30 s. Answers are therefore streamed
 * (OpenRouter sends headers and keep-alive comments at once), and a cheap
 * extension API call every 20 s keeps the worker alive while the model works.
 */
const KEEPALIVE_MS = 20_000;

export type OpenRouterErrorCode =
  | 'auth'
  | 'credits'
  | 'rate-limit'
  | 'model'
  | 'permission'
  | 'network'
  /** The on-device model cannot run here, or is not downloaded yet. */
  | 'unavailable'
  | 'unknown';

export class OpenRouterError extends Error {
  override name = 'OpenRouterError';
  constructor(
    message: string,
    readonly code: OpenRouterErrorCode,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** True once the user has allowed requests to the endpoint (openrouter.ai by default). */
export function hasOpenRouterPermission(endpoint: Endpoint = OPENROUTER_ENDPOINT): Promise<boolean> {
  return browser.permissions.contains({ origins: [endpoint.origin] });
}

function codeFor(status: number): OpenRouterErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404) return 'model';
  return status >= 500 ? 'network' : 'unknown';
}

async function send(
  endpoint: Endpoint,
  path: string,
  apiKey: string | undefined,
  init: RequestInit,
  controller: AbortController,
): Promise<Response> {
  if (!(await hasOpenRouterPermission(endpoint))) {
    throw new OpenRouterError(`Marksync is not allowed to contact ${endpoint.label}.`, 'permission');
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint.base}${path}`, {
      ...init,
      signal: controller.signal,
      // No cookies: the API key is the only credential.
      credentials: 'omit',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
        // App attribution on openrouter.ai (optional headers).
        ...(endpoint.openRouter
          ? { 'HTTP-Referer': 'https://github.com/musayazlik/marksync', 'X-OpenRouter-Title': 'Marksync' }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    throw networkError(err, endpoint.label);
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    throw new OpenRouterError(errorMessage(body) ?? `${endpoint.label} answered ${res.status}.`, codeFor(res.status), res.status);
  }
  return res;
}

function networkError(err: unknown, label: string): OpenRouterError {
  if (err instanceof OpenRouterError) return err;
  const aborted = err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return new OpenRouterError(aborted ? `${label} did not answer in time.` : `Could not reach ${label}.`, 'network');
}

function errorMessage(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  // OpenAI and OpenRouter: { error: { message } }; Ollama and some servers: { error: "..." }.
  const message = typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message ? message.slice(0, 300) : undefined;
}

/**
 * Keeps the service worker alive while `task` runs (see KEEPALIVE_MS). Also
 * used for the on-device model, which can take a while on a slow machine.
 */
export async function keepingAlive<T>(task: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => void browser.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  try {
    return await task();
  } finally {
    clearInterval(keepAlive);
  }
}

/** Runs `task` with a timeout and the service-worker keep-alive. */
async function guarded<T>(label: string, task: (controller: AbortController) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await keepingAlive(() => task(controller));
  } catch (err) {
    throw networkError(err, label);
  } finally {
    clearTimeout(timer);
  }
}

async function request(path: string, apiKey?: string, endpoint: Endpoint = OPENROUTER_ENDPOINT): Promise<unknown> {
  return guarded(endpoint.label, async (controller) => {
    const res = await send(endpoint, path, apiKey, {}, controller);
    return res.json().catch(() => undefined);
  });
}

export interface Completion {
  text: string;
  /** Pages the model read or found (url_citation annotations), http/https only. */
  sources: { url: string; title?: string }[];
  /** Cost in USD, when OpenRouter reports it. */
  cost?: number;
}

type Delta = {
  content?: unknown;
  annotations?: { type?: string; url_citation?: { url?: unknown; title?: unknown } }[];
};
type Chunk = {
  choices?: { delta?: Delta; message?: Delta; error?: { message?: string } }[];
  usage?: { cost?: unknown };
  error?: { message?: string };
};

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  }
  return '';
}

/** Collects the reply from a chat completion, streamed (SSE) or plain JSON. */
export class CompletionReader {
  private text = '';
  private sources = new Map<string, string | undefined>();
  private cost: number | undefined;

  constructor(private readonly label = 'OpenRouter') {}

  add(chunk: Chunk): void {
    const error = chunk.error?.message ?? chunk.choices?.[0]?.error?.message;
    if (error) throw new OpenRouterError(error.slice(0, 300), 'model');
    const part = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message;
    if (part) {
      this.text += contentText(part.content);
      for (const a of part.annotations ?? []) {
        const url = a.url_citation?.url;
        if (a.type !== 'url_citation' || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
        if (this.sources.size < 8 && !this.sources.has(url)) {
          const title = a.url_citation?.title;
          this.sources.set(url, typeof title === 'string' ? title.slice(0, 200) : undefined);
        }
      }
    }
    const cost = chunk.usage?.cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) this.cost = cost;
  }

  /** Feeds one line of a server-sent event stream. */
  addLine(line: string): void {
    // ": OPENROUTER PROCESSING" comments keep the connection alive.
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      return;
    }
    this.add(chunk);
  }

  result(): Completion {
    if (!this.text.trim()) throw new OpenRouterError(`${this.label} returned an empty answer.`, 'model');
    return {
      text: this.text,
      sources: [...this.sources].map(([url, title]) => (title ? { url, title } : { url })),
      ...(this.cost !== undefined ? { cost: this.cost } : {}),
    };
  }
}

/**
 * Sends a chat completion and returns the reply text. With `research` (only on
 * OpenRouter), the model may read the bookmarked page and search the web
 * through OpenRouter's server tools before it answers. Other endpoints get
 * `schema` as structured output when they support it.
 */
export async function chatCompletion(opts: {
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  research?: boolean;
  /** JSON schema of the reply, for endpoints other than OpenRouter. */
  schema?: Record<string, unknown>;
  endpoint?: Endpoint;
}): Promise<Completion> {
  const endpoint = opts.endpoint ?? OPENROUTER_ENDPOINT;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0,
    max_tokens: 2000,
    stream: true,
  };
  if (endpoint.openRouter && opts.research) {
    body.tools = [
      // Reading a page with OpenRouter's own fetcher is free; pages are trimmed to keep the prompt small.
      { type: 'openrouter:web_fetch', parameters: { engine: 'auto', max_content_tokens: 6000 } },
      { type: 'openrouter:web_search', parameters: { engine: 'auto', max_results: 3, max_total_results: 6 } },
    ];
  } else if (endpoint.openRouter || !opts.schema) {
    // JSON mode; models without it still get the JSON-only instruction in the prompt.
    body.response_format = { type: 'json_object' };
  } else {
    // Ollama, LM Studio, vLLM and llama.cpp turn the schema into a grammar.
    body.response_format = { type: 'json_schema', json_schema: { name: 'sort_reply', strict: true, schema: opts.schema } };
  }

  const run = () =>
    guarded(endpoint.label, async (controller) => {
      const res = await send(endpoint, '/chat/completions', opts.apiKey, { method: 'POST', body: JSON.stringify(body) }, controller);
      const reader = new CompletionReader(endpoint.label);
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        reader.add((await res.json()) as Chunk);
        return reader.result();
      }
      const stream = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await stream.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          reader.addLine(buffer.slice(0, newline).replace(/\r$/, ''));
          buffer = buffer.slice(newline + 1);
        }
      }
      if (buffer) reader.addLine(buffer);
      return reader.result();
    });

  try {
    return await run();
  } catch (err) {
    // A server that does not know structured output rejects the request: ask
    // again without it (the prompt still asks for JSON only).
    if (!endpoint.openRouter && body.response_format && err instanceof OpenRouterError && err.status === 400) {
      delete body.response_format;
      return run();
    }
    throw err;
  }
}

/**
 * The models an OpenAI-compatible endpoint offers (`GET /models`). Also the
 * "Test" in Settings for such an endpoint: it shows the address and key work.
 */
export async function fetchEndpointModels(endpoint: Endpoint, apiKey?: string): Promise<string[]> {
  return parseModelIds(await request('/models', apiKey, endpoint));
}

/** Checks an API key without spending credits. Returns the key's label, if any. */
export async function checkKey(apiKey: string): Promise<string> {
  const body = (await request('/key', apiKey)) as { data?: { label?: unknown } } | undefined;
  const label = body?.data?.label;
  return typeof label === 'string' ? label : '';
}

/** Every model OpenRouter offers (public list, the key is not needed). */
export async function fetchModels(): Promise<ModelInfo[]> {
  const models = parseModels(await request('/models'));
  if (!models.length) throw new OpenRouterError('OpenRouter returned no models.', 'unknown');
  return models;
}

/**
 * Limit and spending of the key, and the account balance when this key may
 * read it (some keys may not: then only the key's own numbers are shown).
 */
export async function fetchKeyUsage(apiKey: string): Promise<KeyUsage> {
  const [key, credits] = await Promise.all([
    request('/key', apiKey),
    request('/credits', apiKey).catch((err: unknown) => {
      if (err instanceof OpenRouterError && err.code === 'auth') return undefined;
      if (err instanceof OpenRouterError && err.code === 'permission') throw err;
      return undefined;
    }),
  ]);
  return parseKeyUsage(key, credits);
}
