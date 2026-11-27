import type { ChatMessage } from '../core/ai-sort';
import type { BuiltinLanguage } from '../core/ai-provider';
import { keepingAlive, OpenRouterError } from './openrouter';

/**
 * The browser's own on-device model through the Prompt API (Chrome 138+ for
 * extensions: Gemini Nano). https://developer.chrome.com/docs/extensions/ai/prompt-api
 *
 * The model is downloaded once (about 2-3 GB, needs a user action: Settings
 * starts it), then runs offline. Nothing is sent anywhere.
 */

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
/** `unsupported`: this browser (or this context) has no Prompt API at all. */
export type BuiltinState = Availability | 'unsupported';

interface Session {
  prompt(input: string, opts?: { responseConstraint?: Record<string, unknown>; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface ModelOptions {
  expectedInputs: { type: 'text'; languages: string[] }[];
  expectedOutputs: { type: 'text'; languages: string[] }[];
}
interface CreateOptions extends ModelOptions {
  initialPrompts?: { role: 'system'; content: string }[];
  signal?: AbortSignal;
  monitor?: (m: EventTarget) => void;
}
interface LanguageModelApi {
  availability(opts: ModelOptions): Promise<Availability>;
  create(opts: CreateOptions): Promise<Session>;
}

/** An answer from a small model on a slow machine can take a while. */
const TIMEOUT_MS = 120_000;

function api(): LanguageModelApi | undefined {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel;
}

/** The system prompt is English; titles and folder names are in the user's language. */
function modelOptions(language: BuiltinLanguage): ModelOptions {
  const languages = language === 'en' ? ['en'] : ['en', language];
  return {
    expectedInputs: [{ type: 'text', languages }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
}

export async function builtinAvailability(language: BuiltinLanguage): Promise<BuiltinState> {
  const lm = api();
  if (!lm) return 'unsupported';
  try {
    return await lm.availability(modelOptions(language));
  } catch {
    return 'unavailable';
  }
}

/**
 * Downloads the model if needed. Must start from a click (the Prompt API asks
 * for a user action before a download). `onProgress` gets 0..1.
 */
export async function prepareBuiltin(language: BuiltinLanguage, onProgress: (loaded: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new OpenRouterError('This browser has no built-in AI model.', 'unavailable');
  const session = await lm.create({
    ...modelOptions(language),
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress((e as Event & { loaded: number }).loaded));
    },
  });
  session.destroy();
}

/** Asks the on-device model; a fresh session per bookmark, so one never sees another. */
export async function builtinComplete(opts: {
  messages: ChatMessage[];
  language: BuiltinLanguage;
  schema?: Record<string, unknown>;
}): Promise<string> {
  const lm = api();
  if (!lm) throw new OpenRouterError('This browser has no built-in AI model.', 'unavailable');
  const state = await builtinAvailability(opts.language);
  if (state !== 'available') {
    throw new OpenRouterError(
      state === 'unavailable'
        ? 'This device cannot run the built-in AI model.'
        : 'The built-in AI model is not downloaded yet. Download it in Settings.',
      'unavailable',
    );
  }
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = opts.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  return keepingAlive(async () => {
    let session: Session | undefined;
    try {
      session = await lm.create({
        ...modelOptions(opts.language),
        ...(system ? { initialPrompts: [{ role: 'system' as const, content: system }] } : {}),
        signal,
      });
      const text = await session.prompt(user, { ...(opts.schema ? { responseConstraint: opts.schema } : {}), signal });
      if (!text.trim()) throw new OpenRouterError('The built-in AI model returned an empty answer.', 'model');
      return text;
    } catch (err) {
      if (err instanceof OpenRouterError) throw err;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new OpenRouterError('The built-in AI model did not answer in time.', 'network');
      }
      // QuotaExceededError: the prompt is larger than the model's context.
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenRouterError(`The built-in AI model failed: ${message}`.slice(0, 300), name === 'NotSupportedError' ? 'unavailable' : 'model');
    } finally {
      session?.destroy();
    }
  });
}
