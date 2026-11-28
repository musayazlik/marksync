import { browser } from 'wxt/browser';
import { storage } from '#imports';
import type { Status } from './state';

/**
 * UI text comes from `src/public/_locales/<lang>/messages.json`. It follows
 * the browser's language unless a language is picked in Settings (English is
 * the fallback for anything missing).
 *
 * Messages use `{1}`, `{2}`... for values instead of the `$1` placeholders of
 * the i18n API, so a message never needs a `placeholders` block. Messages must
 * therefore not contain a `$` sign.
 */

/** The languages Marksync ships, with their names in their own language. */
export const LANGUAGES = { en: 'English', tr: 'Türkçe', de: 'Deutsch' } as const;
export type Language = keyof typeof LANGUAGES;
/** `auto` follows the browser's language. */
export type LanguageChoice = 'auto' | Language;

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && Object.hasOwn(LANGUAGES, value);

/** Per browser, like the other settings; read by every page and the background. */
export const languageItem = storage.defineItem<LanguageChoice>('local:uiLanguage', { fallback: 'auto' });

type Messages = Record<string, { message: string }>;
/** The messages of the language picked in Settings; null = the browser's language. */
let picked: { lang: Language; messages: Messages } | null = null;

async function apply(choice: unknown): Promise<void> {
  if (!isLanguage(choice)) {
    picked = null;
    return;
  }
  if (picked?.lang === choice) return;
  try {
    const url = (browser.runtime.getURL as (path: string) => string)(`/_locales/${choice}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    picked = { lang: choice, messages: (await res.json()) as Messages };
  } catch (err) {
    console.warn('[marksync] could not load language', choice, err);
    picked = null;
  }
}

/**
 * Loads the language picked in Settings. Pages await it before they render;
 * the background calls it at start. `onChange` runs after the choice changes
 * (pages reload, the background refreshes its texts).
 */
export async function initI18n(onChange?: () => void): Promise<void> {
  await apply(await languageItem.getValue());
  if (onChange) {
    languageItem.watch(async (choice) => {
      await apply(choice);
      onChange();
    });
  }
}

/** The language the UI is shown in, e.g. "de" or "en-US" (for AI prompts and `lang`). */
export function uiLanguage(): string {
  return picked?.lang ?? browser.i18n.getUILanguage();
}

/** Locale for numbers and dates: the picked language, else the browser's default. */
export function locale(): string | undefined {
  return picked?.lang;
}

export function t(key: string, ...values: (string | number)[]): string {
  // WXT types getMessage with the known keys; keys here are checked by tests/i18n.test.ts instead.
  const message = picked?.messages[key]?.message || (browser.i18n.getMessage as (name: string) => string)(key);
  if (!message) {
    console.warn('[marksync] missing message', key);
    return key;
  }
  if (!values.length) return message;
  return message.replace(/\{(\d)\}/g, (match, n: string) => {
    const value = values[Number(n) - 1];
    return value === undefined ? match : String(value);
  });
}

/** Picks `<key>_one` or `<key>_other`; `{1}` is the formatted number. */
export function tn(key: string, count: number, ...values: (string | number)[]): string {
  return t(count === 1 ? `${key}_one` : `${key}_other`, count.toLocaleString(locale()), ...values);
}

/**
 * Fills elements marked in the HTML:
 * `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`.
 */
export function localizePage(root: ParentNode = document): void {
  document.documentElement.lang = uiLanguage();
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel!));
  }
}

/** Text for a sync error, shown in the popup, Settings and the toolbar icon's tooltip. */
export function errorText(error: NonNullable<Status['error']>): string {
  switch (error.code) {
    case 'mass-delete':
      return t(
        error.source === 'remote' ? 'massDeleteRemote' : 'massDeleteLocal',
        (error.deletions ?? 0).toLocaleString(locale()),
        (error.total ?? 0).toLocaleString(locale()),
      );
    case 'network':
      return t('errNetwork');
    default:
      return error.message;
  }
}
