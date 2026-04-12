import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';

export const PlansMixin = {
  async loadPlans() {
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/plans`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load plans');
      this.plans = await response.json();
      this.renderPlanFilter();
      this.renderPlans();
    } catch (error) {
      console.error('[Admin] Failed to load plans:', error);
    }
  },

  renderPlanFilter() {
    const select = document.getElementById('plan-filter');
    const options = ['<option value="">All Plans</option>'];
    this.plans.forEach(plan => {
      options.push(`<option value="${plan.id}">${escapeHtml(plan.display_name)}</option>`);
    });
    select.innerHTML = options.join('');
  },

  renderPlans() {
    const grid = document.getElementById('plans-grid');

    grid.innerHTML = this.plans.map(plan => `
      <div class="plan-card" data-plan-id="${plan.id}">
        <div class="plan-header">
          <span class="plan-name">${escapeHtml(plan.display_name)}</span>
          <span class="plan-users">${plan.user_count} users</span>
        </div>
        <div class="plan-features">
          <div class="plan-feature"><span class="plan-feature-name">Cameras</span><span class="plan-feature-value">${plan.max_cameras === -1 ? '∞' : plan.max_cameras}</span></div>
          <div class="plan-feature"><span class="plan-feature-name">WHEP</span><span class="plan-feature-value">${plan.max_whep_cameras === -1 ? '∞' : plan.max_whep_cameras}</span></div>
          <div class="plan-feature"><span class="plan-feature-name">AI Daily</span><span class="plan-feature-value ${plan.ai_analysis_enabled ? 'enabled' : 'disabled'}">${plan.ai_analysis_enabled ? (plan.ai_daily_limit === -1 ? '∞' : plan.ai_daily_limit) : '-'}</span></div>
          <div class="plan-feature"><span class="plan-feature-name">Face Recognition</span><span class="plan-feature-value ${plan.face_recognition_enabled ? 'enabled' : 'disabled'}">${plan.face_recognition_enabled ? (plan.max_faces_per_camera === -1 ? '∞' : plan.max_faces_per_camera + '/cam') : '-'}</span></div>
          <div class="plan-feature"><span class="plan-feature-name">Recording</span><span class="plan-feature-value ${plan.recording_enabled ? 'enabled' : 'disabled'}">${plan.recording_enabled ? (plan.max_recording_hours === -1 ? '∞' : plan.max_recording_hours + 'h') : '-'}</span></div>
          <div class="plan-feature"><span class="plan-feature-name">Voice Call</span><span class="plan-feature-value ${plan.voice_call_enabled ? 'enabled' : 'disabled'}">${plan.voice_call_enabled ? 'Yes' : '-'}</span></div>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.plan-card').forEach(card => {
      card.addEventListener('click', () => this.openPlanModal(parseInt(card.dataset.planId)));
    });
  },

  openPlanModal(planId = null) {
    this.editingPlanId = planId;
    const modal = document.getElementById('plan-modal');
    const title = document.getElementById('plan-modal-title');
    const deleteBtn = document.getElementById('delete-plan-btn');

    if (planId) {
      const plan = this.plans.find(p => p.id === planId);
      if (!plan) return;
      title.textContent = 'Edit Plan';
      deleteBtn.style.display = planId > 4 ? 'block' : 'none';
      document.getElementById('plan-name').value = plan.name;
      document.getElementById('plan-name').disabled = planId <= 4;
      document.getElementById('plan-display-name').value = plan.display_name;
      document.getElementById('plan-max-cameras').value = plan.max_cameras;
      document.getElementById('plan-max-whep').value = plan.max_whep_cameras;
      document.getElementById('plan-ai-enabled').checked = !!plan.ai_analysis_enabled;
      document.getElementById('plan-ai-limit').value = plan.ai_daily_limit;
      document.getElementById('plan-face-enabled').checked = !!plan.face_recognition_enabled;
      document.getElementById('plan-max-faces').value = plan.max_faces_per_camera;
      document.getElementById('plan-recording-enabled').checked = !!plan.recording_enabled;
      document.getElementById('plan-max-recording').value = plan.max_recording_hours;
      document.getElementById('plan-retention-days').value = plan.recording_retention_days;
      document.getElementById('plan-voice-call').checked = !!plan.voice_call_enabled;
      document.getElementById('plan-public-sharing').checked = !!plan.public_sharing_enabled;
      document.getElementById('plan-priority-support').checked = !!plan.priority_support;
    } else {
      title.textContent = 'New Plan';
      deleteBtn.style.display = 'none';
      document.getElementById('plan-name').value = '';
      document.getElementById('plan-name').disabled = false;
      document.getElementById('plan-display-name').value = '';
      document.getElementById('plan-max-cameras').value = 2;
      document.getElementById('plan-max-whep').value = 1;
      document.getElementById('plan-ai-enabled').checked = false;
      document.getElementById('plan-ai-limit').value = 0;
      document.getElementById('plan-face-enabled').checked = false;
      document.getElementById('plan-max-faces').value = 0;
      document.getElementById('plan-recording-enabled').checked = false;
      document.getElementById('plan-max-recording').value = 0;
      document.getElementById('plan-retention-days').value = 7;
      document.getElementById('plan-voice-call').checked = false;
      document.getElementById('plan-public-sharing').checked = false;
      document.getElementById('plan-priority-support').checked = false;
    }
    modal.classList.add('active');
  },

  closePlanModal() {
    document.getElementById('plan-modal').classList.remove('active');
    this.editingPlanId = null;
  },

  async savePlan() {
    const data = {
      name: document.getElementById('plan-name').value,
      display_name: document.getElementById('plan-display-name').value,
      max_cameras: parseInt(document.getElementById('plan-max-cameras').value),
      max_whep_cameras: parseInt(document.getElementById('plan-max-whep').value),
      ai_analysis_enabled: document.getElementById('plan-ai-enabled').checked,
      ai_daily_limit: parseInt(document.getElementById('plan-ai-limit').value),
      face_recognition_enabled: document.getElementById('plan-face-enabled').checked,
      max_faces_per_camera: parseInt(document.getElementById('plan-max-faces').value),
      recording_enabled: document.getElementById('plan-recording-enabled').checked,
      max_recording_hours: parseInt(document.getElementById('plan-max-recording').value),
      recording_retention_days: parseInt(document.getElementById('plan-retention-days').value),
      voice_call_enabled: document.getElementById('plan-voice-call').checked,
      public_sharing_enabled: document.getElementById('plan-public-sharing').checked,
      priority_support: document.getElementById('plan-priority-support').checked
    };

    try {
      const url = this.editingPlanId
        ? `${QBitmapConfig.api.admin}/plans/${this.editingPlanId}`
        : `${QBitmapConfig.api.admin}/plans`;
      const response = await fetch(url, {
        method: this.editingPlanId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to save plan'); }
      this.showToast('Plan saved successfully', 'success');
      this.closePlanModal();
      this.loadPlans();
    } catch (error) {
      console.error('[Admin] Failed to save plan:', error);
      this.showToast(error.message, 'error');
    }
  },

  async deletePlan() {
    if (!this.editingPlanId) return;
    if (!confirm('Are you sure you want to delete this plan?')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/plans/${this.editingPlanId}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Failed to delete plan'); }
      this.showToast('Plan deleted', 'success');
      this.closePlanModal();
      this.loadPlans();
    } catch (error) {
      console.error('[Admin] Failed to delete plan:', error);
      this.showToast(error.message, 'error');
    }
  },
};
