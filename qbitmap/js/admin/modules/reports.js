import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';
import { safeAvatarUrl } from './utils.js';

const REASON_LABELS = {
  inappropriate: 'Uygunsuz',
  spam: 'Spam',
  misleading: 'Yaniltici',
  other: 'Diger'
};

const TYPE_LABELS = {
  camera: 'Camera',
  video_message: 'Video/Photo',
  broadcast: 'Broadcast',
  comment: 'Comment'
};

export const ReportsMixin = {
  async loadReports() {
    const search = document.getElementById('report-search').value.trim();
    const status = document.getElementById('report-status-filter').value;
    const entityType = document.getElementById('report-type-filter').value;

    try {
      let url = `${QBitmapConfig.api.admin}/reports?page=${this.reportsPagination.page}&limit=${this.reportsPagination.limit}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (status) url += `&status=${status}`;
      if (entityType) url += `&entity_type=${entityType}`;

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load reports');

      const data = await response.json();
      this.reports = data.items;
      this.reportsPagination = { ...this.reportsPagination, ...data.pagination };
      this.renderReports();
      this.renderReportsPagination();
    } catch (error) {
      console.error('[Admin] Failed to load reports:', error);
      this.showToast('Failed to load reports', 'error');
    }
  },

  renderReports() {
    const tbody = document.getElementById('reports-tbody');

    if (this.reports.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><h3>No reports found</h3><p>Try adjusting your filters</p></td></tr>';
      return;
    }

    tbody.innerHTML = this.reports.map(report => {
      const statusClass = report.status === 'pending' ? 'badge-pending' : report.status === 'resolved' ? 'badge-resolved' : 'badge-dismissed';
      const reasonLabel = REASON_LABELS[report.reason] || report.reason;
      const typeLabel = TYPE_LABELS[report.entity_type] || report.entity_type;
      const detailHtml = report.detail ? `<div class="msg-desc" title="${escapeHtml(report.detail)}">${escapeHtml(report.detail)}</div>` : '<span class="msg-meta">-</span>';

      // Thumbnail for video_message reports
      let thumbHtml;
      if (report.entity_type === 'video_message' && report.thumbnail_path) {
        const thumbSrc = `/uploads/${report.thumbnail_path.replace(/^uploads\//, '')}`;
        const hasCoords = report.content_lat && report.content_lng;
        thumbHtml = `<img src="${thumbSrc}" class="msg-thumbnail${hasCoords ? ' report-thumb-link' : ''}" alt="" loading="lazy"${hasCoords ? ` data-action="goto-content" data-lat="${report.content_lat}" data-lng="${report.content_lng}" data-entity-id="${escapeHtml(report.entity_id)}" data-entity-type="${report.entity_type}" title="Haritada gor"` : ''}>`;
      } else if (report.entity_type === 'video_message') {
        const isVideo = report.media_type === 'video';
        thumbHtml = `<div class="msg-thumbnail-placeholder">${isVideo ? 'VID' : 'IMG'}</div>`;
      } else {
        thumbHtml = `<div class="msg-thumbnail-placeholder" style="font-size:10px;">${typeLabel}</div>`;
      }

      // Content description
      const descHtml = report.content_description
        ? `<div class="msg-desc" title="${escapeHtml(report.content_description)}">${escapeHtml(report.content_description)}</div>`
        : `<span class="msg-meta" title="${escapeHtml(report.entity_id)}">${escapeHtml(report.entity_id.length > 24 ? report.entity_id.substring(0, 24) + '...' : report.entity_id)}</span>`;

      const actions = report.status === 'pending' ? `
        <button class="btn btn-small btn-danger" data-action="delete-reported-content" data-id="${report.id}">Sil</button>
        <button class="btn btn-small" data-action="dismiss-report" data-id="${report.id}">Yoksay</button>
      ` : `<span class="msg-meta">${report.resolved_by_name || '-'}</span>`;

      return `<tr>
        <td>${thumbHtml}</td>
        <td>${descHtml}</td>
        <td><span class="badge badge-${report.entity_type}">${typeLabel}</span></td>
        <td><span class="badge badge-reason">${reasonLabel}</span></td>
        <td>${detailHtml}</td>
        <td><div class="user-cell"><img src="${safeAvatarUrl(report.reporter_avatar)}" alt="" class="user-avatar" style="width:24px;height:24px;"><span class="user-name" style="font-size:12px;">${escapeHtml(report.reporter_name || report.reporter_email || 'Unknown')}</span></div></td>
        <td><span class="badge ${statusClass}">${report.status}</span></td>
        <td><span class="time-ago">${this.timeAgo(report.created_at)}</span></td>
        <td>${actions}</td>
      </tr>`;
    }).join('');
  },

  renderReportsPagination() {
    const container = document.getElementById('reports-pagination');
    const { page, totalPages } = this.reportsPagination;
    if (!totalPages || totalPages <= 1) { container.innerHTML = ''; return; }

    let html = `<button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (i === page - 2 || i === page + 2) { html += '<span class="page-btn">...</span>'; }
    }
    html += `<button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">Next</button>`;
    container.innerHTML = html;
  },

  goToReportsPage(page) { this.reportsPagination.page = page; this.loadReports(); },

  gotoReportedContent(lat, lng, entityId, entityType) {
    if (entityType === 'video_message') {
      // Deep link opens the message popup automatically
      window.open(`/?vmsg=${encodeURIComponent(entityId)}`, '_blank');
    } else {
      // For cameras/broadcasts, just navigate to coordinates
      window.open(`/#${lat},${lng},17`, '_blank');
    }
  },

  async dismissReport(reportId) {
    if (!confirm('Bu raporu yoksaymak istediginize emin misiniz?')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/reports/${reportId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'dismiss' })
      });
      if (!response.ok) { const data = await response.json(); throw new Error((data.error?.message ?? data.error) || 'Failed'); }
      this.showToast('Report dismissed', 'success');
      this.loadReports();
    } catch (error) {
      console.error('[Admin] Dismiss report error:', error);
      this.showToast(error.message, 'error');
    }
  },

  async deleteReportedContent(reportId) {
    if (!confirm('Bildirilen icerigi silmek istediginize emin misiniz? Bu islem geri alinamaz.')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/reports/${reportId}/content`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) { const data = await response.json(); throw new Error((data.error?.message ?? data.error) || 'Failed'); }
      this.showToast('Content deleted & report resolved', 'success');
      this.loadReports();
    } catch (error) {
      console.error('[Admin] Delete reported content error:', error);
      this.showToast(error.message, 'error');
    }
  },
};
