import { browser } from 'wxt/browser';
import type { ChatMessage } from '../core/ai-sort';
import {
  BUILTIN_MAX_FOLDERS,
  BUILTIN_MODEL_NAME,
  builtinLanguage,
  OPENROUTER_ENDPOINT,
  parallelFor,
  parseEndpoint,
  type AiProvider,
  type Endpoint,
} from '../core/ai-provider';
import { builtinComplete } from '../platform/builtin-ai';
import { chatCompletion } from '../platform/openrouter';
import { t } from '../shared/i18n';
import { aiModelsItem, endpointKeyItem, openRouterKeyItem, type Settings } from '../shared/state';
import type { ModelReply } from '../sync/sorter';

/**
 * One place that turns the AI settings into "ask the model": AI sorting and
 * bulk sorting both go through it, whatever the provider.
 */
export interface AiRunner {
  provider: AiProvider;
  /** Shown in the log next to the decision. */
  model: string;
  /** The model can read pages and search the web (OpenRouter with a tool-capable model only). */
  canResearch: boolean;
  /** Costs are reported and the monthly cap applies (OpenRouter only). */
  budgeted: boolean;
  /** Fewer folders for the on-device model's small context. */
  maxFolders?: number;
  /** Language of the texts the model writes for the user. */
  language: string;
  /** Requests at the same time during bulk sorting. */
  parallel: number;
  /** Host permission the requests need; undefined for the on-device model. */
  origin?: string;
  complete(messages: ChatMessage[], opts: { research: boolean; schema?: Record<string, unknown> }): Promise<ModelReply>;
}

/** The endpoint of the `custom` provider, or undefined when none is saved. */
export function customEndpoint(s: Settings): Endpoint | undefined {
  return s.aiEndpoint ? parseEndpoint(s.aiEndpoint) : undefined;
}

/** The host permission AI sorting needs with these settings; undefined for the on-device model. */
export function providerOrigin(s: Settings): string | undefined {
  if (s.aiProvider === 'openrouter') return OPENROUTER_ENDPOINT.origin;
  if (s.aiProvider === 'custom') return customEndpoint(s)?.origin;
  return undefined;
}

/** Throws the message for the user when the runner's host is not allowed yet. */
export async function assertPermission(runner: AiRunner, s: Settings): Promise<void> {
  if (!runner.origin || (await browser.permissions.contains({ origins: [runner.origin] }))) return;
  throw new Error(runner.provider === 'custom' ? t('aiPermissionMissingHost', customEndpoint(s)?.label ?? '') : t('aiPermissionMissing'));
}

/**
 * The runner for the current settings, or an Error with a message for the
 * user when something is missing. `model` and `provider` pin a bulk run to
 * what it started with.
 */
export async function aiRunner(s: Settings, pin?: { provider?: AiProvider; model?: string }): Promise<AiRunner> {
  const provider = pin?.provider ?? s.aiProvider;
  const uiLanguage = browser.i18n.getUILanguage();

  if (provider === 'builtin') {
    const language = builtinLanguage(uiLanguage);
    return {
      provider,
      model: BUILTIN_MODEL_NAME,
      canResearch: false,
      budgeted: false,
      maxFolders: BUILTIN_MAX_FOLDERS,
      language,
      parallel: parallelFor(provider),
      complete: async (messages, { schema }) => ({ text: await builtinComplete({ messages, language, schema }) }),
    };
  }

  if (provider === 'custom') {
    const endpoint = customEndpoint(s);
    if (!endpoint) throw new Error(t('aiNoEndpoint'));
    const model = pin?.model ?? s.aiEndpointModel;
    if (!model) throw new Error(t('aiNoEndpointModel'));
    const apiKey = (await endpointKeyItem.getValue()) || undefined;
    return {
      provider,
      model,
      canResearch: false,
      budgeted: false,
      language: uiLanguage,
      parallel: parallelFor(provider),
      origin: endpoint.origin,
      complete: (messages, { schema }) => chatCompletion({ endpoint, apiKey, model, messages, schema }),
    };
  }

  const [apiKey, cache] = await Promise.all([openRouterKeyItem.getValue(), aiModelsItem.getValue()]);
  if (!apiKey) throw new Error(t('aiNoKey'));
  const model = pin?.model ?? s.aiModel;
  // A model that cannot use tools would reject the research request; it
  // decides from the title and address instead.
  const known = cache?.models.find((m) => m.id === model);
  return {
    provider: 'openrouter',
    model,
    canResearch: known?.tools ?? true,
    budgeted: true,
    language: uiLanguage,
    parallel: parallelFor('openrouter'),
    origin: OPENROUTER_ENDPOINT.origin,
    complete: (messages, { research }) => chatCompletion({ apiKey, model, messages, research }),
  };
}
