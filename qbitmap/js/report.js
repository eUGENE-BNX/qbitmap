import '../css/report.css';
import { QBitmapConfig } from './config.js';
import { AuthSystem } from './auth.js';

const REASONS = [
  { value: 'inappropriate', label: 'Uygunsuz icerik' },
  { value: 'spam', label: 'Spam' },
  { value: 'misleading', label: 'Yaniltici' },
  { value: 'other', label: 'Diger' }
];

// Warning triangle SVG icon
const REPORT_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

export const ReportSystem = {
  apiBase: QBitmapConfig.api.base + '/api/reports',

  /**
   * Get the report button HTML for camera/broadcast popups (cam-btn style)
   */
  getCamBtnHtml() {
    return `<button class="cam-btn report-btn" title="Uygunsuz icerigi bildir">${REPORT_ICON_SVG}</button>`;
  },

  /**
   * Get the report button HTML for video message popup header
   */
  getMsgBtnHtml() {
    return `<button class="video-msg-report-btn" data-action="report-content" title="Uygunsuz icerigi bildir">${REPORT_ICON_SVG}</button>`;
  },

  /**
   * Get the report button HTML for comments
   */
  getCommentBtnHtml(commentId) {
    return `<button class="comment-report-btn" data-report-comment="${commentId}" title="Yorumu bildir"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></button>`;
  },

  /**
   * Show the report dialog modal
   */
  showReportDialog(entityType, entityId) {
    if (!AuthSystem.isLoggedIn()) {
      AuthSystem.showNotification('Bildirim yapmak icin giris yapin', 'error');
      return;
    }

    // Remove any existing modal
    document.getElementById('report-modal')?.remove();

    const reasonsHtml = REASONS.map(r =>
      `<label class="report-reason"><input type="radio" name="report-reason" value="${r.value}"> ${r.label}</label>`
    ).join('');

    const overlay = document.createElement('div');
    overlay.id = 'report-modal';
    overlay.className = 'report-modal-overlay';
    overlay.innerHTML = `
      <div class="report-modal">
        <div class="report-modal-header">
          <h3>Icerik Bildir</h3>
          <button class="report-modal-close">&times;</button>
        </div>
        <div class="report-modal-body">
          <p class="report-modal-desc">Bu icerigin neden uygunsuz oldugunu belirtin:</p>
          ${reasonsHtml}
          <textarea class="report-detail" placeholder="Aciklama (istege bagli)..." maxlength="500" style="display:none"></textarea>
        </div>
        <div class="report-modal-footer">
          <button class="report-cancel-btn">Iptal</button>
          <button class="report-submit-btn" disabled>Bildir</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.report-modal');
    const closeBtn = overlay.querySelector('.report-modal-close');
    const cancelBtn = overlay.querySelector('.report-cancel-btn');
    const submitBtn = overlay.querySelector('.report-submit-btn');
    const detailArea = overlay.querySelector('.report-detail');
    const radios = overlay.querySelectorAll('input[name="report-reason"]');

    const close = () => overlay.remove();

    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    // Show detail textarea when "other" is selected
    radios.forEach(radio => {
      radio.onchange = () => {
        submitBtn.disabled = false;
        detailArea.style.display = radio.value === 'other' ? 'block' : 'none';
      };
    });

    submitBtn.onclick = async () => {
      const selected = overlay.querySelector('input[name="report-reason"]:checked');
      if (!selected) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Gonderiliyor...';

      const reason = selected.value;
      const detail = detailArea.value.trim() || null;

      try {
        const res = await fetch(`${this.apiBase}/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ reason, detail })
        });

        if (res.status === 409) {
          // Already reported
          modal.innerHTML = `
            <div class="report-modal-already">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p>Bu icerigi zaten bildirdiniz.</p>
            </div>
          `;
          setTimeout(close, 2000);
          return;
        }

        if (!res.ok) throw new Error('Report failed');

        // Success
        modal.innerHTML = `
          <div class="report-modal-success">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <p>Bildiriminiz alindi. Tesekkurler.</p>
          </div>
        `;
        setTimeout(close, 2000);
      } catch (error) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Bildir';
        AuthSystem.showNotification('Bildirim gonderilemedi', 'error');
      }
    };
  }
};
