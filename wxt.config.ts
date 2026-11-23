import { defineConfig } from 'wxt';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * The Firefox add-on ID decides the OAuth redirect URI Google sends tokens
 * to. A production build must use an ID the publisher owns (an address on a
 * domain you control, or the UUID AMO assigned); a placeholder could be
 * claimed by someone else's add-on.
 */
function geckoId(mode: string): string {
  const id = (import.meta.env.WXT_GECKO_ID ?? '').trim();
  const unowned =
    !id || /@example\.(org|com|net)$/i.test(id) || /\.(invalid|test|example|localhost)$/i.test(id) || /@localhost$/i.test(id);
  if (mode === 'production' && unowned) {
    // CI builds are never released; they may use a clearly unusable ID.
    if (env.MARKSYNC_UNRELEASED_BUILD === '1') return 'marksync-ci@marksync.invalid';
    throw new Error(
      'WXT_GECKO_ID must be a Firefox add-on ID you own (e.g. marksync@yourdomain.com, or the UUID AMO assigned) ' +
        'for production Firefox builds. See docs/GOOGLE_SETUP.md.',
    );
  }
  return id || 'marksync-dev@marksync.invalid';
}

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  manifestVersion: 3,
  zip: {
    // The sources zip goes to Firefox Add-ons reviewers; never ship secrets in it.
    excludeSources: ['.env', '.env.*', '**/*.pem', 'coverage/**'],
  },
  // The manifest is a function so .env values are loaded before it runs.
  manifest: ({ browser, mode }) => ({
    name: 'Marksync',
    description:
      'Keeps your bookmarks identical in Chrome, Brave, Edge and Firefox, with backups in your own Google Drive.',
    permissions: ['bookmarks', 'storage', 'unlimitedStorage', 'alarms', 'identity'],
    host_permissions: [
      'https://www.googleapis.com/*',
      'https://openidconnect.googleapis.com/*',
    ],
    action: {
      default_title: 'Marksync',
      default_icon: {
        16: 'icon/16.png',
        24: 'icon/24.png',
        32: 'icon/32.png',
        64: 'icon/64.png',
      },
    },
    // Development only: a fixed key gives unpacked Chromium builds the same
    // extension ID in Chrome, Brave and Edge. Store builds get their ID from
    // the store and never carry the development key.
    ...(browser !== 'firefox' && mode === 'development' && import.meta.env.WXT_EXTENSION_KEY
      ? { key: import.meta.env.WXT_EXTENSION_KEY }
      : {}),
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: geckoId(mode),
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
