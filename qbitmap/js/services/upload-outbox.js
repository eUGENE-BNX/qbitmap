/**
 * Upload Outbox — persists video/photo message uploads that couldn't
 * reach the server yet (offline, 5xx loop, etc.) and retries them when
 * the page thinks it's online again.
 *
 * Scope (D.2 MVP):
 *   - IndexedDB-backed queue; file blobs + metadata persist across page
 *     close and device sleep.
 *   - drain() on module init and on window 'online' event.
 *   - Simple queue dispatcher — one POST at a time, sequentially.
 *
 * Deferred to D.3:
 *   - Background Sync API (SW sync event) so the queue drains even when
 *     the tab is closed. Android/Chromium only; iOS has no equivalent.
 *   - Rich UI (persistent badge, queue inspector, manual retry button).
 *
 * Entry schema (IDB, store 'messages'):
 *   {
 *     id: string,                   // uuid
 *     createdAt: number,            // Date.now()
 *     attempts: number,
 *     lastTriedAt: number|null,
 *     lastError: string|null,
 *     // request fields:
 *     endpoint: string,             // absolute URL
 *     fields: Record<string,string>, // formData string fields
 *     files: Array<{ fieldName, filename, blob }>, // ordered
 *   }
 */

const DB_NAME = 'qbitmap-outbox';
const DB_VERSION = 1;
const STORE = 'messages';

let _dbPromise = null;

function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb-unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function _tx(mode) {
  const db = await _openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

function _req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Enqueue an upload for later retry.
 * @param {object} record
 * @param {string} record.endpoint
 * @param {Record<string,string>} record.fields
 * @param {Array<{fieldName:string, filename:string, blob:Blob}>} record.files
 * @returns {Promise<string>} id
 */
export async function enqueue({ endpoint, fields, files }) {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const store = await _tx('readwrite');
  await _req(store.put({
    id,
    createdAt: Date.now(),
    attempts: 0,
    lastTriedAt: null,
    lastError: null,
    endpoint,
    fields: { ...fields },
    files: files.map((f) => ({ fieldName: f.fieldName, filename: f.filename, blob: f.blob })),
  }));
  _emit('qbitmap:outbox-enqueued', { id });
  _emit('qbitmap:outbox-updated');
  // Best-effort Background Sync registration. Chromium/Android only;
  // on iOS Safari this silently no-ops and we rely on the `online`
  // listener. Failures here are not fatal — the client-side drain
  // still runs on the next online event or app boot.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('outbox-flush');
    } catch { /* sync unavailable or permission denied */ }
  }
  return id;
}

function _emit(type, detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, detail ? { detail } : undefined));
}

/** Remove a queued record without attempting to send it. */
export async function discard(id) {
  await _remove(id);
  _emit('qbitmap:outbox-dropped', { id, reason: 'user-discard' });
  _emit('qbitmap:outbox-updated');
}

/** Attempt to send exactly one queued record out-of-band. */
export async function retryOne(id) {
  const store = await _tx('readonly');
  const record = await _req(store.get(id));
  if (!record) return { sent: false, reason: 'not-found' };
  try {
    const res = await _postOne(record);
    if (res.ok) {
      await _remove(id);
      _emit('qbitmap:outbox-sent', { id });
      _emit('qbitmap:outbox-updated');
      return { sent: true };
    }
    await _updateAttempt(id, `HTTP ${res.status}`);
    _emit('qbitmap:outbox-updated');
    return { sent: false, reason: 'http-' + res.status };
  } catch (err) {
    await _updateAttempt(id, err?.message || 'fetch-failed');
    _emit('qbitmap:outbox-updated');
    return { sent: false, reason: 'network' };
  }
}

export async function count() {
  try {
    const store = await _tx('readonly');
    return await _req(store.count());
  } catch { return 0; }
}

export async function list() {
  try {
    const store = await _tx('readonly');
    return await _req(store.getAll());
  } catch { return []; }
}

async function _remove(id) {
  const store = await _tx('readwrite');
  await _req(store.delete(id));
}

async function _updateAttempt(id, lastError) {
  const store = await _tx('readwrite');
  const existing = await _req(store.get(id));
  if (!existing) return;
  existing.attempts = (existing.attempts || 0) + 1;
  existing.lastTriedAt = Date.now();
  existing.lastError = lastError || null;
  await _req(store.put(existing));
}

function _buildFormData(record) {
  const fd = new FormData();
  // Order matters for @fastify/multipart: string fields first, then files.
  for (const [k, v] of Object.entries(record.fields || {})) {
    fd.append(k, v);
  }
  for (const f of record.files || []) {
    fd.append(f.fieldName, f.blob, f.filename);
  }
  return fd;
}

async function _postOne(record) {
  const res = await fetch(record.endpoint, {
    method: 'POST',
    credentials: 'include',
    body: _buildFormData(record),
  });
  return res;
}

// Give up after N attempts to avoid infinite retry on payloads the server
// will never accept (stale auth, deleted recipient, etc).
const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504]);

let _draining = false;
let _drainQueued = false;

/**
 * Attempt each queued upload once, sequentially. Safe to call repeatedly;
 * concurrent drains are coalesced.
 * Returns { sent, failed, dropped }.
 */
export async function drain() {
  if (_draining) { _drainQueued = true; return { sent: 0, failed: 0, dropped: 0 }; }
  _draining = true;
  const stats = { sent: 0, failed: 0, dropped: 0 };
  try {
    const records = await list();
    for (const record of records) {
      // Pre-flight: if we've gone offline mid-drain, bail out.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      try {
        const res = await _postOne(record);
        if (res.ok) {
          await _remove(record.id);
          stats.sent += 1;
          _emit('qbitmap:outbox-sent', { id: record.id });
        } else if (RETRYABLE_STATUSES.has(res.status)) {
          await _updateAttempt(record.id, `HTTP ${res.status}`);
          if ((record.attempts + 1) >= MAX_ATTEMPTS) {
            await _remove(record.id);
            stats.dropped += 1;
            _emit('qbitmap:outbox-dropped', { id: record.id, reason: 'max-attempts' });
          } else {
            stats.failed += 1;
          }
        } else {
          // Permanent failure (4xx other than the retryable set, etc.).
          await _remove(record.id);
          stats.dropped += 1;
          _emit('qbitmap:outbox-dropped', { id: record.id, reason: `http-${res.status}` });
        }
      } catch (err) {
        // Network error — fetch threw. Keep the record, try later.
        await _updateAttempt(record.id, err?.message || 'fetch-failed');
        stats.failed += 1;
      }
    }
  } finally {
    _draining = false;
    _emit('qbitmap:outbox-updated');
    if (_drainQueued) {
      _drainQueued = false;
      // Re-run if another caller asked while we were busy.
      setTimeout(() => { drain().catch(() => {}); }, 0);
    }
  }
  return stats;
}

/**
 * Install listeners: auto-drain on `online`, plus one kick at load time
 * in case a previous session left records behind.
 */
export function initOutbox() {
  if (typeof window === 'undefined') return;
  if (window.__qbitmapOutboxWired) return;
  window.__qbitmapOutboxWired = true;
  const kick = () => { drain().catch(() => {}); };
  window.addEventListener('online', kick);
  // Run once after a short delay so app bootstrap finishes first.
  setTimeout(kick, 2500);
}
