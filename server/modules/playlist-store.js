'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger').child('playlist-store.js');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const SUFFIX = '.json';
const scans = new Map();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function filePath(scanId) {
  return path.join(CACHE_DIR, `${encodeURIComponent(scanId)}${SUFFIX}`);
}

function loadFromDisk(scanId) {
  const fp = filePath(scanId);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.scanId = scanId;
    scans.set(scanId, parsed);
    return parsed;
  } catch (err) {
    log.error('loadFromDisk', `Failed to read cache file for ${scanId}`, { error: err.message });
    return null;
  }
}

function get(scanId) {
  if (!scanId) return null;
  if (scans.has(scanId)) return scans.get(scanId);
  return loadFromDisk(scanId);
}

function save(scanId, state) {
  if (!scanId || !state) return null;
  ensureCacheDir();
  const normalized = {
    ...state,
    scanId,
    lastUpdated: Date.now()
  };
  scans.set(scanId, normalized);
  try {
    fs.writeFileSync(filePath(scanId), JSON.stringify(normalized, null, 2), 'utf8');
  } catch (err) {
    log.error('save', `Failed to persist scan state ${scanId}`, { error: err.message });
  }
  return normalized;
}

function patch(scanId, patchData) {
  if (!scanId || !patchData) return null;
  const existing = get(scanId) || { scanId };
  return save(scanId, { ...existing, ...patchData });
}

function remove(scanId) {
  if (!scanId) return;
  scans.delete(scanId);
  const fp = filePath(scanId);
  if (fs.existsSync(fp)) {
    try {
      fs.unlinkSync(fp);
    } catch (err) {
      log.error('remove', `Failed to delete scan cache file for ${scanId}`, { error: err.message });
    }
  }
}

function clearAll() {
  ensureCacheDir();
  scans.clear();

  const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    const fp = path.join(CACHE_DIR, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.rmSync(fp, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fp);
      }
    } catch (err) {
      log.error('clearAll', `Failed to delete cache entry ${entry.name}`, { error: err.message });
    }
  }
  ensureCacheDir();
}

function listPending() {
  return Array.from(scans.values()).filter(state => state.scanStatus === 'scanning');
}

module.exports = { get, save, patch, remove, listPending, clearAll };
