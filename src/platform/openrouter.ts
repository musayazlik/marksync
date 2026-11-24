import { browser } from 'wxt/browser';
import type { ChatMessage } from '../core/ai-sort';

/**
 * Minimal OpenRouter client (OpenAI-compatible chat completions).
 * https://openrouter.ai/docs/api-reference/overview
 */
const API = 'https://openrouter.ai/api/v1';
/** Optional host permission, asked for when the user turns AI sorting on. */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai/*';
const TIMEOUT_MS = 30_000;

export type OpenRouterErrorCode = 'auth' | 'credits' | 'rate-limit' | 'model' | 'permission' | 'network' | 'unknown';

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

/** True once the user has allowed requests to openrouter.ai. */
export function hasOpenRouterPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: [OPENROUTER_ORIGIN] });
}

function codeFor(status: number): OpenRouterErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404) return 'model';
  return status >= 500 ? 'network' : 'unknown';
}

async function request(path: string, apiKey: string, init: RequestInit = {}): Promise<unknown> {
  if (!(await hasOpenRouterPermission())) {
    throw new OpenRouterError('Marksync is not allowed to contact openrouter.ai.', 'permission');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      // No cookies: the API key is the only credential.
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // App attribution on openrouter.ai (optional headers).
        'HTTP-Referer': 'https://github.com/musayazlik/marksync',
        'X-OpenRouter-Title': 'Marksync',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new OpenRouterError(aborted ? 'OpenRouter did not answer in time.' : 'Could not reach OpenRouter.', 'network');
  } finally {
    clearTimeout(timer);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    throw new OpenRouterError(
      typeof message === 'string' && message ? message.slice(0, 300) : `OpenRouter answered ${res.status}.`,
      codeFor(res.status),
      res.status,
    );
  }
  return body;
}

/** Sends a chat completion and returns the text of the first choice. */
export async function chatCompletion(opts: { apiKey: string; model: string; messages: ChatMessage[] }): Promise<string> {
  const body = (await request('/chat/completions', opts.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: 0,
      max_tokens: 300,
      // JSON mode; models without it still get the JSON-only instruction in the prompt.
      response_format: { type: 'json_object' },
    }),
  })) as {
    choices?: { message?: { content?: unknown }; error?: { message?: string } }[];
    error?: { message?: string };
  };
  const choice = body?.choices?.[0];
  if (choice?.error?.message) throw new OpenRouterError(choice.error.message.slice(0, 300), 'model');
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  // Some providers return content parts.
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'object' && p && 'text' in p ? String(p.text) : '')).join('');
  }
  throw new OpenRouterError('OpenRouter returned an empty answer.', 'model');
}

/** Checks an API key without spending credits. Returns the key's label, if any. */
export async function checkKey(apiKey: string): Promise<string> {
  const body = (await request('/key', apiKey)) as { data?: { label?: unknown } } | undefined;
  const label = body?.data?.label;
  return typeof label === 'string' ? label : '';
}
