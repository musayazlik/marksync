# Marksync

[![CI](https://github.com/musayazlik/marksync/actions/workflows/ci.yml/badge.svg)](https://github.com/musayazlik/marksync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/musayazlik/marksync)](https://github.com/musayazlik/marksync/releases)

**Chrome, Brave, Edge ve Firefox** arasında yer imlerini eşitleyen, yedekleri
**kendi Google Drive'ınızda** tutan açık kaynak eklenti.

Brave'de bir yer imi ekleyin, Firefox'u açın: aynı klasörde, aynı sırada
oradadır. Üçüncü taraf bir sunucu yoktur; her şey Google Drive'ınızdaki
`Marksync` klasöründe durur ve eklenti Drive'daki başka hiçbir dosyayı göremez.

## Özellikler

- Chromium tarayıcılar ve Firefox arasında çift yönlü eşitleme, istediğiniz kadar bilgisayarda
- Yer imleri çubuğu, Diğer yer imleri, Mobil ve Firefox'un Yer İmleri Menüsü tarayıcılar arasında eşleşir
- Alan bazında çakışma çözümü: bir tarayıcıda yeniden adlandırma, diğerinde taşıma; ikisi de korunur
- Aynı yer imleri zaten olan bir tarayıcı bağlandığında kopya oluşmaz
- Bir eşitleme yer imlerinin çoğunu silecekse durur ve onay ister
- Google Drive'a otomatik ve elle yedekleme, tek tıkla geri yükleme
- Başka tarayıcıdan içe aktarma (Marksync kurulu tarayıcıdan ya da herhangi bir tarayıcının HTML dosyasından), kopyasız birleştirme veya yeni klasöre koyma
- Standart HTML yer imi dosyasına dışa aktarma
- Türkçe ve İngilizce arayüz; eşitleme müdahale gerektirdiğinde araç çubuğu simgesinde uyarı rozeti

## Desteklenen tarayıcılar

| Tarayıcı | Nereden kurulur | Not |
|---|---|---|
| Chrome, Brave, Vivaldi, Arc, Yandex ve diğer Chromium tarayıcılar | Chrome Web Store | Google hesabıyla giriş yapılmış Chrome'da hem hesaptaki hem "sadece bu cihazda" duran yer imleri senkronlanır |
| Microsoft Edge | Edge Eklentileri veya Chrome Web Store | |
| Opera | Opera Eklentileri veya Chrome Web Store | "Sıralanmamış yer imleri" Diğer yer imleri olarak senkronlanır; Çöp kutusu ve Hızlı Arama senkronlanmaz |
| Firefox, LibreWolf, Waterfox, Zen, Floorp (masaüstü) | Firefox Eklentileri | Yer İmleri Menüsü, Chromium tarayıcılarda "Bookmarks Menu" klasörü olarak görünür |
| Safari | mümkün değil | Safari eklentilerinde yer imi API'si yok. Safari'den HTML dışa aktarıp başka tarayıcıda içe aktarın |
| Mobil tarayıcılar | mümkün değil | Android ve iOS'ta eklentiler için yer imi API'si yok |

## Gizlilik

- İstenen Google izinleri: `drive.file` (yalnızca Marksync'in oluşturduğu dosyalar), `openid`, `email`.
- Yer imleri tarayıcıdan doğrudan Google Drive'a gider; Marksync'in sunucusu yoktur.
- Erişim token'ı oturum deposunda tutulur ve tarayıcı kapanınca silinir.
- *Disconnect* yalnızca tıkladığınız tarayıcının bağlantısını keser; diğer tarayıcılarınız bağlı kalır.
  Marksync'in erişimini her yerden kaldırmak için https://myaccount.google.com/permissions adresini kullanın.

## Geliştirme

```sh
pnpm install
cp .env.example .env      # Google OAuth client ID'nizi ekleyin (docs/GOOGLE_SETUP.md)
pnpm dev                  # Chrome
pnpm dev:firefox          # Firefox
pnpm test
pnpm build:all            # chrome, firefox, edge, opera
pnpm zip:all              # mağaza paketleri
```

Ayrıntılar için [README.md](README.md) ve [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sürümler

Sürümler otomatik çıkar ([CONTRIBUTING.md](CONTRIBUTING.md#releases)). Her sürümün
değişiklikleri [CHANGELOG.md](CHANGELOG.md) dosyasında, mağaza paketleri ise
[GitHub Releases](https://github.com/musayazlik/marksync/releases) sayfasındadır.
