class LRUCache {
  constructor(maxSize = 2000) {
    this._cache = new Map();
    this._maxSize = maxSize;
    this._invalidateTimer = null;
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this._cache.delete(key);
      return null;
    }
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = 30000) {
    if (this._cache.size >= this._maxSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, { value, expiry: Date.now() + ttlMs });
  }

  invalidateAll() {
    this._cache.clear();
  }

  debouncedInvalidateAll(delayMs = 150) {
    if (this._invalidateTimer) return;
    this._invalidateTimer = setTimeout(() => {
      this._cache.clear();
      this._invalidateTimer = null;
    }, delayMs);
  }
}

module.exports = new LRUCache(2000);
