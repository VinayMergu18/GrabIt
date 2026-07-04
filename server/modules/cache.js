/**
 * cache.js — In-memory metadata cache with TTL.
 *
 * Two stores:
 *   videoCache   — single video metadata keyed by YouTube video ID (30 min TTL)
 *   playlistCache — flat playlist entries keyed by playlist/list ID (10 min TTL)
 *
 * Design: Map-based, no external dependencies, auto-evicts stale entries on
 * every write and on a lazy sweep every 5 minutes. Lookup is O(1).
 */

'use strict';

const VIDEO_TTL    = 30 * 60 * 1000; //  30 minutes
const PLAYLIST_TTL = 10 * 60 * 1000; //  10 minutes
const FORMAT_TTL   = 30 * 60 * 1000; //  30 minutes

class TTLCache {
  constructor(ttlMs, name) {
    this._map   = new Map();
    this._ttl   = ttlMs;
    this._name  = name;
    // Passive sweep every 5 minutes
    this._sweep = setInterval(() => this._evict(), 5 * 60 * 1000);
    if (this._sweep.unref) this._sweep.unref(); // don't keep process alive
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this._map.delete(key); return null; }
    return entry.value;
  }

  set(key, value, ttlMs = this._ttl) {
    this._map.set(key, { value, expires: Date.now() + ttlMs });
  }

  has(key) { return this.get(key) !== null; }
  delete(key) { this._map.delete(key); }
  clear() { this._map.clear(); }
  get size() { return this._map.size; }

  _evict() {
    const now = Date.now();
    for (const [k, v] of this._map) {
      if (now > v.expires) this._map.delete(k);
    }
  }
}

const videoCache    = new TTLCache(VIDEO_TTL,    'video');
const playlistCache = new TTLCache(PLAYLIST_TTL, 'playlist');
const formatCache   = new TTLCache(FORMAT_TTL,   'format');

/** Extract YouTube video ID from any youtube.com/youtu.be URL. */
function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0] || null;
    return u.searchParams.get('v') || null;
  } catch { return null; }
}

/** Extract YouTube list ID from any youtube.com playlist URL. */
function listIdFromUrl(url) {
  try { return new URL(url).searchParams.get('list') || null; }
  catch { return null; }
}

module.exports = {
  videoCache,
  playlistCache,
  formatCache,
  videoIdFromUrl,
  listIdFromUrl
};
