/**
 * sw.js — Background service worker with web stream detection.
 *
 * Stream detection uses two complementary methods:
 *   1. chrome.webRequest (network level) — catches every m3u8/mpd/mp4 request
 *      automatically for every tab, zero code injection needed.
 *   2. DOM scanner (via scripting.executeScript) — called when popup opens
 *      to find <video>, <source>, and data-src attributes already in the page.
 *
 * Per-tab stream store: Map<tabId, Map<url, StreamInfo>>
 * Cleared on tab navigation/removal. Badge shows live stream count.
 */

'use strict';

const SERVER = 'http://127.0.0.1:7272';
const WS_URL = 'ws://127.0.0.1:7272';

// ── Stream store ──────────────────────────────────────────────────────────────
/** @type {Map<number, Map<string, StreamInfo>>} */
const tabStreams = new Map();

const TYPE_MAP = {
  m3u8: 'HLS',  mpd: 'DASH',
  mp4: 'MP4',   webm: 'WebM', m4v: 'MP4',
  mov: 'MOV',   mkv: 'MKV',  avi: 'AVI',
  flv: 'FLV',   ts:  'TS',   ogg: 'OGG',
};

// Extensions that are definitely NOT streams (skip silently)
const SKIP_EXT = new Set([
  'm4s','aac','mp3','vtt','srt','ass','json','xml','js','mjs','css',
  'png','jpg','jpeg','gif','svg','ico','webp','woff','woff2','ttf','otf',
  'html','htm','php','txt','pdf','zip','gz','wasm'
]);

// Hosts to never record (server, local dev)
const SKIP_HOST = new Set(['127.0.0.1','localhost','::1']);

/**
 * Determine the stream type from a URL.
 * Returns null if this URL should be ignored.
 */
function classifyUrl(url) {
  let clean, hostname;
  try {
    const u = new URL(url);
    clean    = u.pathname.toLowerCase();
    hostname = u.hostname;
  } catch { return null; }

  if (SKIP_HOST.has(hostname)) return null;

  // Extension-based detection (most reliable)
  const extM = clean.match(/\.([a-z0-9]{2,4})(?:\?|$)/);
  const ext   = extM?.[1];
  if (ext && SKIP_EXT.has(ext)) return null;
  if (ext && TYPE_MAP[ext])     return TYPE_MAP[ext];

  // Pattern-based (no extension in URL)
  if (/\.m3u8/i.test(url))                      return 'HLS';
  if (/\.mpd/i.test(url))                        return 'DASH';
  if (/manifest\.m3u8|playlist\.m3u8/i.test(url)) return 'HLS';
  if (/\/hls\//i.test(url) && /\.(m3u8|ts)/i.test(url)) return 'HLS';
  if (/\/dash\//i.test(url) && /\.mpd/i.test(url))      return 'DASH';

  return null;
}

/** Guess resolution from URL string (e.g. "1080p", "720", "high") */
function guessQuality(url) {
  const u = url.toLowerCase();
  if (/4k|2160p|uhd/.test(u))     return '4K';
  if (/1440p|2k|qhd/.test(u))     return '1440p';
  if (/1080p|fhd|full.?hd/.test(u)) return '1080p';
  if (/720p|\bhd\b/.test(u))       return '720p';
  if (/480p|\bsd\b/.test(u))       return '480p';
  if (/360p/.test(u))              return '360p';
  if (/240p/.test(u))              return '240p';
  if (/144p/.test(u))              return '144p';
  if (/high/.test(u))              return 'High';
  if (/medium|mid/.test(u))        return 'Medium';
  if (/low/.test(u))               return 'Low';
  return null;
}

/** Build a readable name from the URL path when no page title is available */
function urlName(url) {
  try {
    const u    = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const seg   = parts.find(p => /\.(m3u8|mpd|mp4|webm)/i.test(p)) || parts[parts.length - 1] || '';
    const name  = seg.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]/g, ' ').trim();
    return name || u.hostname;
  } catch { return 'Stream'; }
}

function addStream(tabId, url, pageTitle) {
  if (!tabId || tabId < 0) return;
  const type = classifyUrl(url);
  if (!type) return;

  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const map = tabStreams.get(tabId);

  if (map.has(url)) {
    // Update name if we now have the page title
    if (pageTitle) map.get(url).name = pageTitle;
    return;
  }

  map.set(url, {
    url,
    type,
    name:    pageTitle || urlName(url),
    quality: guessQuality(url),
    ts:      Date.now(),
  });

  updateBadge(tabId, map.size);

  // Push to popup if open
  chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  if (count > 0) chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId }).catch(() => {});
}

// ── webRequest listener — network-level stream detection ──────────────────────
// Fires for EVERY matching request across ALL tabs automatically.
// No page injection needed; this is why webRequest is the primary method.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    // Get page title asynchronously (don't block the request)
    chrome.tabs.get(details.tabId)
      .then(tab => addStream(details.tabId, details.url, tab?.title || ''))
      .catch(() => addStream(details.tabId, details.url, ''));
  },
  {
    urls: [
      '*://*/*.m3u8', '*://*/*.m3u8?*',
      '*://*/*.mpd',  '*://*/*.mpd?*',
      '*://*/*.mp4',  '*://*/*.mp4?*',
      '*://*/*.webm', '*://*/*.webm?*',
      '*://*/*.mkv',  '*://*/*.mkv?*',
      '*://*/*.m4v',  '*://*/*.m4v?*',
      '*://*/*.mov',  '*://*/*.mov?*',
      '*://*/*.flv',  '*://*/*.flv?*',
      '*://*/manifest.m3u8*',
      '*://*/playlist.m3u8*',
      '*://*/hls/*.m3u8*',
      '*://*/dash/*.mpd*',
    ]
  }
);

