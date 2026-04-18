# QBitmap Ekosistemi - Teknik Yetenek Dokümantasyonu

Bu doküman, QBitmap platformu ve tüm yan servislerinin teknik yeteneklerini, entegrasyon noktalarını ve yapılabilecek her şeyi ana hatlarıyla kapsar.

---

## Altyapı Özeti

| Servis | Sunucu | Port | Veritabanı |
|--------|--------|------|------------|
| **QBitmap Frontend** | 91.99.219.248 | 443 (Caddy) | - |
| **QBitmap Backend** | 91.99.219.248 | 3000 | MySQL 8.0 |
| **MediaMTX** | 91.98.90.57 | 8554/8888/8889/1935/9997 | - |
| **ONVIF Events** | 91.98.90.57 | 3001 | In-memory |
| **RTSP Capture** | 91.98.90.57 | 3002 | In-memory |
| **H3 Service** | 46.224.128.93 | 3100 | PostgreSQL 16 |
| **Entangle/Matrix** | 91.98.131.74 | 8000 | - |
| **vLLM** | (yapılandırılabilir) | - | - |
| **Face API** | matcher.qbitwise.com | 443 | - |

---

## 1. QBitmap Frontend

**Teknoloji:** Vanilla JS, MapLibre GL, deck.gl, Three.js, HLS.js, WebRTC
**URL:** `https://qbitmap.com`
**Sayfalar:** index.html (ana uygulama), admin.html (yönetim), status.html (servis izleme)

### 1.1 Harita ve Görselleştirme
- **Vektör harita** — Protomaps temaları ile MapLibre GL, go-pmtiles tile sunucusu
- **Uydu görüntüleri** — PMTiles formatında, Ataşehir ve Sincan bölgeleri için yüksek çözünürlüklü (zoom 17-18)
- **Kamera katmanı** — GeoJSON noktaları, kümeleme (clustering), çevrimiçi/çevrimdışı/alarm ikonları
- **H3 hücre ızgarası** — deck.gl ile altıgen grid overlay, dijital arazi sahipliği renklendirmesi (12 pastel renk)
- **TRON ışık izleri** — Sahip olunan hücreler arası animasyonlu parçacık efektleri (canvas rendering)
- **3D modeller** — Three.js ile harita üzerinde 3D obje ve parçacık küp renderı
- **Araç animasyonu** — Önceden tanımlı rotalarda (Ataşehir Bulvarı, O-4 Otoyol, Kozyatağı O-2) araç simülasyonu
- **Kullanıcı konum gösterimi** — Doğruluk çemberi ile gerçek zamanlı GPS konum
- **Canlı yayın işaretçileri** — Aktif yayıncıların harita üzerindeki konumları
- **Video/fotoğraf mesaj işaretçileri** — Konum bazlı içerik pinleri

### 1.2 Kamera Yönetimi (14 modül)
- **Desteklenen kamera tipleri:**
  - WHEP (WebRTC) — düşük gecikmeli izleme
  - RTSP — IP kamera akışı
  - RTMP — GoPro, OBS, harici encoder
  - Cihaz kamerası — telefon/tablet kamerası
  - Şehir kamerası — belediye HLS kameraları (salt okunur)
- **Kamera talep etme (claim)** ve sahiplik yönetimi
- **Kamera paylaşımı** — e-posta ile diğer kullanıcılara
- **Konum atama** — harita üzerinden GPS koordinatı seçimi
- **Kamera ayarları** — çözünürlük, ONVIF entegrasyonu, AI model seçimi, yüz tanıma, kayıt limitleri
- **Çoklu kamera ızgarası** — grid görünümü ile eşzamanlı çoklu kamera izleme
- **HLS oynatıcı** — hls.js ile canlı yayın, Safari için native fallback
- **Kayıt sistemi** — sunucu tarafı kayıt (max 500MB), aylık saat limiti
- **Kayıt oynatma** — kaydedilmiş videoları modal içinde izleme
- **Tıklanabilir bölgeler** — kamera görüntüsü üzerinde interaktif zone tanımlama, röle URL kontrolü
- **Debug terminal** — kamera logları ve diagnostik bilgiler
- **Filtreler** — tip (RTSP/RTMP/cihaz/şehir), durum (çevrimiçi/çevrimdışı), görünüm modu (kompakt/genişletilmiş)

