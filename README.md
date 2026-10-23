# Finans — Personal Finance Tracker

**English:** Finans is an open-source personal finance app for tracking bank accounts, credit cards, loans, budgets, a payment calendar and a debt payoff plan. It imports bank and card statements (Excel, PDF, CSV), runs as a desktop app (macOS, Windows, Linux) that keeps data on your computer, or as a web app on your own server (Docker), with optional accounts to move your data between them. The interface is available in Turkish and English (Settings → Appearance → Language).

- **Download:** [latest release](https://github.com/ybrzcn/Personal-Finance-Tracker/releases/latest) — macOS (Universal), Windows (x64 / x86 / ARM64, installer or portable), Linux (AppImage, .deb, .rpm, tarball; x86_64 / ARM64). Builds are not code-signed yet: on macOS right-click → Open on first launch; on Windows choose "More info → Run anyway".
- **Self-host:** see [Self-host](#self-host) below.
- **Updates:** from 1.18.0 on, the desktop app checks for new releases and installs them in place (macOS, Windows installer, Linux AppImage); portable, MSI and .deb/.rpm installs get a notice with a download link.
- **Build from source:** Node 20+, Rust (stable), then `npm ci && npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'` (release builds sign update packages and need the project's updater key).
- **License:** [MIT](LICENSE). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md); security issues: [SECURITY.md](SECURITY.md).

### Self-host

```bash
# docker-compose.yml, .env.example and docker/postgres-init.sh from this repo
cp .env.example .env                            # set both passwords (letters and digits only, e.g. `openssl rand -hex 24`)
docker compose pull && docker compose up -d     # ghcr.io/ybrzcn/personal-finance-tracker + PostgreSQL 17, listens on 127.0.0.1:8787
```

Data is stored in PostgreSQL (one schema, rows isolated per user with row-level security). To keep the simpler file-based SQLite storage, delete the `FINANS_DATABASE_URL` line and the `db` service from the compose file.

**Upgrading an existing install (1.0.x):** earlier versions stored data in SQLite. Postgres is the new default and existing data is **not** migrated automatically. To keep your data, remove the `FINANS_DATABASE_URL` line and the `db` service before `docker compose up -d`. To move to Postgres, users export a JSON backup in the app first and restore it into their new account.

**Foreign currency and gold accounts:** bank and cash accounts can be held in a foreign currency, in gold/silver by the gram or in gold coins; their TRY value is shown at the current buying rate. Rates come from the Central Bank of Turkey (currencies) and Harem Altın (gold and silver; an unofficial feed — if it is unreachable the last price is shown and rates can always be entered by hand). Rate history is kept only on a Postgres server; the SQLite server and the desktop app fetch rates live and do not store them.

**Investment funds:** Turkish mutual funds and exchange-traded funds listed on TEFAS can be held as separate accounts counted in shares. Buying and selling are entered as transfers from a TRY account; prices come from TEFAS once a day, and profit/loss and the inflation comparison work as for currencies and gold. The price source is the service the TEFAS website itself uses; it is unofficial and undocumented and accepts only a few requests per minute. Not available in the browser-only mode.

**Net worth history:** On the Accounts page, net worth (assets − card, loan and overdraft debt) at every month end. Foreign currency, gold and funds are valued at today's price, with a second line at cost; the gap is the currency/price gain. Total, assets vs. debts, and per-kind/per-account views; 1 year / 3 years / All. Computed in Rust; not available in the browser-only mode.

**Savings goals:** Set a target amount (TRY, foreign currency or gold) and an optional date, then link the accounts you save in. The app shows progress, how much you need to save per month, your pace over the last 3 months and when you will reach the goal at that pace. Each account belongs to one goal; the nearest goals appear on the Overview. (Requires the server or desktop app.)

**Tags:** Add tags to transactions independent of categories (e.g. "Holiday 2026", "Business expense"); a transaction can have several. Filter by tag on the Transactions page and add/remove tags on many transactions at once. The Tags page shows net spending per tag (refunds deducted), a category breakdown, the monthly trend and an optional total budget. (Requires the server or desktop app.)

**Account summaries:** Card statements, loan schedules, overdraft and FX values are computed by the same Rust code on desktop and server, so the figures match everywhere.

**Budget:** Category budgets, matching of recurring income and expenses, assigning card spending to the month of the salary that pays it, and expected income are computed by the same Rust code on desktop and server. (Requires the server or desktop app.)

**Payment calendar:** Which salary pays each card statement, loan installment and recurring payment, plus the period's already paid statements and received income, is computed by the same Rust code on desktop and server. (Requires the server or desktop app.)

**End-to-end encrypted sync:** with data kept on the device, desktop and mobile apps can sync through the server end-to-end encrypted (Settings → Şifreli eşitleme). Data is encrypted on the device with a key protected by a separate sync passphrase (Argon2id, XChaCha20-Poly1305); the server stores only ciphertext and never sees the passphrase. Changes from several devices are merged record by record; attachments are synced as separate encrypted files. The web interface cannot read this data.

**Profit/loss:** the Kâr/Zarar page shows, for each foreign currency and gold account, the weighted average cost, current value and unrealised profit/loss, plus realised profit/loss for every sale or foreign-currency expense with a monthly chart. Buying and selling are entered as transfers. With a free TCMB EVDS API key (evds3.tcmb.gov.tr → sign up → Profile → API key) it also compares returns with consumer price inflation (TÜFE): set `FINANS_EVDS_KEY` in `.env` on the server (Postgres stores the series), or enter the key under Settings in the desktop app (kept only on that device).

Put it behind HTTPS (Cloudflare Tunnel, Caddy, nginx). The server serves the web app and `/api`; the landing page offers the desktop downloads. Configuration (environment variables) is documented in the Turkish section [Sunucu (self-host)](#sunucu-self-host).

---

**Türkçe:** Banka hesapları, kredi kartları, krediler, bütçe, ödeme takvimi ve borç planı için açık kaynak kişisel finans uygulaması. Masaüstünde (macOS, Windows, Linux) veriler yalnız bilgisayarında kalır; istersen kendi sunucunda web uygulaması olarak da çalışır ve hesabınla verini taşıyabilirsin.

**Teknolojiler:** Tauri 2 (Rust) · React 18 · Vite · TypeScript · Tailwind CSS · Lucide · Recharts · SQLite (rusqlite, gömülü) · axum + PostgreSQL (sunucu)

---

## Özellikler

- **Dashboard:** Toplam Gelir / Gider / Net Bakiye kartları (Bu Ay · Son 30 Gün · Tümü), bu ayın kategori bazlı harcama halkası, son 30 günün kategori çubuk grafiği, son 6 ayın gelir-gider karşılaştırması, son 10 işlem, yaklaşan kart ödemeleri (30 gün). İstatistikler (dönem toplamları, harcama dağılımı, son 6 ay) masaüstünde ve sunucuda aynı Rust kodunda hesaplanır.
- **Hesaplar:** Vadesiz hesap (isteğe bağlı KMH limiti ve faiz oranı), nakit ve kredi kartları. Kartlarda kesim / son ödeme günü, limit, aylık akdi faiz, asgari ödeme oranı; ekstre borcu, son ödeme tarihi, asgari tutar ve ödeme durumu işlemlerden otomatik hesaplanır. Taksitli harcamalar ekstrelere bölünür. Kart tanımlanırken yalnızca "son ekstre ödendi mi?" sorulur; borç, karta girilen harcamalardan hesaplanır. Eski taksitli alışverişler alış tarihi ve toplam taksit sayısıyla girilir, takip başlangıcından önceki ekstrelere düşen taksitler ödenmiş sayılır. Kart ödemesi ve hesaplar arası para aktarımı **transfer** olarak girilir (gider sayılmaz).
- **Döviz ve altın hesapları:** Vadesiz hesap ve nakit; döviz (TCMB'nin yayımladığı 21 para birimi), gram altın/gümüş (has, külçe, 22 ve 14 ayar) ya da ziynet altın (çeyrek, yarım, tam, Ata, beşli, gremse; yeni/eski) olarak tutulabilir. Bakiye kendi biriminde, TL karşılığı güncel alış kuruyla gösterilir ve net servete eklenir. Dövizli gelir, gider ve transferde kur (döviz alımında satış, diğerlerinde alış) kendiliğinden gelir ve değiştirilebilir; geçmiş tarihli işlemde o günün TCMB kuru kullanılır. **Kurlar** sayfasında alış, satış, günlük değişim ve geçmiş grafiği bulunur. Kaynaklar: dövizde TCMB (iş günü 15:30), altın ve gümüşte Harem Altın (resmî olmayan akış; ulaşılamazsa son fiyat gösterilir, kur her zaman elle girilebilir).
- **Yatırım fonları:** TEFAS'taki yatırım fonları ve borsa yatırım fonları (BYF) ayrı hesaplar olarak tutulur (birim: pay). Hesap formunda "Yatırım fonu" seçilip fon kodu ya da adıyla aranır. Alım-satım TL hesabından transferle girilir (pay adedi ve fiyat; fiyat o günün TEFAS fiyatıyla gelir). Fiyat TEFAS'tan günde bir alınır; **Kurlar** sayfasında "Fonlarım" altında son fiyat, günlük değişim ve 3 aylık grafik bulunur. Kâr/zarar ve enflasyon karşılaştırması döviz/altınla aynı çalışır. Fiyat kaynağı TEFAS sitesinin kullandığı servistir; resmî ve belgelenmiş değildir, dakikada en çok birkaç istek kabul eder (ulaşılamazsa son fiyat "eski" uyarısıyla gösterilir).
- **Net servet geçmişi:** Hesaplar sayfasında her ay sonundaki net servet (varlıklar − kart, kredi ve KMH borcu). Döviz, altın ve fonlar bugünkü fiyatla değerlenir; yanında maliyetle değer çizilir, aradaki fark kur/fiyat kazancıdır. Toplam, varlık ve borç, tür ve hesap kırılımı görünümleri; 1 yıl / 3 yıl / Tümü. Hesaplar sayfasındaki kutular da aynı hesaptan gelir; ileri tarihli kart ve kredi işlemleri tarihi gelince sayılır. Hesap Rust'ta yapılır.
- **Birikim hedefleri:** Hedef tutarı (TL, döviz ya da altın) ve isteğe bağlı tarih koy, biriktirdiğin hesapları bağla. Uygulama ilerlemeyi, ayda ne kadar biriktirmen gerektiğini, son 3 ayın hızını ve bu hızla hedefe ne zaman ulaşacağını gösterir. Her hesap bir hedefe bağlanır; Genel Bakış'ta en yakın hedefler görünür.
- **Etiketler:** İşlemlere kategoriden bağımsız etiketler ekle (ör. "Tatil 2026", "İş masrafı"); bir işlem birden çok etiket taşıyabilir. İşlemler sayfasında etikete göre süz, birden çok işlemi seçip toplu etiket ekle/kaldır. Etiketler sayfası etiket başına net harcamayı (iadeler düşülür), kategori kırılımını, aylık seyri ve isteğe bağlı toplam bütçenin durumunu gösterir.
- **Hesap özetleri:** Kart ekstreleri, kredi ödeme planı, KMH ve döviz değeri masaüstünde ve sunucuda aynı Rust kodunda hesaplanır; rakamlar her yerde aynıdır. Form önizlemeleri (nakit avans planı, taksitlerin düşeceği ekstreler, kart kesim tarihleri, kredi taksit önerisi, döviz karşılığı, nakit eksi uyarısı) de Rust'ta hesaplanır.
- **Bütçe:** Kategori bütçeleri, düzenli gelir/gider eşleştirmesi, kart harcamalarının ödeyecek maaşın ayına yazılması ve beklenen gelir masaüstünde ve sunucuda aynı Rust kodunda hesaplanır.
- **Ödeme takvimi:** Kart ekstreleri, kredi taksitleri ve düzenli ödemelerin hangi maaştan karşılanacağı, dönemin ödenmiş ekstreleri ve yatmış gelirleri masaüstünde ve sunucuda aynı Rust kodunda hesaplanır.
- **Mevduat, BES ve diğer varlıklar:** Vadeli mevduatta yıllık brüt faiz, stopaj ve vade girilir; kart dönemin brüt/net faizini, işleyen faizi ve vade sonu tutarını gösterir, vade dolunca net faiz tek tıkla "Yatırım" geliri olarak kaydedilip mevduat yenilenir ya da vadesize çevrilir. BES'te katkılar transferle, güncel fon değeri elle girilir; ev, araba gibi varlıklar alış bedeliyle eklenip değeri elle güncellenir. Bunlar net servete ve varlık dağılımına girer, ödeme takviminde harcanabilir nakit sayılmaz.
- **Belgeler:** İşleme fiş, fatura gibi belgeler (fotoğraf ya da PDF, en çok 10 MB, işlem başına 10) eklenir; telefonda kamerayla çekilebilir. Metni olan PDF'teki genel toplam ve tarih işleme öneri olarak gelir (fotoğraftan metin okunmaz). Belgeler veritabanında saklanır; JSON yedek içermez, masaüstünün veritabanı yedeği içerir.
- **Giriş güvenliği (sunucu):** Ayarlar → Giriş güvenliği'nden iki aşamalı doğrulama açılır: QR kodu doğrulama uygulamasına (Google Authenticator, 1Password vb.) okutulur, girişte şifreden sonra 6 haneli kod istenir. Web'de passkey eklenip şifre yazmadan parmak izi, yüz ya da cihaz PIN'iyle girilir (passkey sunucunun alan adına bağlıdır; https ve alan adı gerekir, masaüstü ve mobil uygulamada kod kullanılır). Telefon kaybolursa kurtarma koduyla yeni şifre belirlenir; iki aşamalı doğrulama kapanır ve passkey'ler silinir. Passkey isteğin `Host` başlığındaki alan adına bağlanır: Caddy ve Cloudflare Tunnel bunu korur, nginx'te `proxy_set_header Host $host;` gerekir.
- **Şifreli eşitleme (masaüstü ve mobil):** Veri bu cihazdayken Ayarlar → Şifreli eşitleme'den açılır; veriler cihazda şifrelenip sunucuya öyle gider, sunucu içeriği okuyamaz. Veri anahtarı ayrı bir eşitleme parolasıyla korunur (Argon2id; veri XChaCha20-Poly1305), parola sunucuya gitmez. Öbür cihaz aynı parolayla bağlanır: yerel veri ya sunucudakiyle değiştirilir (önce yedeklenir) ya da birleştirilir. Eşitleme açılışta, pencere öne gelince ve dakikada bir arka planda yapılır; değişiklikler kayıt kayıt birleştirilir (iki cihazda aynı kayıt değiştiyse son eşitleyen cihazınki kalır, bir cihazda silinip öbüründe değiştirilen kayıt korunur). Belge ekleri ayrı şifreli dosyalar olarak eşitlenir. Parola bağlı bir cihazdan değiştirilebilir; unutulur ve hiçbir cihaz bağlı kalmazsa sunucudaki kopya açılamaz (cihazlardaki veri yerinde kalır), hesap şifresiyle silinip yeniden açılır. Web arayüzü bu veriyi göremez.
- **Dil:** Arayüz Türkçe ve İngilizce; Ayarlar → Görünüm → Dil'den cihaz başına seçilir (varsayılan Türkçe). Tarih ve sayılar seçili dile göre biçimlenir; sunucudan ve hesaplama katmanından gelen hata mesajları da çevrilir. Kullanıcı verisi (kategori, hesap adları) çevrilmez.
- **Raporlar:** Dönem seç (bu ay, geçen ay, bu yıl, geçen yıl, son 12 ay ya da özel aralık); gider ya da geliri kategori, hesap veya etikete göre kır, önceki dönemle ya da geçen yılın aynı dönemiyle karşılaştır (tutar ve yüzde değişim), aylık seyri ve gelirin giderlere ve birikime akışını (Sankey) gör. Harcama tarihine göre; taksitler kendi aylarına düşer, transferler sayılmaz.
- **Kâr/Zarar:** Döviz, altın ve fon hesaplarında ağırlıklı ortalama maliyet, güncel değer ve kâğıt üstü kâr/zarar; her satışın ve dövizle yapılan giderin gerçekleşen kâr/zararı, aylık grafikle. Alım ve satım transfer olarak girilir; açılış bakiyesinin maliyeti hesap formunda girilebilir (boşsa açılış günü kuru). TCMB EVDS anahtarı verilirse getiri TÜFE ile karşılaştırılır (reel kâr/zarar): anahtar evds3.tcmb.gov.tr'de ücretsiz üyelikle Profil → API Anahtarı'ndan alınır; sunucuda `.env`'deki `FINANS_EVDS_KEY`'e, masaüstünde Ayarlar'a girilir (yalnız o cihazda saklanır). Faiz, temettü ve fon dağıtımı seçilen gelir kategorilerinden (varsayılan "Yatırım") yatırım geliri olarak sayılır; toplam kazanç kâğıt üstü + gerçekleşen + yatırım gelirini gösterir. Varlık dağılımı TL, döviz, altın/gümüş ve fon paylarını gösterir.
- **Krediler:** Kalan anapara, aylık faiz, KKDF+BSMV, kalan vade ve sonraki taksit tarihiyle ödeme planı; "Taksit öde" anaparayı krediye transfer, faizi "Faiz ve Masraflar" gideri olarak kaydeder.
- **Bütçe:** Gider kategorilerine aylık limit (ilerleme çubuğu, aşım uyarısı), düzenli gelirler (maaş günü) ve düzenli giderler (kira, fatura, abonelik). İstenen düzenli kayıt günü gelince işlem olarak kendiliğinden kaydedilir (ödeme o günlerde elle girildiyse eklenmez; eklenemezse uyarılır). İstenen kategoride bütçe devreder: artan para sonraki ayın payına eklenir, aşım düşülür. Plan özeti henüz bir işe atanmamış parayı gösterir (sıfır tabanlı bütçe).
- **Ödeme Takvimi:** Önümüzdeki 1/3/6 ayın kart ekstreleri (kesilmemişler tahmini), kredi taksitleri ve düzenli giderleri; her ödeme son ödeme tarihinden önce yatan son gelire yazılır (hesap bazında elle seçilebilir), gelir başına "kalan" gösterilir.
- **Analiz:** Abonelikler kategorisinden otomatik bulunan aboneliklerin aylık / yıllık maliyeti (ad, sıklık, iptal düzeltilebilir) ve seçili değişken gider kategorileri (varsayılan Eğlence, Restoran, Kafe, Market) için aylık / yıllık harcama tahmini ve ay sonu beklentisi. Hesap Rust'ta yapılır.
- **Borç Planı:** Aylık ayrılabilecek tutara göre Çığ / Kartopu / kendi sıranız / yalnız asgari stratejilerinin simülasyonu; toplam faiz, kapanma tarihi ve aylık ödeme tablosu. Hesap masaüstünde ve sunucuda aynı Rust kodunda yapılır.
- **Uzun Vade:** Bugünkü net servetten 5–30 yıl sonrasına aylık tahmin: düzenli gelir ve giderler, kategori limitleri, son ayların düzensiz gider ortalaması ve kredi taksitleri; yıllık zam, enflasyon, getiri ve aylık ek tutar varsayımları. Yıllık tablo, bugünün parasıyla değer, kredinin bittiği ay ve nakdin eksiye düştüğü ay uyarısı.
- **Ekstre içe aktarma:** Bankadan indirilen Excel (XLSX/XLS/ODS), PDF veya CSV/TXT hesap hareketi ya da kart ekstresi (PDF'te tarihle başlayan satırlar okunur; şifreli ve taranmış PDF desteklenmez); sütunlar otomatik tanınır, kategoriler geçmiş işlemlere ve bilinen işyerlerine göre önerilir, mükerrer kayıtlar ve kart ödemeleri işaretlenir. Dosya en çok 25 MB, tablo en çok 20.000 satır olabilir. Okuma, eşleştirme ve kategori önerileri Rust'ta yapılır.
- **İşlemler:** Ekleme / düzenleme / silme; açıklama-kategori-tutar araması, tür, kategori ve tarih aralığı filtreleri (hazır aralıklar dahil), tarih/tutar sıralama, filtrelenmiş sonucu CSV'ye aktarma.
- **Kategoriler:** Varsayılan gelir/gider kategorileri, renk seçimli ekleme / düzenleme / silme. Silinen kategorinin işlemleri silinmez, "Kategorisiz" kalır.
- **Yedekleme:** JSON yedek alma ve geri yükleme (atomik — hata olursa hiçbir veri değişmez), CSV dışa / içe aktarma (Excel uyumlu `;` ayırıcı, UTF-8 BOM). Eski (v1) yedekler geri yüklenince tüm işlemler "Genel Hesap"a atanır.
- **Güncelleme:** Masaüstü uygulaması açıkken yeni sürümü kendisi denetler (açılışta ve 6 saatte bir) ve sağ altta bildirir; "Güncelle ve yeniden başlat" imzası doğrulanan paketi indirip kurar. macOS, Windows kurulumu ve Linux AppImage kendini günceller; taşınabilir, MSI ve .deb/.rpm kurulumlarında indirme sayfası açılır. Ayarlar → Güncellemeler'den elle de denetlenir.
- **Masaüstü deneyimi:** Sistem temasını otomatik algılama + Açık/Koyu tema, macOS'ta modern overlay başlık çubuğu, Windows'ta native pencere kontrolleri, `⌘/Ctrl + N` yeni işlem, `⌘/Ctrl + 1-9` sayfa geçişi, macOS'ta standart `⌘Q` / `⌘W` menüsü.

## Verilerin saklandığı yer

| Platform | Konum |
| --- | --- |
| macOS | `~/Library/Application Support/com.ybrzcn.finans/finans.db` |
| Windows | `%APPDATA%\com.ybrzcn.finans\finans.db` |
| Linux | `~/.local/share/com.ybrzcn.finans/finans.db` |

Konum uygulama içinde **Ayarlar → Veri Konumu** bölümünde de görünür ve klasör tek tıkla açılabilir.

---

## Mac'te hızlı başlangıç

```bash
xcode-select --install                                            # C/C++ derleyici (bir kez)
brew install node                                                 # veya nodejs.org'dan .pkg kurulumu
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # Rust (Enter → varsayılan kurulum)
source "$HOME/.cargo/env"                                         # ya da terminali yeniden açın

cd finans
npm install           # bağımlılıklar + ikonlar
npm run tauri dev     # uygulamayı geliştirme modunda açar (ilk derleme birkaç dk)
npm run build:mac     # .app + .dmg → src-tauri/target/release/bundle/
```

### Test kontrol listesi

- [ ] Uygulama açılınca giriş ekranı olmadan doğrudan Genel Bakış geliyor
- [ ] Gelir / gider ekle, düzenle (çift tık veya kalem), sil
- [ ] İşlemler sayfasında arama, tür, kategori, tarih aralığı filtreleri
- [ ] Kategori ekle / düzenle / sil (silinen kategorinin işlemleri "Kategorisiz" kalır)
- [ ] Dashboard kartları ve grafikler eklenen verilerle güncelleniyor
- [ ] Ayarlar → JSON yedek al → bir işlem sil → yedeği geri yükle → işlem geri geldi
- [ ] CSV dışa aktar → Numbers / Excel'de Türkçe karakterler doğru görünüyor → CSV içe aktar
- [ ] Tema: Sistem / Açık / Koyu; macOS görünümü değiştirince "Sistem" modu otomatik uyuyor
- [ ] Hesaplar → kredi kartı ekle (ör. kesim 23, son ödeme 3) → önizleme "son ödeme" tarihini ertesi ayın 3'ü gösteriyor
- [ ] Kartı ekle → "Harcama" ile 5 ay önceki 12 taksitli alışverişi gir → form "5/12 taksit ödenmiş sayılır" diyor, kalan 7 taksit Ödeme Takvimi'nde aylara dağılıyor
- [ ] Karta 3 taksitli harcama gir → İşlemler'de "3 taksit" rozeti, kart kartında dönem içi harcama taksit tutarı kadar
- [ ] Kartta "Ödeme yap" → vadesiz hesaptan transfer; Genel Bakış'taki gider toplamı değişmiyor, kart durumu "Ödendi"
- [ ] Eski sürümden gelen veriler "Genel Hesap" altında görünüyor; `finans.db.v1.bak` dosyası oluştu
- [ ] Bütçe → Düzenli Gelirler → Maaş (ör. her ayın 10'u) ekle → Ödeme Takvimi'nde kart/kredi ödemeleri maaş altında gruplanıyor
- [ ] Hesaplar → Kredi ekle (kalan anapara, faiz, vade, sonraki taksit) → "Taksit öde" → kalan anapara azalıyor
- [ ] Borç Planı → aylık tutar gir → strateji kartları ve aylık tablo güncelleniyor
- [ ] Hesaplar → Ekstre Yükle → bankanın Excel / PDF / CSV dosyası → sütunlar ve kategoriler doğru; içe aktarınca işlemler hesaba ekleniyor
- [ ] ⌘N yeni işlem, ⌘1-9 sayfa geçişi, ⌘Q çıkış, ⌘C/⌘V form alanlarında çalışıyor
- [ ] Ayarlar → Veri Konumu → "Finder'da göster" `~/Library/Application Support/com.ybrzcn.finans/` açıyor
- [ ] Uygulamayı kapatıp açınca veriler duruyor

> İmzasız `.dmg` başka bir Mac'e indirildiğinde Gatekeeper uyarı verebilir. Uygulamaya sağ tık → **Aç** deyin, ya da: `xattr -cr /Applications/Finans.app`

### Sürüm yayınlama

`v1.2.3` biçiminde bir etiket gönderildiğinde GitHub Actions (`.github/workflows/release.yml`) macOS, Windows (x64/x86/ARM64) ve Linux (x86_64/ARM64) paketlerini derler, tanıtım sayfasının bağlandığı sabit adlarla (`scripts/release-names.json`) Release'e yükler; `docker.yml` sunucu imajını `ghcr.io`'ya gönderir. Bir derleme başarısız olursa sürüm taslak kalır.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

İlk yayından sonra bir kez: GitHub'da paketin (**Packages → personal-finance-tracker → Package settings**) görünürlüğünü **Public** yapın (aksi halde `docker compose pull` giriş ister) ve repo ayarlarında **Private vulnerability reporting**'i açın (SECURITY.md). `-` içeren etiketler (`v1.1.0-rc.1`) ön sürüm olarak yayınlanır; tanıtım sayfası ve Docker `latest` kararlı sürümde kalır. Compose'ta `--build` ile yerelde derlenen imaj aynı adı alır; sonraki `pull` onu hazır imajla değiştirir.

## Kurulum (ilk sefer)

### 1. Ön gereksinimler

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

WebView2, Windows 10/11'de zaten yüklüdür. Kurulumdan sonra terminali yeniden açın.

**macOS**

```bash
xcode-select --install
brew install node
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. Bağımlılıkları yükleyin

```bash
npm install
```

> `postinstall` adımı `app-icon.png` dosyasından tüm platform ikonlarını (`src-tauri/icons/`) otomatik üretir.

### 3. Geliştirme modunda çalıştırın

```bash
npm run tauri dev
```

İlk derleme Rust bağımlılıkları nedeniyle birkaç dakika sürebilir; sonrakiler hızlıdır.

> `npm run dev` düz tarayıcıda açılırsa (http://localhost:1420) 8080'deki sunucuya bağlanır (aşağıdaki sunucu komutu).

---

## Paketleme (Build)

| Komut | Çıktı |
| --- | --- |
| `npm run tauri:build` | Mevcut platform için tüm paketler |
| `npm run build:win` | Windows `.exe` (NSIS kurulum) + `.msi` |
| `npm run build:mac` | macOS `.app` + `.dmg` (mevcut mimari) |
| `npm run build:mac-universal` | macOS Universal (Intel + Apple Silicon) `.app` + `.dmg` |

Çıktılar: `src-tauri/target/release/bundle/` (universal için `src-tauri/target/universal-apple-darwin/release/bundle/`).

> Not: Tauri çapraz derleme desteklemez; Windows paketleri Windows'ta, macOS paketleri macOS'ta üretilmelidir (ya da GitHub Actions ile her iki platformda).
> Universal build için önce: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`

---

## Sunucu (self-host)

`crates/finans-server`, birden çok kullanıcının kendi hesabıyla kullanabileceği bir sunucudur. Veri iki şekilde tutulabilir:

- **PostgreSQL** (`FINANS_DATABASE_URL` verilirse; Compose'da varsayılan): tek şema, her kullanıcının satırları satır düzeyi güvenlikle (RLS) ayrılır.
- **SQLite** (verilmezse): her kullanıcının verisi ayrı bir dosyada.

İki modda da iş kuralları masaüstü uygulamasıyla aynı koddan (`finans-core`) gelir. **Kurlar** yalnız Postgres modunda saklanır: sunucu altın ve gümüşü 15 dakikada bir, TCMB kurunu iş günü 15:30'dan sonra çekip geçmişiyle tutar. SQLite modunda ve masaüstünde kurlar saklanmaz; istendiğinde kaynaklardan çekilip bir dakika bellekte tutulur (kur geçmişi grafiği yoktur). Web arayüzü ve masaüstü/mobil "Sunucu modu" bu API'ye bağlanır.

### Docker ile kurulum

```bash
cp .env.example .env   # iki şifreyi değiştirin (yalnız harf ve rakam; ör. openssl rand -hex 24)
docker compose pull && docker compose up -d   # hazır imaj (ghcr.io/ybrzcn/personal-finance-tracker) + PostgreSQL 17, 127.0.0.1:8787
# ya da kaynaktan: docker compose up -d --build
# port: FINANS_PORT=9000 docker compose up -d
docker compose logs -f finans
```

Compose iki servis kurar: `db` (PostgreSQL, verisi `finans-pg` volume'ünde, port dışarı açılmaz) ve `finans`. Postgres ilk açılışta `docker/postgres-init.sh` ile uygulamaya ayrı bir kullanıcı (`finans`) ve veritabanı oluşturur. Bu kullanıcının süper kullanıcı **olmaması** gerekir: süper kullanıcılar satır düzeyi güvenliği atlar, bu yüzden sunucu böyle bir kullanıcıyla açılmayı reddeder.

**Kendi PostgreSQL'iniz** (en az 15) varsa `db` servisini silin, uygulama kullanıcısını kendiniz oluşturun ve adresi verin:

```sql
CREATE ROLE finans LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '…';
CREATE DATABASE finans OWNER finans;
```

```
FINANS_DATABASE_URL=postgres://finans:…@sunucu:5432/finans               # aynı ağda
FINANS_DATABASE_URL=postgres://finans:…@sunucu:5432/finans?sslmode=require   # internet üzerinden (TLS)
```

Tablolar sunucu açılırken otomatik oluşturulur ve güncellenir.

**Önceki sürümden (1.0.x) güncelliyorsanız:** eski sürümler veriyi SQLite'ta tutuyordu. Yeni `docker-compose.yml` varsayılan olarak Postgres kullanır ve eski veri **kendiliğinden taşınmaz**; Postgres'le açılınca boş bir sunucu görürsünüz (sunucu günlüğünde bunun için bir uyarı çıkar, eski veri `finans-data` volume'ünde durur). Verinizle devam etmek için güncellemeden önce aşağıdaki gibi SQLite'ta kalın. Postgres'e geçmek isterseniz önce her kullanıcı uygulamadan JSON yedek alır, sonra yeni sunucuda hesap açıp yedeği geri yükler.

**SQLite'ta kalmak için** `docker-compose.yml`'den `FINANS_DATABASE_URL` satırını ve `db` servisini silin. Veriler `finans-data` volume'ünde (`/data`) durur (bind mount kullanılırsa klasörün sahibi uid 10001 olmalı): `auth.db` (hesaplar, oturumlar) ve `users/<kullanıcı-id>.db`.

| Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `FINANS_DATA_DIR` | `/data` (Docker), `./data` | Veri klasörü |
| `PORT` | `8080` | Dinlenen port |
| `FINANS_REGISTRATION` | `open` | `closed` ise yeni hesap açılamaz |
| `FINANS_SECURE_COOKIE` | `true` | Oturum çerezine `Secure` eklenir; HTTPS olmadan yalnız yerel denemede `false` |
| `FINANS_ALLOWED_ORIGINS` | masaüstü/mobil uygulama kökenleri | CORS izinli kökenler (virgülle); `none` CORS'u kapatır (masaüstü/mobil sunucu modu çalışmaz) |
| `FINANS_WEB_DIR` | `/app/web` (Docker) | Derlenmiş web arayüzü; boşsa yalnız API sunulur |
| `FINANS_TRUST_PROXY` | boş (compose'da `cloudflare`) | İstemci IP'sinin kaynağı: `cloudflare` → `CF-Connecting-IP` (Cloudflare/Tunnel), `xff` → `X-Forwarded-For`'un son değeri (Caddy/nginx). Sunucu doğrudan internete açıksa boş bırakın (başlıklar sahte olabilir) |
| `FINANS_DATABASE_URL` | boş (Compose'da Postgres) | Verilirse veri PostgreSQL'de tutulur; boşsa SQLite |
| `FINANS_DB_POOL` | `8` | PostgreSQL bağlantı havuzu boyutu |
| `FINANS_MAX_USERS` | `0` (sınırsız) | En fazla hesap sayısı |
| `FINANS_EVDS_KEY` | boş | TCMB EVDS API anahtarı; verilirse TÜFE günde bir çekilir (Postgres'te saklanır, SQLite modunda bellekte), Kâr/Zarar sayfasında enflasyon karşılaştırması açılır |
| `FINANS_ATTACHMENT_QUOTA_MB` | 1024 | Kullanıcı başına işlem belgeleri (fiş, fatura) kotası, MB; 0 sınırsız |
| `FINANS_SYNC_QUOTA_MB` | 2048 | Kullanıcı başına şifreli eşitleme verisi (veri + belgeler) kotası, MB; 0 sınırsız |

`FINANS_USER_QUOTA_MB` 1.1.0'da kaldırıldı (kullanıcı başına kota yok); verilirse yok sayılır.

### HTTPS

Sunucu düz HTTP dinler; internete açarken önüne HTTPS sağlayan bir reverse proxy koyun. Caddy örneği (`Caddyfile`):

```
finans.ornek.com {
    reverse_proxy localhost:8787
}
```

`docker-compose.yml` portu (varsayılan 8787, `FINANS_PORT`) yalnız `127.0.0.1`'e açar; Cloudflare Tunnel'da servis adresi `http://localhost:8787` olur; dışarıdan erişim proxy üzerinden olur. Giriş denemeleri IP başına dakikada 30, e-posta başına dakikada 10 ile sınırlıdır; proxy arkasında IP'nin doğru alınması için `FINANS_TRUST_PROXY` (`cloudflare` ya da `xff`) gerekir (aksi halde tüm istemciler proxy'nin IP'sini paylaşır). Ekstre dosyaları ayrı bir alt süreçte 1 GB bellek ve 30 sn sınırıyla okunur.

### Yönetim

```bash
docker compose exec finans finans-server users                       # kullanıcıları listeler
docker compose exec finans finans-server reset-password ad@ornek.com # geçici şifre verir, oturumları kapatır
docker compose exec finans finans-server disable-2fa ad@ornek.com    # doğrulama kodunu kapatır, passkey'leri siler
```

Kullanıcılar şifrelerini unutursa kayıtta verilen kurtarma koduyla kendileri de sıfırlayabilir.

Yedekleme (PostgreSQL):

```bash
docker compose exec db pg_dump -U postgres -d finans -Fc > finans.dump                  # yedek al
docker compose exec -T db pg_restore -U postgres -d finans --clean < finans.dump        # geri yükle
```

SQLite modunda `/data` klasörünün (volume) kopyası yeterlidir; tutarlı kopya için kopyalamadan önce `docker compose stop` önerilir. İki modda da kullanıcılar uygulama içinden JSON yedek alabilir.

### Web

Docker imajı web arayüzünü de içerir: sunucunun adresini (ör. `https://finans.ornek.com`) tarayıcıda açıp kayıt olun ya da giriş yapın. Kayıtta gösterilen **kurtarma kodunu** saklayın; şifre unutulursa yalnız onunla sıfırlanabilir. Web sürümü tarayıcıda veri saklamaz (yalnız oturum çerezi ve tema tercihi).

Telefonda uygulama gibi kullanmak için: iOS Safari → Paylaş → **Ana Ekrana Ekle**; Android Chrome → menü → **Uygulamayı yükle**.

Geliştirme:

```bash
# 1. terminal: sunucu (8080). Masaüstü geliştirme sürümü (npm run tauri dev) http://localhost:1420 kökeninden bağlanır;
#    bu yüzden geliştirmede o köken de CORS listesine eklenir (üretimde gerekmez)
cd crates/finans-server && FINANS_SECURE_COOKIE=false \
  FINANS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420 cargo run
# 2. terminal: web arayüzü (http://localhost:1430, /api istekleri 8080'e yönlenir)
npm run dev:web
```

`npm run build:web` web arayüzünü `dist/` klasörüne derler; sunucu `FINANS_WEB_DIR=dist` ile onu yayınlar.

### Docker olmadan

```bash
cd crates/finans-server
cargo build --release
npm run build:web   # repo kökünde
FINANS_DATA_DIR=/var/lib/finans FINANS_WEB_DIR=/yol/finans/dist ./target/release/finans-server
```

### API

Tüm yanıtlar JSON; hata biçimi `{"error": "<mesaj>"}`. Kimlik: web'de `finans_session` çerezi, diğer istemcilerde `Authorization: Bearer <token>`.

| Uç nokta | Açıklama |
|---|---|
| `POST /api/auth/register` `{email, password, device?}` | Hesap açar; `{token, user, recoveryCode}` |
| `POST /api/auth/login` `{email, password, device?, mfa?}` | `{token, user}`; iki aşamalı doğrulama açıksa `{mfa: "totp", ticket}` (istemci `mfa: true` göndermezse güncelleme uyarısı) |
| `POST /api/auth/login/totp` `{ticket, code}` | Girişin ikinci adımı (bilet 5 dk, 5 deneme; kullanıcı başına saatte 10, günde 50 yanlış kod); `{token, user}` |
| `POST /api/auth/passkey/options`, `POST /api/auth/passkey/login` | Passkey ile giriş: sorgu ve imzalı yanıt (`id, clientDataJSON, authenticatorData, signature`) |
| `GET /api/me/security` | `{totp, passkeys}` |
| `POST /api/me/totp/setup` `{password}`, `POST /api/me/totp/enable` `{ticket, code}`, `POST /api/me/totp/disable` `{password, code}` | Doğrulama uygulaması kodu (anahtar, `otpauth://` adresi ve QR kodu; ilk doğru kodla açılır, diğer oturumlar kapanır; açıkken yeni anahtar verilmez) |
| `POST /api/me/passkeys/options` `{password, code?}`, `POST /api/me/passkeys`, `DELETE /api/me/passkeys/{id}` `{password}` | Passkey ekleme (ES256, EdDSA, RS256; doğrulama uygulaması açıksa kod da gerekir, diğer oturumlar kapanır) ve silme (şifreyle) |
| `GET /api/sync`, `PUT /api/sync/keyring` `{keyring}`, `DELETE /api/sync` `{password}` | Şifreli eşitleme durumu (sürüm, boyut, parolayla sarılmış anahtar), anahtarlık (ilk kurulum ya da aynı anahtarın yeni parolayla sarımı) ve sunucudaki kopyanın silinmesi |
| `GET/PUT /api/sync/data` (`x-sync-key`, `x-sync-base`) | Şifreli anlık görüntü; yazma yalnız okunan sürümün üzerine (değiştiyse 409) |
| `GET /api/sync/files`, `GET/PUT/DELETE /api/sync/files/{id}` | Şifreli belge ekleri |
| `POST /api/auth/logout` | Oturumu kapatır |
| `POST /api/auth/change-password` `{currentPassword, newPassword}` | Diğer oturumlar kapanır |
| `POST /api/auth/recover` `{email, recoveryCode, newPassword, device?}` | Yeni şifre + yeni kurtarma kodu; doğrulama uygulaması kodu kapanır, passkey'ler silinir (`totpDisabled`, `passkeysRemoved`) |
| `GET /api/me`, `DELETE /api/me` `{password}` | Hesap bilgisi / hesabı ve tüm veriyi silme |
| `GET, POST /api/{categories,accounts,transactions,recurring}` | Listele / ekle. Listeler arayüzün gösterdiği sırayla gelir (işlemler tarihe, hesaplar ve kategoriler Türkçe alfabetik ada göre) |
| `PUT, DELETE /api/{categories,accounts,transactions,recurring}/{id}` | Güncelle / sil |
| `PUT /api/recurring/{id}/exception` `{month, amount, note}` | Düzenli kaydın o aya özel tutarı (`amount: 0` "bu ay yatmayacak", `null` istisnayı kaldırır); güncel kaydı döndürür |
| `POST /api/recurring/auto-post` | Otomatik kaydı açık düzenli kayıtların günü gelmiş aylarını işlem olarak ekler (her plan ayı bir kez; ödeme gününe ±10 gün yakın elle girilmiş uyan işlem varsa eklenmez); `{created, failed}` |
| `GET /api/budgets`, `PUT /api/budgets/{categoryId}` `{amount}` | Bütçeler (`amount: null` kaldırır) |
| `PUT /api/budgets/{categoryId}/rollover` `{from}` | Devreden bütçe: `from` (YYYY-MM) ayından itibaren artan/aşan sonraki aya geçer; `null` kapatır |
| `GET /api/settings`, `PUT /api/settings/{key}` | Borç planı / analiz ayarları |
| `POST /api/restore`, `GET /api/export` | Tüm veriyi değiştir / indir |
| `POST /api/statements/parse?name=<dosya>` (ham bayt) | Ekstre dosyasını okur (CSV, Excel, PDF) ve çözümler: tablo, başlık satırı, tahmin edilen sütunlar ve ekstre özeti (kesim, son ödeme, dönem borcu, limit, faiz) |
| `POST /api/statements/rows` | Ekstre tablosundan işlem satırları: tutar ve işaret, taksit, kart ödemesi algılama, mükerrer kayıt, önerilen kategori (`columns`/`signMode` boşsa tahmin edilir; en çok 20.000 satır, gövde en çok 32 MB) |
| `POST /api/preview/statement-card` | Ekstre özetinin kart ayarlarından farkı ve ekstrenin takip başlangıcından önce olup olmadığı |
| `POST /api/preview/statement-totals` | Seçili ekstre satırlarının gider/gelir toplamı ve dönem içi harcamayla uyumu (TL) |
| `POST /api/preview/category-rule` | Kategori kuralı önizlemesi: kaydedilecek kelimeler ve kurala uyan işlemler |
| `GET /api/categories/suggestions` | Kategorisiz işlemler için açıklamaya göre kategori önerileri (kurallar, geçmiş, bilinen işyerleri) |
| `POST /api/export/csv` `{transactionIds}` | İşlemlerin CSV'si (`{csv}`; Excel için BOM, `;` ayırıcı, formül koruması). `transactionIds: null` bütün işlemler; dizi verilirse o işlemler o sırayla |
| `GET /api/export/backup` | JSON yedek metni (`{json}`, sürüm 3): veri ile borç planı, analiz ve kategori kuralı ayarları |
| `POST /api/backup/parse` `{text}` | Yedeği doğrular (v1/v2/v3; v1 yedek "Genel Hesap"a taşınır); geri yüklenecek veriyi döndürür (gövde en çok 64 MB) |
| `POST /api/csv/parse` `{text}` | Finans CSV'sini okur: satırlar, atlanan satırlar ve nedenleri, "Hesap" sütunu var mı (gövde en çok 64 MB) |
| `POST /api/csv/merge` `{rows, defaultAccountId}` | CSV satırlarından eklenecek yeni kategoriler ve işlemler; hedef hesabı ya da döviz bilgisi eksik satırların sayısı (veri yazmaz) |
| `GET /api/reset/seed` | "Verileri sıfırla" sonrası başlangıç verisi: varsayılan kategoriler ve boş "Genel Hesap" (yeni kimliklerle; veri yazmaz) |
| `GET /api/rates/latest[?refresh=1]`, `GET /api/rates/at?code=&date=`, `GET /api/rates/history?code=&from=&to=` | Kurlar; güncel listede kullanıcının fonları da (`FON:XXX`) bulunur (döviz/altın geçmişi yalnız Postgres; fon geçmişi her iki modda) |
| `GET /api/funds/search?q=<kod ya da ad>` | TEFAS fon arama (en çok 20 sonuç) |
| `GET /api/pnl?from=&to=&kind=all\|fx\|fund` | Kâr/zarar raporu (tutarlar kuruş, kurlar ×1.000.000, yüzdeler baz puan); `kind` döviz/altın ya da fonlarla sınırlar; dönemdeki yatırım geliri (`investmentIncomeCategoryIds` ayarındaki gelir kategorileri) ve bugünkü varlık dağılımı da döner |
| `GET /api/accounts/report` | Hesap özetleri: kart ekstreleri ve borcu, ödeme ipuçları, kredi ödeme planı, banka/KMH, döviz değeri, mevduat dönemi ve BES/varlık değerlemesi (tutarlar kuruş) |
| `POST /api/accounts/{id}/deposit/mature` `{renew}` | Vadesi dolan mevduatın net faizini gelir olarak kaydeder; `renew` aynı süreyle yeniler, değilse vadesize çevirir |
| `GET /api/budget/report?month=YYYY-MM` | Bütçe: kategori harcamaları ve limitleri, düzenli/düzensiz gelir ve gider, devreden bütçe, ayrılan bütçe, kalan, düzenli kayıtların o aydaki tarih ve tutarları (tutarlar kuruş) |
| `GET /api/income/status` | Gelir durumu: bu ay beklenen gelir (maaş / diğer) ve yatış günü gelmiş ama girilmemiş düzenli gelirler (tutarlar kuruş) |
| `GET /api/cashplan?months=N` | Ödeme takvimi (N = 1–24 ay): bugünkü nakit, maaş dönemleri ya da takvim ayları, her dönemin gelirleri, ödemeleri (hangi gelirden karşılandığı), ödenmiş/yatmış kalemleri ve tahmini bakiyesi (tutarlar kuruş) |
| `GET /api/obligations/upcoming?days=N` | Önümüzdeki N gündeki (1–365) ve gecikmiş kart, kredi ve planlı ödemeler (tutarlar kuruş) |
| `GET /api/debt/plan` | Borç planı: faiz işleyen borçlar, Çığ / Kartopu / hesap sırası / yalnız asgari ve "Kendi planım" simülasyonları (ayarlardaki aylık tutar, aya özel tutarlar, kurallar ve hücrelerle), en az faizli plan, ilk 24 ayın tablosu (tutarlar kuruş) |
| `GET /api/overview?period=thisMonth\|lastMonth\|last30\|thisYear\|all` | Genel Bakış: dönemin gelir/gider/net toplamları (girilmemiş düzenli gelirin plan tutarı dahil), işlem sayısı, tasarruf oranı, kategori/hesap/satıcı gider dağılımı, önceki dönemin kategori dağılımı, son 6 ayın gelir ve gideri (tutarlar kuruş) |
| `GET /api/categories/usage` | Kategori başına işlem sayısı ve tutar toplamı (tutarlar kuruş) |
| `GET /api/analysis` | Analiz: Abonelikler kategorisinden bulunan abonelikler (kayıtlı düzeltmeler uygulanmış; aylık/yıllık maliyet, sonraki ödeme, gecikme) ve seçili kategorilerin aylık/yıllık harcama tahmini, ay sonu beklentisi, en çok harcanan yerler (tutarlar kuruş) |
| `POST /api/preview/transaction` | İşlem formu önizlemesi: gövde formun taslağı; TL karşılığı, kur tarafı, nakit avans planı, taksitlerin düşeceği ekstreler, nakit eksi denetimi, gelirin bütçe ayı seçenekleri (tutarlar kuruş) |
| `POST /api/preview/account` | Hesap formu önizlemesi: kartın sonraki ve son kesim/son ödeme tarihleri, yeni kartın takip başlangıcı, kredi taksit önerisi (kuruş), hesabın işlem kaydı var mı |
| `POST /api/preview/recurring` | Düzenli kayıt formu önizlemesi: bugünkü tutar, değişiklik tarihi varsayılanı, hafta sonu kaymaları, miktarın TL karşılığı, kayıtta yazılacak tutar ve geçmiş |
| `GET /api/networth` | Net servet geçmişi: her ay sonu (son nokta bugün) varlık, borç, bugünkü fiyatla ve maliyetle net, tür ve hesap kırılımı (tutarlar kuruş) |
| `GET /api/projection?years=&incomeGrowthPct=&expenseGrowthPct=&returnPct=&monthlyExtra=` | Uzun vadeli tahmin: bugünkü aylık akış, aylık net servet serisi, yıllık satırlar (giren, çıkan, getiri, kredi borcu, net servet, bugünün parasıyla), kredi bitiş ayı, nakdin eksiye düştüğü ay (tutarlar kuruş; varsayımlar `projection` ayarında saklanır) |
| `GET /api/reports?preset=thisMonth\|lastMonth\|thisYear\|lastYear\|last12\|custom&from=&to=&compare=previous\|lastYear\|none&kind=expense\|income&group=category\|account\|tag` | Dönemsel rapor: dönem ve karşılaştırma aralığı, gelir/gider/net ve birikim oranı, kırılım satırları (pay, önceki, değişim), aylık seri, gelir akışı (tutarlar kuruş) |
| `GET/POST /api/transactions/{id}/attachments` (`?name=`, gövde dosya) | İşlemin belgeleri / belge ekle (JPEG, PNG, WebP, PDF; içerikten tanınır) |
| `GET /api/attachments/counts`, `GET/DELETE /api/attachments/{id}` | İşlem başına belge sayısı; belge içeriği (kum havuzunda) ya da silme |
| `POST /api/receipts/parse` (gövde PDF) | Fiş/fatura PDF'inden toplam ve tarih önerisi |
| `GET, POST /api/goals` | Birikim hedefleri (bağlı hesaplarıyla) / yeni hedef |
| `PUT, DELETE /api/goals/{id}` | Hedefi ve bağlı hesaplarını değiştir / sil |
| `GET /api/goals/report` | Hedeflerin ilerlemesi, son 3 ayın hızı, aylık gereken tutar ve tahmini tarih (tutarlar hedef biriminde) |
| `GET, POST /api/tags` | Etiketler / yeni etiket (`{name, color, budget?}`) |
| `PUT, DELETE /api/tags/{id}` | Etiketi değiştir / sil (işlemler kalır) |
| `GET /api/tags/report` | Etiket başına net harcama, kategori kırılımı, aylık seyir ve bütçe durumu (TL) |
| `POST /api/transactions/tags` `{transactionIds, add, remove}` | Seçili işlemlere toplu etiket ekle/kaldır (en çok 5.000) |
| `GET /api/health` | Sağlık kontrolü |

## Masaüstü: hesap ve veri yeri

İlk açılışta uygulama bir Finans sunucusunun adresini ister (resmi sunucu adresi derlemeye `VITE_DEFAULT_SERVER_URL` ile gömülebilir; boşsa kullanıcı yazar), ardından hesap açtırır ya da giriş yaptırır ve verinin nerede duracağını sorar:

- **Bu cihazda**: Bugünkü gibi yerel SQLite; sunucuya veri gitmez, açılışta internet gerekmez.
- **Sunucuda**: Web ile aynı veri; her işlem sunucuya yazılır, internet gerekir.

"Şimdilik hesapsız devam et" ile hesap açmadan yalnız yerel kullanılabilir; hesap sonradan Ayarlar → Hesap'tan bağlanır.

Ayarlar → Hesap:

- **Verilerimi sunucuya taşı**: Yerel veri (ayarlarla) sunucudakinin yerine yazılır; yerel dosya yedek olarak kalır.
- **Bu cihaza indir**: Yerel veritabanı önce yedeklenir (`finans.db.sifirlama-oncesi-….bak`), sonra sunucudaki veri yazılır.
- **Şifreli eşitleme** (veri bu cihazdayken): cihazlar sunucu üzerinden uçtan uca şifreli eşitlenir; durum ve son ortak sürüm veri klasöründeki `sync.json` ve `sync-base.json`'da (veri anahtarı da `sync.json`'da; veritabanı dosyası kadar korunmalı). Eşitleme seçili veritabanı dosyasına bağlıdır; başka dosyaya geçilince o dosya bağlı sayılmaz.
- **Çıkış yap / Hesabı sil**: Bu cihazdaki yerel veri silinmez.

Sunucu adresi ve oturum token'ı uygulama veri klasöründeki `config.json`'da saklanır. Sunucu, masaüstü/mobil uygulamaların kökenlerine varsayılan olarak CORS izni verir (`FINANS_ALLOWED_ORIGINS`).


## Proje yapısı

```
finans/
├── app-icon.png                 # İkon kaynağı (npm run icons ile yeniden üretilir)
├── index.html
├── package.json                 # dev / build / paketleme komutları
├── vite.config.ts
├── tailwind.config.js
├── src/                         # React arayüzü
│   ├── main.tsx                 # Provider'lar
│   ├── App.tsx                  # Yerleşim + global kısayollar
│   ├── index.css                # Tailwind + tema değişkenleri
│   ├── components/              # Sidebar, Modal, formlar, grafikler, ortak bileşenler
│   ├── pages/                   # Dashboard, Transactions, Categories, Settings
│   ├── state/                   # data (CRUD + uygulama ayarları), settings (tema + ayar erişimi), ui (modal/toast)
│   └── lib/                     # api (Tauri ↔ SQLite), csv, backup, fileio, stats, format
├── Dockerfile, docker-compose.yml # Sunucu imajı
├── crates/finans-server/        # Sunucu (axum): hesaplar, kullanıcı başına veritabanı, REST API
├── crates/finans-core/          # Veri katmanı (Tauri'ye bağlı değil; masaüstü ve sunucu ortak)
│   └── src/
│       ├── db.rs                # Şema, migration, varsayılan kategoriler
│       ├── store.rs             # Doğrulama, CRUD, atomik geri yükleme, ayarlar
│       └── statement.rs         # Ekstre okuma (CSV/TXT, Excel, PDF; bayt alır)
└── src-tauri/                   # Masaüstü kabuğu (Tauri)
    ├── Cargo.toml
    ├── tauri.conf.json          # Pencere, paketleme, CSP
    ├── capabilities/default.json# İzinler (en az yetki)
    └── src/
        ├── main.rs
        ├── lib.rs               # Uygulama kurulumu, DB yolu, komut kaydı
        ├── commands.rs          # finans-core'u çağıran Tauri komutları, veritabanı dosyası işlemleri
        └── maintenance.rs       # Sürüm bilgisi, uygulamayı kaldırma
```

## Veri modeli

```text
categories   (id TEXT PK, name, type 'income'|'expense', color, created_at, UNIQUE(name, type))
accounts     (id TEXT PK, name UNIQUE, kind 'bank'|'cash'|'credit_card'|'loan', color, opening_balance_cents,
              opening_date, credit_limit_cents, interest_rate_bp, statement_day, due_day,
              min_payment_rate_bp, sort_order, archived, term_months, first_due_date,
              installment_cents, tax_rate_bp, funding_income_id, opening_period_cents,
              opening_installments (JSON), created_at)
recurring_items (id TEXT PK, name, type 'income'|'expense', amount_cents, day 1-31,
              account_id → accounts, category_id → categories, active, sort_order, created_at)
budgets      (category_id PK → categories ON DELETE CASCADE, amount_cents)
transactions (id TEXT PK, amount_cents INTEGER > 0, type 'income'|'expense'|'transfer',
              account_id → accounts, to_account_id → accounts (yalnız transfer),
              category_id → categories ON DELETE SET NULL, date 'YYYY-MM-DD', description,
              installments 1-36, budget_month, created_at)
settings     (key TEXT PK, value JSON)   -- borç planı ve analiz ayarları (tema gibi cihaz tercihleri localStorage'da)
```

Tutarlar kayan nokta hatalarını önlemek için veritabanında **kuruş (tam sayı)** olarak saklanır. Şema sürümü `PRAGMA user_version` ile takip edilir; yeni migration'lar `crates/finans-core/src/db.rs` içindeki `migrate` fonksiyonuna eklenir.

## CSV içe aktarma biçimi

Başlık satırı zorunludur; ayırıcı (`;`, `,` veya sekme) otomatik algılanır. Sütun adları Türkçe veya İngilizce olabilir:

```csv
Tarih;Tür;Kategori;Tutar;Açıklama
2026-10-01;Gelir;Maaş;45.000,00;Ekim maaşı
05.10.2026;Gider;Market;1.250,75;Haftalık alışveriş
```

- Tarih: `YYYY-AA-GG` veya `GG.AA.YYYY`
- Tür sütunu yoksa negatif tutarlar gider, pozitifler gelir sayılır.
- Olmayan kategoriler otomatik oluşturulur.
- Döviz/altın hesaplarının işlemleri `Para birimi`, `Orijinal tutar` (o birimdeki miktar) ve `Kur` sütunlarıyla gelir; iki tarafı da döviz olan transferlerde hedef taraf `Hedef para birimi`, `Hedef miktar` ve `Hedef kur` sütunlarındadır (dışa aktarılan dosyada bu sütunlar hazırdır).
