/**
 * Upload Outbox UI — pending-count badge + inspector modal.
 *
 * Listens to the outbox events from upload-outbox.js:
 *   qbitmap:outbox-enqueued
 *   qbitmap:outbox-sent
 *   qbitmap:outbox-dropped
 *   qbitmap:outbox-updated
 *
 * Keeps a tiny badge in view whenever count > 0 so users don't forget
 * they have pending messages, and a modal they can open to manually
 * retry or discard individual records.
 */
import { count, list, drain, retryOne, discard } from './upload-outbox.js';
import { escapeHtml } from '../html-escape.js';

let _badge = null;

export function initOutboxUI() {
  if (typeof window === 'undefined') return;
  if (window.__qbitmapOutboxUIWired) return;
  window.__qbitmapOutboxUIWired = true;

  _ensureBadge();
  _refresh();

  window.addEventListener('qbitmap:outbox-updated', _refresh);
  window.addEventListener('qbitmap:outbox-enqueued', _refresh);
  window.addEventListener('qbitmap:outbox-sent', _refresh);
  window.addEventListener('qbitmap:outbox-dropped', _refresh);
}

function _ensureBadge() {
  if (_badge) return;
  _badge = document.createElement('button');
  _badge.type = 'button';
  _badge.id = 'qb-outbox-badge';
  _badge.className = 'qb-outbox-badge';
  _badge.setAttribute('aria-label', 'Bekleyen yüklemeleri göster');
  _badge.hidden = true;
  _badge.addEventListener('click', openInspector);
  document.body.appendChild(_badge);
}

async function _refresh() {
  if (!_badge) return;
  const n = await count();
  if (n <= 0) {
    _badge.hidden = true;
    _badge.textContent = '';
    return;
  }
  _badge.hidden = false;
  _badge.textContent = `${n} bekliyor`;
}

function _fmtAgo(ts) {
  const dt = Math.max(0, Date.now() - ts);
  const m = Math.floor(dt / 60000);
  if (m < 1) return 'az önce';
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  const d = Math.floor(h / 24);
  return `${d} gün önce`;
}

function _fmtFilename(record) {
  const names = (record.files || []).map((f) => f.filename).filter(Boolean);
  if (names.length === 0) return '(dosyasız)';
  if (names.length === 1) return names[0];
  return `${names[0]} (+${names.length - 1} daha)`;
}

async function openInspector() {
  if (document.getElementById('qb-outbox-modal')) return;
  const records = await list();
  const overlay = document.createElement('div');
  overlay.id = 'qb-outbox-modal';
  overlay.className = 'qb-outbox-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'qb-outbox-title');
  overlay.innerHTML =
    '<div class="qb-outbox-dialog">' +
      '<header class="qb-outbox-header">' +
        '<h2 id="qb-outbox-title">Bekleyen yüklemeler</h2>' +
        '<button type="button" class="qb-outbox-close" aria-label="Kapat">&times;</button>' +
      '</header>' +
      '<div class="qb-outbox-body">' + _renderList(records) + '</div>' +
      '<footer class="qb-outbox-footer">' +
        `<button type="button" class="qb-outbox-drain"${records.length === 0 ? ' disabled' : ''}>Hepsini dene</button>` +
      '</footer>' +
    '</div>';
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.qb-outbox-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.qb-outbox-drain').addEventListener('click', async () => {
    await drain();
    // list + badge refresh happens via 'qbitmap:outbox-updated'
    const remaining = await list();
    const body = overlay.querySelector('.qb-outbox-body');
    body.innerHTML = _renderList(remaining);
    _wireItemActions(overlay);
    if (remaining.length === 0) overlay.querySelector('.qb-outbox-drain').disabled = true;
  });
  _wireItemActions(overlay);
}

function _renderList(records) {
  if (records.length === 0) {
    return '<p class="qb-outbox-empty">Bekleyen bir şey yok.</p>';
  }
  return (
    '<ul class="qb-outbox-list">' +
    records.map((r) => (
      '<li class="qb-outbox-item" data-id="' + escapeHtml(r.id) + '">' +
        '<div class="qb-outbox-item-info">' +
          `<div class="qb-outbox-item-name">${escapeHtml(_fmtFilename(r))}</div>` +
          `<div class="qb-outbox-item-meta">${escapeHtml(_fmtAgo(r.createdAt))} · ${r.attempts} deneme${r.lastError ? ' · ' + escapeHtml(String(r.lastError).slice(0, 40)) : ''}</div>` +
        '</div>' +
        '<div class="qb-outbox-item-actions">' +
          '<button type="button" class="qb-outbox-retry" aria-label="Tekrar dene">⟳</button>' +
          '<button type="button" class="qb-outbox-discard" aria-label="Sil">×</button>' +
        '</div>' +
      '</li>'
    )).join('') +
    '</ul>'
  );
}

function _wireItemActions(overlay) {
  overlay.querySelectorAll('.qb-outbox-item').forEach((li) => {
    const id = li.getAttribute('data-id');
    li.querySelector('.qb-outbox-retry')?.addEventListener('click', async () => {
      li.classList.add('qb-outbox-busy');
      await retryOne(id);
      // Refresh list from current state
      const remaining = await list();
      overlay.querySelector('.qb-outbox-body').innerHTML = _renderList(remaining);
      _wireItemActions(overlay);
      overlay.querySelector('.qb-outbox-drain').disabled = remaining.length === 0;
    });
    li.querySelector('.qb-outbox-discard')?.addEventListener('click', async () => {
      if (!confirm('Bu yüklemeyi atayım mı?')) return;
      await discard(id);
      const remaining = await list();
      overlay.querySelector('.qb-outbox-body').innerHTML = _renderList(remaining);
      _wireItemActions(overlay);
      overlay.querySelector('.qb-outbox-drain').disabled = remaining.length === 0;
    });
  });
}