### 1.3 AI ve Algılama
- **AI görüntü analizi** — vLLM vision modeli ile gerçek zamanlı kare analizi
- **Düşme algılama** — acil durum tespiti, alarm tetikleme
- **Yangın/kavga/panik tespiti** — yapılandırılabilir kurallar ve promptlar
- **Yüz tanıma** — referans yüz veritabanı, eşleşme/eşleşmeme alarmı
- **Yüz bulanıklaştırma** — gizlilik için otomatik pikselasyon
- **AI arama** — canlı yayında bölge seçerek hedefli AI analizi
- **Kamera başına özel AI modeli ve prompt** — global ayarı override edebilme
- **AI istek kuyruğu** — max 3 eşzamanlı istek, rate limit aşımı önleme

### 1.4 Canlı Yayın (WHIP)
- **WHIP protokolü** ile cihaz kamerasından haritaya canlı yayın
- **Kamera değiştirme** — ön/arka kamera geçişi
- **Çözünürlük seçimi** — 720p, 1080p
- **Yayın sırasında kayıt**
- **Yayın sırasında AI analizi** — acil durum tespiti
- **Yayın sırasında yüz tespiti** — referans yüzlerle eşleştirme
- **Eşzamanlı birden fazla yayıncı** desteği

### 1.5 Video/Fotoğraf Mesajları
- **Video kaydı** — max 30 saniye, 20MB limit
- **Fotoğraf çekimi** — çoklu çözünürlük: standart (1920x1080), yüksek (2560x1440), maksimum (4K)
- **Flaş kontrolü**, **zoom** (pinch), **ön/arka kamera** geçişi
- **Konum etiketi** — harita üzerinde pin yerleştirme
- **Mekan etiketi** — Google Places API ile restoran, kafe, mağaza vb.
- **Gizlilik kontrolü** — herkese açık veya belirli alıcıya özel
- **Alıcı seçimi** — autocomplete ile kullanıcı arama
- **Yorum dizileri** — iç içe yorumlar, sayfalama
- **Görüntüleme sayacı**
- **AI ile içerik analizi** — video/fotoğraf için otomatik açıklama oluşturma
- **Paylaşım linki** — token bazlı güvenli paylaşım
- **Plyr video oynatıcı** ile oynatma

### 1.6 Kimlik Doğrulama
- **Google OAuth 2.0** ile giriş
- **Biyometrik yüz tanıma** ile giriş (FacePlugin SDK + OpenCV.js)
- **Canlılık algılama** — anti-spoofing, fotoğraf/video sahteciliği önleme (göz kırpma, hareket tespiti)
- **HttpOnly cookie** ile güvenli oturum yönetimi (localStorage kullanılmaz)

### 1.7 Sesli Kontrol
- **Web Speech API** ile Türkçe sesli komutlar
- Harita navigasyonu: merkez, yakınlaştırma, sınırlar
- Sürekli tanıma modu, transcript tamponlama, debounce

### 1.8 Tesla Dashcam
- **SEI metadata çıkarma** — GPS koordinatları, hız, vites (park/sürüş/geri/nötr), direksiyon açısı, autopilot durumu
- **Protobuf decode** — ikili metadata çözümleme
- **Senkronize video oynatma** ile gösterge paneli overlay (hız, vites, direksiyon görseli)
- **Harita üzerinde araç konum takibi** ve rota çizimi

### 1.9 Admin Paneli
- **Kullanıcı yönetimi** — plan atama, rol değiştirme (user/admin), aktiflik, admin notları, özellik override
- **Plan/abonelik yönetimi** — kamera limiti, WHEP limiti, günlük AI limiti, yüz limiti, aylık kayıt saati, saklama süresi, özellik bayrakları
- **ONVIF kamera şablonları** — üretici/model bazlı profil CRUD
- **AI ayarları** — vLLM URL, model adı, izleme promptu, arama promptu, max token, sıcaklık
- **Sesli arama ayarları** — Matrix URL, oda ID, hedef kullanıcı, soğuma süresi, timeout
- **Google Places yapılandırması** — yarıçap, max sonuç, dahil edilen mekan tipleri, fallback tipleri
- **Video/fotoğraf mesaj moderasyonu** — arama, filtreleme, silme, indirme
- **İstatistik paneli** — toplam kullanıcı, aktif kullanıcı, toplam kamera, çevrimiçi kamera, günlük AI analizi, mesaj sayıları

