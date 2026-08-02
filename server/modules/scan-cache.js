/**
 * scan-cache.js — Persistent cache for playlist scan progress.
 *
 * Stores scan progress per tabId and playlistId as JSON files in the cache/ directory.
 * Files are named: scan-{tabId}-{playlistId}.json
 *
 * Provides methods to save, load, and clear scan progress.
 * Also provides auto-save interval to periodically flush in-memory cache to disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const SAVE_INTERVAL_MS = 5000; // Save every 5 seconds

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Get file path for a given tabId and playlistId.
 */
function getFilePath(tabId, playlistId) {
  // Sanitize playlistId for filesystem safety
  const safeId = playlistId.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return path.join(CACHE_DIR, `scan-${tabId}-${safeId}.json`);
}

/**
 * ScanProgress represents the state of a playlist scan.
 * @typedef {Object} ScanProgress
 * @property {string} playlistId - YouTube playlist ID
 * @property {string} tabId - Extension tab ID
 * @property {number} scannedCount - Number of videos processed so far
 * @property {number} totalVideos - Total videos in playlist
 * @property {Object} videoTotals - Size totals per quality tier
 * @property {Object} audioTotals - Size totals per audio format
 * @property {number} totalDuration - Total duration in seconds
 * @property {boolean} completed - Whether scan is finished
 * @property {number} lastUpdated - Timestamp of last update
 */
class ScanCache {
  constructor() {
    // In-memory cache: Map<tabId, Map<playlistId, ScanProgress>>
    this._map = new Map();
    this._saveInterval = null;
    this._startAutoSave();
  }

  /**
   * Start periodic autosave of all dirty entries.
   * @private
   */
  _startAutoSave() {
    if (this._saveInterval) return;
    this._saveInterval = setInterval(() => {
      this._flushAll();
    }, SAVE_INTERVAL_MS);
    if (this._saveInterval.unref) this._saveInterval.unref();
  }

  /**
   * Stop autosave and flush remaining data.
   */
  stop() {
    if (this._saveInterval) {
      clearInterval(this._saveInterval);
      this._saveInterval = null;
    }
    this._flushAll();
  }

  /**
   * Save scan progress for a specific tabId and playlistId.
   * @param {string} tabId
   * @param {string} playlistId
   * @param {ScanProgress} progress
   */
  save(tabId, playlistId, progress) {
    if (!tabId || !playlistId) return;

    let tabMap = this._map.get(tabId);
    if (!tabMap) {
      tabMap = new Map();
      this._map.set(tabId, tabMap);
    }

    // Update timestamp
    progress.lastUpdated = Date.now();
    tabMap.set(playlistId, progress);

    // Also persist immediately to disk (optional, we also have autosave)
    this._persist(tabId, playlistId, progress);
  }

  /**
   * Load scan progress for a tabId and playlistId from disk.
   * @param {string} tabId
   * @param {string} playlistId
   * @returns {ScanProgress|null} The progress object or null if not found.
   */
  load(tabId, playlistId) {
    if (!tabId || !playlistId) return null;

    // First check memory
    const tabMap = this._map.get(tabId);
    if (tabMap) {
      const cached = tabMap.get(playlistId);
      if (cached) return cached;
    }

    // Try to load from disk
    const progress = this._loadFromFile(tabId, playlistId);
    if (progress) {
      // Cache it in memory
      if (!this._map.has(tabId)) {
        this._map.set(tabId, new Map());
      }
      this._map.get(tabId).set(playlistId, progress);
    }
    return progress;
  }

  /**
   * Remove scan progress for a tabId and playlistId from memory and disk.
   * @param {string} tabId
   * @param {string} playlistId
   */
  clear(tabId, playlistId) {
    if (!tabId || !playlistId) return;
    const tabMap = this._map.get(tabId);
    if (tabMap) {
      tabMap.delete(playlistId);
      if (tabMap.size === 0) {
        this._map.delete(tabId);
      }
    }
    // Delete file
    const filePath = getFilePath(tabId, playlistId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.warn(`[scan-cache] Failed to delete cache file ${filePath}:`, e);
    }
  }

  /**
   * Load progress from JSON file.
   * @private
   */
  _loadFromFile(tabId, playlistId) {
    const filePath = getFilePath(tabId, playlistId);
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, 'utf8');
      const obj = JSON.parse(data);
      // Validate basic structure
      if (obj && typeof obj === 'object' && obj.playlistId && obj.tabId) {
        return obj;
      }
    } catch (e) {
      console.warn(`[scan-cache] Failed to load cache file ${filePath}:`, e);
    }
    return null;
  }

  /**
   * Save progress to JSON file.
   * @private
   */
  _persist(tabId, playlistId, progress) {
    const filePath = getFilePath(tabId, playlistId);
    try {
      const json = JSON.stringify(progress, null, 2);
      // Write to temporary file then rename for atomicity
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (e) {
      console.warn(`[scan-cache] Failed to save cache file ${filePath}:`, e);
    }
  }

  /**
   * Flush all in-memory changes to disk.
   * @private
   */
  _flushAll() {
    for (const [tabId, tabMap] of this._map.entries()) {
      for (const [playlistId, progress] of tabMap.entries()) {
        this._persist(tabId, playlistId, progress);
      }
    }
  }
}

// Export a singleton instance
const scanCache = new ScanCache();
module.exports = { scanCache };