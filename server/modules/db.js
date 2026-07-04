/**
 * db.js — Lightweight JSON-file persistence layer.
 * Stores history, settings, and queue state.
 * No native dependencies — pure Node.js fs.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

const DEFAULT_SETTINGS = {
  youtube: {
    downloadFolder: path.join(require('os').homedir(), 'Downloads', 'GrabIt', 'YouTube'),
    defaultQuality: 'best',
    preferredVideoFormat: 'mp4',
    preferredAudioFormat: 'mp3',
    embedSubtitles: false,
    autoSubtitleLang: 'en',
    concurrentDownloads: 2,
    retryCount: 3,
    autoRetry: true,
    sponsorBlock: false,
    customArgs: ''
  },
  instagram: {
    downloadFolder: path.join(require('os').homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    preferredVideoQuality: 'best',
    preferredAudioFormat: 'mp3',
    createCarouselFolders: true,
    downloadStories: true,
    concurrentDownloads: 2,
    retryCount: 3,
    autoRetry: true,
    cookieSource: 'auto',
    sessionFile: '',
    customArgs: ''
  },
  generic: {
    downloadFolder: path.join(require('os').homedir(), 'Downloads', 'GrabIt', 'Generic'),
    preferredVideoFormat: 'mp4',
    preferredAudioFormat: 'mp3',
    maxResolution: '1080',
    concurrentDownloads: 2,
    retryCount: 2,
    autoRetry: true,
    customArgs: ''
  },
  app: {
    urlInputMode: false,
    showVerificationBadge: true,
    theme: 'dark',
    notificationsEnabled: true,
    openFolderAfterDownload: false
  },
  logging: {
    enabled: false,
    level: 'info'
  }
};

let _db = {
  history: [],
  settings: DEFAULT_SETTINGS,
  queue: []
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.warn(`[DB] Failed to read ${file}:`, e.message);
  }
  return fallback;
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[DB] Failed to write ${file}:`, e.message);
  }
}

async function initDB() {
  ensureDir();
  _db.history = readJSON(HISTORY_FILE, []);
  _db.settings = deepMerge(DEFAULT_SETTINGS, readJSON(SETTINGS_FILE, {}));
  _db.queue = []; // Always start fresh queue (persisted items were incomplete)
  console.log(`[DB] Loaded ${_db.history.length} history entries`);
}

// ---- History ----
function getHistory() { return _db.history; }

function addHistory(entry) {
  _db.history.unshift({ ...entry, id: entry.id || require('crypto').randomUUID(), addedAt: Date.now() });
  if (_db.history.length > 2000) _db.history = _db.history.slice(0, 2000);
  writeJSON(HISTORY_FILE, _db.history);
}

function updateHistory(id, patch) {
  const idx = _db.history.findIndex(h => h.id === id);
  if (idx !== -1) {
    _db.history[idx] = { ..._db.history[idx], ...patch };
    writeJSON(HISTORY_FILE, _db.history);
  }
}

function deleteHistory(id) {
  _db.history = _db.history.filter(h => h.id !== id);
  writeJSON(HISTORY_FILE, _db.history);
}

function clearHistory() {
  _db.history = [];
  writeJSON(HISTORY_FILE, _db.history);
}

function searchHistory(query) {
  const q = query.toLowerCase();
  return _db.history.filter(h =>
    (h.title || '').toLowerCase().includes(q) ||
    (h.url || '').toLowerCase().includes(q)
  );
}

// ---- Settings ----
function getSettings() { return _db.settings; }

function updateSettings(section, patch) {
  if (_db.settings[section]) {
    _db.settings[section] = { ..._db.settings[section], ...patch };
  } else {
    _db.settings[section] = patch;
  }
  writeJSON(SETTINGS_FILE, _db.settings);
  return _db.settings;
}

function resetSettings() {
  _db.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  writeJSON(SETTINGS_FILE, _db.settings);
  return _db.settings;
}

// ---- Deep merge helper ----
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] || {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = {
  initDB,
  getHistory, addHistory, updateHistory, deleteHistory, clearHistory, searchHistory,
  getSettings, updateSettings, resetSettings
};
