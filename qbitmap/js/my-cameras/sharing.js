import { QBitmapConfig } from "../config.js";
import { Logger, escapeHtml, showNotification } from "../utils.js";
import { AuthSystem } from "../auth.js";

const SharingMixin = {
  async openShareModal(cameraId) {
    const camera = this.cameras.find(c => String(c.id) === String(cameraId));
    if (!camera) return;

    this.sharingCameraId = cameraId;

    const modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'claim-modal active';
    modal.innerHTML = `
      <div class="modal-overlay" onclick="MyCamerasSystem.closeShareModal()"></div>
      <div class="modal-content">
        <h3>Kamera Paylaş</h3>
        <p class="modal-desc"><strong>${escapeHtml(camera.name)}</strong> kamerasını paylaş</p>

        <div class="share-form">
          <input type="email" id="share-email" placeholder="Email adresi girin" autocomplete="off">
          <button class="btn-primary" onclick="MyCamerasSystem.shareCamera()">Paylaş</button>
        </div>
        <div id="share-error" class="claim-error"></div>

        <div class="share-section">
          <h4>Paylaşılan Kişiler</h4>
          <div class="shares-list" id="shares-list">
            <div class="shares-loading">Yükleniyor...</div>
          </div>
        </div>

        <div class="share-info">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span>Paylaşılan kişiler kamerayı sadece izleyebilir</span>
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" onclick="MyCamerasSystem.closeShareModal()">Kapat</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Focus email input
    document.getElementById('share-email').focus();

    // Load current shares
    await this.loadShares(cameraId);
  },

  /**
   * Close share modal
   */
  closeShareModal() {
    const modal = document.getElementById('share-modal');
    if (modal) modal.remove();
    this.sharingCameraId = null;
  },

  /**
   * Load shares for camera
   */
  async loadShares(cameraId) {
    const sharesList = document.getElementById('shares-list');

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${cameraId}/shares`, {
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to load shares');

      const data = await response.json();
      const shares = data.shares || [];

      if (shares.length === 0) {
        sharesList.innerHTML = '<div class="shares-empty">Henüz kimseyle paylaşılmadı</div>';
        return;
      }

      sharesList.innerHTML = shares.map(share => `
        <div class="share-item" data-share-id="${share.id}">
          <div class="share-user">
            ${share.shared_with_avatar
              ? `<img src="${escapeHtml(share.shared_with_avatar)}" alt="" class="share-avatar">`
              : `<div class="share-avatar-placeholder">${(share.shared_with_name || share.shared_with_email || '?')[0].toUpperCase()}</div>`
            }
            <div class="share-user-info">
              <span class="share-name">${escapeHtml(share.shared_with_name || share.shared_with_email)}</span>
              ${share.shared_with_name ? `<span class="share-email">${escapeHtml(share.shared_with_email)}</span>` : ''}
            </div>
          </div>
          <button class="btn-danger btn-sm" onclick="MyCamerasSystem.removeShare(${share.id})">Kaldır</button>
        </div>
      `).join('');

    } catch (error) {
      Logger.error('[Share] Load shares error:', error);
      sharesList.innerHTML = '<div class="shares-error">Paylaşımlar yüklenemedi</div>';
    }
  },

  /**
   * Share camera with email
   */
  async shareCamera() {
    const emailInput = document.getElementById('share-email');
    const errorDiv = document.getElementById('share-error');
    const email = emailInput.value.trim();

    errorDiv.textContent = '';

    if (!email) {
      errorDiv.textContent = 'Email adresi gerekli';
      return;
    }

    // Basic email validation
    if (!email.includes('@') || !email.includes('.')) {
      errorDiv.textContent = 'Geçerli bir email adresi girin';
      return;
    }

    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.sharingCameraId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (!response.ok) {
        errorDiv.textContent = data.error || 'Paylaşım başarısız';
        return;
      }

      // Clear input and reload shares
      emailInput.value = '';
      await this.loadShares(this.sharingCameraId);
      Analytics.event('camera_share');
      AuthSystem.showNotification('Kamera paylaşıldı', 'success');

    } catch (error) {
      Logger.error('[Share] Share camera error:', error);
      errorDiv.textContent = 'Bir hata oluştu';
    }
  },

  /**
   * Remove share
   */
  async removeShare(shareId) {
    try {
      const response = await fetch(`${this.apiBase}/me/cameras/${this.sharingCameraId}/shares/${shareId}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove share');
      }

      // Remove from list
      const shareItem = document.querySelector(`.share-item[data-share-id="${shareId}"]`);
      if (shareItem) shareItem.remove();

      // Check if list is empty
      const sharesList = document.getElementById('shares-list');
      if (sharesList && !sharesList.querySelector('.share-item')) {
        sharesList.innerHTML = '<div class="shares-empty">Henüz kimseyle paylaşılmadı</div>';
      }

      AuthSystem.showNotification('Paylaşım kaldırıldı', 'success');

    } catch (error) {
      Logger.error('[Share] Remove share error:', error);
      AuthSystem.showNotification('Paylaşım kaldırılamadı', 'error');
    }
  },

  // ==================== SHARED CAMERA ACTIONS ====================

  /**
   * View shared camera on map (fly to location)
   */
  viewSharedCamera(deviceId, lng, lat) {
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Close dashboard
    this.close();

    // Fly to camera location
    if (window.map) {
      window.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });
    }
  },

  /**
   * Open shared camera popup
   */
  openSharedCameraPopup(deviceId, lng, lat) {
    if (!lng || !lat) {
      AuthSystem.showNotification('Kameranın konumu belirlenmemiş', 'error');
      return;
    }

    // Close dashboard
    this.close();

    // Fly to camera location and open popup
    if (window.map) {
      window.map.flyTo({
        center: [lng, lat],
        zoom: 17,
        essential: true
      });

      // Wait for map to settle, then open popup
      setTimeout(() => {
        if (window.CameraSystem) {
          const camera = CameraSystem.cameras.find(c => c.device_id === deviceId);
          if (camera) {
            CameraSystem.openCameraPopup(camera, [lng, lat]);
          } else {
            AuthSystem.showNotification('Kamera haritada bulunamadı', 'error');
          }
        }
      }, 1500);
    }
  }
};

export { SharingMixin };
