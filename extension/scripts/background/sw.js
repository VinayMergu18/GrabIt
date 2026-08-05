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
console.log('[sw.js] Script starting');

const SERVER = 'http://127.0.0.1:7272';
const WS_URL = 'ws://127.0.0.1:7272';
// Cookie extraction constants
const COOLDOWN_MS = 5000; // 5 seconds between cookie extractions for same site
const lastCookieExtraction = new Map(); // Track last extraction time per tabId

// ── Stream store ──────────────────────────────────────────────────────────────
/** @type {Map<number, Map<string, StreamInfo>>} */
const tabStreams = new Map();
// Request headers are needed for signed/CDN streams that reject a bare fetch.
const requestHeaders = new Map();
let vdownWorker = null;
let vdownWorkerReady = null;
const vdownWaiters = new Map();
// ── Playlist scan progress store ────────────────────────────────────────
/** @type {Map<number, Map<string, any>>} */
const playlistProgressMap = new Map();

const TYPE_MAP = {
  m3u8: 'HLS',  mpd: 'DASH',
  mp4: 'MP4',   webm: 'WebM', m4v: 'MP4',
  mov: 'MOV',   mkv: 'MKV',  avi: 'AVI',
  flv: 'FLV',   ts:  'TS',   ogg: 'OGG', ogv: 'OGG',
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
  if (typeof url !== 'string') return null;
  let clean, hostname;
  try {
    const u = new URL(url);
    clean    = u.pathname.toLowerCase();
    hostname = u.hostname;
  } catch { return null; }

  if (SKIP_HOST.has(hostname)) return null;

  const urlLower = url.toLowerCase();
  if (urlLower.endsWith('.m3u8')) return 'HLS';
  if (urlLower.endsWith('.mpd')) return 'DASH';
  if (urlLower.endsWith('.mp4') || urlLower.endsWith('.m4v')) return 'MP4';
  if (urlLower.endsWith('.webm')) return 'WebM';
  if (urlLower.endsWith('.ogg') || urlLower.endsWith('.ogv')) return 'OGG';
  if (urlLower.endsWith('.mkv')) return 'MKV';
  if (urlLower.endsWith('.avi')) return 'AVI';
  if (urlLower.endsWith('.mov')) return 'MOV';
  if (urlLower.endsWith('.flv')) return 'FLV';
  if (urlLower.endsWith('.ts')) return 'TS';
  // Pattern-based detection for URLs without clear extension
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url)) return 'DASH';
  if (/manifest\.m3u8|playlist\.m3u8/i.test(url)) return 'HLS';
  if (/\/hls\//i.test(url) && /\.(m3u8|ts)/i.test(url)) return 'HLS';
  if (/\/dash\//i.test(url) && /\.mpd/i.test(url)) return 'DASH';

  return null;
}

/** Guess resolution from URL string (e.g. "1080p", "720", "high") */
function guessQuality(url) {
  if (typeof url !== 'string') return null;
  const urlLower = url.toLowerCase();
  if (/4k|2160p|uhd/.test(urlLower)) return '4K';
  if (/1440p|2k|qhd/.test(urlLower)) return '1440p';
  if (/1080p|fhd|full.?hd/.test(urlLower)) return '1080p';
  if (/720p|\bhd\b/.test(urlLower)) return '720p';
  if (/480p|\bsd\b/.test(urlLower)) return '480p';
  if (/360p/.test(urlLower)) return '360p';
  if (/240p/.test(urlLower)) return '240p';
  if (/144p/.test(urlLower)) return '144p';
  if (/high/.test(urlLower)) return 'High';
  if (/medium|mid/.test(urlLower)) return 'Medium';
  if (/low/.test(urlLower)) return 'Low';
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

function addStream(tabId, url, pageTitle, headers = []) {
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

  const stream = {
    url,
    type,
    name:    pageTitle || urlName(url),
    quality: guessQuality(url),
    headers: normalizeHeaders(headers),
    variants: null,
    parsing: false,
    ts:      Date.now(),
  };
  map.set(url, stream);

  updateBadge(tabId, map.size);

  // Push to popup if open
  chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
  if (type === 'HLS' || type === 'DASH') enrichManifest(tabId, stream);
}

function normalizeHeaders(headers) {
  const allow = new Set(['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent']);
  return (headers || []).map(h => Array.isArray(h) ? { name: h[0], value: h[1] } : h)
    .filter(h => h?.name && h.value && allow.has(h.name.toLowerCase()))
    .map(h => [h.name, h.value]);
}

// The bundled site detectors are derived from VDown and send their already
// parsed `on_media` object through this small serde format. Consume it directly:
// it is more accurate than trying to infer a master playlist from a media
// rendition request.
function vdownDeserialize(value) {
  if (!value || typeof value !== 'object' || !value.__serde_tag) return value;
  const data = value.__serde_val;
  switch (value.__serde_tag) {
    case 'primitive': return data;
    case 'url': return data;
    case 'headers': return data || [];
    case 'array': return (data || []).map(vdownDeserialize);
    case 'some': return vdownDeserialize(data);
    case 'none': return null;
    case 'object': return Object.fromEntries(Object.entries(data || {}).map(([key, item]) => [key, vdownDeserialize(item)]));
    case 'map': return new Map((data || []).map(([key, item]) => [vdownDeserialize(key), vdownDeserialize(item)]));
    default: return null;
  }
}

function optionValue(value) { return value?.__serde_tag ? vdownDeserialize(value) : value; }

function addDetectorMedia(tabId, rawMedia, pageTitle) {
  const media = vdownDeserialize(rawMedia);
  if (!media || !['m3u8_playlist', 'mpd_playlist'].includes(media.type) || !media.master_url) return false;
  const url = optionValue(media.master_url);
  if (!url) return false;
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const map = tabStreams.get(tabId);
  const playlist = optionValue(media.playlist) || [];
  const variants = playlist.map((entry, index) => {
    const quality = optionValue(entry.quality) || {};
    const size = optionValue(quality.size) || {};
    const av = optionValue(entry.av) || {};
    return {
      id: `${media.type}-${index}`, protocol: media.type === 'mpd_playlist' ? 'dash' : 'hls',
      workerEntry: Number.isFinite(entry.index) ? entry.index : index,
      url: optionValue(av.video) || url, audioUrl: optionValue(av.audio) || null,
      width: Number(size.width || 0), height: Number(size.height || 0), bitrate: Number(optionValue(quality.bitrate) || 0),
      codecs: '', container: optionValue(entry.demuxer) || 'mp4'
    };
  }).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  const existing = map.get(url);
  map.set(url, {
    url, type: media.type === 'mpd_playlist' ? 'DASH' : 'HLS', name: optionValue(media.title) || pageTitle || urlName(url),
    quality: null, headers: normalizeHeaders(optionValue(media.sent_headers)), variants, parsing: false, ts: Date.now(),
    manifestError: variants.length ? null : 'The site exposed no downloadable variants.'
  });
  updateBadge(tabId, map.size);
  chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
  return !existing;
}

function attributes(line) {
  const out = {};
  line.replace(/([A-Z0-9-]+)=((?:\"[^\"]*\")|[^,]*)/gi, (_, k, v) => { out[k] = v.replace(/^\"|\"$/g, ''); return _; });
  return out;
}

function mimeFromCodecs(codecs = '') {
  return /vp9|vp09|av01/i.test(codecs) ? 'webm' : 'mp4';
}

function parseHlsMaster(text, masterUrl) {
  const lines = text.split(/\r?\n/);
  const audioGroups = new Map();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line.slice(13));
    if (a.TYPE === 'AUDIO' && a.GROUP-ID && a.URI && (!audioGroups.has(a.GROUP-ID) || a.DEFAULT === 'YES'))
      audioGroups.set(a.GROUP-ID, new URL(a.URI, masterUrl).href);
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attributes(lines[i].slice(18));
    const uri = lines.slice(i + 1).find(x => x.trim() && !x.startsWith('#'));
    if (!uri) continue;
    const [width, height] = (a.RESOLUTION || 'x').split('x').map(Number);
    variants.push({ id: `hls-${variants.length}`, protocol: 'hls', url: new URL(uri.trim(), masterUrl).href,
      audioUrl: audioGroups.get(a.AUDIO) || null, width: width || 0, height: height || 0,
      bitrate: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0), codecs: a.CODECS || '', container: mimeFromCodecs(a.CODECS) });
  }
  return variants;
}

function parseDashMpd(text, masterUrl) {
  const variants = [];
  const attrs = s => Object.fromEntries([...s.matchAll(/([\w:-]+)=[\"']([^\"']*)[\"']/g)].map(m => [m[1], m[2]]));
  let setIndex = 0;
  for (const match of text.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const set = attrs(match[1]), body = match[2], mime = set.mimeType || '';
    if (!mime.startsWith('video/')) { setIndex++; continue; }
    let index = 0;
    for (const repMatch of body.matchAll(/<Representation\b([^>]*)(?:\/>|>([\s\S]*?)<\/Representation>)/gi)) {
      const rep = attrs(repMatch[1]), repBody = repMatch[2] || '';
      const base = repBody.match(/<BaseURL[^>]*>\s*([^<]+)\s*<\/BaseURL>/i)?.[1] || body.match(/<BaseURL[^>]*>\s*([^<]+)\s*<\/BaseURL>/i)?.[1];
      variants.push({ id: `dash-${setIndex}-${index++}`, protocol: 'dash', representationId: rep.id,
        workerEntry: variants.length,
        url: base ? new URL(base, masterUrl).href : masterUrl, width: Number(rep.width || set.width || 0), height: Number(rep.height || set.height || 0),
        bitrate: Number(rep.bandwidth || 0), codecs: rep.codecs || set.codecs || '', container: mime.includes('webm') ? 'webm' : 'mp4' });
    }
    setIndex++;
  }
  return variants;
}

async function enrichManifest(tabId, stream) {
  if (stream.parsing) return;
  stream.parsing = true;
  try {
    const response = await fetch(stream.url, { headers: Object.fromEntries(stream.headers), credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const variants = stream.type === 'HLS' ? parseHlsMaster(text, stream.url) : parseDashMpd(text, stream.url);
    // A media playlist is a valid single-quality HLS source.
    stream.variants = variants.length ? variants.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate) :
      stream.type === 'HLS' ? [{ id: 'hls-source', protocol: 'hls', url: stream.url, width: 0, height: 0, bitrate: 0, codecs: '', container: 'mp4' }] : [];
  } catch (error) {
    stream.manifestError = error.message;
    // If we cannot fetch the manifest, assume it's a media playlist and use it as a single variant (for HLS only)
    if (stream.type === 'HLS') {
      stream.variants = [{ id: 'hls-source', protocol: 'hls', url: stream.url, width: 0, height: 0, bitrate: 0, codecs: '', container: 'mp4' }];
    } else {
      stream.variants = [];
    }
  } finally {
    stream.parsing = false;
    chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
  }
}

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  if (count > 0) chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId }).catch(() => {});
}

// Cookie extraction for YouTube/Instagram
async function extractAndSendCookies(tabId, url) {
  try {
    const urlObj = new URL(url);
    // Keep the original hostname for logging
    const originalHostname = urlObj.hostname;
    let hostname = urlObj.hostname;
    // Remove www. prefix if present
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }

    let cookieDomain;
    if (hostname.endsWith('.youtube.com') || hostname === 'youtube.com') {
      cookieDomain = 'youtube.com';
    } else if (hostname.endsWith('.instagram.com') || hostname === 'instagram.com') {
      cookieDomain = 'instagram.com';
    } else {
      // Not a site we care about
      return;
    }

    // Check cooldown
    const now = Date.now();
    const lastExtraction = lastCookieExtraction.get(tabId) || 0;
    if (now - lastExtraction < COOLDOWN_MS) {
      return; // Still in cooldown period
    }

    // Get all cookies for the domain (which will include subdomains)
    const cookies = await chrome.cookies.getAll({ domain: cookieDomain });

    if (cookies.length === 0) {
      console.log(`[AutoCookies] No ${cookieDomain} cookies found for tab ${tabId} (hostname: ${originalHostname})`);
      return;
    }

    // Convert to Netscape cookie format
    const cookiesTxt = [
      '# Netscape HTTP Cookie File',
      '# This file was generated by GrabIt Extension',
      '',
      ...cookies.map(cookie => {
        const domain = cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain;
        const secure = cookie.secure ? 'TRUE' : 'FALSE';
        const httpOnly = cookie.httpOnly ? 'TRUE' : 'FALSE';
        const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0;
        return [domain, 'TRUE', cookie.path, secure, expires, cookie.name, cookie.value].join('\t');
      })
    ].join('\n');

    // Send to local server
    const response = await fetch(`${SERVER}/cookies/inject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cookies: cookiesTxt })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    console.log(`[AutoCookies] Injected ${cookies.length} ${cookieDomain} cookies for tab ${tabId} (hostname: ${originalHostname})`);

    // Update last extraction time
    lastCookieExtraction.set(tabId, now);

  } catch (error) {
    // The media Stream tab is fully offline. Keep the legacy YT/Instagram
    // cookie relay quiet when the optional local server is not running.
    console.debug(`[AutoCookies] Optional local server unavailable: ${error.message}`);
  }
}

// ── webRequest listener — network-level stream detection ──────────────────────
// Fires for EVERY matching request across ALL tabs automatically.
// No page injection needed; this is why webRequest is the primary method.
chrome.webRequest.onSendHeaders.addListener(
  (details) => { if (details.tabId >= 0) requestHeaders.set(details.requestId, details.requestHeaders || []); },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['requestHeaders', 'extraHeaders']
);
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    // Get page title asynchronously (don't block the request)
    chrome.tabs.get(details.tabId)
      .then(tab => addStream(details.tabId, details.url, tab?.title || '', requestHeaders.get(details.requestId)))
      .catch(() => addStream(details.tabId, details.url, '', requestHeaders.get(details.requestId)));
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

// Many CDNs hide the extension in a signed URL. Content-Type lets those streams
// enter the same manifest pipeline as ordinary .m3u8/.mpd URLs.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0) return;
  const contentType = (details.responseHeaders || []).find(h => h.name?.toLowerCase() === 'content-type')?.value?.toLowerCase() || '';
  let type = null;
  if (/mpegurl|vnd\.apple\.mpegurl/.test(contentType)) type = 'HLS';
  else if (/dash\+xml/.test(contentType)) type = 'DASH';
  else if (/^video\//.test(contentType)) type = 'MP4';
  if (!type || classifyUrl(details.url)) return;
  if (!tabStreams.has(details.tabId)) tabStreams.set(details.tabId, new Map());
  const map = tabStreams.get(details.tabId);
  if (map.has(details.url)) return;
  chrome.tabs.get(details.tabId).then(tab => {
    map.set(details.url, { url: details.url, type, name: tab?.title || urlName(details.url), quality: null,
      headers: normalizeHeaders(requestHeaders.get(details.requestId)), variants: null, parsing: false, ts: Date.now() });
    updateBadge(details.tabId, map.size);
    const stream = map.get(details.url);
    chrome.runtime.sendMessage({ type: 'streams_updated', tabId: details.tabId }).catch(() => {});
    if (type === 'HLS' || type === 'DASH') enrichManifest(details.tabId, stream);
  }).catch(() => {});
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders', 'extraHeaders']);

// ── Tab lifecycle ─────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabStreams.delete(tabId);
    updateBadge(tabId, 0);
  } else if (changeInfo.status === 'complete' && tabId >= 0) {
    // Get the tab URL to check if it's YouTube/Instagram
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.url) {
        extractAndSendCookies(tabId, tab.url).catch(err => {
          console.error('[AutoCookies] Error in extractAndSendCookies:', err);
        });
      }
    }).catch(() => {
      // Silently handle errors (e.g., if tab was closed)
    });
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

// VDown's browser-only worker is vendored separately so its large generated
// LibAV bundle is not duplicated in this source file. It uses this exact channel.
const vdownChannel = new BroadcastChannel('worker_service');
vdownChannel.addEventListener('message', event => {
  if (event.data?.channel !== 3) return;
  const message = event.data.msg;
  const id = message?.data?.download_id;
  if (message?.name === 'download_progress' && id) notifyStreamProgress(null, id, message.data.progress);
  if ((message?.name === 'download_result' || message?.name === 'download_error') && id) {
    const waiter = vdownWaiters.get(id);
    if (!waiter) return;
    vdownWaiters.delete(id);
    message.name === 'download_result' ? waiter.resolve(message.data) : waiter.reject(new Error(message.data.error || 'LibAV worker failed'));
  }
});

function vdownSerialize(value) {
  if (value instanceof URL) return { __serde_tag: 'url', __serde_val: value.href };
  if (value instanceof Headers) return { __serde_tag: 'headers', __serde_val: [...value.entries()] };
  if (Array.isArray(value)) return { __serde_tag: 'array', __serde_val: value.map(vdownSerialize) };
  if (value === null || typeof value !== 'object') return { __serde_tag: 'primitive', __serde_val: value };
  const output = {}; for (const [key, item] of Object.entries(value)) output[key] = vdownSerialize(item);
  return { __serde_tag: 'object', __serde_val: output };
}

async function ensureVdownWorker() {
  if (vdownWorkerReady) return vdownWorkerReady;
  vdownWorkerReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LibAV worker files are not installed. See scripts/stream-worker/README.md.')), 4000);
    const ready = event => {
      if (event.data?.channel === 3 && event.data?.msg?.name === 'is_ready_success') {
        clearTimeout(timer); vdownChannel.removeEventListener('message', ready); resolve();
      }
    };
    vdownChannel.addEventListener('message', ready);
    try { vdownWorker = new Worker(chrome.runtime.getURL('scripts/stream-worker/main.js'), { type: 'module' }); }
    catch (error) { clearTimeout(timer); vdownChannel.removeEventListener('message', ready); reject(error); }
  });
  try { return await vdownWorkerReady; } catch (error) { vdownWorkerReady = null; throw error; }
}

async function vdownDownload(args) {
  await ensureVdownWorker();
  return new Promise((resolve, reject) => {
    vdownWaiters.set(args.download_id, { resolve, reject });
    vdownChannel.postMessage({ channel: 2, msg: { name: 'download', data: { download_args: vdownSerialize(args) } } });
  });
}

// ── Offline Stream-tab downloader ───────────────────────────────────────────
// This deliberately never calls SERVER. Direct files and muxed HLS are assembled
// in the extension; encrypted/adaptive A/V streams are rejected instead of being
// silently sent to a server or producing a corrupt file.
function safeFilename(name, extension) {
  const base = String(name || 'video').replace(/[\\/:*?\"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140) || 'video';
  return `${base}.${extension}`;
}

function notifyStreamProgress(tabId, streamUrl, progress) {
  chrome.runtime.sendMessage({ type: 'stream_download_progress', tabId, streamUrl, progress }).catch(() => {});
}

async function fetchBytes(url, headers, onProgress) {
  const response = await fetch(url, { headers: Object.fromEntries(headers || []), credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching media`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const parts = []; let loaded = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); loaded += value.byteLength; onProgress?.(loaded); }
  const result = new Uint8Array(loaded); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function hlsBytes(playlistUrl, headers, progress) {
  const response = await fetch(playlistUrl, { headers: Object.fromEntries(headers || []), credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching HLS playlist`);
  const text = await response.text();
  if (/^#EXT-X-KEY:.*METHOD=(?!NONE)/mi.test(text)) throw new Error('Encrypted HLS/DRM streams cannot be downloaded.');
  const lines = text.split(/\r?\n/), urls = [];
  let init = null;
  for (const line of lines) {
    const map = line.match(/^#EXT-X-MAP:.*URI=\"([^\"]+)\"/i); if (map) init = new URL(map[1], playlistUrl).href;
    if (line.trim() && !line.startsWith('#')) urls.push(new URL(line.trim(), playlistUrl).href);
  }
  if (!urls.length) throw new Error('HLS media playlist contains no segments.');
  const all = init ? [init, ...urls] : urls, parts = []; let loaded = 0;
  for (let i = 0; i < all.length; i++) {
    const bytes = await fetchBytes(all[i], headers); parts.push(bytes); loaded += bytes.byteLength;
    progress({ phase: 'downloading', completed: i + 1, total: all.length, bytes: loaded });
  }
  const output = new Uint8Array(loaded); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return { bytes: output, extension: init ? 'mp4' : 'ts' };
}

async function offlineStreamDownload(tabId, streamUrl, variantId) {
  const stream = tabStreams.get(tabId)?.get(streamUrl);
  if (!stream) throw new Error('The selected stream is no longer available. Refresh the page and try again.');
  const variant = stream.variants?.find(v => v.id === variantId) || null;
  const headers = stream.headers || [];
  notifyStreamProgress(tabId, streamUrl, { phase: 'starting' });
  let blob, extension, workerBlobUrl = null;
  if (stream.type === 'HLS') {
    if (!variant) throw new Error('The HLS qualities are still loading. Please try again in a moment.');
    if (variant.audioUrl) {
      const id = `stream_${crypto.randomUUID()}`;
      const result = await vdownDownload({ download_id: id, headers: new Headers(headers), good_basename: safeFilename(stream.name, 'mp4').replace(/\.mp4$/, ''), subdir: '', save_as: false, will_use_jsfetch: false,
        strategy: 'm3u8_audio_video_two_sources', muxer: 'mp4', url: new URL(variant.url), url_audio: new URL(variant.audioUrl), carry_get_params: false,
        extension: 'mp4', is_youtube: false, throttle: false, cache: 'default', duration: 'unknown' });
      workerBlobUrl = result.internal_bloburl; extension = 'mp4';
    } else {
      const result = await hlsBytes(variant.url, headers, p => notifyStreamProgress(tabId, streamUrl, p));
      blob = new Blob([result.bytes], { type: result.extension === 'mp4' ? 'video/mp4' : 'video/mp2t' }); extension = result.extension;
    }
  } else if (stream.type === 'DASH') {
    if (!variant) throw new Error('The DASH qualities are still loading. Please try again in a moment.');
    const id = `stream_${crypto.randomUUID()}`; extension = variant.container || 'mp4';
    const result = await vdownDownload({ download_id: id, headers: new Headers(headers), good_basename: safeFilename(stream.name, extension).replace(new RegExp(`\\.${extension}$`), ''), subdir: '', save_as: false, will_use_jsfetch: true,
      strategy: 'mpd_audio_video_one_source', muxer: extension, url: new URL(stream.url), carry_get_params: false, entry: variant.workerEntry,
      duration: 'unknown', extension, is_youtube: false, throttle: false, cache: 'default' });
    workerBlobUrl = result.internal_bloburl;
  } else {
    const bytes = await fetchBytes(stream.url, headers, bytes => notifyStreamProgress(tabId, streamUrl, { phase: 'downloading', bytes }));
    extension = (stream.type === 'WebM' ? 'webm' : stream.type || 'mp4').toLowerCase(); blob = new Blob([bytes], { type: 'application/octet-stream' });
  }
  const objectUrl = workerBlobUrl || URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url: objectUrl, filename: safeFilename(stream.name, extension), conflictAction: 'uniquify', saveAs: false });
    notifyStreamProgress(tabId, streamUrl, { phase: 'complete', downloadId: id });
    return { downloadId: id };
  } finally {
    setTimeout(() => {
      if (workerBlobUrl) vdownChannel.postMessage({ channel: 2, msg: { name: 'revoke_blob_url', data: { blob_url: workerBlobUrl } } });
      else URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // VDown-compatible dedicated detectors (Vimeo, VK, Bilibili, etc.).
  // Their parsed manifests contain the real rendition list, including URLs that
  // may never appear as a browser network request.
  if (msg?.channel === 0 && msg?.msg?.name === 'on_media') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      addDetectorMedia(tabId, msg.msg.data?.media, sender.tab?.title || '');
      sendResponse({ ok: true });
    }
    return true;
  }

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

  if (msg.type === 'DOWNLOAD_STREAM_OFFLINE') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      try {
        const result = await offlineStreamDownload(tabs[0]?.id, msg.streamUrl, msg.variantId);
        sendResponse({ ok: true, ...result });
      } catch (error) { sendResponse({ ok: false, error: error.message || String(error) }); }
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
console.log('[AutoCookies] Background service worker active — watching for YouTube/Instagram tabs');
chrome.runtime.onStartup.addListener(connectWS);
chrome.runtime.onInstalled.addListener(connectWS);
