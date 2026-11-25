import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // A fake `browser` (storage, runtime, i18n...) for tests of the services.
  plugins: [WxtVitest()],
  test: { include: ['tests/**/*.test.ts'] },
});
