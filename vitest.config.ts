import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // A fake `browser` (storage, runtime, i18n...) for tests of the services.
  plugins: [WxtVitest()],
  // PBKDF2 and the sync scenarios can be slow on busy CI runners.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15_000 },
});
