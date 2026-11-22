import type { Status } from './state';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export function timeAgo(ms: number | undefined): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleString();
}

export function statusTone(s: Status): 'ok' | 'warn' | 'error' | '' {
  if (!s.connected) return '';
  if (s.error?.code === 'mass-delete' || s.error?.code === 'network') return 'warn';
  if (s.error) return 'error';
  return 'ok';
}

/** Runs an action with the button disabled; shows errors next to it. */
export async function withBusy(button: HTMLButtonElement, action: () => Promise<unknown>, errorEl?: HTMLElement) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  if (errorEl) errorEl.hidden = true;
  try {
    await action();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
