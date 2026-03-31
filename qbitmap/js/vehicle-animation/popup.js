import { escapeHtml } from '../utils.js';
import { hardcodedVideoUrls } from './routes.js';

/**
 * Vehicle popup management
 */
export const PopupMixin = {
  createVehiclePopup: function(vehicleId) {
    var existingPopup = document.getElementById('vehicle-popup-' + vehicleId);
    if (existingPopup) return existingPopup;

    var popup = document.createElement('div');
    popup.id = 'vehicle-popup-' + vehicleId;
    popup.className = 'vehicle-popup';
    popup.innerHTML = '<div class="vehicle-popup-header">' +
      '<button class="vehicle-popup-mjpeg" title="MJPEG Stream">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M23 7l-7 5 7 5V7z"></path>' +
          '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>' +
        '</svg>' +
      '</button>' +
      '<button class="vehicle-popup-edit" title="Düzenle">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
          '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>' +
        '</svg>' +
      '</button>' +
      '<button class="vehicle-popup-close">&times;</button>' +
    '</div>' +
    '<div class="vehicle-popup-camera">' +
      '<span class="vehicle-plate"></span>' +
      '<div class="camera-placeholder">Kamera bağlı değil</div>' +
      '<img class="camera-feed" style="display:none">' +
      '<video class="video-feed" style="display:none" autoplay loop muted playsinline></video>' +
    '</div>';

    var self = this;
    popup.querySelector('.vehicle-popup-mjpeg').addEventListener('click', function() { self.toggleMjpeg(vehicleId); });
    popup.querySelector('.vehicle-popup-edit').addEventListener('click', function() { self.editVehicle(vehicleId); });
    popup.querySelector('.vehicle-popup-close').addEventListener('click', function() { self.closePopup(vehicleId); });

    document.body.appendChild(popup);
    return popup;
  },

  setupClickHandler: function() {
    var self = this;
    this.map.on('click', 'vehicles', function(e) {
      if (e.features && e.features.length > 0) {
        var vehicleId = e.features[0].properties.id;
        self.showPopup(vehicleId);
      }
    });

    this.map.on('mouseenter', 'vehicles', function() {
      self.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', 'vehicles', function() {
      self.map.getCanvas().style.cursor = '';
    });
  },

  showPopup: function(vehicleId) {
    var self = this;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    if (this.activeVehicles[vehicleId]) {
      this.closePopup(vehicleId);
      return;
    }

    var popup = this.createVehiclePopup(vehicleId);
    popup.querySelector('.vehicle-plate').textContent = vehicle.plate;

    var cameraPlaceholder = popup.querySelector('.camera-placeholder');
    var cameraFeed = popup.querySelector('.camera-feed');
    var videoFeed = popup.querySelector('.video-feed');
    var refreshInterval = null;

    var videoUrl = vehicle.videoUrl || hardcodedVideoUrls[vehicleId] || null;

    if (videoUrl) {
      cameraPlaceholder.style.display = 'none';
      cameraFeed.style.display = 'none';
      videoFeed.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; object-fit:contain; background:#000;';
      videoFeed.src = videoUrl;
      videoFeed.play().catch(function() {});
    } else if (vehicle.whepUrl) {
      cameraPlaceholder.textContent = 'Bağlanıyor...';
      cameraPlaceholder.style.display = 'flex';
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';
      this.startWhepStream(vehicleId, vehicle.whepUrl, videoFeed, cameraPlaceholder);
    } else if (vehicle.cameraId) {
      cameraPlaceholder.textContent = 'Yükleniyor...';
      cameraPlaceholder.style.display = 'flex';
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';
      this.loadCameraFrame(vehicle.cameraId, cameraFeed, cameraPlaceholder);
      refreshInterval = setInterval(function() {
        var activeData = self.activeVehicles[vehicleId];
        if (activeData && !activeData.mjpegMode) {
          self.loadCameraFrame(vehicle.cameraId, cameraFeed, cameraPlaceholder);
        }
      }, 3000);
    } else {
      cameraFeed.style.display = 'none';
      videoFeed.style.display = 'none';
      cameraPlaceholder.style.display = 'flex';
      cameraPlaceholder.textContent = 'Kamera bağlı değil';
    }

    this.activeVehicles[vehicleId] = {
      popup: popup,
      refreshInterval: refreshInterval,
      mjpegMode: false
    };

    popup.classList.add('active');
    this.updatePopupPosition(vehicleId);
  },

  closePopup: function(vehicleId) {
    var activeData = this.activeVehicles[vehicleId];
    if (!activeData) return;

    var popup = activeData.popup;

    if (activeData.refreshInterval) {
      clearInterval(activeData.refreshInterval);
    }

    if (activeData.peerConnection) {
      activeData.peerConnection.close();
    }

    var cameraFeed = popup.querySelector('.camera-feed');
    if (cameraFeed) cameraFeed.src = '';

    var videoFeed = popup.querySelector('.video-feed');
    if (videoFeed) {
      videoFeed.pause();
      videoFeed.srcObject = null;
      videoFeed.src = '';
    }

    popup.classList.remove('active');
    setTimeout(function() {
      if (popup.parentNode) {
        popup.parentNode.removeChild(popup);
      }
    }, 300);

    delete this.activeVehicles[vehicleId];
  },

  closeAllPopups: function() {
    var self = this;
    Object.keys(this.activeVehicles).forEach(function(vehicleId) {
      self.closePopup(vehicleId);
    });
  },

  updatePopupPosition: function(vehicleId) {
    var activeData = this.activeVehicles[vehicleId];
    if (!activeData) return;

    var pos = this.vehiclePositions[vehicleId];
    if (!pos) return;

    var popup = activeData.popup;
    var point = this.map.project(pos);

    popup.style.left = point.x + 'px';
    popup.style.top = (point.y - 20) + 'px';
  },

  updateAllPopupPositions: function() {
    var self = this;
    Object.keys(this.activeVehicles).forEach(function(vehicleId) {
      self.updatePopupPosition(vehicleId);
    });
  },

  editVehicle: function(vehicleId) {
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    var modal = document.createElement('div');
    modal.id = 'vehicle-edit-modal';
    modal.className = 'vehicle-edit-modal active';
    modal.innerHTML = '<div class="modal-overlay"></div>' +
      '<div class="modal-content">' +
        '<h3>Araç Düzenle</h3>' +
        '<div class="form-group">' +
          '<label>Plaka</label>' +
          '<input type="text" id="edit-plate" value="' + escapeHtml(vehicle.plate) + '" placeholder="34 ABC 123">' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Kamera (opsiyonel)</label>' +
          '<div id="camera-dropdown-container">' +
            '<div class="camera-loading">Kameralar yükleniyor...</div>' +
          '</div>' +
        '</div>' +
        '<input type="hidden" id="edit-vehicle-id" value="' + escapeHtml(vehicleId) + '">' +
        '<div class="modal-actions">' +
          '<button class="btn-secondary">İptal</button>' +
          '<button class="btn-primary">Kaydet</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    var self = this;
    modal.querySelector('.modal-overlay').addEventListener('click', function() { self.closeEditModal(); });
    modal.querySelector('.btn-secondary').addEventListener('click', function() { self.closeEditModal(); });
    modal.querySelector('.btn-primary').addEventListener('click', function() { self.saveVehicleEdit(); });

    this.loadWhepCamerasDropdown(vehicle.cameraId);
  },

  closeEditModal: function() {
    var modal = document.getElementById('vehicle-edit-modal');
    if (modal) modal.remove();
  },

  saveVehicleEdit: function() {
    var vehicleId = document.getElementById('edit-vehicle-id').value;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    if (!vehicle) return;

    var plate = document.getElementById('edit-plate').value.trim();
    var selectEl = document.getElementById('edit-camera-id');
    var cameraId = selectEl.value.trim() || null;
    var whepUrl = null;

    if (selectEl.selectedIndex > 0) {
      var selectedOption = selectEl.options[selectEl.selectedIndex];
      whepUrl = selectedOption.getAttribute('data-whep-url') || null;
    }

    vehicle.plate = plate;
    vehicle.cameraId = cameraId;
    vehicle.whepUrl = whepUrl;

    this.saveVehicles();
    this.closeEditModal();

    if (this.activeVehicles[vehicleId]) {
      this.closePopup(vehicleId);
      this.showPopup(vehicleId);
    }
  },
};