### 1.10 Durum İzleme Paneli (status.html)
- Tüm servislerin **gerçek zamanlı sağlık durumu**
- **SVG ağ grafiği** — servisler arası bağlantı görselleştirme
- **Animasyonlu veri paketleri** — akış görseli
- **Yanıt süresi izleme**
- **30 saniyede bir otomatik yenileme**

---

## 2. QBitmap Backend (Fastify + Node.js)

**URL:** `https://stream.qbitmap.com`
**Veritabanı:** MySQL 8.0 (27 tablo, mysql2/promise ile bağlantı havuzu - 20 bağlantı)
**Yönetim:** systemd (qbitmap-backend.service)

### 2.1 Kamera CRUD ve Yönetim
- **WHEP kamera** oluşturma (WebRTC, özellik limiti kontrolü)
- **RTSP kamera** oluşturma — MediaMTX'e path ekleme + ONVIF servisine kayıt (transactional rollback)
- **RTMP kamera** oluşturma (GoPro/OBS)
- **Şehir kamerası** (HLS) oluşturma (admin)
- Kamera güncelleme (ad, konum, herkese açık durumu)
- Kamera silme (ONVIF kaydı + MediaMTX path + kayıtlar temizleme)
- Sahiplik devri (release)
- **Kamera paylaşımı** — e-posta bazlı, paylaşım listeleme/silme
- **Kamera ayarları versiyonlama** — cihaz senkronizasyonu için config_version takibi

### 2.2 Akış ve Medya
- **Frame cache** — bellekte JPEG depolama, device frame yükleme (30 frame/dk limit)
- **MJPEG canlı akış** — istemci kaydı, viewer sayısı, stream durumu
- **WHEP/WHIP proxy** — MediaMTX'e HTTPS→HTTP köprüleme, SSRF koruması (özel IP aralıkları engelleme)
- **HLS akış** — MediaMTX üzerinden fMP4
- **Kayıt yönetimi** — başlatma/durdurma/listeleme/silme/oynatma, 60dk max otomatik durdurma, özellik limiti kontrolü
- **Canlı yayın** — kullanıcı başına tek yayın, kayıt desteği
- **Video/fotoğraf mesaj yükleme** — multipart, 20MB max, 30sn max video, 5/10dk rate limit, thumbnail
- **Görüntü proxy** — CORS sorunlarını aşmak için domain whitelist ile

### 2.3 AI Entegrasyonu
- **vLLM proxy** — görüntü analizi, base64 → model → yanıt
- **Rate limiting** — 240/dk IP bazlı, plan bazlı günlük limit
- **AI izleme** — kamera başına başlatma/durdurma, analiz kaydı
- **Alarm oluşturma** — algılama metadata'sı ile (tip, güvenilirlik, açıklama)
- **Alarm yönetimi** — temizleme, geçmiş, aktif alarmlar (sayfalama)
- **İstatistikler** — aktif kamera sayısı, alarm sayıları, WebSocket bağlantı sayısı

### 2.4 Yüz Tanıma
- **Referans yüz yönetimi** — ekleme/silme, plan bazlı limit kontrolü
- **Yüz tanıma proxy** — Face API'ye (matcher.qbitwise.com) yönlendirme
- **Tespit logları** — kayıt ve listeleme
- **Yüz alarmı tetikleme** — eşleşme durumunda sesli arama başlatma
- **Ayar yönetimi** — etkinleştirme, aralık (5-60sn), tetikleyici isim listesi

