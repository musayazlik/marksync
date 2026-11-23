import { browser } from 'wxt/browser';
import type { Status } from './state';

/**
 * UI text comes from `src/public/_locales/<lang>/messages.json` and follows
 * the browser's language (English is the fallback).
 *
 * Messages use `{1}`, `{2}`... for values instead of the `$1` placeholders of
 * the i18n API, so a message never needs a `placeholders` block. Messages must
 * therefore not contain a `$` sign.
 */
export function t(key: string, ...values: (string | number)[]): string {
  // WXT types getMessage with the known keys; keys here are checked by tests/i18n.test.ts instead.
  const message = (browser.i18n.getMessage as (name: string) => string)(key);
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
  return t(count === 1 ? `${key}_one` : `${key}_other`, count.toLocaleString(), ...values);
}

/**
 * Fills elements marked in the HTML:
 * `data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`.
 */
export function localizePage(root: ParentNode = document): void {
  document.documentElement.lang = browser.i18n.getUILanguage();
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
        (error.deletions ?? 0).toLocaleString(),
        (error.total ?? 0).toLocaleString(),
      );
    case 'network':
      return t('errNetwork');
    default:
      return error.message;
  }
}
