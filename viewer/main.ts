import { decryptJson, isEncryptionInfo, isEnvelope, unlockKey, WrongPassphraseError, type EncryptionInfo } from '../src/core/crypto';
import { Library, ROOT_NAMES, type BookmarkView, type FolderView } from '../src/core/library';
import { sanitizeTagsFile } from '../src/core/tags';
import { ROOT_KEYS, type SyncState } from '../src/core/types';
import { sanitizeRemoteRecords } from '../src/core/validate';
import { DriveClient, DriveError, quote, type DriveCodec } from '../src/platform/drive';
import { t } from './text';
import './style.css';

/**
 * The read-only web viewer (PWA): signs in with Google (drive.file, through
 * Google Identity Services), reads Marksync's files from the user's Drive,
 * decrypts them on this device when encryption is on, and shows the tree
 * with search. No server of our own; nothing is written.
 */

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------- texts ----------

$('#welcome-title').textContent = t('welcomeTitle');
$('#welcome-text').textContent = t('welcomeText');
$('#welcome-privacy').textContent = t('welcomePrivacy');
$('#sign-in').textContent = t('signIn');
$('#sign-out').textContent = t('signOut');
$('#unlock-title').textContent = t('unlockTitle');
$('#unlock-text').textContent = t('unlockText');
$('#unlock-button').textContent = t('unlock');
$<HTMLInputElement>('#find').placeholder = t('search');
$('#find').setAttribute('aria-label', t('search'));
$('#passphrase').setAttribute('aria-label', t('unlockTitle'));

function show(id: 'welcome' | 'unlock' | 'library' | 'none') {
  for (const name of ['welcome', 'unlock', 'library'] as const) $(`#${name}`).hidden = name !== id;
  // On an error screen (wrong account...) the user must be able to sign out and try again.
  $('#sign-out').hidden = id === 'welcome';
}

function message(text: string, tone: 'error' | 'info' = 'info') {
  const box = $('#message');
  box.textContent = text;
  box.className = `notice small ${tone === 'error' ? 'error' : ''}`;
  box.hidden = !text;
}

// ---------- Google sign-in (Google Identity Services) ----------

interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}
interface Gis {
  accounts: { oauth2: { initTokenClient(c: { client_id: string; scope: string; callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void; error_callback?: (e: { type?: string; message?: string }) => void }): TokenClient; revoke(token: string, done?: () => void): void } };
}

let token: { value: string; expiresAt: number } | undefined;
let tokenClient: TokenClient | undefined;
let waiting: ((value: string) => void)[] = [];

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis };
  if (w.google?.accounts) return Promise.resolve(w.google);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => (w.google ? resolve(w.google) : reject(new Error('Google sign-in did not load.')));
    script.onerror = () => reject(new Error(navigator.onLine ? 'Google sign-in did not load.' : t('offline')));
    document.head.append(script);
  });
}

async function signIn(prompt: '' | 'consent' = 'consent'): Promise<string> {
  if (!CLIENT_ID) throw new Error(t('noClient'));
  const gis = await loadGis();
  tokenClient ??= gis.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (r) => {
      if (!r.access_token) {
        message(t('signInFailed', r.error ?? '?'), 'error');
        return;
      }
      token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
      const resolve = waiting;
      waiting = [];
      resolve.forEach((f) => f(r.access_token!));
    },
    error_callback: (e) => message(t('signInFailed', e.message ?? e.type ?? '?'), 'error'),
  });
  return new Promise((resolve) => {
    waiting.push(resolve);
    tokenClient!.requestAccessToken({ prompt });
  });
}

async function getToken(): Promise<string> {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  token = undefined;
  throw new DriveError(401, t('expired'));
}

// ---------- reading the library ----------

let drive = new DriveClient(getToken, async () => undefined);
let folderId = '';
let library: Library | undefined;

async function folder(): Promise<string | undefined> {
  const found = await drive.list(`name = 'Marksync' and mimeType = '${FOLDER_MIME}' and 'root' in parents`);
  return found[0]?.id;
}

async function fileIn(name: string) {
  return (await drive.list(`name = ${quote(name)} and ${quote(folderId)} in parents`, 'createdTime'))[0];
}

let encryptionInfo: EncryptionInfo | undefined;

async function load() {
  message(t('loading'));
  const id = await folder();
  if (!id) {
    message(t('noFolder'), 'error');
    show('none');
    return;
  }
  folderId = id;
  const infoFile = await fileIn('encryption.json');
  if (infoFile) {
    const info = await new DriveClient(getToken, async () => undefined).downloadJson<unknown>(infoFile.id);
    if (isEncryptionInfo(info)) {
      encryptionInfo = info;
      message('');
      show('unlock');
      $<HTMLInputElement>('#passphrase').focus();
      return;
    }
  }
  await read();
}

async function read() {
  const stateFile = await fileIn('sync-state.json');
  if (!stateFile) {
    message(t('noState'), 'error');
    show('none');
    return;
  }
  const state = await drive.downloadJson<SyncState>(stateFile.id);
  if (!state || typeof state !== 'object' || (state.schema !== 1 && state.schema !== 2)) {
    message(t('newer'), 'error');
    return;
  }
  const { records } = sanitizeRemoteRecords(state.records, Date.now());
  const tagsFile = await fileIn('tags.json');
  const tags = tagsFile ? sanitizeTagsFile(await drive.downloadJson<unknown>(tagsFile.id).catch(() => undefined), Date.now()) : {};
  library = new Library(records, tags);
  message('');
  show('library');
  render();
}

