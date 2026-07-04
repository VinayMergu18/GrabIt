/**
 * routes/slide.js — Real-time carousel slide tracking.
 * Content script POSTs current slide index continuously.
 * Server stores and broadcasts to popup.
 */

const express = require('express');
const router = express.Router();
const { broadcastSlideUpdate } = require('../websocket');

// In-memory slide state per tab
const slideState = new Map();

// Content script reports current slide
router.post('/update', (req, res) => {
  const { tabId, url, slideIndex, slideCount, mediaType, platform } = req.body;
  if (!tabId) return res.status(400).json({ error: 'tabId required' });

  const state = {
    tabId, url, slideIndex: slideIndex || 0,
    slideCount: slideCount || 1,
    mediaType: mediaType || 'unknown',
    platform: platform || 'unknown',
    updatedAt: Date.now()
  };

  slideState.set(String(tabId), state);
  broadcastSlideUpdate(tabId, slideIndex);
  res.json({ ok: true });
});

// Popup asks for current slide state
router.get('/state/:tabId', (req, res) => {
  const state = slideState.get(String(req.params.tabId));
  res.json(state || { slideIndex: 0, slideCount: 1 });
});

// Cleanup stale states (> 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, state] of slideState.entries()) {
    if (state.updatedAt < cutoff) slideState.delete(id);
  }
}, 300000);

module.exports = router;
