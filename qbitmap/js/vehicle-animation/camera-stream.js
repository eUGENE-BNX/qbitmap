import { QBitmapConfig } from '../config.js';
import { AuthSystem } from '../auth.js';
import { escapeHtml, Logger } from '../utils.js';

/**
 * Camera streaming methods for vehicle popups
 */
export const CameraStreamMixin = {
  loadCameraFrame: function(cameraId, imgElement, placeholder) {
    fetch(QBitmapConfig.api.public + '/cameras/' + cameraId + '/latest')
      .then(function(response) {
        if (!response.ok) throw new Error('No frame');
        return response.json();
      })
      .then(function(data) {
        var frame = data.frame;
        var frameUrl = frame.id === 'cached'
          ? QBitmapConfig.api.public + '/frames/cached?device_id=' + cameraId + '&t=' + Date.now()
          : QBitmapConfig.api.public + '/frames/' + frame.id + '?t=' + Date.now();

        imgElement.onload = function() {
          placeholder.style.display = 'none';
          imgElement.style.display = 'block';
        };

        imgElement.onerror = function() {
          imgElement.style.display = 'none';
          placeholder.style.display = 'flex';
          placeholder.textContent = 'Görüntü alınamıyor';
        };

        imgElement.src = frameUrl;
      })
      .catch(function() {
        imgElement.style.display = 'none';
        placeholder.style.display = 'flex';
        placeholder.textContent = 'Kamera çevrimdışı';
      });
  },

  startWhepStream: function(vehicleId, whepUrl, videoEl, placeholder) {
    var self = this;

    if (!whepUrl || !videoEl) {
      placeholder.textContent = 'WHEP URL bulunamadı';
      return;
    }

    var pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    var activeData = this.activeVehicles[vehicleId];
    if (activeData) {
      activeData.peerConnection = pc;
    }

    pc.ontrack = function(event) {
      Logger.log('[VehicleWHEP] Got track:', event.track.kind);
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.style.cssText = 'display:block; position:absolute; top:0; left:0; width:100%; height:100%; object-fit:contain; background:#000;';
        placeholder.style.display = 'none';

        videoEl.play().catch(function(err) {
          Logger.error('[VehicleWHEP] Play error:', err);
        });
      }
    };

    pc.oniceconnectionstatechange = function() {
      Logger.log('[VehicleWHEP] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        placeholder.textContent = 'Bağlantı kesildi';
        placeholder.style.display = 'flex';
        videoEl.style.display = 'none';
      }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.createOffer()
      .then(function(offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function() {
        var proxyUrl = QBitmapConfig.api.public + '/whep-proxy?url=' + encodeURIComponent(whepUrl);
        return fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp
        });
      })
      .then(function(response) {
        if (!response.ok) throw new Error('WHEP proxy failed: ' + response.status);
        return response.text();
      })
      .then(function(answerSdp) {
        if (!answerSdp) throw new Error('No SDP in response');
        return pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: answerSdp
        }));
      })
      .then(function() {
        Logger.log('[VehicleWHEP] Connected successfully');
      })
      .catch(function(error) {
        Logger.error('[VehicleWHEP] Error:', error);
        placeholder.textContent = 'Bağlantı hatası';
        placeholder.style.display = 'flex';
        videoEl.style.display = 'none';
      });
  },

  toggleMjpeg: function(vehicleId) {
    var self = this;
    var vehicle = this.vehicles.find(function(v) { return v.id === vehicleId; });
    var activeData = this.activeVehicles[vehicleId];
    if (!vehicle || !vehicle.cameraId || !activeData) return;

    var popup = activeData.popup;
    var mjpegBtn = popup.querySelector('.vehicle-popup-mjpeg');
    var cameraFeed = popup.querySelector('.camera-feed');
    var placeholder = popup.querySelector('.camera-placeholder');

    activeData.mjpegMode = !activeData.mjpegMode;

    if (activeData.mjpegMode) {
      mjpegBtn.classList.add('active');

      if (activeData.refreshInterval) {
        clearInterval(activeData.refreshInterval);
        activeData.refreshInterval = null;
      }

      placeholder.textContent = 'MJPEG bağlanıyor...';
      placeholder.style.display = 'flex';
      cameraFeed.style.display = 'none';

      var retryCount = 0;
      var maxRetries = 10;

      var tryLoadStream = function() {
        cameraFeed.onload = function() {
          placeholder.style.display = 'none';
          cameraFeed.style.display = 'block';
        };

        cameraFeed.onerror = function() {
          retryCount++;
          var currentData = self.activeVehicles[vehicleId];
          if (retryCount < maxRetries && currentData && currentData.mjpegMode) {
            setTimeout(tryLoadStream, 1000);
          } else {
            placeholder.textContent = 'MJPEG bağlanamadı';
            placeholder.style.display = 'flex';
            cameraFeed.style.display = 'none';
          }
        };

        cameraFeed.src = QBitmapConfig.api.public + '/stream/' + vehicle.cameraId + '?t=' + Date.now();
      };

      setTimeout(tryLoadStream, 500);
    } else {
      mjpegBtn.classList.remove('active');
      cameraFeed.src = '';

      this.loadCameraFrame(vehicle.cameraId, cameraFeed, placeholder);

      activeData.refreshInterval = setInterval(function() {
        var currentData = self.activeVehicles[vehicleId];
        if (currentData && !currentData.mjpegMode) {
          self.loadCameraFrame(vehicle.cameraId, cameraFeed, placeholder);
        }
      }, 3000);
    }
  },

  loadWhepCamerasDropdown: function(selectedCameraId) {
    var container = document.getElementById('camera-dropdown-container');
    if (!container) return;

    if (!AuthSystem.isLoggedIn()) {
      container.innerHTML = '<div class="camera-auth-warning">' +
        '<span>Kamera seçmek için giriş yapın</span>' +
        '<button class="btn-secondary btn-sm">Giriş Yap</button>' +
      '</div>';
      var self = this;
      container.querySelector('.btn-secondary').addEventListener('click', function() { self.closeEditModal(); AuthSystem.login(); });
      return;
    }

    fetch(QBitmapConfig.api.users + '/me/cameras', { credentials: 'include' })
      .then(function(response) {
        if (!response.ok) throw new Error('Failed to load cameras');
        return response.json();
      })
      .then(function(data) {
        var cameras = data.cameras || [];
        var whepCameras = cameras.filter(function(cam) {
          return cam.camera_type === 'whep';
        });

        var html = '<select id="edit-camera-id">';
        html += '<option value="">Kamera seçmeyin</option>';

        whepCameras.forEach(function(cam) {
          var selected = cam.device_id === selectedCameraId ? ' selected' : '';
          html += '<option value="' + escapeHtml(cam.device_id) + '" data-whep-url="' + escapeHtml(cam.whep_url || '') + '"' + selected + '>' +
            escapeHtml(cam.name || cam.device_id) + '</option>';
        });
        html += '</select>';

        if (whepCameras.length === 0) {
          html += '<small>Henüz IP kameranız yok</small>';
        } else {
          html += '<small>IP/RTSP kameralarınız listelenir</small>';
        }

        container.innerHTML = html;
      })
      .catch(function(error) {
        Logger.error('[VehicleEdit] Camera load error:', error);
        container.innerHTML = '<div class="camera-error">Kameralar yüklenemedi</div>';
      });
  },
};
