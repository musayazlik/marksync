import { describe, expect, it } from 'vitest';

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
  it('ships English and Turkish', () => {
    expect([...languages].sort()).toEqual(['en', 'tr']);
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
