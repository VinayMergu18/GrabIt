/**
 * routes/probe.js — Media detection endpoints.
 *
 * GET  /probe/quick?url=...     Stage 1: instant URL analysis  (<1ms)
 * POST /probe/deep              Stage 2: full yt-dlp metadata probe
 * POST /probe/batch             Batch probe multiple URLs
 * POST /probe/cancel/:id        Cancel in-progress playlist enrichment
 *
 * Playlist workflow:
 *   POST /probe/deep with a playlist URL returns the flat playlist result
 *   (title, count, no sizes yet) AND immediately starts playlist-worker.js
 *   in the background. The worker broadcasts `playlist_progress` WS events
 *   as each video resolves, updating the UI's size totals live.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const log     = require('../logger').child('routes/probe.js');

const { quickAnalyze, probeYouTube, probeInstagram, probeGeneric, detectPlatform, detectYouTubeType } = require('../detector');
const { broadcastProbeResult } = require('../websocket');
const { getCookiesFilePath }   = require('../cookies');

// Active playlist enrichment handles keyed by playlistId
const activeEnrichments = new Map();

// Stage 1: Instant URL analysis
router.get('/quick', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  log.info('GET /quick', 'Request', { url });
  try {
    const result = quickAnalyze(url);
    log.ok('GET /quick', 'Result', { platform: result.platform, contentType: result.contentType });
    res.json(result);
  } catch (e) {
    log.error('GET /quick', 'Failed', e);
    res.status(500).json({ error: e.message });
  }
});

// Stage 2: Deep probe + background playlist enrichment
router.post('/deep', async (req, res) => {
  const { url, tabId } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const platform = detectPlatform(url);
  log.info('POST /deep', 'Request received', { url, platform, tabId });

  try {
    let result;
    const t0 = Date.now();

    if (platform === 'youtube')        result = await probeYouTube(url);
    else if (platform === 'instagram') result = await probeInstagram(url, req.body.currentSlide || 0);
    else                               result = await probeGeneric(url);

    log.ok('POST /deep', `Probe complete in ${Date.now() - t0}ms`, {
      platform, contentType: result.contentType,
      title: result.title?.slice(0, 80),
      formatsCount: result.videoFormats?.length ?? result.formats?.length ?? 0,
      hasSubtitles: result.hasSubtitles,
      audioFormatsCount: result.audioFormats?.length ?? 0,
      error: result.error || null
    });

    if (tabId) broadcastProbeResult(tabId, result);
    if (result.contentType === 'playlist' || result.contentType === 'mix_playlist') {
      _startEnrichment(result, tabId);
    }

    const { entries: _entries, ...safe } = result;
    res.json(safe);
  } catch (e) {
    log.error('POST /deep', 'Probe threw an exception', {
      url, platform, errorMsg: e.message,
      stack: e.stack?.split('\n').slice(0,5).join(' | ')
    });
    res.status(500).json({ error: e.message, platform });
  }
});

// Cancel an in-progress playlist enrichment
router.post('/cancel/:id', (req, res) => {
  const handle = activeEnrichments.get(req.params.id);
  if (handle) { handle.cancel(); activeEnrichments.delete(req.params.id); }
  res.json({ ok: true });
});

// Batch probe (up to 10 URLs)
router.post('/batch', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' });

  const results = await Promise.allSettled(
    urls.slice(0, 10).map(url => {
      const p = detectPlatform(url);
      if (p === 'youtube')   return probeYouTube(url);
      if (p === 'instagram') return probeInstagram(url);
      return probeGeneric(url);
    })
  );

  res.json(results.map((r, i) => ({
    url: urls[i],
    ...(r.status === 'fulfilled' ? r.value : { error: r.reason?.message })
  })));
});

function _startEnrichment(playlistResult, tabId) {
  if (!playlistResult.entries?.length || !playlistResult.enriching) return;

  const id = playlistResult.playlistId || playlistResult.title;
  if (!id) return;

  // Cancel any stale enrichment for the same playlist
  if (activeEnrichments.has(id)) activeEnrichments.get(id).cancel();

  // Dynamically require to avoid circular deps at module load time
  const { startPlaylistEnrichment } = require('../playlist-worker');
  const cookieFile = getCookiesFilePath?.() || null;

  const handle = startPlaylistEnrichment(id, tabId, playlistResult.entries, cookieFile);
  activeEnrichments.set(id, handle);

  // Auto-cleanup after 30 minutes regardless
  setTimeout(() => { activeEnrichments.delete(id); }, 30 * 60 * 1000);
}

module.exports = router;
