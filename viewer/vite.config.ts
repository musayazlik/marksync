import { defineConfig } from 'vite';

/**
 * The web viewer (viewer/): a static site, e.g. on GitHub Pages. Built from
 * the repository root (`pnpm build:viewer`), so paths are relative to it.
 * VITE_GOOGLE_CLIENT_ID: a "Web application" OAuth client in the same Google
 * Cloud project as the extension, with the site's origin as an authorized
 * JavaScript origin.
 */
export default defineConfig({
  root: 'viewer',
  base: './',
  // .env files at the repository root.
  envDir: '..',
  publicDir: 'public',
  build: {
    outDir: '../.output/viewer',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      // The viewer, and the invitation page of shared folders.
      input: { main: 'viewer/index.html', join: 'viewer/join.html' },
    },
  },
});
