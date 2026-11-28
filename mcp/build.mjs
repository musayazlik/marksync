// Bundles the server (and the parts of the extension's core it reuses) into one file.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // The MCP SDK and zod are installed as dependencies, not bundled.
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
});
console.log(`Built dist/index.js (marksync-mcp ${pkg.version}).`);
