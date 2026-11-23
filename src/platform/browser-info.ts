import { getSettings } from '../shared/state';
import { t } from '../shared/i18n';

interface Brand {
  brand: string;
}
type Nav = Navigator & { brave?: unknown; userAgentData?: { brands?: Brand[]; platform?: string } };

/**
 * Best guess at the browser name. Chromium browsers name themselves in
 * `userAgentData.brands` (Edge, Opera, Brave, Chrome...); some, like Vivaldi
 * and Arc, look exactly like Chrome. Users can set their own name in Settings.
 */
export function detectBrowser(): string {
  const nav = navigator as Nav;
  const ua = navigator.userAgent;
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  const has = (name: string) => brands.some((b) => b.includes(name));

  let name: string;
  if (/Firefox\//.test(ua)) {
    name = /LibreWolf/.test(ua) ? 'LibreWolf' : /Waterfox/.test(ua) ? 'Waterfox' : 'Firefox';
  } else if (nav.brave || has('Brave')) name = 'Brave';
  else if (has('Microsoft Edge') || /Edg\//.test(ua)) name = 'Edge';
  else if (has('Opera') || /OPR\//.test(ua)) name = 'Opera';
  else if (/Vivaldi/.test(ua)) name = 'Vivaldi';
  else if (/YaBrowser/.test(ua)) name = 'Yandex';
  else if (has('Google Chrome')) name = 'Chrome';
  else name = 'Chromium';

  const platform = nav.userAgentData?.platform || ua;
  const os = /Win/.test(platform)
    ? 'Windows'
    : /Mac/.test(platform)
      ? 'macOS'
      : /Android/.test(platform)
        ? 'Android'
        : /CrOS|Chrome OS/.test(platform)
          ? 'ChromeOS'
          : /Linux/.test(platform)
            ? 'Linux'
            : '';
  return os ? t('deviceLabel', name, os) : name;
}

/** The name shown for this browser in backups and in other browsers' import lists. */
export async function deviceLabel(): Promise<string> {
  return (await getSettings()).deviceName.trim() || detectBrowser();
}