### 2.5 ONVIF Entegrasyonu
- **Şablon yönetimi** — üretici/model bazlı ONVIF port ve desteklenen olay profilleri
- **Kamera keşfi** — ONVIF servisinden mevcut kamera listesi
- **Kamera kaydı/silme** — ONVIF servisine HTTP ile
- **Olay webhook** — IP bazlı kimlik doğrulama (91.98.90.57 whitelist)
- **Sesli arama tetikleme** — ONVIF olaylarında (insan tespiti vb.)

### 2.6 Sesli Arama (Entangle/Matrix)
- **Entangle Matrix API** entegrasyonu (91.98.131.74:8000)
- Desteklenen örnek tipleri: `fire`, `human`, `person`
- ONVIF olay tetiklemesi + yüz tanıma tetiklemesi
- Kamera başına **soğuma süresi** (tekrarlanan aramaları önleme)
- Yapılandırılabilir oda ID, hedef kullanıcı
- Otomatik kapama timeout, bağlantı timeout

### 2.7 H3 Senkronizasyon
- Backend → H3 servisine **içerik öğesi** bildirimi (`notifyH3ContentItem`, `notifyH3ContentRemove`)
- Backend → H3 servisine **kullanıcı profili** senkronizasyonu (`notifyH3UserProfile`)
- **Toplu senkronizasyon** — admin endpoint üzerinden migration
- **Kamera koordinat listesi** — H3 servisi tarafından çekilir (service key auth)

### 2.8 Tıklanabilir Bölgeler (Clickable Zones)
- Kamera görüntüsü üzerinde koordinat bazlı bölge tanımlama
- Bölgeye **röle URL'si** atama (SSRF doğrulama ile)
- Röle durumu **toggle** (açma/kapama)
- Zone CRUD (oluşturma/listeleme/güncelleme/silme)

### 2.9 Google Places Entegrasyonu
- Konum bazlı mekan arama (yapılandırılabilir yarıçap, max sonuç)
- Mekan tipi filtreleme (restoran, kafe, mağaza, hastane vb.)
- **Önbellek sistemi** — istatistik, temizleme, arama, mekan ikonu güncelleme

### 2.10 WebSocket (Gerçek Zamanlı)
- **Alarm yayını** — tüm bağlı istemcilere alarm bildirimi
- **İzleme durumu değişiklikleri** — kamera AI izleme başlatma/durdurma
- **Yorum bildirimleri**
- **Akış istemci yönetimi** — MJPEG stream viewer tracking

### 2.11 Sağlık İzleme
- **Çoklu servis sağlık kontrolü** — MySQL, MediaMTX, ONVIF, H3, vLLM
- Servis konfigürasyon bilgisi
- Aggregated health endpoint

### 2.12 Arka Plan Görevleri
- **MediaMTX senkronizasyonu** — 2 dakikada bir batch (10 kamera/batch) path kontrolü
- **Temizlik servisi** — periyodik eski veri temizliği
- **Cooldown map temizliği** — süresi dolan soğuma kayıtlarını silme
- **Last-seen throttling** — kamera görülme zamanını 5 saniyede bir güncelleme

