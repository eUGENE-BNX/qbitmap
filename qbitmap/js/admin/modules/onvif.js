import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';

export const OnvifMixin = {
  async loadOnvifTemplates() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load ONVIF templates');
      const data = await response.json();
      this.onvifTemplates = data.templates || [];
      this.renderOnvifTemplates();
    } catch (error) { console.error('[Admin] Failed to load ONVIF templates:', error); }
  },

  renderOnvifTemplates() {
    const tbody = document.getElementById('onvif-tbody');
    if (!tbody) return;
    tbody.innerHTML = this.onvifTemplates.map(template => `
      <tr>
        <td>${template.id}</td>
        <td><strong>${escapeHtml(template.modelName)}</strong></td>
        <td>${escapeHtml(template.manufacturer)}</td>
        <td>${template.onvifPort}</td>
        <td><div class="event-tags">${(template.supportedEvents || []).map(e => `<span class="event-tag event-${escapeHtml(e)}">${escapeHtml(e)}</span>`).join('')}</div></td>
        <td><button class="btn btn-sm btn-ghost" data-action="edit-onvif" data-id="${template.id}">Edit</button></td>
      </tr>
    `).join('');
  },

  openOnvifModal(templateId = null) {
    this.editingOnvifId = templateId;
    const modal = document.getElementById('onvif-modal');
    const deleteBtn = document.getElementById('delete-onvif-btn');

    document.getElementById('onvif-model-name').value = '';
    document.getElementById('onvif-manufacturer').value = '';
    document.getElementById('onvif-port').value = '2020';
    ['motion', 'human', 'pet', 'vehicle', 'tamper', 'line'].forEach(event => {
      const cb = document.getElementById(`onvif-event-${event}`);
      if (cb) cb.checked = (event === 'motion');
    });

    if (templateId) {
      const template = this.onvifTemplates.find(t => t.id === templateId);
      if (template) {
        document.getElementById('onvif-modal-title').textContent = 'Edit ONVIF Profile';
        document.getElementById('onvif-model-name').value = template.modelName || '';
        document.getElementById('onvif-manufacturer').value = template.manufacturer || '';
        document.getElementById('onvif-port').value = template.onvifPort || 2020;
        const events = template.supportedEvents || [];
        ['motion', 'human', 'pet', 'vehicle', 'tamper', 'line'].forEach(event => {
          const cb = document.getElementById(`onvif-event-${event}`);
          if (cb) cb.checked = events.includes(event) || events.includes(event.replace('line', 'line_crossing'));
        });
        deleteBtn.style.display = templateId === 1 ? 'none' : 'block';
      }
    } else {
      document.getElementById('onvif-modal-title').textContent = 'New ONVIF Profile';
      deleteBtn.style.display = 'none';
    }
    modal.classList.add('active');
  },

  closeOnvifModal() {
    document.getElementById('onvif-modal').classList.remove('active');
    this.editingOnvifId = null;
  },

  async saveOnvifTemplate() {
    const modelName = document.getElementById('onvif-model-name').value.trim();
    const manufacturer = document.getElementById('onvif-manufacturer').value.trim();
    const onvifPort = parseInt(document.getElementById('onvif-port').value) || 2020;
    if (!modelName || !manufacturer) { this.showToast('Model name and manufacturer are required', 'error'); return; }

    const supportedEvents = [];
    if (document.getElementById('onvif-event-motion')?.checked) supportedEvents.push('motion');
    if (document.getElementById('onvif-event-human')?.checked) supportedEvents.push('human');
    if (document.getElementById('onvif-event-pet')?.checked) supportedEvents.push('pet');
    if (document.getElementById('onvif-event-vehicle')?.checked) supportedEvents.push('vehicle');
    if (document.getElementById('onvif-event-tamper')?.checked) supportedEvents.push('tamper');
    if (document.getElementById('onvif-event-line')?.checked) supportedEvents.push('line_crossing');

    try {
      const url = this.editingOnvifId ? `${QBitmapConfig.api.admin}/onvif-templates/${this.editingOnvifId}` : `${QBitmapConfig.api.admin}/onvif-templates`;
      const response = await fetch(url, {
        method: this.editingOnvifId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ modelName, manufacturer, onvifPort, supportedEvents })
      });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to save template'); }
      this.showToast('ONVIF profile saved', 'success');
      this.closeOnvifModal();
      this.loadOnvifTemplates();
    } catch (error) { console.error('[Admin] Failed to save ONVIF template:', error); this.showToast(error.message, 'error'); }
  },

  async deleteOnvifTemplate() {
    if (!this.editingOnvifId || this.editingOnvifId === 1) return;
    if (!confirm('Are you sure you want to delete this ONVIF profile?')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/onvif-templates/${this.editingOnvifId}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to delete template'); }
      this.showToast('ONVIF profile deleted', 'success');
      this.closeOnvifModal();
      this.loadOnvifTemplates();
    } catch (error) { console.error('[Admin] Failed to delete ONVIF template:', error); this.showToast(error.message, 'error'); }
  },
};
