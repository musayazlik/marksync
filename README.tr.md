<img src="docs/logo.svg" alt="" width="72" height="72">

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
- Google Drive yerine kendi sunucunuz: herhangi bir WebDAV sunucusu (Nextcloud, ownCloud, NAS) aynı şifreleme ve çakışmaya karşı güvenli yazmayla aynı dosyaları tutar
- Yapay zekâ asistanları: `marksync-mcp` sunucusu Claude, Cursor ve diğer MCP istemcilerinin yer imlerinizde arama yapmasını ve Marksync'te onayladığınız değişiklikler önermesini sağlar ([mcp/](mcp/))
- Anlamla arama: hiçbir kelime eşleşmese bile yer imlerini konusuna göre bulun (isteğe bağlı; OpenRouter'da ya da kendi sunucunuzda embedding, indeks Drive üzerinden paylaşılır)
- Yeniden keşfet: günde ya da haftada bir, popup unuttuğunuz birkaç yer imini (bazıları son kaydettiklerinizle ilgili) açmanız, tutmanız, arşivlemeniz ya da silmeniz için getirir; varsayılan kapalı, hiçbir şey tarayıcıdan çıkmaz
- Tarayıcılar arasında eşitlenen etiketler: yapay zekâ önerir, popup'ta düzenlersiniz, popup aramasında `#etiket` ile süzersiniz
- Sürüm geçmişi: herhangi bir yedeği şimdiki yer imlerinizle karşılaştırın (kaldırılan, taşınan, adı değişen, eklenen; klasöre göre), tek bir yer imini ya da klasörü geri getirin, bir yer imini hâlâ içeren yedeği bulun
- Başka tarayıcıdan içe aktarma (Marksync kurulu tarayıcıdan ya da herhangi bir tarayıcının HTML dosyasından), kopyasız birleştirme veya yeni klasöre koyma
- Standart HTML yer imi dosyasına dışa aktarma
- Türkçe ve İngilizce arayüz; eşitleme müdahale gerektirdiğinde araç çubuğu simgesinde uyarı rozeti
- Yinelenen yer imi bulucu: birden fazla kez kaydedilmiş sayfalar (fark yalnızca http/https, sondaki eğik çizgi ya da `utm_` parametreleri olsa bile); her birinden bir kopya tutulur, önce yedek alınır
- Bağlantı denetimi: sayfası kaybolmuş ya da taşınmış yer imlerini bulur; taşınanı yeni adresiyle güncelleyin, kaybolanı [Wayback Machine](https://web.archive.org)'deki kayıtlı kopyasına yönlendirin
- Kendi [OpenRouter](https://openrouter.ai) anahtarınızla isteğe bağlı yapay zekâ düzenlemesi: bir gelen kutusu klasörü seçin, model (varsayılan Claude Opus) oraya eklediğiniz her yer imini araştırır, en uygun klasöre taşır ve sitenin ne olduğunu, ne için kullanıldığını açıklar; her karar Geri al seçeneğiyle bir kayıt sayfasında listelenir
- OpenRouter olmadan ücretsiz ve gizli yapay zekâ düzenlemesi: kendi OpenAI uyumlu sunucunuzu (Ollama, LM Studio, vLLM, llama.cpp) ya da tarayıcının cihaz üzerindeki yerleşik modelini (Chrome 138+, Gemini Nano) kullanın
- Yer imlerini yapay zekâyla adlandırma: klasörleri seçin, yapay zekâ her sayfayı okuyup sitenin ne işe yaradığını anlatan anlaşılır bir başlık önersin; kaydetmeden önce her öneriyi düzenleyin, her değişikliği geri alın
- Tüm kütüphaneyi yapay zekâyla toparlama: aynı anlama gelen klasörleri birleştirme, belirsiz olanları yeniden adlandırma, anlaşılmayan başlıkları temizleme ve boş klasörleri kaldırma; önce maliyet tahmini, incelenebilir bir plan, yedek ve her değişiklik için Geri al
- Yapay zekâ ekleri: OpenRouter'ın tüm model listesinden arayarak seçim (ücretsiz / web araştırması filtreleri, fiyatlar), mevcut bir klasörü önizleme ve onayla toplu düzenleme, aylık harcama sınırı ve popup'ta OpenRouter bakiyesi ile harcamalar
- Popup'tan tüm yer imlerinde anlık arama (başlık, adres, klasör ve yapay zekânın site hakkında öğrendikleri; aksan duyarsız)
- İsteğe bağlı uçtan uca şifreleme: Drive'daki eşitleme dosyası, yedekler ve tarayıcı listeleri yalnızca sizin bildiğiniz bir parolayla şifrelenir (AES-256-GCM, PBKDF2)
- Hesap adresi ekranda gizli görünür (`mu*****7@gmail.com`), tıklayınca açılır

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
- Yapay zekâ düzenlemesi varsayılan olarak kapalıdır. Yalnızca bir tarayıcıda açtığınızda (bu sırada
  `openrouter.ai` ya da kendi sunucunuzun adresi için izin istenir), o tarayıcı gelen kutusuna
  eklediğiniz her yer iminin başlığını ve adresini (sorgu kısmı olmadan) ve klasör adlarınızı o
  sağlayıcıya ve seçtiğiniz modele gönderir. Tarayıcının yerleşik modeliyle hiçbir şey cihazdan
  çıkmaz. API anahtarları o tarayıcının yerel deposunda kalır, Drive'a hiçbir zaman yüklenmez.
- Bağlantı denetimi yalnızca siz başlattığınızda çalışır (bu sırada tüm siteleri açma izni istenir).
  Her yer iminin adresini çerezleriniz olmadan ister, kendi bilgisayarınızdaki veya yerel ağınızdaki
  adresleri hiç açmaz ve kaybolan her sayfanın adresini `archive.org`'da arar.
- Şifreleme açıkken Drive'da yalnızca şifreli dosya içerikleri bulunur. Dosya adları, tarihler, tarayıcı
  adları ve yer imi sayıları (yedek ve içe aktarma listelerinde görünenler) okunabilir kalır. Parola
  tarayıcılarınızdan çıkmaz; her tarayıcı türetilen anahtarı bağlantıyı kesene kadar yerel deposunda tutar.
  Unutulan parola kurtarılamaz: *Parolamı unuttum* şifreli dosyaları siler ve eşitlemeyi yer imlerinizden
  yeniden başlatır; yer imlerinize dokunulmaz.

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

## Ücretsiz ve ücretsiz kalacak

Marksync'in kendine ait bir sunucusu ya da hesabı yok ve böyle kalacak:

- Her şey ücretsiz. Yapay zekâ özellikleri kendi anahtarınızla (OpenRouter), kendi sunucunuzda
  (Ollama, LM Studio, ...) ya da tarayıcının yerleşik modeliyle çalışır; Marksync isteklerinizin
  ücretini ödemez ve onları hiç görmez.
- Ücretli paket, "Pro" özellik ya da barındırılan bir yapay zekâ aracısı yok: bunlar bir sunucu
  gerektirir ve verilerinizin yalnızca tarayıcılarınız, Drive'ınız ve seçtiğiniz yapay zekâ
  sağlayıcısı arasında dolaştığı sözünü bozar.
- Marksync işinize yarıyorsa en çok bir yıldız, bir hata bildirimi, bir çeviri ya da bir pull
  request yardımcı olur.

## Sürümler

Sürümler otomatik çıkar ([CONTRIBUTING.md](CONTRIBUTING.md#releases)). Her sürümün
değişiklikleri [CHANGELOG.md](CHANGELOG.md) dosyasında, mağaza paketleri ise
[GitHub Releases](https://github.com/musayazlik/marksync/releases) sayfasındadır.
