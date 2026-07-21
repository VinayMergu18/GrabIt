/**
 * cookies.js — Cookie management for gallery-dl and yt-dlp.
 *
 * Priority order (checked fresh on every getCookiesArgs call):
 *   1. Manual session file path from settings (always wins if file exists)
 *   2. Cached cookies.txt extracted from browser (valid if < 8h old)
 *   3. No cookies
 *
 * Key fixes:
 *  - Manual path checked BEFORE cache — setting a session file always works
 *  - cookiesFileValid() ignores manual-path files (they have their own freshness)
 *  - getCookiesArgs() re-reads settings on every call, so UI changes take effect immediately
 *  - No automatic browser extraction; cookies must be provided via manual file or extension injection
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DATA_DIR     = path.join(__dirname, '..', 'data');
const COOKIES_FILE = path.join(DATA_DIR, 'cookies.txt');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let _extractedBrowser = null;
let _cookiesReady     = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ytdlpBin()    { return process.platform === 'win32' ? 'yt-dlp.exe'     : 'yt-dlp'; }
function galleryDlBin(){ return process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl'; }

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Read the manual session file path from settings.
 * Re-reads from disk every time so UI changes take effect immediately.
 */
function getManualCookiePath() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const p = s?.instagram?.sessionFile?.trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function cookiesFileValid() {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  const stat = fs.statSync(COOKIES_FILE);
  if (stat.size < 200) return false;           // too small — header-only or empty
  const ageH = (Date.now() - stat.mtimeMs) / 3600000;
  if (ageH >= 8) return false;                 // too old

  // Additional validation: check that the file looks like a Netscape cookie file
  try {
    const content = fs.readFileSync(COOKIES_FILE, 'utf8');
    const lines = content.split(/\r?\n/);
    let foundValidLine = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Netscape cookie line: domain, flag, path, secure, expiration, name, value (tab-separated)
      const fields = trimmed.split('\t');
      if (fields.length === 7) {
        // Optionally check that expiration is numeric
        if (!isNaN(Date.parse(fields[4]))) {
          foundValidLine = true;
          break;
        }
      }
    }
    return foundValidLine;
  } catch (e) {
    console.warn('[Cookies] Failed to validate cookie file:', e.message);
    return false;
  }
}

// ── Browser detection ─────────────────────────────────────────────────────────

const BROWSER_ORDER = ['brave', 'chrome', 'edge', 'chromium', 'firefox'];

function detectInstalledBrowsers() {
  const home  = os.homedir();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const paths = isWin ? {
    brave:    path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
    chrome:   path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    edge:     path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    chromium: path.join(home, 'AppData', 'Local', 'Chromium', 'User Data'),
    firefox:  path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles')
  } : isMac ? {
    brave:    path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    chrome:   path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    edge:     path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
    firefox:  path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
  } : {
    brave:    path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    chrome:   path.join(home, '.config', 'google-chrome'),
    chromium: path.join(home, '.config', 'chromium'),
    firefox:  path.join(home, '.mozilla', 'firefox')
  };

  return BROWSER_ORDER.filter(b => paths[b] && fs.existsSync(paths[b]));
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function tryExtractWithYtDlp(browser) {
  try {
    await execFileAsync(ytdlpBin(), [
      '--cookies-from-browser', browser,
      '--cookies', COOKIES_FILE,
      '--skip-download',
      '--no-warnings', '--quiet',
      'https://www.instagram.com/instagram/'
    ], { timeout: 20000 });
    if (cookiesFileValid()) { console.log(`[Cookies] Extracted via yt-dlp from ${browser}`); return true; }
  } catch (e) {
    console.warn(`[Cookies] yt-dlp/${browser}:`, e.message.split('\n')[0]);
  }
  return false;
}

async function tryExtractWithGalleryDl(browser) {
  try {
    await execFileAsync(galleryDlBin(), [
      '--cookies-from-browser', browser,
      '--cookies', COOKIES_FILE,
      '--no-download',
      'https://www.instagram.com/instagram/'
    ], { timeout: 20000 });
    if (cookiesFileValid()) { console.log(`[Cookies] Extracted via gallery-dl from ${browser}`); return true; }
  } catch (e) {
    console.warn(`[Cookies] gallery-dl/${browser}:`, e.message.split('\n')[0]);
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function startupCookieExtract() {
  ensureDataDir();

  // Manual path always wins
  const manual = getManualCookiePath();
  if (manual) {
    console.log(`[Cookies] Using manual session file: ${manual}`);
    _cookiesReady = true;
    return;
  }

  if (cookiesFileValid()) {
    console.log('[Cookies] Using cached cookies.txt');
    _cookiesReady = true;
    return;
  }

  // No cookie file available; do not attempt browser extraction
  console.log('[Cookies] No cookies available (manual or cached).');
  _cookiesReady = false;
  _extractedBrowser = null;
}

async function refreshCookies() {
  if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
  _cookiesReady = false;
  _extractedBrowser = null;

  // After removal, check if manual cookie file exists
  const manual = getManualCookiePath();
  if (manual) {
    console.log('[Cookies] Using manual session file after refresh:', manual);
    _cookiesReady = true;
    return;
  }

  // If cookie file exists (should not, because we just deleted) but check anyway
  if (cookiesFileValid()) {
    console.log('[Cookies] Using cached cookies.txt after refresh');
    _cookiesReady = true;
    return;
  }

  console.log('[Cookies] No cookies available after refresh.');
  _cookiesReady = false;
}

function injectCookies(cookiesTxt) {
  ensureDataDir();
  fs.writeFileSync(COOKIES_FILE, cookiesTxt, 'utf8');
  _cookiesReady = cookiesFileValid();
  console.log(`[Cookies] Injected, valid=${_cookiesReady}`);
  return _cookiesReady;
}

function getCookiesFile() {
  // Always check manual path first (re-reads settings live)
  const manual = getManualCookiePath();
  if (manual) return manual;
  return cookiesFileValid() ? COOKIES_FILE : null;
}

/**
 * Returns CLI args to pass cookies to the given tool.
 * Re-reads manual path from settings on every call.
 */
function getCookiesArgs(tool = 'yt-dlp') {
  const file = getCookiesFile();
  if (file) {
    // Convert backslashes to forward slashes for yt-dlp on Windows
    const normalized = process.platform === 'win32' ? file.replace(/\\/g, '/') : file;
    return ['--cookies', normalized];
  }
  return [];
}

function getCookieStatus() {
  const file = getCookiesFile();
  let ageMinutes = null;
  if (file) {
    try { ageMinutes = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000); } catch {}
  }
  return {
    hasFile:       !!file,
    filePath:      file,
    isManual:      !!getManualCookiePath(),
    extractedFrom: _extractedBrowser,
    ready:         _cookiesReady,
    ageMinutes
  };
}

module.exports = {
  startupCookieExtract,
  refreshCookies,
  injectCookies,
  getCookiesFile,
  getCookiesArgs,
  getCookieStatus
};
