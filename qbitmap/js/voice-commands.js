/**
 * QBitmap Voice Commands Configuration
 * Sesli komut tanımları ve Türkçe normalizasyon
 */

const VoiceCommands = {
  // Uyandırma sözcükleri - bunlardan biri olmadan komut çalışmaz
  wakeWords: ['kubit', 'kübit', 'kbit', 'qbit', 'q bit', 'que bit'],

  commands: [
    // === Zoom Komutları ===
    { patterns: ['yaklaş', 'yakınlaş', 'zoom in', 'büyüt'], action: 'zoomIn' },
    { patterns: ['uzaklaş', 'zoom out', 'küçült'], action: 'zoomOut' },
    { patterns: ['bir seviye yaklaş', '1 seviye yaklaş'], action: 'zoomIn', params: { levels: 1 } },
    { patterns: ['iki seviye yaklaş', '2 seviye yaklaş'], action: 'zoomIn', params: { levels: 2 } },
    { patterns: ['üç seviye yaklaş', '3 seviye yaklaş'], action: 'zoomIn', params: { levels: 3 } },
    { patterns: ['bir seviye uzaklaş', '1 seviye uzaklaş'], action: 'zoomOut', params: { levels: 1 } },
    { patterns: ['iki seviye uzaklaş', '2 seviye uzaklaş'], action: 'zoomOut', params: { levels: 2 } },
    { patterns: ['üç seviye uzaklaş', '3 seviye uzaklaş'], action: 'zoomOut', params: { levels: 3 } },

    // === Şehir Navigasyonu ===
    { patterns: ['istanbul', 'istanbula git'], action: 'flyTo', params: { center: [29.0, 41.0], zoom: 10 } },
    { patterns: ['ankara', 'ankaraya git'], action: 'flyTo', params: { center: [32.85, 39.92], zoom: 10 } },
    { patterns: ['izmir', 'izmire git'], action: 'flyTo', params: { center: [27.14, 38.42], zoom: 10 } },
    { patterns: ['antalya', 'antalyaya git'], action: 'flyTo', params: { center: [30.71, 36.89], zoom: 10 } },
    { patterns: ['bursa', 'bursaya git'], action: 'flyTo', params: { center: [29.06, 40.19], zoom: 10 } },
    { patterns: ['adana', 'adanaya git'], action: 'flyTo', params: { center: [35.32, 37.0], zoom: 10 } },
    { patterns: ['konya', 'konyaya git'], action: 'flyTo', params: { center: [32.48, 37.87], zoom: 10 } },
    { patterns: ['trabzon', 'trabzona git'], action: 'flyTo', params: { center: [39.72, 41.0], zoom: 10 } },
    { patterns: ['diyarbakır', 'diyarbakira git'], action: 'flyTo', params: { center: [40.22, 37.91], zoom: 10 } },
    { patterns: ['samsun', 'samsuna git'], action: 'flyTo', params: { center: [36.33, 41.28], zoom: 10 } },
    { patterns: ['ataşehir', 'atasehir', 'ataşehire git', 'atasehire git'], action: 'flyTo', params: { center: [29.124, 40.991], zoom: 17.5 } },
    { patterns: ['sincan', 'sincana git'], action: 'flyTo', params: { center: [32.57650073, 39.96556239], zoom: 17.5 } },

    // === Harita Kontrolleri ===
    { patterns: ['tam ekran', 'fullscreen', 'full screen'], action: 'toggleFullscreen' },
    { patterns: ['kuzeye dön', 'kuzeye bak', 'kuzey'], action: 'resetBearing' },
    { patterns: ['sıfırla', 'başa dön', 'reset'], action: 'resetView' },

    // === Kamera Komutları ===
    { patterns: ['kadıköy kamera', 'kadikoy kamera'], action: 'openCityCamera', params: { keyword: 'kadikoy' } },
    { patterns: ['üsküdar kamera', 'uskudar kamera'], action: 'openCityCamera', params: { keyword: 'uskudar' } },
    { patterns: ['kameraları göster', 'kameralari goster'], action: 'showCameras' },
    { patterns: ['kameraları gizle', 'kameralari gizle'], action: 'hideCameras' },
    { patterns: ['kameralarım', 'kameralarim', 'kameralarin', 'kameralarımı', 'kameralarimi', 'my cameras'], action: 'openMyCameras' },

    // === Yardım ===
    { patterns: ['yardım', 'help', 'komutlar'], action: 'showHelp' },
    { patterns: ['dur', 'stop', 'kapat', 'sustur'], action: 'stopListening' },
  ],

  /**
   * Türkçe karakter normalizasyonu
   * Büyük/küçük harf ve Türkçe karakterleri standartlaştırır
   */
  normalize(text) {
    return text
      // Önce Türkçe büyük harfleri dönüştür (toLowerCase bunları düzgün yapmaz)
      .replace(/İ/g, 'i')
      .replace(/I/g, 'i')  // Türkçe'de I → ı ama biz i yapıyoruz
      .replace(/Ğ/g, 'g')
      .replace(/Ü/g, 'u')
      .replace(/Ş/g, 's')
      .replace(/Ö/g, 'o')
      .replace(/Ç/g, 'c')
      // Sonra diğer büyük harfleri küçült
      .toLowerCase()
      // Türkçe küçük harfleri ASCII'ye dönüştür
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      // Noktalama işaretlerini kaldır
      .replace(/[.,!?;:'"]/g, '')
      .trim();
  }
};