// ── Tab lifecycle ─────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabStreams.delete(tabId);
    updateBadge(tabId, 0);
  }
});

// ── DOM scanner (injected on demand when popup opens) ────────────────────────
// Runs in the page context to find <video src>, <source src>, and data attributes
// that point to media — catches streams loaded before webRequest was active.
function domScannerScript() {
  const STREAM_RE = /\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|flv|avi|ogg)(\?|#|$)/i;
  const seen = new Set();
  const found = [];

  const check = (src) => {
    if (!src || seen.has(src)) return;
    seen.add(src);
    // Resolve relative URLs
    try { src = new URL(src, location.href).href; } catch { return; }
    if (STREAM_RE.test(src)) found.push({ url: src, pageTitle: document.title });
  };

  document.querySelectorAll('video, audio, source').forEach(el => {
    check(el.src || el.currentSrc || el.getAttribute('src') || '');
  });
  document.querySelectorAll('[data-src],[data-video-src],[data-hls-url],[data-m3u8],[data-url]').forEach(el => {
    check(el.dataset.src || el.dataset.videoSrc || el.dataset.hlsUrl || el.dataset.m3u8 || el.dataset.url || '');
  });
  // Scan inline JSON / script tags for m3u8/mpd URLs (e.g. Next.js __NEXT_DATA__)
  document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(el => {
    const text = el.textContent || '';
    const rx = /https?:\/\/[^\s"'<>]+\.(m3u8|mpd)(\?[^\s"'<>]*)?/gi;
    let m;
    while ((m = rx.exec(text)) !== null) check(m[0]);
  });

  return found;
}

async function scanDomOfTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: domScannerScript,
    });
    const found = results?.[0]?.result || [];
    found.forEach(({ url, pageTitle }) => addStream(tabId, url, pageTitle));
  } catch {} // may fail on chrome:// pages — ignore
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null, wsRetryTimer = null;

function connectWS() {
  if (ws?.readyState === WebSocket.OPEN) return;
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen    = () => clearTimeout(wsRetryTimer);
    ws.onmessage = (ev) => { try { handleServerEvent(JSON.parse(ev.data)); } catch {} };
    ws.onclose   = () => { wsRetryTimer = setTimeout(connectWS, 3000); };
    ws.onerror   = () => ws.close();
  } catch { wsRetryTimer = setTimeout(connectWS, 5000); }
}

function handleServerEvent(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});

  if (msg.type === 'download_complete') {
    chrome.notifications.create(`dl_${msg.id}`, {
      type: 'basic', iconUrl: '../icons/icon48.png',
      title: 'GrabIt — Download Complete',
      message: msg.file ? `Saved: ${msg.file.split(/[/\\]/).pop()}` : 'Download finished',
      buttons: [{ title: 'Open File' }, { title: 'Open Folder' }]
    });
  }
  if (msg.type === 'download_error') {
    chrome.notifications.create(`err_${msg.id}`, {
      type: 'basic', iconUrl: '../icons/icon48.png',
      title: 'GrabIt — Download Failed',
      message: msg.error || 'Unknown error'
    });
  }
}

chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
  const id = notifId.replace(/^(dl_|err_)/, '');
  chrome.runtime.sendMessage({ type: 'notification_action', id, action: btnIndex === 0 ? 'open_file' : 'open_folder' }).catch(() => {});
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Popup asking for all detected streams on the active tab
  if (msg.type === 'GET_STREAMS') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) await scanDomOfTab(tabId); // run DOM scan on every popup open
      const streams = tabId ? [...(tabStreams.get(tabId)?.values() || [])] : [];
      // Sort: manifests first, then by time detected
      streams.sort((a, b) => {
        const order = { HLS: 0, DASH: 1, MP4: 2, WebM: 3, MKV: 4, MOV: 5, FLV: 6, TS: 7 };
        return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.ts - b.ts;
      });
      sendResponse({ streams, tabId });
    });
    return true;
  }

  if (msg.type === 'CLEAR_STREAMS') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) { tabStreams.delete(tabId); updateBadge(tabId, 0); }
      sendResponse({ ok: true });
    });
    return true;
  }

  // From content.js DOM scanner
  if (msg.type === 'STREAM_DETECTED') {
    addStream(sender.tab?.id, msg.url, msg.pageTitle || '');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SLIDE_UPDATE') {
    fetch(`${SERVER}/slide/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...msg.data, tabId: sender.tab?.id })
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CHECK_SERVER') {
    fetch(`${SERVER}/health`).then(r => r.json()).then(d => sendResponse({ ok: true, ...d })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id });
    return true;
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
connectWS();
chrome.runtime.onStartup.addListener(connectWS);
chrome.runtime.onInstalled.addListener(connectWS);
