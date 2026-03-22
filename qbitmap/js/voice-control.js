/**
 * QBitmap Voice Control System
 * Web Speech API ile sesli harita kontrolü
 */

window.VoiceControl = {
  recognition: null,
  isListening: false,
  lastCommand: null,
  lastCommandTime: 0,
  transcriptBuffer: [],
  bufferDuration: 3000,    // 3 saniye buffer
  debounceMs: 2000,        // 2 saniye spam koruması
  boundToggle: null,       // For cleanup
  boundBeforeUnload: null, // For cleanup on page unload
  restartAttempts: 0,      // Track restart attempts to prevent infinite loops
  maxRestartAttempts: 10,  // Maximum restart attempts before stopping

  // Default center/zoom from config
  get defaultCenter() {
    return typeof QBitmapConfig !== 'undefined'
      ? QBitmapConfig.map.defaultCenter
      : [29.12304, 40.99112];
  },
  get defaultZoom() {
    return typeof QBitmapConfig !== 'undefined'
      ? QBitmapConfig.map.defaultZoom
      : 14.5;
  },

  /**
   * Sistemi başlat
   */
  init() {
    // Browser desteği kontrolü
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      Logger.warn('[Voice] SpeechRecognition bu tarayıcıda desteklenmiyor');
      this.hideMicButton();
      return false;
    }

    // Check if user has voice control feature enabled
    // Will be checked against AuthSystem.user.features.voiceControl
    this.checkUserPermission();

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'tr-TR';
    this.recognition.maxAlternatives = 3;

    this.setupEvents();
    this.bindMicButton();

    // Register beforeunload cleanup to prevent memory leaks
    this.boundBeforeUnload = () => this.cleanup();
    window.addEventListener('beforeunload', this.boundBeforeUnload);

    Logger.log('[Voice] Sistem hazır');
    return true;
  },

  /**
   * Check if user has voice control permission
   */
  checkUserPermission() {
    // If AuthSystem is available and user is logged in
    if (window.AuthSystem && AuthSystem.user) {
      const hasPermission = AuthSystem.user.features?.voiceControl;
      if (!hasPermission) {
        Logger.warn('[Voice] Ses kontrolü bu hesap için aktif değil');
        this.hideMicButton();
        return false;
      }
    }
    return true;
  },

  /**
   * Speech Recognition event'lerini ayarla
   */
  setupEvents() {
    this.recognition.onresult = (event) => this.handleResult(event);
    this.recognition.onerror = (event) => this.handleError(event);
    this.recognition.onend = () => this.handleEnd();
    this.recognition.onstart = () => this.handleStart();
    this.recognition.onspeechstart = () => Logger.log('[Voice] Konuşma algılandı');
    this.recognition.onspeechend = () => Logger.log('[Voice] Konuşma bitti');
  },

  /**
   * Tanıma sonuçlarını işle
   */
  handleResult(event) {
    const now = Date.now();

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      const confidence = result[0].confidence;
      const isFinal = result.isFinal;

      // Buffer'a ekle
      this.transcriptBuffer.push({
        text: transcript,
        time: now,
        isFinal,
        confidence
      });

      // 3 saniyeden eski kayıtları temizle
      this.transcriptBuffer = this.transcriptBuffer.filter(
        item => now - item.time < this.bufferDuration
      );

      // Son 3 saniyedeki tüm metni birleştir
      const fullText = this.transcriptBuffer.map(t => t.text).join(' ');

      // Debug log
      if (isFinal) {
        Logger.log('[Voice] Final:', transcript, `(${(confidence * 100).toFixed(0)}%)`);
      }

      // Wake word ve komut ara
      this.processText(fullText, isFinal);
    }
  },

  /**
   * Metni işle ve komut ara
   */
  processText(text, isFinal) {
    const normalized = VoiceCommands.normalize(text);

    // Wake word kontrolü
    const hasWakeWord = VoiceCommands.wakeWords.some(w =>
      normalized.includes(VoiceCommands.normalize(w))
    );

    if (!hasWakeWord) return;

    // Komutları kontrol et (uzun pattern'ler önce)
    const sortedCommands = [...VoiceCommands.commands].sort((a, b) => {
      const maxA = Math.max(...a.patterns.map(p => p.length));
      const maxB = Math.max(...b.patterns.map(p => p.length));
      return maxB - maxA;
    });

    for (const cmd of sortedCommands) {
      for (const pattern of cmd.patterns) {
        const normalizedPattern = VoiceCommands.normalize(pattern);
        if (normalized.includes(normalizedPattern)) {
          this.executeCommand(cmd, pattern);
          return;
        }
      }
    }
  },

  /**
   * Komutu çalıştır
   */
  executeCommand(cmd, matchedPattern) {
    const now = Date.now();

    // Debounce kontrolü
    if (this.lastCommand === cmd.action &&
        now - this.lastCommandTime < this.debounceMs) {
      Logger.log('[Voice] Debounced:', cmd.action);
      return;
    }

    this.lastCommand = cmd.action;
    this.lastCommandTime = now;
    this.transcriptBuffer = [];

    Logger.log('[Voice] Çalıştırılıyor:', cmd.action, cmd.params || '');
    this.showFeedback(matchedPattern);

    // Komutu çalıştır
    this.runAction(cmd.action, cmd.params);
  },

  /**
   * Aksiyonu gerçekleştir
   */
  runAction(action, params = {}) {
    const map = window.map;
    if (!map && action !== 'stopListening' && action !== 'showHelp') {
      Logger.warn('[Voice] Harita bulunamadı');
      return;
    }

    switch (action) {
      case 'zoomIn': {
        const levels = params.levels || 1;
        const currentZoom = map.getZoom();
        map.easeTo({ zoom: currentZoom + levels, duration: 300 });
        break;
      }

      case 'zoomOut': {
        const levels = params.levels || 1;
        const currentZoom = map.getZoom();
        map.easeTo({ zoom: currentZoom - levels, duration: 300 });
        break;
      }

      case 'flyTo':
        map.flyTo({
          center: params.center,
          zoom: params.zoom || 10,
          essential: true
        });
        break;

      case 'toggleFullscreen':
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.body.requestFullscreen().catch(e => {
            Logger.warn('[Voice] Fullscreen hatası:', e);
          });
        }
        break;

      case 'resetBearing':
        map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
        break;

      case 'resetView':
        map.flyTo({
          center: this.defaultCenter,
          zoom: this.defaultZoom,
          bearing: 0,
          pitch: 0,
          essential: true
        });
        break;

      case 'showCameras':
        // CameraSystem varsa kameraları göster
        if (window.CameraSystem && typeof CameraSystem.showAllCameras === 'function') {
          CameraSystem.showAllCameras();
        }
        break;

      case 'hideCameras':
        // CameraSystem varsa kameraları gizle
        if (window.CameraSystem && typeof CameraSystem.hideAllCameras === 'function') {
          CameraSystem.hideAllCameras();
        }
        break;

      case 'openMyCameras': {
        // Async IIFE - API'den kamera listesi çek ve git
        const self = this;
        (async () => {
          try {
            Logger.log('[Voice] openMyCameras başlıyor...');

            // Auth kontrolü - email varsa login
            const userEmail = window.AuthSystem?.user?.email;
            Logger.log('[Voice] userEmail:', userEmail);

            if (!userEmail) {
              self.showFeedback('Önce giriş yapın', 'error');
              return;
            }

            // API'den kameraları çek
            Logger.log('[Voice] API çağrılıyor...');
            const response = await fetch('https://stream.qbitmap.com/api/users/me/cameras', {
              credentials: 'include'
            });

            Logger.log('[Voice] API response:', response.status);

            if (!response.ok) {
              self.showFeedback('Kameralar yüklenemedi', 'error');
              return;
            }

            const cameras = await response.json();
            Logger.log('[Voice] API kameralar:', cameras);

            // Koordinatı olan ilk kamerayı bul
            const camera = cameras.find(c => c.lat && c.lng);

            if (camera) {
              Logger.log('[Voice] FlyTo:', camera.lng, camera.lat);
              map.flyTo({
                center: [camera.lng, camera.lat],
                zoom: 15,
                essential: true
              });
            } else {
              Logger.log('[Voice] Koordinatlı kamera bulunamadı');
            }

            // Paneli de aç
            loadScript('/js/my-cameras.js?v=20260206').then(() => {
              if (window.MyCamerasSystem?.open) MyCamerasSystem.open();
            });
          } catch (err) {
            Logger.error('[Voice] openMyCameras hatası:', err);
            self.showFeedback('Bir hata oluştu', 'error');
          }
        })();
        break;
      }

      case 'openCityCamera': {
        const self = this;
        (async () => {
          try {
            // CameraSystem'den city kamerasını bul
            if (!window.CameraSystem || !CameraSystem.cameras) {
              self.showFeedback('Kamera sistemi yüklenmedi', 'error');
              return;
            }

            // Kamerayı bul (isimde keyword içeren)
            const keyword = params.keyword || 'kadikoy';
            const camera = CameraSystem.cameras.find(c =>
              c.camera_type === 'city' &&
              VoiceCommands.normalize(c.name || '').includes(keyword)
            );

            if (!camera) {
              self.showFeedback('Kamera bulunamadı', 'error');
              return;
            }

            // Popup'ı aç
            await CameraSystem.openCameraPopup(camera, [camera.lng, camera.lat]);

            // Popup açıldıktan sonra koordinatlara git (popup merkeze gelsin)
            if (camera.lng && camera.lat) {
              setTimeout(() => {
                map.flyTo({
                  center: [camera.lng, camera.lat],
                  zoom: 17,
                  essential: true
                });
              }, 100);
            }

            self.showFeedback('Kamera açılıyor', 'info');
          } catch (err) {
            Logger.error('[Voice] openCityCamera hatası:', err);
            self.showFeedback('Bir hata oluştu', 'error');
          }
        })();
        break;
      }

      case 'showHelp':
        this.showHelpToast();
        break;

      case 'stopListening':
        this.stop();
        this.showFeedback('Dinleme durduruldu', 'info');
        break;

      default:
        Logger.warn('[Voice] Bilinmeyen aksiyon:', action);
    }
  },

  /**
   * Dinlemeyi başlat/durdur
   */
  toggle() {
    if (this.isListening) {
      this.stop();
    } else {
      this.start();
    }
  },

  /**
   * Dinlemeyi başlat
   */
  start() {
    try {
      this.recognition.start();
    } catch (e) {
      // Zaten çalışıyorsa hata verir, yoksay
      Logger.log('[Voice] Start hatası (muhtemelen zaten çalışıyor):', e.message);
    }
  },

  /**
   * Dinlemeyi durdur
   */
  stop() {
    this.isListening = false;
    this.updateButton(false);
    try {
      this.recognition.stop();
    } catch (e) {
      Logger.log('[Voice] Stop hatası:', e.message);
    }
  },

  /**
   * Dinleme başladığında
   */
  handleStart() {
    this.isListening = true;
    this.restartAttempts = 0; // Reset on successful start
    this.updateButton(true);
    Logger.log('[Voice] Dinleme başladı');
    this.showFeedback('Dinleniyor...', 'info');
  },

  /**
   * Dinleme bittiğinde - sürekli dinleme için otomatik yeniden başlat
   */
  handleEnd() {
    if (this.isListening) {
      // Check restart attempt limit to prevent infinite loops
      this.restartAttempts++;
      if (this.restartAttempts >= this.maxRestartAttempts) {
        Logger.warn('[Voice] Maximum restart attempts reached, stopping');
        this.stop();
        this.showFeedback('Mikrofon bağlantısı başarısız', 'error');
        return;
      }

      // Küçük gecikme ile yeniden başlat
      setTimeout(() => {
        if (this.isListening) {
          try {
            this.recognition.start();
          } catch (e) {
            Logger.log('[Voice] Yeniden başlatma hatası:', e.message);
          }
        }
      }, 100);
    }
  },

  /**
   * Hata durumunda
   */
  handleError(event) {
    Logger.error('[Voice] Hata:', event.error);

    switch (event.error) {
      case 'not-allowed':
        this.showFeedback('Mikrofon izni gerekli', 'error');
        this.isListening = false;
        this.updateButton(false);
        break;

      case 'no-speech':
        // Sessizlik, normal - yoksay
        break;

      case 'network':
        this.showFeedback('Ağ hatası', 'error');
        break;

      case 'aborted':
        // Kullanıcı tarafından durduruldu
        break;

      default:
        this.showFeedback(`Hata: ${event.error}`, 'error');
    }
  },

  /**
   * Mikrofon butonunu güncelle
   */
  updateButton(active) {
    const btn = document.getElementById('mic-button');
    if (btn) {
      btn.classList.toggle('active', active);
      btn.title = active ? 'Dinlemeyi Durdur' : 'Sesli Komut';
      btn.setAttribute('aria-pressed', active);
      btn.setAttribute('aria-label', active ? 'Dinlemeyi durdur' : 'Sesli komut');
    }
  },

  /**
   * Mikrofon butonunu gizle (desteklenmeyen tarayıcılarda)
   */
  hideMicButton() {
    const btn = document.getElementById('mic-button');
    if (btn) {
      btn.style.display = 'none';
    }
  },

  /**
   * Feedback toast göster
   */
  showFeedback(message, type = 'success') {
    // Mevcut toast'ları temizle
    document.querySelectorAll('.voice-feedback').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `voice-feedback ${type}`;
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
      </svg>
      <span>${message}</span>
    `;
    document.body.appendChild(toast);

    // Animasyonlu göster
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 2 saniye sonra kaldır
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  },

  /**
   * Yardım toast'ı göster
   */
  showHelpToast() {
    const helpText = `
      Komutlar: yaklaş, uzaklaş, istanbul, ankara, izmir, tam ekran, kuzey, sıfırla, dur
    `.trim();
    this.showFeedback(helpText, 'info');
  },

  /**
   * Mikrofon butonunu bağla
   */
  bindMicButton() {
    const btn = document.getElementById('mic-button');
    if (btn && !btn._voiceBound) {
      btn._voiceBound = true;
      this.boundToggle = () => this.toggle();
      btn.addEventListener('click', this.boundToggle);
    }
  },

  /**
   * Cleanup - remove event listeners and stop recognition
   */
  cleanup() {
    // Stop recognition
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {}
      this.recognition = null;
    }
    this.isListening = false;

    // Remove mic button listener
    const btn = document.getElementById('mic-button');
    if (btn && this.boundToggle) {
      btn.removeEventListener('click', this.boundToggle);
      btn._voiceBound = false;
    }
    this.boundToggle = null;

    // Remove beforeunload listener
    if (this.boundBeforeUnload) {
      window.removeEventListener('beforeunload', this.boundBeforeUnload);
      this.boundBeforeUnload = null;
    }
  }
};

// DOM hazır olduğunda başlat
document.addEventListener('DOMContentLoaded', () => {
  VoiceControl.init();
});
