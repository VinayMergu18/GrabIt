/**
 * logger.js — Structured rotating log for GrabIt server.
 *
 * Every log entry is one JSON line:
 *   { ts, level, file, fn, msg, ...extras }
 *
 * Writes to:
 *   logs/grabit.log          — all levels (rotates at 10 MB, keeps 3)
 *   logs/grabit-errors.log   — ERROR only
 *
 * Also prints colour-coded lines to the terminal so you can watch live with:
 *   node index.js
 *   or
 *   Get-Content logs\grabit.log -Wait  (PowerShell)
 *   tail -f logs/grabit.log            (bash)
 *
 * Usage in any module:
 *   const log = require('./logger').child('detector.js');
 *   log.info('probeYouTubeSingle', 'Starting probe', { url, args });
 *   log.cmd ('probeYouTubeSingle', 'yt-dlp', args);
 *   log.out ('probeYouTubeSingle', stdout, stderr);
 *   log.error('probeYouTubeSingle', 'Probe failed', err);
 *   log.ok  ('probeYouTubeSingle', 'Probe succeeded', { videoId, title });
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { getSettings } = require('./db');

// ── Config ────────────────────────────────────────────────────────────────────
const LOG_DIR      = path.join(__dirname, '../../logs');
const LOG_FILE     = path.join(LOG_DIR, 'grabit.log');
const ERR_FILE     = path.join(LOG_DIR, 'grabit-errors.log');
const MAX_BYTES    = 10 * 1024 * 1024;  // rotate at 10 MB
const KEEP_ROTATED = 3;                  // keep .1 .2 .3
const STDOUT_TRUNC = 2000;               // truncate long stdout in terminal

const LEVELS = { DEBUG: 10, INFO: 20, CMD: 25, OUT: 26, OK: 30, WARN: 40, ERROR: 50 };
const COLOURS = {
  DEBUG: '\x1b[90m',   // grey
  INFO:  '\x1b[36m',   // cyan
  CMD:   '\x1b[33m',   // yellow
  OUT:   '\x1b[90m',   // grey
  OK:    '\x1b[32m',   // green
  WARN:  '\x1b[35m',   // magenta
  ERROR: '\x1b[31m',   // red
  RESET: '\x1b[0m'
};

// Helper to check if logging is enabled via settings
function isLoggingEnabled() {
  try {
    const settings = getSettings();
    return !!settings.logging?.enabled;
  } catch (e) {
    // If settings cannot be read, default to enabled to avoid silent failures during startup
    return true;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

let _logStream = openStream(LOG_FILE);
let _errStream = openStream(ERR_FILE);

function openStream(file) {
  return fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
}

function rotate(file) {
  try {
    for (let i = KEEP_ROTATED; i >= 1; i--) {
      const old  = `${file}.${i}`;
      const prev = i === 1 ? file : `${file}.${i - 1}`;
      if (fs.existsSync(prev)) fs.renameSync(prev, old);
    }
  } catch {}
}

function checkRotate() {
  try {
    if (fs.statSync(LOG_FILE).size >= MAX_BYTES) {
      _logStream.end();
      rotate(LOG_FILE);
      _logStream = openStream(LOG_FILE);
    }
  } catch {}
}

// ── Core write ────────────────────────────────────────────────────────────────
function write(level, file, fn, msg, extras = {}) {
  if (!isLoggingEnabled()) return;

  checkRotate();

  const entry = {
    ts:    new Date().toISOString(),
    level,
    file,
    fn:    fn || '?',
    msg,
    ...flatten(extras)
  };

  const line = JSON.stringify(entry) + os.EOL;
  _logStream.write(line);
  if (LEVELS[level] >= LEVELS.ERROR) _errStream.write(line);

  // Terminal output
  const col   = COLOURS[level] || '';
  const reset = COLOURS.RESET;
  const time  = entry.ts.slice(11, 23);                     // HH:MM:SS.mmm
  const tag   = `[${level.padEnd(5)}]`;
  const loc   = `${file} › ${fn || '?'}`;
  const extra = fmtExtras(extras);

  process.stderr.write(`${col}${time} ${tag} ${loc}: ${msg}${extra}${reset}\n`);
}

/** Flatten nested objects one level deep for JSON readability */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function fmtExtras(extras) {
  const pairs = Object.entries(extras)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (typeof v === 'string' && v.length > STDOUT_TRUNC)
        return `${k}=${JSON.stringify(v.slice(0, STDOUT_TRUNC) + '…(truncated)')}`;
      if (Array.isArray(v)) return `${k}=[${v.join(' ')}]`;
      return `${k}=${JSON.stringify(v)}`;
    });
  return pairs.length ? '  ' + pairs.join('  ') : '';
}

// ── Child logger factory ──────────────────────────────────────────────────────
function child(filename) {
  const file = path.basename(filename);
  return {
    debug : (fn, msg, extras)  => write('DEBUG', file, fn, msg, extras),
    info  : (fn, msg, extras)  => write('INFO',  file, fn, msg, extras),
    ok    : (fn, msg, extras)  => write('OK',    file, fn, msg, extras),
    warn  : (fn, msg, extras)  => write('WARN',  file, fn, msg, extras),
    error : (fn, msg, errOrExtras) => {
      const extras = errOrExtras instanceof Error
        ? { errorMsg: errOrExtras.message, stack: errOrExtras.stack?.split('\n').slice(0,4).join(' | ') }
        : (errOrExtras || {});
      write('ERROR', file, fn, msg, extras);
    },

    /** Log the exact command being run — bin + full args array */
    cmd: (fn, bin, args) => write('CMD', file, fn,
      `Running: ${path.basename(bin)} ${args.join(' ')}`,
      { bin, args: args.join(' ') }),

    /** Log stdout/stderr from a finished subprocess */
    out: (fn, stdout, stderr, exitCode) => {
      const hasOut = stdout?.trim();
      const hasErr = stderr?.trim();
      const level  = exitCode !== 0 && exitCode !== null && exitCode !== undefined ? 'ERROR' : 'OUT';

      if (hasOut) write(level, file, fn, 'stdout', {
        exitCode,
        lines:  stdout.trim().split('\n').length,
        stdout: stdout.trim().slice(0, 4000)
      });
      if (hasErr) write(level, file, fn, 'stderr', {
        exitCode,
        stderr: stderr.trim().slice(0, 4000)
      });
      if (!hasOut && !hasErr) write(level, file, fn, 'no output', { exitCode });
    },

    /** Log a download event (started / progress / complete / error) */
    download: (fn, event, extras) => write(
      event === 'error' ? 'ERROR' : event === 'complete' ? 'OK' : 'INFO',
      file, fn, `Download ${event}`, extras
    )
  };
}

// ── Global logger (for index.js / uncaught exceptions) ───────────────────────
const globalLog = child('server');

module.exports = { child, log: globalLog, LOG_FILE, ERR_FILE, LOG_DIR };
