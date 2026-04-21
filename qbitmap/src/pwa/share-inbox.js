// Main-thread pickup for Web Share Target payloads. The service worker
// parked the FormData in IndexedDB and redirected here with
// `?share=pending&id=<uuid>`. We take the record, clear the query so a
// reload doesn't replay, and hand the files to VideoMessage — which
// opens the upload flow with media prefilled.

import { shareInboxTake, shareInboxPrune } from './idb-share-inbox.js';

export async function initShareInbox() {
  if (typeof window === 'undefined') return;

  let params;
  try { params = new URLSearchParams(window.location.search); } catch { return; }
  const pending = params.get('share');
  const id = params.get('id');

  // Housekeeping on every load, not just when there's a pending pickup.
  shareInboxPrune().catch(() => {});

  if (pending !== 'pending' || !id) return;

  // Remove the query so reload / share re-entry doesn't re-trigger.
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('share');
    url.searchParams.delete('id');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch { /* noop */ }

  const record = await shareInboxTake(id).catch(() => null);
  if (!record) return;

  const { files = [], title = '', text = '', url = '' } = record;

  // Auth-gated: if the user isn't signed in, bail out with a toast. The
  // dropped payload is already gone — we could re-stash it but the user
  // just came from the system share sheet, not a natural Qbitmap flow.
  // Re-asking them to share after logging in is the cleaner UX.
  const auth = window.AuthSystem;
  const deadline = Date.now() + 10_000;
  const waitForAuth = () => new Promise((resolve) => {
    const tick = () => {
      if (window.AuthSystem && typeof window.AuthSystem.isLoggedIn === 'function') {
        resolve(window.AuthSystem);
      } else if (Date.now() > deadline) {
        resolve(null);
      } else {
        setTimeout(tick, 150);
      }
    };
    tick();
  });
  const a = auth && typeof auth.isLoggedIn === 'function' ? auth : await waitForAuth();
  if (!a || !a.isLoggedIn()) {
    a?.showNotification?.('Paylaşılan içeriği göndermek için önce giriş yapın', 'info', 4500);
    return;
  }

  // Hand off. Load video-message lazily since share flow is rare enough
  // to keep out of the critical path.
  try {
    const mod = await import('../../js/video-message/index.js');
    const VM = mod.VideoMessage || window.VideoMessage;
    if (VM && typeof VM.ingestSharedFiles === 'function') {
      await VM.ingestSharedFiles(files, { title, text, url });
    } else {
      a.showNotification?.('Paylaşım alındı ama form açılamadı', 'error', 4000);
    }
  } catch (err) {
    console.warn('[share-inbox] handoff failed', err);
    a.showNotification?.('Paylaşılan içerik işlenemedi', 'error', 4000);
  }
}