### 2.13 Güvenlik
- **SSRF koruması** — özel IP aralıkları (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x) engelleme
- **Rate limiting** — global 100/dk, auth 5/dk, streaming 300/dk, AI 240/dk, yorum 10/5dk, mesaj 5-10dk
- **Parametre doğrulama** — Zod şemaları
- **Dosya yükleme güvenliği** — MIME doğrulama, boyut limiti (yüz: 2MB, video: 20MB), path traversal önleme
- **CORS** — credentials ile cross-origin yapılandırma
- **Helmet** — CSP, X-Frame-Options, MIME sniffing önleme
- **HttpOnly cookie** — JWT token güvenliği (localStorage'a asla yazılmaz)
- **GZIP/Deflate sıkıştırma** — >1KB yanıtlar için

---

## 3. MediaMTX (Medya Akış Sunucusu)

**Konum:** 91.98.90.57 (Server 2)
**Dağıtım:** Docker Compose
**Rol:** Tüm kamera akışlarının merkezi hub'ı

### 3.1 Desteklenen Protokoller

| Protokol | Port | Yön | Kullanım |
|----------|------|-----|----------|
| **RTSP** | 8554 | Giriş/Çıkış | IP kamera akışı alımı, RTSP-Capture servisi tarafından frame çekme |
| **WebRTC** | 8889 | Giriş (WHIP) / Çıkış (WHEP) | Tarayıcıdan düşük gecikmeli yayın ve izleme |
| **HLS** | 8888 | Çıkış | fMP4 formatında HTTP canlı akış (7 segment × 1sn = ~7sn gecikme) |
| **RTMP** | 1935 | Giriş | GoPro, OBS, harici encoder'lardan akış alımı |
| **API** | 9997 | Yönetim | Path oluşturma/silme, kayıt başlatma/durdurma |
| **Playback** | 9996 | Çıkış | Kaydedilmiş video dosyası erişimi |
| **Metrics** | 9998 | İzleme | Prometheus formatında metrikler (viewer, bandwidth) |

### 3.2 Yetenekler
- **Dinamik path yönetimi** — backend API üzerinden kamera ekleme/silme
- **Çoklu protokol dönüşümü** — RTSP→HLS, RTSP→WebRTC, RTMP→HLS, RTMP→WebRTC vb.
- **Kayıt** — fMP4 formatı, 1 saatlik segmentler, 15 gün (360 saat) saklama, otomatik silme
- **IP bazlı yetkilendirme** — localhost ve backend sunucusuna (91.99.219.248) tam erişim
- **Anonim RTMP yayını** — harici cihazlardan kimlik doğrulamasız akış alımı
- **Kriptografik path adları** — tahmin edilemez stream URL'leri

---

## 4. ONVIF Events Servisi

**Konum:** 91.98.90.57:3001
**Teknoloji:** Node.js + Fastify + onvif npm paketi

### 4.1 Yetenekler
- **ONVIF kamera bağlantısı** — PullPoint event subscription ile güvenilir olay alımı
- **45 saniyelik bağlantı timeout**
- **3 saniyelik olay debounce** — aynı tip + aynı kamera için tekrar engelleme
- **Webhook bildirimi** — olayları QBitmap backend'ine POST
- **Bellekte olay geçmişi** — kamera başına son 10 olay
- **Kamera CRUD** — ekleme, silme, listeleme (kimlik bilgileri diske yazılmaz)
- **Sağlık kontrolü** — bağlı kamera istatistikleri

### 4.2 Desteklenen Olay Tipleri

| Olay | Açıklama | Tetiklediği Aksiyonlar |
|------|----------|----------------------|
| **Motion** | Hareket algılama | AI analizi başlatma, kayıt başlatma |
| **Human** | İnsan tespiti | Sesli arama tetikleme, alarm oluşturma |
| **Pet** | Evcil hayvan tespiti | Bildirim gönderme |
| **Vehicle** | Araç tespiti | Bildirim gönderme |
| **Line Crossing** | Sanal çizgi geçişi | Alarm, kayıt başlatma |
| **Tamper** | Kamera kurcalama tespiti | Acil alarm |

---

## 5. RTSP Capture Servisi

**Konum:** 91.98.90.57:3002
**Teknoloji:** Node.js + Fastify + ffmpeg

### 5.1 Yetenekler
- **RTSP akışından JPEG frame çekme** — ffmpeg spawn ile
- **Yapılandırılabilir çekim aralığı** — 1-60 saniye (varsayılan 5sn)
- **Eşzamanlı max 50 aktif capture**
- **10 saniyelik ffmpeg timeout** — takılan işlemleri öldürme
- **Bellekte son frame depolama** — kamera başına en son kare
- **Binary JPEG ve Base64 çıktı** formatları
- **Service key kimlik doğrulama**
- **Çakışma önleme** — devam eden capture varsa yenisini atlama

---

## 6. H3 Service (Dijital Arazi Sahipliği)

**Konum:** 46.224.128.93:3100
**Teknoloji:** Node.js + Fastify + PostgreSQL 16 (H3 uzantısı)
**Veritabanı:** qbitmap_h3

### 6.1 H3 Grid Hesaplama
- **Viewport bazlı hücre sorgusu** — SW/NE köşeleri + zoom ile
- **50.000 hücre limiti** — performans güvencesi
- **Zoom-çözünürlük eşleştirmesi:**
  - Zoom 5-6 → Resolution 4 (~1,770 km²)
  - Zoom 7-8 → Resolution 5 (~252 km²)
  - Zoom 9-10 → Resolution 6 (~36 km²)
  - Zoom 11-12 → Resolution 7 (~5.2 km²)
  - Zoom 13-14 → Resolution 8 (~0.74 km²)
  - Zoom 15-16 → Resolution 9-10
  - Zoom 17-18 → Resolution 11-12
  - Zoom 19-20 → Resolution 13 (~43.87 m²)

### 6.2 Dijital Arazi Sahipliği
- **Puan bazlı sahiplik:**
  - Kamera yerleştirme: **50 puan**
  - Video mesajı: **5 puan**
  - Fotoğraf mesajı: **1 puan**
- **Berabere kalma kuralı** — en yüksek puan kazanır, eşitlikte en eski içerik üreticisi
- **Şehir kameraları hariç** — CITY_ prefix ile başlayan kameralar sahiplik dışı
- **Kullanıcı bazlı pastel renklendirme** — 12 benzersiz renk
- **Liderlik tablosu** — sahip olunan hücre sayısına göre sıralama (limit 10-50)

### 6.3 Veri Senkronizasyonu
- **İçerik öğesi upsert/silme** — fotoğraf, video, kamera verilerini H3 indeksine eşleme
- **Toplu içerik senkronizasyonu** — migration için bulk endpoint
- **Kullanıcı profili senkronizasyonu** — displayName, avatarUrl
- **Kamera senkronizasyonu** — tam ve artımlı (incremental)
- **Materialized view yenileme** — H3 sayım sorgularını hızlandırma

### 6.4 Performans
- **LRU cache** — 2000 giriş, yapılandırılabilir TTL
- **Hexagon cache** — 30 saniye TTL
- **Ownership cache** — 60 saniye TTL
- **Leaderboard cache** — 60 saniye TTL
- **PostgreSQL bağlantı havuzu** — 20 bağlantı, 5sn timeout

---

## 7. Yapılabileceklerin Tam Listesi

### A. Kamera ve Gözetim
1. Herhangi bir IP kamerayı (RTSP/ONVIF) platforma eklemek
2. RTMP ile GoPro veya OBS'den canlı akış almak
3. WebRTC ile tarayıcıdan düşük gecikmeli canlı yayın başlatmak
4. Birden fazla kamerayı grid görünümünde eşzamanlı izlemek
5. Kameraları harita üzerinde coğrafi konumlarıyla görüntülemek
6. Kamera akışını HLS, WebRTC veya MJPEG ile izlemek
7. Kameraları diğer kullanıcılarla e-posta ile paylaşmak
8. Kamera akışını sunucu tarafında kaydetmek ve geri oynatmak
9. ONVIF olayları (hareket, insan, araç, evcil hayvan, kurcalama, çizgi geçişi) almak ve işlemek
10. Kamera görüntüsü üzerinde tıklanabilir bölge tanımlayıp röle kontrol etmek

### B. AI ve Akıllı Algılama
11. Kamera akışını vLLM vision modeli ile gerçek zamanlı analiz etmek (düşme, yangın, kavga tespiti)
12. Kamera başına özel AI modeli ve prompt tanımlamak
13. Yüz tanıma ile belirli kişileri tespit etmek (referans yüz veritabanı)
14. Yüz eşleşmesinde otomatik sesli arama tetiklemek
15. Gizlilik için yüzleri otomatik bulanıklaştırmak (pikselasyon)
16. ONVIF olaylarında (insan tespiti, hareket) sesli arama tetiklemek
17. Canlı yayın sırasında bölge seçerek hedefli AI analizi yapmak
18. Video/fotoğraf mesajlarını AI ile analiz edip otomatik açıklama oluşturmak

### C. Medya İçerik
19. 30 saniyelik video mesajları kaydetmek ve konumla etiketlemek
20. Çoklu çözünürlükte fotoğraf çekmek (1080p, 1440p, 4K)
21. İçerikleri Google Places ile mekan etiketlemek (restoran, kafe, mağaza vb.)
22. İçerikleri herkese açık veya belirli alıcıya özel paylaşmak
23. İçeriklere yorum yazmak ve iç içe yorum dizileri oluşturmak
24. Görüntüleme sayısını takip etmek
25. Token bazlı paylaşım linki oluşturmak

### D. Harita ve Görselleştirme
26. Vektör harita üzerinde kameraları, yayınları, mesajları katmanlı görüntülemek
27. Bölgesel yüksek çözünürlüklü uydu görüntülerine geçiş yapmak
28. H3 altıgen ızgara ile dijital arazi sahipliğini görselleştirmek
29. TRON tarzı ışık izleri animasyonu ile sahiplik bağlantılarını görmek
30. Önceden tanımlı rotalarda araç simülasyonlarını izlemek
31. Kullanıcı konumlarını haritada göstermek/gizlemek
32. 3D modelleri ve parçacık efektlerini harita üzerinde renderlamak

### E. Kullanıcı ve Kimlik
33. Google OAuth 2.0 ile giriş yapmak
34. Yüz tanıma ile biyometrik giriş yapmak (canlılık algılama korumalı)
35. Kullanıcı profilini görüntülemek ve yönetmek
36. Konum paylaşımını açıp kapamak (diğer kullanıcılar tarafından görünürlük)
37. Plan bazlı özellik limitleri ile erişim kontrolü sağlamak

### F. Sesli Kontrol ve Arama
38. Türkçe sesli komutlarla haritayı kontrol etmek (merkez, zoom, sınırlar)
39. Acil durumlarda otomatik sesli arama (Entangle/Matrix) tetiklemek
40. Kamera bazlı sesli arama açma/kapama

### G. Tesla Entegrasyonu
41. Tesla dashcam videolarını SEI metadata ile oynatmak
42. GPS, hız, vites, direksiyon açısı, autopilot durumu overlay görmek
43. Araç rotasını haritada takip etmek

### H. Dijital Arazi Sahipliği
44. Kamera (50 puan), video (5 puan), fotoğraf (1 puan) ile H3 hücre sahipliği kazanmak
45. Liderlik tablosunda sıralama takip etmek
46. Sahip olunan bölgeleri haritada kullanıcı renk kodlu görmek
47. K-ring komşu hücre analizleri yapmak (1-5 halka)

### I. Yönetim ve Operasyon
48. Kullanıcıları yönetmek (plan atama, rol değiştirme, özellik override, devre dışı bırakma)
49. Abonelik planlarını CRUD ile yönetmek (limitler, özellik bayrakları)
50. ONVIF kamera şablonları oluşturmak (üretici/model bazlı)
51. Şehir kameralarını (HLS) yönetmek
52. Sistem ayarlarını merkezi olarak yapılandırmak (AI, sesli arama, Places)
53. Tüm servislerin sağlık durumunu gerçek zamanlı izlemek
54. Video/fotoğraf mesajlarını moderasyon amaçlı yönetmek (arama, silme, indirme)
55. İstatistik panelinden platform kullanımını takip etmek (kullanıcı, kamera, AI, mesaj)
56. Servisler arası ağ grafiğini ve veri akışını görselleştirmek

---

## 8. Servisler Arası Veri Akışı

```
                    ┌──────────────────────────────┐
                    │      KULLANICI (Tarayıcı)     │
                    │   MapLibre + WebRTC + HLS      │
                    │   deck.gl + Three.js + WS      │
                    └──────────────┬────────────────┘
                                   │ HTTPS
                    ┌──────────────▼────────────────┐
                    │    Caddy (Reverse Proxy)       │
                    │    qbitmap.com → frontend      │
                    │    stream.qbitmap.com → :3000   │
                    │    h3.qbitmap.com → 46.224:3100 │
                    │    tiles → :8081 (go-pmtiles)  │
                    └──────────────┬────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                          │
┌────────▼─────────┐    ┌─────────▼────────┐    ┌───────────▼──────────┐
│  QBitmap Backend  │    │    H3 Service     │    │       vLLM            │
│  Fastify + MySQL  │    │  Fastify + PG 16  │    │  (AI Vision Model)    │
│  91.99.219.248    │    │  46.224.128.93    │    │                       │
│                   │    │                   │    │ • Görüntü analizi     │
│ • Kamera CRUD     │◄──►│ • H3 grid        │    │ • Düşme/yangın tespiti│
│ • Auth (OAuth)    │sync│ • Dijital sahiplik│    │ • İçerik açıklama     │
│ • Medya yükleme   │    │ • Liderlik tablosu│    └───────────────────────┘
│ • AI proxy ───────┼────┼──────────────────┼──────────────►
│ • WebSocket       │    └──────────────────┘
│ • Kayıt yönetimi  │
│ • Yüz tanıma ─────┼───────────────────┐
│ • Sesli arama ─────┼──────────┐        │
│ • ONVIF webhook ◄──┼────┐     │        │
└────────┬───────────┘    │     │        │
         │                │     │        │
┌────────▼────────────────┼─────┼────────┼──────────────────┐
│        Server 2 (91.98.90.57)  │        │                  │
│                          │     │        │                  │
│  ┌───────────────┐  ┌───┴────┴──┐     │                  │
│  │   MediaMTX    │  │   ONVIF   │     │                  │
│  │               │  │   Events  │     │                  │
│  │ RTSP   :8554  │  │   :3001   │     │                  │
│  │ HLS    :8888  │  │           │     │                  │
│  │ WebRTC :8889  │  │ Motion    │     │                  │
│  │ RTMP   :1935  │  │ Human     │     │                  │
│  │ API    :9997  │  │ Pet       │     │                  │
│  │ Play   :9996  │  │ Vehicle   │     │                  │
│  │ Metric :9998  │  │ Tamper    │     │                  │
│  └───────┬───────┘  │ LineCross │     │                  │
│          │          └───────────┘     │                  │
│  ┌───────▼───────┐                    │                  │
│  │  RTSP Capture │                    │                  │
│  │    :3002      │                    │                  │
│  │  ffmpeg frame │                    │                  │
│  │  extraction   │                    │                  │
│  └───────────────┘                    │                  │
└───────────────────────────────────────┘                  │
         │                                                  │
┌────────▼──────────┐     ┌─────────────┐    ┌─────────────▼──┐
│  IP Kameralar      │     │ Entangle    │    │    Face API     │
│  RTSP / ONVIF      │     │ Matrix API  │    │ matcher.qbitwise│
│  GoPro (RTMP)      │     │ Sesli Arama │    │    .com          │
│  OBS (RTMP)        │     │ 91.98.131.74│    │                 │
│  Cihaz Kamerası    │     │    :8000    │    │ Yüz eşleştirme  │
└────────────────────┘     └─────────────┘    └─────────────────┘
```

---

## 9. Teknoloji Yığını Özeti

### Frontend Kütüphaneleri
| Kategori | Teknoloji |
|----------|-----------|
| Harita/GIS | MapLibre GL, deck.gl, h3-js, PMTiles, go-pmtiles |
| Video/Akış | HLS.js, Plyr, WHIP/WHEP (WebRTC), MediaRecorder API |
| 3D Grafik | Three.js |
| Yüz Tanıma | FacePlugin SDK, OpenCV.js |
| Encoding | protobuf.min.js (Tesla SEI) |
| Analitik | Google Analytics 4 |
| Auth | Google OAuth 2.0 |
| Gerçek Zamanlı | WebSocket, WebRTC |
| Ses | Web Speech API |

### Backend Teknolojileri
| Kategori | Teknoloji |
|----------|-----------|
| Framework | Fastify |
| Veritabanı | MySQL 8.0 (mysql2/promise) |
| Doğrulama | Zod |
| Güvenlik | Helmet, CORS, rate-limit |
| Dosya | @fastify/multipart |
| Sıkıştırma | @fastify/compress |
| Gerçek Zamanlı | @fastify/websocket |

### Altyapı
| Kategori | Teknoloji |
|----------|-----------|
| Web Sunucu | Caddy |
| Akış Sunucu | MediaMTX (Docker) |
| Tile Sunucu | go-pmtiles v1.30.0 |
| Süreç Yönetimi | systemd |
| Veritabanları | MySQL 8.0, PostgreSQL 16 |
| AI | vLLM (self-hosted) |
