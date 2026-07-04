/**
 * routes/cookies.js — Cookie management endpoints.
 *
 * POST /cookies/inject      Accept cookies.txt content from extension
 * POST /cookies/refresh     Force re-extract from browser
 * GET  /cookies/status      Return current cookie state
 */

const express = require('express');
const router = express.Router();
const { injectCookies, refreshCookies, getCookieStatus } = require('../cookies');

// Extension content script can POST the raw cookies.txt Netscape string
router.post('/inject', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string') {
    return res.status(400).json({ error: 'cookies string required' });
  }
  const ok = injectCookies(cookies);
  res.json({ ok, message: ok ? 'Cookies saved' : 'Cookies file appears invalid (too small)' });
});

// Force re-extract from browser
router.post('/refresh', async (req, res) => {
  try {
    const ok = await refreshCookies();
    res.json({ ok, status: getCookieStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status check
router.get('/status', (req, res) => {
  res.json(getCookieStatus());
});

module.exports = router;
