/**
 * routes/scan.js — Scan persistence endpoints.
 *
 * GET  /load?tabId=&playlistId=   Load saved scan progress
 * POST /save                     Save scan progress (optional, also done via WS)
 */

'use strict';

const express = require('express');
const router  = express.Router();
const log     = require('../logger').child('routes/scan.js');
const { scanCache } = require('../scan-cache');

// GET /load
router.get('/load', (req, res) => {
  const { tabId, playlistId } = req.query;
  if (!tabId || !playlistId) {
    return res.status(400).json({ error: 'tabId and playlistId required' });
  }
  try {
    const progress = scanCache.load(tabId, playlistId);
    if (progress) {
      log.info('GET /scan/load', 'Loaded scan progress', { tabId, playlistId, progress });
      res.json({ ok: true, progress });
    } else {
      res.json({ ok: true, progress: null });
    }
  } catch (e) {
    log.error('GET /scan/load', 'Failed', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /save
router.post('/save', (req, res) => {
  const { tabId, playlistId, progress } = req.body;
  if (!tabId || !playlistId || !progress) {
    return res.status(400).json({ error: 'tabId, playlistId, and progress required' });
  }
  try {
    scanCache.save(tabId, playlistId, progress);
    log.info('POST /scan/save', 'Saved scan progress', { tabId, playlistId });
    res.json({ ok: true });
  } catch (e) {
    log.error('POST /scan/save', 'Failed', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;