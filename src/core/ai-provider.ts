/**
 * Where AI sorting sends its prompts: pure helpers, no browser APIs.
 *
 * - `openrouter`: OpenRouter (any of its models, web research, cost reporting).
 * - `custom`: any OpenAI-compatible chat-completions endpoint the user runs or
 *   trusts (Ollama, LM Studio, vLLM, llama.cpp, a self-hosted gateway).
 * - `builtin`: the browser's own on-device model (Chrome's Gemini Nano through
 *   the Prompt API). Nothing leaves the device.
 */

export type AiProvider = 'openrouter' | 'custom' | 'builtin';
export const AI_PROVIDERS: readonly AiProvider[] = ['openrouter', 'custom', 'builtin'];

/** An OpenAI-compatible API. */
export interface Endpoint {
  /** Base URL without a trailing slash, e.g. "http://localhost:11434/v1". */
  base: string;
  /** Host permission pattern for it (match patterns have no port). */
  origin: string;
  /** Shown in messages, e.g. "localhost:11434". */
  label: string;
  /** OpenRouter: attribution headers, server tools and cost reporting. */
  openRouter: boolean;
}

export const OPENROUTER_ENDPOINT: Endpoint = {
  base: 'https://openrouter.ai/api/v1',
  origin: 'https://openrouter.ai/*',
  label: 'OpenRouter',
  openRouter: true,
};

export const MAX_ENDPOINT_LENGTH = 300;

/**
 * Reads the base URL typed in Settings. Only http(s), no credentials, query or
 * fragment (a key belongs in the key field, not in the address). Returns
 * undefined when the address cannot be used.
 */
export function parseEndpoint(input: string): Endpoint | undefined {
  const text = input.trim();
  if (!text || text.length > MAX_ENDPOINT_LENGTH) return undefined;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password || u.search || u.hash || !u.hostname) return undefined;
  const path = u.pathname.replace(/\/+$/, '');
  // Typing the full chat URL is a common slip: keep only the base.
  const base = `${u.protocol}//${u.host}${path.replace(/\/chat\/completions$/i, '')}`;
  return {
    base,
    origin: `${u.protocol}//${u.hostname}/*`,
    label: u.host,
    openRouter: u.hostname === 'openrouter.ai',
  };
}

/** True for addresses on this computer or a private network, where plain http is expected. */
export function isLocalEndpoint(e: Endpoint): boolean {
  const host = new URL(e.base).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host);
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** Model names of local servers: "llama3.2:3b", "qwen/qwen3-8b", "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf". */
export const ENDPOINT_MODEL = /^[\w.:/@+-]{1,200}$/;

/** Model IDs from an OpenAI-compatible `GET /models` answer ({ data: [{ id }] }). */
export function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | undefined)?.data ?? (body as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  for (const m of data) {
    const id = (m as { id?: unknown; name?: unknown } | null)?.id ?? (m as { name?: unknown } | null)?.name;
    if (typeof id === 'string' && ENDPOINT_MODEL.test(id)) ids.add(id);
    if (ids.size >= 500) break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Languages Chrome's built-in model reads and writes. */
const BUILTIN_LANGUAGES = ['en', 'es', 'ja', 'de', 'fr'] as const;
export type BuiltinLanguage = (typeof BUILTIN_LANGUAGES)[number];

/** The UI language if the built-in model supports it, English otherwise. */
export function builtinLanguage(uiLanguage: string): BuiltinLanguage {
  const base = uiLanguage.toLowerCase().split(/[-_]/)[0] ?? '';
  return (BUILTIN_LANGUAGES as readonly string[]).includes(base) ? (base as BuiltinLanguage) : 'en';
}

/** The on-device model has a small context: fewer folders are offered. */
export const BUILTIN_MAX_FOLDERS = 120;

/** Shown in the log as the model that decided. */
export const BUILTIN_MODEL_NAME = 'Chrome built-in AI';

/** Requests in flight at the same time during bulk sorting. */
export function parallelFor(provider: AiProvider): number {
  return provider === 'openrouter' ? 3 : provider === 'custom' ? 2 : 1;
}
