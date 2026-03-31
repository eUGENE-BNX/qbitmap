import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';

export const CityCamerasMixin = {
  async loadCityCameras() {
    try {
      const res = await fetch(`${QBitmapConfig.api.admin}/cameras/city`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      this.cityCameras = data.cameras || [];
      this.renderCityCameras();
    } catch (err) { console.error('City cameras load error:', err); }
  },

  renderCityCameras() {
    const tbody = document.getElementById('city-cameras-tbody');
    if (!tbody) return;
    if (this.cityCameras.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#666;">Henüz şehir kamerası yok</td></tr>';
      return;
    }
    tbody.innerHTML = this.cityCameras.map(cam => `
      <tr>
        <td>${cam.id}</td>
        <td>${escapeHtml(cam.name || '-')}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(cam.rtsp_source_url || '')}">${escapeHtml(cam.rtsp_source_url || '-')}</td>
        <td>${cam.lat ? `${Number(cam.lat).toFixed(4)}, ${Number(cam.lng).toFixed(4)}` : '-'}</td>
        <td><button class="btn btn-sm" data-action="edit-city-camera" data-id="${cam.id}">Düzenle</button></td>
      </tr>
    `).join('');
  },

  openCityCameraModal(cameraId) {
    this.editingCityCameraId = cameraId || null;
    const modal = document.getElementById('city-camera-modal');
    const title = document.getElementById('city-camera-modal-title');
    const deleteBtn = document.getElementById('city-cam-delete-btn');

    if (cameraId) {
      const cam = this.cityCameras.find(c => c.id === cameraId);
      if (!cam) return;
      title.textContent = 'Kamera Düzenle';
      document.getElementById('city-cam-name').value = cam.name || '';
      document.getElementById('city-cam-url').value = cam.rtsp_source_url || '';
      document.getElementById('city-cam-lat').value = cam.lat || '';
      document.getElementById('city-cam-lng').value = cam.lng || '';
      deleteBtn.style.display = 'inline-flex';
    } else {
      title.textContent = 'Yeni Şehir Kamerası';
      document.getElementById('city-cam-name').value = '';
      document.getElementById('city-cam-url').value = '';
      document.getElementById('city-cam-lat').value = '';
      document.getElementById('city-cam-lng').value = '';
      deleteBtn.style.display = 'none';
    }
    modal.classList.add('active');
  },

  closeCityCameraModal() {
    document.getElementById('city-camera-modal').classList.remove('active');
    this.editingCityCameraId = null;
  },

  async saveCityCamera() {
    const name = document.getElementById('city-cam-name').value.trim();
    const hls_url = document.getElementById('city-cam-url').value.trim();
    const lat = document.getElementById('city-cam-lat').value;
    const lng = document.getElementById('city-cam-lng').value;

    if (!name) return alert('Kamera adı gerekli');
    if (!hls_url) return alert('HLS URL gerekli');
    if (!hls_url.endsWith('.m3u8')) return alert('URL .m3u8 ile bitmelidir');

    const body = { name, hls_url };
    if (lat) body.lat = parseFloat(lat);
    if (lng) body.lng = parseFloat(lng);

    try {
      let res;
      if (this.editingCityCameraId) {
        res = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${this.editingCityCameraId}`, {
          method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
      } else {
        res = await fetch(`${QBitmapConfig.api.admin}/cameras/city`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kayıt başarısız');
      this.closeCityCameraModal();
      this.loadCityCameras();
    } catch (err) { alert('Hata: ' + err.message); }
  },

  async deleteCityCamera() {
    if (!this.editingCityCameraId) return;
    if (!confirm('Bu kamerayı silmek istediğinize emin misiniz?')) return;
    try {
      const res = await fetch(`${QBitmapConfig.api.admin}/cameras/city/${this.editingCityCameraId}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Silme başarısız'); }
      this.closeCityCameraModal();
      this.loadCityCameras();
    } catch (err) { alert('Hata: ' + err.message); }
  },
};
