import { QBitmapConfig } from '../config.js';
import { Logger, escapeHtml, TimerManager } from '../utils.js';

/**
 * QBitmap Camera System - Recordings Modal Module
 * Handles recordings list display and video playback
 */

const RecordingsModalMixin = {
  // Plyr instance
  recordingsPlayer: null,
  currentRecordingCamera: null,
  // Pagination state
  recordingsPage: 1,
  recordingsHasMore: false,
  recordingsLoading: false,

  /**
   * Open recordings modal for a camera (by deviceId)
   */
  async openRecordingsModal(deviceId) {
    const camera = this.cameras.find(c => c.device_id === deviceId);
    if (!camera) {
      Logger.warn('[Recordings] Camera not found:', deviceId);
      return;
    }
    await this.openRecordingsModalWithCamera(camera);
  },

  /**
   * Open recordings modal with camera object directly
   */
  async openRecordingsModalWithCamera(camera) {
    if (!camera) return;

    this.currentRecordingCamera = camera;

    // Create modal if doesn't exist
    let modal = document.getElementById('recordings-modal');
    if (!modal) {
      modal = this.createRecordingsModal();
      document.body.appendChild(modal);
    }

    // Update title - just bold camera name
    modal.querySelector('.recordings-modal-title').textContent =
      camera.name || camera.device_id;

    // Reset pagination state
    this.recordingsPage = 1;
    this.recordingsHasMore = false;

    // Show loading state
    const listContainer = modal.querySelector('.recordings-list');
    listContainer.innerHTML = '<div class="recordings-loading"><div class="spinner"></div><span>Yükleniyor...</span></div>';

    // Show modal
    modal.classList.add('active');

    // Load recordings
    await this.loadRecordingsList(camera.device_id, true);
  },

  /**
   * Create recordings modal HTML
   */
  createRecordingsModal() {
    const modal = document.createElement('div');
    modal.id = 'recordings-modal';
    modal.className = 'recordings-modal';
    modal.innerHTML = `
      <div class="recordings-modal-overlay"></div>
      <div class="recordings-modal-content">
        <div class="recordings-modal-header">
          <h2 class="recordings-modal-title">Kayitlar</h2>
          <button class="recordings-modal-close">&times;</button>
        </div>
        <div class="recordings-modal-body">
          <div class="recordings-player-container">
            <video id="recordings-video" playsinline controls></video>
            <div class="recordings-no-selection">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Oynatmak icin bir kayit secin</span>
            </div>
          </div>
          <div class="recordings-list-container">
            <div class="recordings-list"></div>
          </div>
        </div>
      </div>
    `;

    // Static event listeners
    modal.querySelector('.recordings-modal-overlay').addEventListener('click', () => this.closeRecordingsModal());
    modal.querySelector('.recordings-modal-close').addEventListener('click', () => this.closeRecordingsModal());

    // Event delegation for dynamic list items
    modal.querySelector('.recordings-list').addEventListener('click', (e) => {
      const playBtn = e.target.closest('.recording-play-btn');
      if (playBtn) {
        const item = playBtn.closest('.recording-item');
        this.playRecording(this.currentRecordingCamera.device_id, item.dataset.start, item.dataset.duration);
        return;
      }
      const downloadBtn = e.target.closest('.recording-download-btn');
      if (downloadBtn) {
        const item = downloadBtn.closest('.recording-item');
        this.downloadRecording(this.currentRecordingCamera.device_id, item.dataset.start, item.dataset.duration);
        return;
      }
      const deleteBtn = e.target.closest('.recording-delete-btn');
      if (deleteBtn) {
        const item = deleteBtn.closest('.recording-item');
        this.deleteRecording(this.currentRecordingCamera.device_id, item.dataset.start);
        return;
      }
      const loadMoreBtn = e.target.closest('.recordings-load-more');
      if (loadMoreBtn) {
        this.loadMoreRecordings();
        return;
      }
      const retryBtn = e.target.closest('.recordings-error button');
      if (retryBtn) {
        this.refreshRecordingsList();
        return;
      }
    });

    return modal;
  },

  /**
   * Load recordings list from API with pagination
   */
  async loadRecordingsList(deviceId, reset = false) {
    const listContainer = document.querySelector('.recordings-list');
    if (!listContainer || this.recordingsLoading) return;

    this.recordingsLoading = true;

    if (reset) {
      this.recordingsPage = 1;
    }

    try {
      const response = await fetch(
        `${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/list?page=${this.recordingsPage}&limit=20`,
        { credentials: 'include' }
      );

      if (!response.ok) {
        throw new Error('Failed to load recordings');
      }

      const data = await response.json();
      // Filter out very short recordings (less than 3 seconds) - these are usually artifacts
      const recordings = (data.recordings || []).filter(rec => rec.duration >= 3);
      this.recordingsHasMore = data.hasMore;

      if (reset && recordings.length === 0) {
        listContainer.innerHTML = `
          <div class="recordings-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>Henuz kayit yok</span>
          </div>
        `;
        return;
      }

      // Generate HTML for recordings
      const recordingsHtml = recordings.map(rec => {
        const startDate = new Date(rec.start);
        const duration = this.formatDuration(rec.duration);
        const dateStr = startDate.toLocaleDateString('tr-TR', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });

        return `
          <div class="recording-item" data-start="${rec.start}" data-duration="${rec.duration}">
            <button class="recording-play-btn" title="Oynat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </button>
            <div class="recording-info">
              <span class="recording-date">${dateStr}</span>
              <span class="recording-duration">${duration}</span>
            </div>
            <div class="recording-actions">
              <button class="recording-download-btn" title="Indir">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
              </button>
              <button class="recording-delete-btn" title="Sil">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Load more button HTML
      const loadMoreHtml = this.recordingsHasMore ? `
        <button class="recordings-load-more">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          Daha fazla yükle
        </button>
      ` : '';

      if (reset) {
        listContainer.innerHTML = recordingsHtml + loadMoreHtml;
      } else {
        // Remove existing load more button and append new items
        const existingLoadMore = listContainer.querySelector('.recordings-load-more');
        if (existingLoadMore) existingLoadMore.remove();
        listContainer.insertAdjacentHTML('beforeend', recordingsHtml + loadMoreHtml);
      }

    } catch (error) {
      Logger.error('[Recordings] Load error:', error);
      listContainer.innerHTML = `
        <div class="recordings-error">
          <span>Kayitlar yuklenemedi</span>
          <button>Tekrar Dene</button>
        </div>
      `;
    } finally {
      this.recordingsLoading = false;
    }
  },

  /**
   * Load more recordings (next page)
   */
  async loadMoreRecordings() {
    if (!this.currentRecordingCamera || !this.recordingsHasMore) return;
    this.recordingsPage++;
    await this.loadRecordingsList(this.currentRecordingCamera.device_id, false);
  },

  /**
   * Play a recording
   */
  async playRecording(deviceId, start, duration) {
    const videoEl = document.getElementById('recordings-video');
    const noSelection = document.querySelector('.recordings-no-selection');

    if (!videoEl) return;

    // Hide no selection message
    if (noSelection) noSelection.style.display = 'none';

    // Build video URL
    const videoUrl = `${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/get?start=${encodeURIComponent(start)}&duration=${duration}`;

    // Destroy existing Plyr instance
    if (this.recordingsPlayer) {
      this.recordingsPlayer.destroy();
      this.recordingsPlayer = null;
    }
    // Release any prior Media Session from the previous clip.
    if (this._mediaSessionCleanup) {
      this._mediaSessionCleanup();
      this._mediaSessionCleanup = null;
    }

    // Reset video element
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    // Set video source
    videoEl.src = videoUrl;

    // Wait for video to be ready before initializing Plyr
    videoEl.onloadedmetadata = () => {
      // Initialize Plyr after source is loaded
      this.recordingsPlayer = new Plyr(videoEl, {
        controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
        hideControls: false,
        resetOnEnd: true
      });

      // [PWA] Media Session — lock-screen metadata + play/pause/seek for
      // the recorded clip. Not live, so seek bar + position state stay on.
      import('../../src/pwa/media-session.js').then(({ wireMediaSession }) => {
        const cam = this.cameras?.find((c) => c.device_id === deviceId);
        const cameraName = cam?.name || cam?.device_id || 'Kayıt';
        const when = new Date(start);
        const fmt = isNaN(when) ? '' : when.toLocaleString('tr-TR', {
          dateStyle: 'medium', timeStyle: 'short',
        });
        this._mediaSessionCleanup = wireMediaSession(videoEl, {
          title: cameraName,
          artist: fmt,
          album: 'QBitmap Kayıt',
          live: false,
        });
      }).catch(() => {});

      // Play
      videoEl.play().catch(() => {});
    };

    videoEl.onerror = () => {
      Logger.error('[Recordings] Video load error');
    };

    // Highlight selected item
    document.querySelectorAll('.recording-item').forEach(item => {
      item.classList.toggle('active', item.dataset.start === start);
    });
  },

  /**
   * Download a recording
   */
  downloadRecording(deviceId, start, duration) {
    const downloadUrl = `${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/get?start=${encodeURIComponent(start)}&duration=${duration}&download=true`;

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `recording_${deviceId}_${new Date(start).toISOString().replace(/[:.]/g, '-')}.mp4`;
    a.click();
  },

  /**
   * Delete a recording
   */
  async deleteRecording(deviceId, start) {
    if (!confirm('Bu kaydi silmek istediginizden emin misiniz?')) {
      return;
    }

    try {
      const response = await fetch(
        `${QBitmapConfig.api.users.replace('/users', '')}/recordings/${deviceId}/delete?start=${encodeURIComponent(start)}`,
        { method: 'DELETE', credentials: 'include' }
      );

      if (!response.ok) {
        throw new Error('Failed to delete recording');
      }

      // Remove from UI
      const item = document.querySelector(`.recording-item[data-start="${start}"]`);
      if (item) {
        item.remove();
      }

      // Check if list is empty
      const listContainer = document.querySelector('.recordings-list');
      if (listContainer && !listContainer.querySelector('.recording-item')) {
        listContainer.innerHTML = `
          <div class="recordings-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>Henuz kayit yok</span>
          </div>
        `;
      }

    } catch (error) {
      Logger.error('[Recordings] Delete error:', error);
      alert('Kayit silinemedi');
    }
  },

  /**
   * Close recordings modal
   */
  closeRecordingsModal() {
    const modal = document.getElementById('recordings-modal');
    if (modal) {
      modal.classList.remove('active');
    }

    // Destroy player
    if (this.recordingsPlayer) {
      this.recordingsPlayer.destroy();
      this.recordingsPlayer = null;
    }
    // Release the Media Session so no stale "Now Playing" chip remains.
    if (this._mediaSessionCleanup) {
      this._mediaSessionCleanup();
      this._mediaSessionCleanup = null;
    }

    // Reset video
    const videoEl = document.getElementById('recordings-video');
    if (videoEl) {
      videoEl.src = '';
    }

    // Show no selection message
    const noSelection = document.querySelector('.recordings-no-selection');
    if (noSelection) noSelection.style.display = 'flex';

    this.currentRecordingCamera = null;
  },

  /**
   * Format duration in seconds to mm:ss
   */
  formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
};

export { RecordingsModalMixin };
