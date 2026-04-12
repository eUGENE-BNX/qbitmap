import { QBitmapConfig } from '../../config.js';
import { escapeHtml } from '../../utils.js';
import { safeAvatarUrl } from './utils.js';

export const MessagesMixin = {
  async loadMessages() {
    const search = document.getElementById('msg-search').value.trim();
    const mediaType = document.getElementById('msg-type-filter').value;

    try {
      let url = `${QBitmapConfig.api.admin}/messages?page=${this.messagesPagination.page}&limit=${this.messagesPagination.limit}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (mediaType) url += `&media_type=${mediaType}`;

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load messages');

      const data = await response.json();
      this.messages = data.items;
      this.messagesPagination = { ...this.messagesPagination, ...data.pagination };
      this.renderMessages();
      this.renderMessagesPagination();
    } catch (error) {
      console.error('[Admin] Failed to load messages:', error);
      this.showToast('Failed to load messages', 'error');
    }
  },

  renderMessages() {
    const tbody = document.getElementById('messages-tbody');

    if (this.messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><h3>No messages found</h3><p>Try adjusting your filters</p></td></tr>';
      return;
    }

    tbody.innerHTML = this.messages.map(msg => {
      const isVideo = msg.media_type === 'video';
      const thumbHtml = msg.thumbnail_path
        ? `<img src="/uploads/${msg.thumbnail_path.replace(/^uploads\//, '')}" class="msg-thumbnail" alt="" loading="lazy">`
        : `<div class="msg-thumbnail-placeholder">${isVideo ? 'VID' : 'IMG'}</div>`;
      const sizeStr = this.formatFileSize(msg.file_size);
      const durationStr = isVideo && msg.duration_ms ? ` / ${(msg.duration_ms / 1000).toFixed(1)}s` : '';
      const visibility = msg.recipient_id ? '<span class="badge badge-private">Private</span>' : '<span class="badge badge-public">Public</span>';
      const tagsHtml = (msg.tags || []).map(t => `<span class="msg-tag">${escapeHtml(t)}</span>`).join('') || '<span class="msg-meta">-</span>';
      const aiSnippet = msg.ai_description ? `<div class="msg-ai-desc" title="${escapeHtml(msg.ai_description)}">${escapeHtml(msg.ai_description)}</div>` : '';

      return `<tr>
        <td>${thumbHtml}</td>
        <td><div class="msg-desc" title="${escapeHtml(msg.description || '')}">${escapeHtml(msg.description || 'No description')}</div>${aiSnippet}</td>
        <td><div class="user-cell"><img src="${safeAvatarUrl(msg.sender_avatar)}" alt="" class="user-avatar" style="width:24px;height:24px;"><span class="user-name" style="font-size:12px;">${escapeHtml(msg.sender_name || 'Unknown')}</span></div></td>
        <td><span class="badge badge-${msg.media_type}">${msg.media_type}</span>${visibility}</td>
        <td><span class="msg-meta">${sizeStr}${durationStr}</span></td>
        <td><span class="msg-meta">${msg.view_count}</span></td>
        <td><div class="msg-tags">${tagsHtml}</div></td>
        <td><span class="time-ago">${this.timeAgo(msg.created_at)}</span></td>
        <td><button class="btn btn-small btn-danger" data-action="delete-message" data-id="${msg.message_id}">Delete</button></td>
      </tr>`;
    }).join('');
  },

  renderMessagesPagination() {
    const container = document.getElementById('messages-pagination');
    const { page, totalPages } = this.messagesPagination;
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

  goToMessagesPage(page) { this.messagesPagination.page = page; this.loadMessages(); },

  async deleteMessage(messageId) {
    if (!confirm('Bu mesajı silmek istediğinize emin misiniz? Dosya da diskten silinecek.')) return;
    try {
      const response = await fetch(`${QBitmapConfig.api.admin}/messages/${messageId}`, { method: 'DELETE', credentials: 'include' });
      if (!response.ok) { const data = await response.json(); throw new Error((data.error?.message ?? data.error) || 'Failed to delete'); }
      this.showToast('Message deleted', 'success');
      this.loadMessages();
      this.loadStats();
    } catch (error) {
      console.error('[Admin] Delete message error:', error);
      this.showToast(error.message, 'error');
    }
  },
};
