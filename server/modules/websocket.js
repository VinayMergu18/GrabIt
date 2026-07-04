/**
 * websocket.js — Real-time broadcasting to extension clients.
 *
 * Events:
 *   connected           → sent on connect with server version
 *   queue_update        → { queue: Item[] }
 *   download_progress   → { id, progress }  (debounced 200ms)
 *   download_complete   → { id, file, ... }
 *   download_error      → { id, error }
 *   probe_result        → { tabId, result }
 *   playlist_progress   → { playlistId, tabId, completed, total, videoTotals, audioTotals, totalDuration, done }
 *   slide_update        → { tabId, slideIndex }
 */

'use strict';

const { WebSocketServer } = require('ws');

let wss = null;
const clients = new Set();
const progressTimers = new Map();
const PROGRESS_DEBOUNCE_MS = 200;

function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => { clients.delete(ws); console.log(`[WS] Client disconnected (${clients.size} remaining)`); });
    ws.on('error', (err) => { console.warn('[WS] Client error:', err.message); clients.delete(ws); try { ws.terminate(); } catch {} });

    safeSend(ws, { type: 'connected', version: '4.0.0' });
    try { const { getQueue } = require('./queue'); safeSend(ws, { type: 'queue_update', queue: getQueue() }); } catch {}
  });

  // Ping every 20s; drop dead clients
  const pingInterval = setInterval(() => {
    for (const ws of [...clients]) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { clients.delete(ws); }
    }
  }, 20000);
  wss.on('close', () => clearInterval(pingInterval));
  console.log('[WS] WebSocket server initialized');
}

function broadcast(eventType, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ type: eventType, ...payload, ts: Date.now() });
  for (const ws of [...clients]) { if (ws.readyState === 1) safeSend(ws, msg, true); }
}

function safeSend(ws, data, isString = false) {
  try { ws.send(isString ? data : JSON.stringify(data)); } catch {}
}

function broadcastProgress(id, progress) {
  if (progressTimers.has(id)) return;
  progressTimers.set(id, setTimeout(() => {
    progressTimers.delete(id);
    broadcast('download_progress', { id, progress });
  }, PROGRESS_DEBOUNCE_MS));
  if ((progress.percent || 0) > 0 && (progress.percent || 0) < 100) {
    broadcast('download_progress', { id, progress });
  }
}

function broadcastComplete(id, info) {
  if (progressTimers.has(id)) { clearTimeout(progressTimers.get(id)); progressTimers.delete(id); }
  broadcast('download_complete', { id, ...info });
}

function broadcastError(id, error) {
  if (progressTimers.has(id)) { clearTimeout(progressTimers.get(id)); progressTimers.delete(id); }
  broadcast('download_error', { id, error });
}

function broadcastQueueUpdate(items) {
  broadcast('queue_update', { queue: items });
}

function broadcastSlideUpdate(tabId, slideIndex) {
  broadcast('slide_update', { tabId, slideIndex });
}

function broadcastProbeResult(tabId, result) {
  broadcast('probe_result', { tabId, result });
}

/** Called by playlist-worker.js as each batch of videos resolves. */
function broadcastPlaylistProgress(playlistId, tabId, data) {
  broadcast('playlist_progress', { playlistId, tabId, ...data });
}

module.exports = {
  initWebSocket, broadcast,
  broadcastProgress, broadcastComplete, broadcastError,
  broadcastQueueUpdate, broadcastSlideUpdate,
  broadcastProbeResult, broadcastPlaylistProgress
};
