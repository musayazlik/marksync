/** The viewer's texts: English, and Turkish when the device is set to it. */
const en = {
  welcomeTitle: 'Your bookmarks, on any device',
  welcomeText: 'Browse and search the bookmarks Marksync syncs between your browsers, read straight from your own Google Drive.',
  welcomePrivacy: 'Read-only. Marksync has no server: your bookmarks go only between this device and your Google Drive.',
  signIn: 'Sign in with Google',
  signOut: 'Sign out',
  unlockTitle: 'Encrypted library',
  unlockText: 'Your bookmarks are end-to-end encrypted. Enter your Marksync passphrase; it stays on this device and is forgotten when you close the page.',
  unlock: 'Unlock',
  wrongPassphrase: 'Wrong passphrase.',
  loading: 'Loading your bookmarks…',
  noFolder: 'There is no Marksync folder in this Google Drive yet. Connect the Marksync extension to this Google account first.',
  noState: 'Marksync has not synced to this Drive yet. Let the extension sync once.',
  newer: 'Your library uses a newer format. Reload the page to get the latest viewer.',
  noClient: 'This copy of the viewer has no Google sign-in configured.',
  signInFailed: 'Google sign-in failed: {1}',
  expired: 'Your sign-in expired. Sign in again.',
  search: 'Search titles, addresses, folders, #tags',
  all: 'All bookmarks',
  empty: 'Nothing here.',
  none: 'No bookmark matches “{1}”.',
  count: '{1} bookmarks',
  results: '{1} of {2} results',
  folders: '{1} folders · {2} bookmarks',
  offline: 'You are offline. Connect to load your bookmarks.',
} as const;

const tr: Record<keyof typeof en, string> = {
  welcomeTitle: 'Yer imleriniz her cihazda',
  welcomeText: 'Marksync\'in tarayıcılarınız arasında eşitlediği yer imlerine göz atın ve arayın; doğrudan kendi Google Drive\'ınızdan okunur.',
  welcomePrivacy: 'Salt okunur. Marksync\'in sunucusu yok: yer imleriniz yalnızca bu cihaz ile Google Drive\'ınız arasında dolaşır.',
  signIn: 'Google ile giriş yap',
  signOut: 'Çıkış yap',
  unlockTitle: 'Şifreli kütüphane',
  unlockText: 'Yer imleriniz uçtan uca şifreli. Marksync parolanızı girin; bu cihazda kalır ve sayfayı kapattığınızda unutulur.',
  unlock: 'Kilidi aç',
  wrongPassphrase: 'Parola yanlış.',
  loading: 'Yer imleriniz yükleniyor…',
  noFolder: 'Bu Google Drive\'da henüz Marksync klasörü yok. Önce Marksync eklentisini bu Google hesabına bağlayın.',
  noState: 'Marksync bu Drive ile henüz eşitlenmedi. Eklentinin bir kez eşitlemesini bekleyin.',
  newer: 'Kütüphaneniz daha yeni bir biçim kullanıyor. En son görüntüleyici için sayfayı yenileyin.',
  noClient: 'Görüntüleyicinin bu kopyasında Google girişi ayarlanmamış.',
  signInFailed: 'Google girişi başarısız: {1}',
  expired: 'Oturumunuzun süresi doldu. Yeniden giriş yapın.',
  search: 'Başlık, adres, klasör, #etiket ara',
  all: 'Tüm yer imleri',
  empty: 'Burada bir şey yok.',
  none: '“{1}” ile eşleşen yer imi yok.',
  count: '{1} yer imi',
  results: '{2} sonuçtan {1} tanesi',
  folders: '{1} klasör · {2} yer imi',
  offline: 'Çevrimdışısınız. Yer imlerinizi yüklemek için bağlanın.',
};

const table = navigator.language.toLowerCase().startsWith('tr') ? tr : en;
document.documentElement.lang = table === tr ? 'tr' : 'en';

export function t(key: keyof typeof en, ...values: (string | number)[]): string {
  return table[key].replace(/\{(\d)\}/g, (m, n: string) => String(values[Number(n) - 1] ?? m));
}