$<HTMLFormElement>('#unlock').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#passphrase');
  const button = $<HTMLButtonElement>('#unlock-button');
  if (!encryptionInfo) return;
  button.disabled = true;
  const info = encryptionInfo;
  void unlockKey(input.value, info)
    .then(async (key) => {
      input.value = '';
      // The key lives in this page's memory only.
      const codec: DriveCodec = {
        encode: () => Promise.reject(new Error('read-only')),
        decode: async (stored) => (isEnvelope(stored) ? decryptJson(stored, key, info.keyId) : stored),
      };
      drive = new DriveClient(getToken, async () => undefined, codec);
      await read();
    })
    .catch((err: unknown) => message(err instanceof WrongPassphraseError ? t('wrongPassphrase') : String(err), 'error'))
    .finally(() => (button.disabled = false));
});

// ---------- browsing and search ----------

let current = '';
const find = $<HTMLInputElement>('#find');

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

function bookmarkRow(b: BookmarkView, withFolder: boolean): HTMLLIElement {
  const li = el('li', 'row bookmark');
  const a = el('a');
  a.href = /^https?:/i.test(b.url) ? b.url : '#';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const avatar = el('span', 'avatar', (host(b.url)[0] ?? '•').toUpperCase());
  let h = 0;
  for (const c of host(b.url)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  avatar.style.setProperty('--hue', String(h % 360));
  const text = el('span', 'text');
  text.append(el('span', 'title', b.title || b.url), el('span', 'sub', [host(b.url), withFolder ? b.folder : ''].filter(Boolean).join(' · ')));
  if (b.tags?.length) {
    const tags = el('span', 'tags');
    for (const tag of b.tags) {
      const chip = el('button', 'tag', `#${tag}`);
      chip.type = 'button';
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        find.value = `#${tag.replace(/\s+/g, '-')}`;
        render();
      });
      tags.append(chip);
    }
    text.append(tags);
  }
  a.append(avatar, text);
  li.append(a);
  return li;
}

function folderRow(f: FolderView): HTMLLIElement {
  const li = el('li', 'row folder');
  const b = el('button');
  b.type = 'button';
  b.append(el('span', 'icon', '▸'), el('span', 'text'));
  const text = b.lastElementChild!;
  text.append(el('span', 'title', f.path.split(' / ').at(-1) ?? f.path), el('span', 'sub', t('folders', f.folders, f.bookmarks)));
  b.addEventListener('click', () => {
    current = f.id;
    render();
    window.scrollTo({ top: 0 });
  });
  li.append(b);
  return li;
}

function crumbs() {
  const nav = $('#crumbs');
  nav.replaceChildren();
  const add = (label: string, id: string) => {
    const b = el('button', 'crumb', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      current = id;
      render();
    });
    nav.append(b);
  };
  add(t('all'), '');
  if (!current || !library) return;
  const chain: string[] = [];
  let id = current;
  for (let guard = 0; guard < 300 && id; guard++) {
    chain.unshift(id);
    if ((ROOT_KEYS as readonly string[]).includes(id)) break;
    id = library.records[id]?.parentId ?? '';
  }
  for (const c of chain) add((ROOT_NAMES as Record<string, string>)[c] ?? library.records[c]?.title ?? c, c);
}

function render() {
  if (!library) return;
  const list = $('#list');
  const query = find.value.trim();
  $('#crumbs').hidden = !!query;
  if (query) {
    const { results, total } = library.search(query, 100);
    list.replaceChildren(...results.map((b) => bookmarkRow(b, true)));
    if (!results.length) list.replaceChildren(el('li', 'empty muted', t('none', query)));
    $('#count').textContent = total > results.length ? t('results', results.length, total) : t('count', total);
    return;
  }
  crumbs();
  if (!current) {
    const tops = library.folders().filter((f) => (ROOT_KEYS as readonly string[]).includes(f.id));
    list.replaceChildren(...tops.map(folderRow));
    $('#count').textContent = t('count', library.stats().bookmarks);
    return;
  }
  const here = library.listFolder(current);
  if (!here) {
    current = '';
    render();
    return;
  }
  list.replaceChildren(...here.folders.map(folderRow), ...here.bookmarks.map((b) => bookmarkRow(b, false)));
  if (!here.folders.length && !here.bookmarks.length) list.replaceChildren(el('li', 'empty muted', t('empty')));
  $('#count').textContent = t('folders', here.folders.length, here.bookmarks.length);
}

find.addEventListener('input', render);
window.addEventListener('popstate', () => render());

// ---------- start ----------

$('#sign-in').addEventListener('click', () => {
  message('');
  void signIn('consent')
    .then(load)
    .catch((err: unknown) => message(err instanceof Error ? err.message : String(err), 'error'));
});
$('#sign-out').addEventListener('click', () => {
  // The grant is not revoked: the token simply expires within the hour.
  token = undefined;
  library = undefined;
  encryptionInfo = undefined;
  drive = new DriveClient(getToken, async () => undefined);
  show('welcome');
});

show('welcome');
if (!CLIENT_ID) message(t('noClient'), 'error');
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
