/** The viewer's texts: English, or Turkish or German when the device is set to it. */
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

const de: Record<keyof typeof en, string> = {
  welcomeTitle: 'Ihre Lesezeichen auf jedem Gerät',
  welcomeText: 'Durchsuchen Sie die Lesezeichen, die Marksync zwischen Ihren Browsern synchronisiert, direkt aus Ihrem eigenen Google Drive gelesen.',
  welcomePrivacy: 'Nur lesen. Marksync hat keinen Server: Ihre Lesezeichen gehen nur zwischen diesem Gerät und Ihrem Google Drive hin und her.',
  signIn: 'Mit Google anmelden',
  signOut: 'Abmelden',
  unlockTitle: 'Verschlüsselte Bibliothek',
  unlockText: 'Ihre Lesezeichen sind Ende-zu-Ende-verschlüsselt. Geben Sie Ihre Marksync-Passphrase ein; sie bleibt auf diesem Gerät und wird vergessen, wenn Sie die Seite schließen.',
  unlock: 'Entsperren',
  wrongPassphrase: 'Falsche Passphrase.',
  loading: 'Ihre Lesezeichen werden geladen…',
  noFolder: 'In diesem Google Drive gibt es noch keinen Marksync-Ordner. Verbinden Sie zuerst die Marksync-Erweiterung mit diesem Google-Konto.',
  noState: 'Marksync hat noch nicht mit diesem Drive synchronisiert. Lassen Sie die Erweiterung einmal synchronisieren.',
  newer: 'Ihre Bibliothek nutzt ein neueres Format. Laden Sie die Seite neu, um den neuesten Viewer zu erhalten.',
  noClient: 'In dieser Kopie des Viewers ist keine Google-Anmeldung eingerichtet.',
  signInFailed: 'Google-Anmeldung fehlgeschlagen: {1}',
  expired: 'Ihre Anmeldung ist abgelaufen. Melden Sie sich erneut an.',
  search: 'Titel, Adressen, Ordner, #Tags suchen',
  all: 'Alle Lesezeichen',
  empty: 'Nichts hier.',
  none: 'Kein Lesezeichen passt zu „{1}“.',
  count: '{1} Lesezeichen',
  results: '{1} von {2} Ergebnissen',
  folders: '{1} Ordner · {2} Lesezeichen',
  offline: 'Sie sind offline. Stellen Sie eine Verbindung her, um Ihre Lesezeichen zu laden.',
};

const tables = { en, tr, de } as const;
/** The first of the device's languages the viewer speaks, English otherwise. */
export const viewerLanguage: keyof typeof tables =
  (navigator.languages?.length ? navigator.languages : [navigator.language])
    .map((l) => l.toLowerCase().split('-')[0])
    .find((l): l is keyof typeof tables => l === 'en' || l === 'tr' || l === 'de') ?? 'en';
const table: Record<keyof typeof en, string> = tables[viewerLanguage];
document.documentElement.lang = viewerLanguage;

export function t(key: keyof typeof en, ...values: (string | number)[]): string {
  return table[key].replace(/\{(\d)\}/g, (m, n: string) => String(values[Number(n) - 1] ?? m));
}
