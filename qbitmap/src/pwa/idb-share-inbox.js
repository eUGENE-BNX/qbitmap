// Tiny IndexedDB wrapper shared between the service-worker share-target
// handler and the main-thread reader. A single object store keyed by an
// id holds the captured FormData fields (files + title + text + url)
// until the UI picks them up. Nothing else uses this DB, so no
// migrations are needed.

const DB_NAME = 'qbitmap-pwa';
const DB_VERSION = 1;
const STORE = 'share-inbox';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function shareInboxPut(id, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function shareInboxTake(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const val = req.result;
      if (val) store.delete(id);
      tx.oncomplete = () => { db.close(); resolve(val || null); };
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// Best-effort GC of leftovers older than 1 hour. Runs once per reader
// session so nothing accumulates if the user drops a share flow midway.
export async function shareInboxPrune() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) return;
      const v = cursor.value;
      if (!v || typeof v.at !== 'number' || v.at < cutoff) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}
