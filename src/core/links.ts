/**
 * Link checker: pure helpers, no browser APIs.
 *
 * A check is one or two HTTP requests to a bookmarked page (see
 * services/links-service.ts). These helpers decide what the answers mean and
 * read the Wayback Machine's availability API. Nothing here changes bookmarks.
 */
import { normalizeUrl } from './dedupe';

/**
 * - `dead`: the page is gone (404/410) or the site cannot be reached at all.
 * - `redirected`: the page answers from another address now.
 * - `unknown`: no clear answer (sign-in needed, blocked, rate-limited, server
 *   errors, timeouts). Never treated as dead.
 * - `ok`: the page answers.
 */
export type LinkStatus = 'ok' | 'dead' | 'redirected' | 'unknown';

/** What one request returned. */
export interface Attempt {
  /** HTTP status of the final response, if any. */
  status?: number;
  /** Address of the final response after redirects. */
  finalUrl?: string;
  /** Set when no response came back. */
  error?: 'timeout' | 'network';
}

/** Why a link got its status, shown to the user. */
export type LinkReason =
  | 'not-found' // 404
  | 'gone' // 410
  | 'unreachable' // no response at all, twice
  | 'moved' // answers from another address
  | 'needs-sign-in' // 401 / 403
  | 'rate-limited' // 429
  | 'server-error' // 5xx
  | 'timeout'
  | 'other-status';

export interface Verdict {
  status: LinkStatus;
  reason?: LinkReason;
  httpStatus?: number;
  /** For `redirected`: where the page is now. */
  finalUrl?: string;
}

/**
 * True when a redirect leads to a different page, not just to the same page
 * with https, a trailing slash or tracking parameters (which is not worth
 * bothering the user about).
 */
export function isMeaningfulRedirect(from: string, to: string | undefined): boolean {
  if (!to || to === from) return false;
  // Sites routinely bounce between example.com and www.example.com.
  const a = normalizeUrl(from)?.replace(/^www\./, '');
  const b = normalizeUrl(to)?.replace(/^www\./, '');
  return !!a && !!b && a !== b;
}

/**
 * The verdict for one bookmark from its request attempts, the last one being
 * the most reliable (callers retry before concluding a page is dead).
 */
export function classify(url: string, attempt: Attempt): Verdict {
  if (attempt.error === 'network') return { status: 'dead', reason: 'unreachable' };
  if (attempt.error === 'timeout') return { status: 'unknown', reason: 'timeout' };
  const s = attempt.status;
  if (s === undefined) return { status: 'unknown', reason: 'other-status' };
  if (s === 404) return { status: 'dead', reason: 'not-found', httpStatus: s };
  if (s === 410) return { status: 'dead', reason: 'gone', httpStatus: s };
  if (s === 401 || s === 403) return { status: 'unknown', reason: 'needs-sign-in', httpStatus: s };
  if (s === 429) return { status: 'unknown', reason: 'rate-limited', httpStatus: s };
  if (s >= 500) return { status: 'unknown', reason: 'server-error', httpStatus: s };
  if (s >= 200 && s < 400) {
    if (isMeaningfulRedirect(url, attempt.finalUrl)) {
      return { status: 'redirected', reason: 'moved', httpStatus: s, finalUrl: attempt.finalUrl };
    }
    return { status: 'ok', httpStatus: s };
  }
  return { status: 'unknown', reason: 'other-status', httpStatus: s };
}

/** HEAD is not allowed everywhere; these answers mean "try GET instead". */
export function shouldRetryWithGet(attempt: Attempt): boolean {
  if (attempt.error === 'network') return true;
  const s = attempt.status;
  return s === 400 || s === 403 || s === 404 || s === 405 || s === 501 || (s !== undefined && s >= 500);
}

/**
 * Addresses that are never checked: anything but http(s), and hosts on this
 * computer or the local network, which say nothing about the web and should
 * not be probed.
 */
export function isCheckable(url: string | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (!host.includes('.') && !host.includes(':')) return false; // intranet names like "nas"
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return false;
    }
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  }
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
  }
  return true;
}

/** The availability API request for a page. */
export function waybackLookupUrl(url: string): string {
  return `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
}

export interface Snapshot {
  url: string;
  /** Milliseconds since the epoch. */
  at?: number;
}

/**
 * Reads the availability API's answer. Returns the closest snapshot that
 * archived a working page, with an https address, or undefined.
 */
export function parseWayback(body: unknown): Snapshot | undefined {
  const closest = (body as { archived_snapshots?: { closest?: Record<string, unknown> } } | null)?.archived_snapshots
    ?.closest;
  if (!closest || closest.available !== true || typeof closest.url !== 'string') return undefined;
  if (typeof closest.status === 'string' && !closest.status.startsWith('2')) return undefined;
  let url: URL;
  try {
    url = new URL(closest.url);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'web.archive.org') return undefined;
  url.protocol = 'https:';
  const ts = typeof closest.timestamp === 'string' ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(closest.timestamp) : null;
  const at = ts ? Date.UTC(+ts[1]!, +ts[2]! - 1, +ts[3]!, +ts[4]!, +ts[5]!, +ts[6]!) : undefined;
  return { url: url.href, ...(at !== undefined ? { at } : {}) };
}

/** Host of an address, for running at most one check per site at a time. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The part of a bookmark tree node the checker reads (matches BookmarkNode). */
export interface LinkTreeNode {
  id: string;
  title: string;
  url?: string;
  type?: string;
  unmodifiable?: string;
  children?: LinkTreeNode[];
}

export interface CheckableBookmark {
  id: string;
  title: string;
  url: string;
  /** "Bookmarks bar / Work" — the folder the bookmark is in. */
  folderPath: string;
}

/**
 * Every bookmark worth checking, in tree order. Folders in `exclude` (Opera's
 * Trash and Speed Dial) and managed bookmarks are skipped, and so are
 * addresses `isCheckable` refuses.
 */
export function listCheckable(tree: LinkTreeNode[], opts: { exclude?: Iterable<string> } = {}): CheckableBookmark[] {
  const exclude = new Set(opts.exclude ?? []);
  const out: CheckableBookmark[] = [];
  const walk = (node: LinkTreeNode, path: string[]) => {
    for (const child of node.children ?? []) {
      if (exclude.has(child.id) || child.unmodifiable || child.type === 'separator') continue;
      const folder = child.type ? child.type === 'folder' : child.url === undefined;
      if (folder) walk(child, [...path, child.title.trim() || '(untitled)']);
      else if (isCheckable(child.url)) {
        out.push({ id: child.id, title: child.title, url: child.url!, folderPath: path.join(' / ') });
      }
    }
  };
  for (const root of tree) walk(root, []);
  return out;
}
