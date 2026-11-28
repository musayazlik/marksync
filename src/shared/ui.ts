import { locale, t } from './i18n';
import type { Status } from './state';

/** Release notes of every version (GitHub Releases, written by release-please). */
export const RELEASES_URL = 'https://github.com/musayazlik/marksync/releases';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Lets a masked address be shown by click or keyboard (Enter / Space). */
export function revealOnClick(el: HTMLElement, toggle: () => void) {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
}

export function timeAgo(ms: number | undefined): string {
  if (!ms) return t('timeNever');
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return t('timeJustNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('timeMinutesAgo', m);
  const h = Math.round(m / 60);
  if (h < 24) return t('timeHoursAgo', h);
  return new Date(ms).toLocaleString(locale());
}

export function statusTone(s: Status): 'ok' | 'warn' | 'error' | '' {
  if (!s.connected) return '';
  if (s.error?.code === 'mass-delete' || s.error?.code === 'network' || s.error?.code === 'locked') return 'warn';
  if (s.error) return 'error';
  return 'ok';
}

/** Shows a message in the floating error toast, which hides itself again. */
const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export function showToast(el: HTMLElement, message: string) {
  el.textContent = message;
  el.hidden = false;
  // Restart the entrance animation for a new message.
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimers.get(el));
  toastTimers.set(
    el,
    setTimeout(() => (el.hidden = true), 8000),
  );
}

/** Runs an action with the button disabled and a spinner on it; shows errors in the toast. */
export async function withBusy(button: HTMLButtonElement, action: () => Promise<unknown>, errorEl?: HTMLElement) {
  button.disabled = true;
  button.dataset.busy = '';
  button.setAttribute('aria-busy', 'true');
  if (errorEl) errorEl.hidden = true;
  try {
    await action();
  } catch (err) {
    if (errorEl) showToast(errorEl, err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
  }
}

export type EmblemState = 'off' | 'ok' | 'syncing' | 'warn' | 'error';

/** The emblem's state for a sync status. */
export function emblemState(s: Status, syncEnabled = true): EmblemState {
  if (!s.connected || !syncEnabled) return 'off';
  if (s.syncing) return 'syncing';
  const tone = statusTone(s);
  return tone === 'warn' || tone === 'error' ? tone : 'ok';
}

/** Updates the status emblem; the back bookmark settles with a small drop when a sync finishes. */
export function setEmblem(el: Element, state: EmblemState) {
  const html = el as HTMLElement;
  const before = html.dataset.state;
  html.dataset.state = state;
  if (before === 'syncing' && state === 'ok') {
    el.classList.remove('settled');
    void html.getBoundingClientRect();
    el.classList.add('settled');
  }
}
