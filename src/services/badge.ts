import { browser } from 'wxt/browser';
import { errorText, t } from '../shared/i18n';
import type { Settings, Status } from '../shared/state';

/** Amber: sync is paused and waits for a decision (large deletion). */
const PAUSED_COLOR = '#b45309';
/** Red: sync cannot run until something is fixed (sign-in, setup, broken file). */
const ERROR_COLOR = '#b91c1c';

/**
 * What the toolbar icon shows, so a problem is visible without opening the
 * popup. Network errors get no badge: they are usually a laptop going
 * offline and fix themselves on the next check. With sync turned off, a
 * paused deletion waits too, so it gets no badge either (same as the popup).
 */
export function badgeFor(status: Status, settings: Pick<Settings, 'syncEnabled'>): { text: string; color?: string; title: string } {
  const name = t('extName');
  const error = status.connected ? status.error : undefined;
  if (!error || error.code === 'network') return { text: '', title: name };
  if (error.code === 'mass-delete') {
    if (!settings.syncEnabled) return { text: '', title: name };
    return { text: '!', color: PAUSED_COLOR, title: `${name}: ${t('badgePaused')}` };
  }
  // Locked: waiting for the passphrase, not broken.
  if (error.code === 'locked') return { text: '!', color: PAUSED_COLOR, title: `${name}: ${errorText(error)}` };
  return { text: '!', color: ERROR_COLOR, title: `${name}: ${errorText(error)}` };
}

export async function updateBadge(status: Status, settings: Pick<Settings, 'syncEnabled'>): Promise<void> {
  const badge = badgeFor(status, settings);
  await browser.action.setBadgeText({ text: badge.text });
  if (badge.color) await browser.action.setBadgeBackgroundColor({ color: badge.color });
  // White text on the dark badge colours; not every browser has this call.
  if (badge.text) await browser.action.setBadgeTextColor?.({ color: '#ffffff' }).catch(() => undefined);
  await browser.action.setTitle({ title: badge.title });
}
