/**
 * routes/logs.js — Log file viewer endpoints.
 *
 * GET /logs/tail?n=100&level=ERROR   — Last N lines, optionally filtered by level
 * GET /logs/file                     — Full log file download
 * GET /logs/errors                   — Errors-only log download
 * DELETE /logs/clear                 — Truncate both log files
 */

'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const { LOG_FILE, ERR_FILE } = require('../logger');

/** Read last N lines from a file efficiently */
function tailFile(file, n = 200) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines   = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

/** Parse a log line from JSON, fallback to raw string */
function parseLine(line) {
  try { return JSON.parse(line); } catch { return { raw: line }; }
}

// GET /logs/tail?n=200&level=ERROR&file=detector.js&fn=probeYouTubeSingle
router.get('/tail', (req, res) => {
  const n      = Math.min(parseInt(req.query.n) || 200, 2000);
  const level  = (req.query.level || '').toUpperCase();
  const fileF  = (req.query.file  || '').toLowerCase();
  const fnF    = (req.query.fn    || '').toLowerCase();

  let lines = tailFile(LOG_FILE, n * 4) // read more to allow filtering
    .map(parseLine);

  if (level) lines = lines.filter(l => l.level === level);
  if (fileF) lines = lines.filter(l => (l.file || '').toLowerCase().includes(fileF));
  if (fnF)   lines = lines.filter(l => (l.fn   || '').toLowerCase().includes(fnF));

  lines = lines.slice(-n);
  res.json({ count: lines.length, lines });
});

// GET /logs/file — download the full log
router.get('/file', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.status(404).json({ error: 'No log file yet' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="grabit.log"');
  fs.createReadStream(LOG_FILE).pipe(res);
});

// GET /logs/errors — download errors-only log
router.get('/errors', (req, res) => {
  if (!fs.existsSync(ERR_FILE)) return res.status(404).json({ error: 'No error log yet' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="grabit-errors.log"');
  fs.createReadStream(ERR_FILE).pipe(res);
});

// DELETE /logs/clear
router.delete('/clear', (req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
    if (fs.existsSync(ERR_FILE)) fs.writeFileSync(ERR_FILE, '');
    res.json({ ok: true, msg: 'Logs cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
