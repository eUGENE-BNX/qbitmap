/**
 * QBitmap Comment Widget
 * Reusable comment system for video messages, cameras, etc.
 */

const CommentWidget = {
  apiBase: null,

  // Current active instance state
  activeEntityType: null,
  activeEntityId: null,
  activeContainer: null,

  init() {
    this.apiBase = QBitmapConfig.api.base + '/api/comments';
  },

  // Render comment section into a container
  async render(container, entityType, entityId) {
    this.activeEntityType = entityType;
    this.activeEntityId = entityId;
    this.activeContainer = container;

    const isLoggedIn = typeof AuthSystem !== 'undefined' && AuthSystem.isLoggedIn();

    container.innerHTML = `
      <div class="comments-section">
        <div class="comments-list" data-comments-list></div>
        <button class="comments-load-more" data-comments-load-more style="display:none">Daha eski yorumlar</button>
        ${isLoggedIn ? `
        <div class="comments-input-row">
          <input type="text" class="comments-input" data-comments-input placeholder="Yorum yaz..." maxlength="500" />
          <button class="comments-submit" data-comments-submit title="Gonder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
        ` : ''}
      </div>
    `;

    // Wire events
    const input = container.querySelector('[data-comments-input]');
    const submitBtn = container.querySelector('[data-comments-submit]');
    const loadMoreBtn = container.querySelector('[data-comments-load-more]');

    if (input && submitBtn) {
      submitBtn.onclick = () => this._handleSubmit(entityType, entityId, input);
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._handleSubmit(entityType, entityId, input);
        }
      };
    }

    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => this._loadMore(entityType, entityId);
    }

    // Load initial comments
    await this._loadComments(entityType, entityId);
  },

  async _loadComments(entityType, entityId) {
    try {
      const response = await fetch(
        `${this.apiBase}?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`,
        { credentials: 'include' }
      );
      if (!response.ok) return;

      const data = await response.json();
      const list = this.activeContainer?.querySelector('[data-comments-list]');
      if (!list) return;

      list.innerHTML = '';

      // Comments come DESC (newest first), reverse for display (oldest on top)
      const comments = (data.comments || []).reverse();
      for (const c of comments) {
        list.appendChild(this._createCommentEl(c));
      }

      // Scroll to bottom
      list.scrollTop = list.scrollHeight;

      // Show/hide load more
      const loadMoreBtn = this.activeContainer?.querySelector('[data-comments-load-more]');
      if (loadMoreBtn) {
        loadMoreBtn.style.display = data.hasMore ? '' : 'none';
        if (data.hasMore && comments.length > 0) {
          loadMoreBtn.dataset.beforeId = comments[0].id; // oldest visible
        }
      }
    } catch (e) {
      // Silently fail
    }
  },

  async _loadMore(entityType, entityId) {
    const loadMoreBtn = this.activeContainer?.querySelector('[data-comments-load-more]');
    const beforeId = loadMoreBtn?.dataset.beforeId;
    if (!beforeId) return;

    try {
      const response = await fetch(
        `${this.apiBase}?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}&before=${beforeId}`,
        { credentials: 'include' }
      );
      if (!response.ok) return;

      const data = await response.json();
      const list = this.activeContainer?.querySelector('[data-comments-list]');
      if (!list) return;

      const prevScrollHeight = list.scrollHeight;

      // Prepend older comments (they come DESC, reverse for display)
      const comments = (data.comments || []).reverse();
      const fragment = document.createDocumentFragment();
      for (const c of comments) {
        fragment.appendChild(this._createCommentEl(c));
      }
      list.insertBefore(fragment, list.firstChild);

      // Maintain scroll position
      list.scrollTop = list.scrollHeight - prevScrollHeight;

      // Update load more
      if (loadMoreBtn) {
        loadMoreBtn.style.display = data.hasMore ? '' : 'none';
        if (data.hasMore && comments.length > 0) {
          loadMoreBtn.dataset.beforeId = comments[0].id;
        }
      }
    } catch (e) {
      // Silently fail
    }
  },

  async _handleSubmit(entityType, entityId, input) {
    const content = input.value.trim();
    if (!content) return;

    const submitBtn = this.activeContainer?.querySelector('[data-comments-submit]');
    if (submitBtn) submitBtn.disabled = true;
    input.disabled = true;

    try {
      const response = await fetch(this.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ entityType, entityId, content })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (err.error) Logger.warn('[Comments] Submit error:', err.error);
        return;
      }

      input.value = '';
      Analytics.event('comment_post', { entity_type: entityType });

      // Comment will appear via WebSocket broadcast
      // But also add locally for instant feedback
      const data = await response.json();
      if (data.comment) {
        this._appendComment(data.comment);
      }
    } catch (e) {
      Logger.warn('[Comments] Submit failed:', e);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  },

  _appendComment(comment) {
    const list = this.activeContainer?.querySelector('[data-comments-list]');
    if (!list) return;

    // Avoid duplicate (WebSocket may arrive after local append)
    if (list.querySelector(`[data-comment-id="${comment.id}"]`)) return;

    list.appendChild(this._createCommentEl(comment));
    list.scrollTop = list.scrollHeight;
  },

  _createCommentEl(comment) {
    const isOwn = typeof AuthSystem !== 'undefined' && AuthSystem.isLoggedIn() &&
                  AuthSystem.getCurrentUser()?.id === comment.user_id;

    const div = document.createElement('div');
    div.className = 'comment-item';
    div.dataset.commentId = comment.id;

    const esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };

    div.innerHTML = `
      <img class="comment-avatar" src="${esc(comment.user_avatar || '')}" alt="" onerror="this.style.display='none'" />
      <div class="comment-body">
        <div class="comment-meta">
          <span class="comment-author">${esc(comment.user_name || 'Kullanici')}</span>
          <span class="comment-time">${esc(this.formatTimeAgo(comment.created_at))}</span>
          ${isOwn ? '<button class="comment-delete" title="Sil">&times;</button>' : ''}
        </div>
        <div class="comment-text">${esc(comment.content)}</div>
      </div>
    `;

    // Wire delete button
    if (isOwn) {
      const deleteBtn = div.querySelector('.comment-delete');
      if (deleteBtn) {
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          this._deleteComment(comment.id);
        };
      }
    }

    return div;
  },

  async _deleteComment(commentId) {
    try {
      const response = await fetch(`${this.apiBase}/${commentId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) return;

      // Remove from DOM immediately
      this._removeCommentEl(commentId);
    } catch (e) {
      // Silently fail
    }
  },

  _removeCommentEl(commentId) {
    const el = this.activeContainer?.querySelector(`[data-comment-id="${commentId}"]`);
    if (el) el.remove();
  },

  // WebSocket handlers
  handleCommentNew(payload) {
    // Only add if it matches the currently active entity
    if (!this.activeContainer) return;
    if (payload.entityType !== this.activeEntityType || payload.entityId !== this.activeEntityId) return;

    this._appendComment({
      id: payload.commentId,
      user_id: payload.userId,
      user_name: payload.userName,
      user_avatar: payload.userAvatar,
      content: payload.content,
      created_at: payload.createdAt
    });
  },

  handleCommentDeleted(payload) {
    if (!this.activeContainer) return;
    if (payload.entityType !== this.activeEntityType || payload.entityId !== this.activeEntityId) return;

    this._removeCommentEl(payload.commentId);
  },

  // Cleanup when popup closes
  destroy() {
    this.activeEntityType = null;
    this.activeEntityId = null;
    this.activeContainer = null;
  },

  formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return 'Az once';
    if (diffMin < 60) return `${diffMin} dk once`;
    if (diffHour < 24) return `${diffHour} saat once`;
    if (diffDay < 7) return `${diffDay} gun once`;
    return date.toLocaleDateString('tr-TR');
  }
};

// Auto-init when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  if (typeof QBitmapConfig !== 'undefined') {
    CommentWidget.init();
  }
});
