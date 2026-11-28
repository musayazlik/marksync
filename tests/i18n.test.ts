import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initI18n, LANGUAGES, languageItem, t, tn, uiLanguage } from '../src/shared/i18n';

type Messages = Record<string, { message: string; description?: string }>;

// Read through Vite, so the test needs no Node type definitions.
const localeFiles = import.meta.glob<Messages>('../src/public/_locales/*/messages.json', {
  eager: true,
  import: 'default',
});
const sources = import.meta.glob<string>(['../src/**/*.ts', '../src/**/*.html'], {
  eager: true,
  query: '?raw',
  import: 'default',
});

const byLang = new Map(
  Object.entries(localeFiles).map(([path, messages]) => [path.split('/').at(-2)!, messages] as const),
);
const languages = [...byLang.keys()];
const load = (lang: string): Messages => byLang.get(lang)!;
const en = load('en');

/** Message keys the code and pages ask for. */
function usedKeys(): Set<string> {
  const keys = new Set<string>(['extName', 'extDescription']);
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="(\w+)"/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/\bt\(\s*'(\w+)'/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/\btn\(\s*'(\w+)'/g)) keys.add(`${m[1]}_one`).add(`${m[1]}_other`);
    // t(cond ? 'a' : 'b')
    for (const m of text.matchAll(/\bt\([^()']*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)) keys.add(m[1]!).add(m[2]!);
    // Keys kept in lookup tables, e.g. the backup reasons in Settings.
    for (const m of text.matchAll(/'(backupReason\w+)'/g)) keys.add(m[1]!);
  }
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{\d\}/g)].map((m) => m[0]).sort();

describe('translations', () => {
  it('ships English, Turkish and German, and offers each of them in Settings', () => {
    expect([...languages].sort()).toEqual(['de', 'en', 'tr']);
    expect(Object.keys(LANGUAGES).sort()).toEqual([...languages].sort());
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it('has every message the code uses', () => {
    const missing = [...usedKeys()].filter((k) => !en[k]);
    expect(missing).toEqual([]);
  });

  it.each(languages)('%s has the same keys and placeholders as English', (lang: string) => {
    const messages = load(lang);
    expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
    for (const [key, { message }] of Object.entries(messages)) {
      expect(message, key).not.toBe('');
      // `$` starts an i18n API placeholder; t() uses {1}, {2} instead.
      expect(message.includes('$'), `${lang}/${key} contains $`).toBe(false);
      // Plural forms may drop the number ("Added 1 bookmark."), so only the
      // other messages must keep exactly the same placeholders.
      if (!key.endsWith('_one')) expect(placeholders(message), `${lang}/${key}`).toEqual(placeholders(en[key]!.message));
    }
  });

  it('keeps the store description within the Chrome Web Store limit', () => {
    for (const lang of languages) expect(load(lang).extDescription!.message.length).toBeLessThanOrEqual(132);
  });
});

describe('language setting', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getUILanguage = (() => 'en-US') as typeof fakeBrowser.i18n.getUILanguage;
    fakeBrowser.i18n.getMessage = ((key: string) => en[key]?.message ?? '') as typeof fakeBrowser.i18n.getMessage;
    // The extension's own messages.json, as fetch() would return it.
    vi.stubGlobal('fetch', async (url: string) => {
      const lang = /_locales\/(\w+)\/messages\.json$/.exec(url)?.[1] ?? '';
      const messages = byLang.get(lang);
      return messages ? new Response(JSON.stringify(messages)) : new Response('', { status: 404 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows the browser until a language is picked', async () => {
    await initI18n();
    expect(uiLanguage()).toBe('en-US');
    expect(t('syncNow')).toBe('Sync now');

    await languageItem.setValue('de');
    await initI18n();
    expect(uiLanguage()).toBe('de');
    expect(t('syncNow')).toBe('Jetzt synchronisieren');
    expect(tn('findCount', 3)).toBe('3 Lesezeichen');
  });

  it('switches when the setting changes, and back to the browser language', async () => {
    const changed = vi.fn();
    await initI18n(changed);
    await languageItem.setValue('tr');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    expect(t('syncNow')).toBe(load('tr').syncNow!.message);

    await languageItem.setValue('auto');
    await vi.waitFor(() => expect(uiLanguage()).toBe('en-US'));
    expect(t('syncNow')).toBe('Sync now');
  });
});
