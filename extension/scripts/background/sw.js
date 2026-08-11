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
 *
 * ── Fixes applied in this revision ──────────────────────────────────────
 *  1. parseHlsMaster used the invalid property access `a.GROUP-ID`, which
 *     JS parses as `a.GROUP - ID` and throws a ReferenceError ("ID is not
 *     defined") the moment a master playlist declares an #EXT-X-MEDIA
 *     AUDIO group — i.e. almost any modern adaptive HLS stream. Because
 *     that throw happened inside enrichManifest's try/catch, it was
 *     silently swallowed and the stream fell back to the single-source
 *     fallback, silently losing quality/variant selection. Fixed to use
 *     bracket access `a['GROUP-ID']`.
 *  2. Stream registration ran on chrome.webRequest.onBeforeRequest, which
 *     fires BEFORE onSendHeaders. That meant requestHeaders.get(requestId)
 *     was always empty at the moment a stream was first recorded, so
 *     referer/origin/auth/cookie headers were never actually attached to
 *     newly detected streams — breaking downloads of signed/CDN-protected
 *     or referer-locked streams (the exact case the code's own comments
 *     say this map exists for). Fixed by moving extension-pattern-based
 *     detection to onSendHeaders, where details.requestHeaders is already
 *     populated and available synchronously.
 *  3. The shared `requestHeaders` map (populated for every xmlhttprequest/
 *     media/other request on every site, used to support the content-type
 *     based CDN detection in onHeadersReceived) was never cleaned up,
 *     growing without bound for the lifetime of the service worker. Added
 *     onCompleted/onErrorOccurred listeners to evict entries once a
 *     request finishes.
 *  4. lastCookieExtraction (per-tab cooldown map) was never cleaned up on
 *     tab close. Now cleared alongside tabStreams in onRemoved.
 *  5. Removed dead code that was never called or read anywhere in this
 *     file: playlistProgressMap, SKIP_EXT, hlsBytes(), fetchBytes().
 *     offlineStreamDownload() always routes through the LibAV worker
 *     (vdownDownload) now, so the old raw byte-fetch helpers were stale
 *     leftovers from an earlier implementation.
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
const offlineStreamJobs = new Map();
const offlineAbortControllers = new Map();
const OFFLINE_QUEUE_KEY = 'grabit_offline_stream_queue_v1';
const STREAM_STORE_KEY = 'grabit_streams_by_tab_v1';
let persistStreamsTimer = null;
// MV3 can suspend the service worker within seconds. Persist playlist metadata
// per tab; preview Blob URLs are regenerated after a service-worker restart.
const streamStoreReady = chrome.storage.session.get(STREAM_STORE_KEY).then(result => {
  for (const [tabId, savedStreams] of Object.entries(result[STREAM_STORE_KEY] || {})) {
    const id = Number(tabId);
    if (!Number.isInteger(id) || !Array.isArray(savedStreams)) continue;
    const current = tabStreams.get(id) || new Map();
    for (const stream of savedStreams) {
      if (!stream?.url || current.has(stream.url)) continue;
      delete stream.previewUrl; delete stream.previewPending; delete stream.previewFailed;
      current.set(stream.url, stream);
    }
    tabStreams.set(id, current);
    updateBadge(id, current.size);
  }
}).catch(error => console.debug('[Stream store] restore failed:', error));
const offlineQueueReady = chrome.storage.session.get(OFFLINE_QUEUE_KEY).then(result => {
  for (const job of result[OFFLINE_QUEUE_KEY] || []) if (job?.id) offlineStreamJobs.set(job.id, job);
}).catch(error => console.debug('[Offline queue] restore failed:', error));

function persistStreamStore() {
  clearTimeout(persistStreamsTimer);
  persistStreamsTimer = setTimeout(() => {
    const saved = Object.fromEntries([...tabStreams].map(([tabId, streams]) => [tabId, [...streams.values()].map(stream => {
      const copy = { ...stream }; delete copy.previewUrl; delete copy.previewPending; delete copy.previewFailed; return copy;
    })]));
    chrome.storage.session.set({ [STREAM_STORE_KEY]: saved }).catch(error => console.debug('[Stream store] save failed:', error));
  }, 100);
}

function publishOfflineQueue() {
  const jobs = [...offlineStreamJobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  chrome.storage.session.set({ [OFFLINE_QUEUE_KEY]: jobs }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'offline_queue_update', queue: jobs }).catch(() => {});
}

function updateOfflineJob(id, patch) {
  const job = offlineStreamJobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  publishOfflineQueue();
}
// Request headers are needed for signed/CDN streams that reject a bare fetch.
// Populated by the broad onSendHeaders listener below and evicted once the
// underlying network request finishes (see onCompleted/onErrorOccurred).
const requestHeaders = new Map();
let vdownWorkerReady = null;
const vdownWaiters = new Map();
const opfsBlobWaiters = new Map();
let vdownTaskChain = Promise.resolve();

const TYPE_MAP = {
  m3u8: 'HLS',  mpd: 'DASH',
  mp4: 'MP4',   webm: 'WebM', m4v: 'MP4',
  mov: 'MOV',   mkv: 'MKV',  avi: 'AVI',
  flv: 'FLV',   ts:  'TS',   ogg: 'OGG', ogv: 'OGG',
};

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
  // Added for other stream types with query parameters
  if (/\.mp4/i.test(url) || /\.\m4v/i.test(url)) return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  if (/\.mkv/i.test(url)) return 'MKV';
  if (/\.mov/i.test(url)) return 'MOV';
  if (/\.flv/i.test(url)) return 'FLV';
  if (/\.ts/i.test(url)) return 'TS';
  if (/\.(ogg|ogv)/i.test(url)) return 'OGG';

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

/**
 * Safely creates a URL object, falling back to the original string if URL construction fails
 * @param {string} urlString - The URL string to convert to a URL object
 * @returns {URL|string} - A URL object if successful, otherwise the original string
 */
function safeUrlObject(urlString) {
  try {
    return new URL(urlString);
  } catch (e) {
    // If URL construction fails, return the original string
    // The VDown worker's vdownSerialize function handles strings correctly
    return urlString;
  }
}

/** Normalize a URL string for equivalence comparison: ignore query, fragment, username, password, and trailing slash. */
function normalizeUrl(equivUrl) {
  try {
    const u = new URL(equivUrl);
    // Remove trailing slash from pathname if present (except for root?)
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    // Return origin + pathname
    return u.origin + pathname;
  } catch {
    // If URL invalid, fall back to lowercased string without query/fragment?
    // For simplicity, return the original string lowercased and strip everything after '?'
    const clean = equivUrl.split('?')[0].split('#')[0].toLowerCase();
    return clean;
  }
}

function urlsEquivalent(url1, url2) {
  return normalizeUrl(url1) === normalizeUrl(url2);
}

function findEquivalentStream(streamMap, url) {
  for (const [existingUrl, stream] of streamMap) {
    if (urlsEquivalent(existingUrl, url)) {
      return stream;
    }
  }
  return null;
}

function getStreamByUrl(tabId, url) {
  const map = tabStreams.get(tabId);
  if (!map) return null;
  return findEquivalentStream(map, url);
}

function addStream(tabId, url, pageTitle, headers = []) {
  if (!tabId || tabId < 0) return;
  const type = classifyUrl(url);
  if (!type) return;

  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const map = tabStreams.get(tabId);

  // Look for an existing stream with an equivalent URL (ignoring query, fragment, etc.)
  const existingStream = findEquivalentStream(map, url);
  let streamToUpdate;

  if (existingStream) {
    // Found an equivalent stream, we'll update it
    streamToUpdate = existingStream;
  } else {
    // No equivalent stream found, create a new one
    streamToUpdate = {
      url,
      type,
      name:    pageTitle || urlName(url),
      quality: guessQuality(url),
      headers: normalizeHeaders(headers),
      variants: null,
      parsing: false,
      ts:      Date.now(),
    };
    // Add to map using the original URL as key (for consistency with existing code)
    map.set(url, streamToUpdate);
  }

  // Update name if we now have a page title and the stream doesn't have a name yet
  // (or always update if pageTitle is provided? The original behavior was to update if pageTitle is provided)
  if (pageTitle && (!streamToUpdate.name || streamToUpdate.name === urlName(url))) {
    streamToUpdate.name = pageTitle;
  }
  // Backfill headers if this stream was first seen without them
  if ((!streamToUpdate.headers || streamToUpdate.headers.length === 0)) {
    const normalized = normalizeHeaders(headers);
    if (normalized.length) streamToUpdate.headers = normalized;
  }

  // Enrich manifest for HLS/DASH streams if we don't have variant info yet
  // Do this for both new streams and existing streams that lack variant info
  const needsEnrichment = (type === 'HLS' || type === 'DASH') &&
                         (!streamToUpdate.variants || streamToUpdate.variants.length === 0);
  if (needsEnrichment) {
    enrichManifest(tabId, streamToUpdate);
  }

  // Update badge and persist if this is a genuinely new stream (by URL)
  // We check if the exact URL was already in the map to avoid excessive updates
  if (!map.has(url)) {
    updateBadge(tabId, map.size);
    persistStreamStore();
    // Push to popup if open
    chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
  }
}

function normalizeHeaders(headers) {
  const allow = new Set(['accept', 'accept-language', 'authorization', 'cookie', 'origin', 'referer', 'user-agent']);
  const source = headers instanceof Headers ? [...headers.entries()] :
    (Array.isArray(headers) ? headers : (headers && typeof headers === 'object' ? Object.entries(headers) : []));
  return source.map(h => Array.isArray(h) ? { name: h[0], value: h[1] } : h)
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

function hasResolvedQuality(stream) {
  return Array.isArray(stream?.variants) && stream.variants.some(variant => Number(variant.height) > 0);
}

function mergeInferiorStreamDuplicates(map, preferred) {
  if (!hasResolvedQuality(preferred)) return;
  for (const [key, candidate] of map) {
    if (urlsEquivalent(key, preferred.url) || hasResolvedQuality(candidate)) continue;
    // Only merge records that describe the same visible media: same page title
    // and artwork. This avoids collapsing legitimately separate videos on a
    // page while removing the generic network record VDown has superseded.
    const sameTitle = candidate.name === preferred.name;
    const sameArtwork = Boolean(preferred.thumbnailUrl) && candidate.thumbnailUrl === preferred.thumbnailUrl;
    const isChildRendition = (preferred.variants || []).some(variant =>
      urlsEquivalent(variant.url, candidate.url) ||
      (variant.audioUrl && urlsEquivalent(variant.audioUrl, candidate.url))
    );
    if (isChildRendition || (sameTitle && sameArtwork)) map.delete(key);
  }
}

function addDetectorMedia(tabId, rawMedia, pageTitle) {
  const media = vdownDeserialize(rawMedia);
  if (!media || !['m3u8_playlist', 'mpd_playlist'].includes(media.type) || !media.master_url) return false;
  const url = optionValue(media.master_url);
  if (!url) return false;
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Map());
  const map = tabStreams.get(tabId);
  const rawPlaylist = optionValue(media.playlist) || [];
  // VDown detectors normally send the normalized rendition array. Accept the
  // parser's master-playlist object too, so a detector update can never make
  // GrabIt fall back to a single unlabelled "Source" entry.
  const playlist = Array.isArray(rawPlaylist) ? rawPlaylist :
    (Array.isArray(rawPlaylist.playlists) ? rawPlaylist.playlists : []);
  const variants = playlist.map((entry, index) => {
    const quality = optionValue(entry.quality) || {};
    const size = optionValue(quality.size) || {};
    const av = optionValue(entry.av) || {};
    const attributes = optionValue(entry.attributes) || {};
    const resolution = attributes.RESOLUTION || attributes.resolution || {};
    const width = Number(size.width || resolution.width || 0);
    const height = Number(size.height || resolution.height || 0);
    const videoUrl = optionValue(av.video) || optionValue(entry.url) || optionValue(entry.uri) || url;
    const audioUrl = optionValue(av.audio) || null;
    let resolvedVideoUrl = videoUrl, resolvedAudioUrl = audioUrl;
    try { resolvedVideoUrl = new URL(String(videoUrl), safeUrlObject(url)).href; } catch {}
    try { if (audioUrl) resolvedAudioUrl = new URL(String(audioUrl), safeUrlObject(url)).href; } catch {}
    return {
      id: `${media.type}-${index}`, protocol: media.type === 'mpd_playlist' ? 'dash' : 'hls',
      workerEntry: Number.isFinite(entry.index) ? entry.index : index,
      url: resolvedVideoUrl, audioUrl: resolvedAudioUrl,
      width, height, bitrate: Number(optionValue(quality.bitrate) || attributes.BANDWIDTH || attributes.bandwidth || 0),
      codecs: '', container: optionValue(entry.demuxer) || 'mp4'
    };
  }).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  // VDown's deduplication rule: once a master playlist is known, discard the
  // child rendition entries discovered from the network. They are not separate
  // videos and were the source of GrabIt's duplicate cards.
  const childUrls = variants.flatMap(variant => [variant.url, variant.audioUrl]).filter(Boolean);
  for (const [key, candidate] of map) {
    const candidateVariants = candidate.variants || [];
    const isSamePlaylist = candidate.type === (media.type === 'mpd_playlist' ? 'DASH' : 'HLS') &&
      candidateVariants.some(variant => childUrls.some(childUrl => urlsEquivalent(childUrl, variant.url)));
    if (!urlsEquivalent(key, url) && (childUrls.some(childUrl => urlsEquivalent(childUrl, candidate.url)) || isSamePlaylist)) map.delete(key);
  }
  const existing = map.get(url);
  map.set(url, {
    url, type: media.type === 'mpd_playlist' ? 'DASH' : 'HLS', name: optionValue(media.title) || pageTitle || urlName(url),
    quality: null, headers: normalizeHeaders(optionValue(media.sent_headers)), variants, parsing: false, ts: Date.now(),
    // A detector does not always provide artwork. Preserve the page poster and
    // an already generated VDown preview when it re-announces this media.
    thumbnailUrl: optionValue(media.thumbnail_url) || existing?.thumbnailUrl || null,
    previewFile: existing?.previewFile || null, previewUrl: null,
    source: 'detector',
    manifestError: variants.length ? null : 'The site exposed no downloadable variants.'
  });
  mergeInferiorStreamDuplicates(map, map.get(url));
  updateBadge(tabId, map.size);
  persistStreamStore();
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
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const audioGroups = new Map();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line.slice(13));
    // FIX: `a.GROUP-ID` is invalid property access (parsed as `a.GROUP - ID`,
    // throwing "ID is not defined"). Bracket notation is required because
    // GROUP-ID contains a hyphen.
    if (a.TYPE === 'AUDIO' && a['GROUP-ID'] && a.URI && (!audioGroups.has(a['GROUP-ID']) || a.DEFAULT === 'YES'))
      audioGroups.set(a['GROUP-ID'], new URL(a.URI, safeUrlObject(masterUrl)).href);
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attributes(lines[i].slice(18));
    const uri = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
    if (!uri) continue;
    const [width, height] = (a.RESOLUTION || 'x').split('x').map(Number);
    variants.push({ id: `hls-${variants.length}`, protocol: 'hls', url: new URL(uri.trim(), safeUrlObject(masterUrl)).href,
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
        url: base ? new URL(base, safeUrlObject(masterUrl)).href : safeUrlObject(masterUrl), width: Number(rep.width || set.width || 0), height: Number(rep.height || set.height || 0),
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
    const response = await fetch(safeUrlObject(stream.url), { headers: Object.fromEntries(stream.headers), credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const variants = stream.type === 'HLS' ? parseHlsMaster(text, stream.url) : parseDashMpd(text, stream.url);
    // A media playlist is a valid single-quality HLS source.
    stream.variants = variants.length ? variants.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate) :
      stream.type === 'HLS' ? [{ id: 'hls-source', protocol: 'hls', url: stream.url, width: 0, height: 0, bitrate: 0, codecs: '', container: 'mp4' }] : [];
    if (variants.length) {
      const childUrls = new Set(variants.flatMap(variant => [variant.url, variant.audioUrl]).filter(Boolean));
      const map = tabStreams.get(tabId);
      for (const [key, candidate] of map || []) {
        if (key === stream.url) continue;
        // Check if candidate's URL is equivalent to any of the childUrls
        if ([...childUrls].some(childUrl => urlsEquivalent(candidate.url, childUrl))) {
          map.delete(key);
        }
      }
      if (map) mergeInferiorStreamDuplicates(map, stream);
      stream.previewUrl = null;
    }
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
    persistStreamStore();
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

// ── webRequest listeners — network-level stream detection ─────────────────────
const STREAM_URL_PATTERNS = [
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
  // Added for Instagram and other CDNs with deeper paths - 2 levels
  '*://*/*/*.mp4',  '*://*/*/*.mp4?*',
  '*://*/*/*.webm', '*://*/*/*.webm?*',
  '*://*/*/*.m4v',  '*://*/*/*.m4v?*',
  '*://*/*/*.mov',  '*://*/*/*.mov?*',
  '*://*/*/*.flv',  '*://*/*/*.flv?*',
  // Added for Instagram and other CDNs with deeper paths - 3 levels
  '*://*/*/*/*.mp4',  '*://*/*/*/*.mp4?*',
  '*://*/*/*/*.webm', '*://*/*/*/*.webm?*',
  '*://*/*/*/*.m4v',  '*://*/*/*/*.m4v?*',
  '*://*/*/*/*.mov',  '*://*/*/*/*.mov?*',
  '*://*/*/*/*.flv',  '*://*/*/*/*.flv?*',
  // Added for Instagram and other CDNs with deeper paths - 4 levels
  '*://*/*/*/*/*.mp4',  '*://*/*/*/*/*.mp4?*',
  '*://*/*/*/*/*.webm', '*://*/*/*/*/*.webm?*',
  '*://*/*/*/*/*.m4v',  '*://*/*/*/*/*.m4v?*',
  '*://*/*/*/*/*.mov',  '*://*/*/*/*/*.mov?*',
  '*://*/*/*/*/*.flv',  '*://*/*/*/*/*.flv?*',
];

// Broad capture across every request, used to (a) supply headers to the
// content-type based CDN detector in onHeadersReceived, and (b) evicted in
// onCompleted/onErrorOccurred below so this map cannot grow unbounded.
chrome.webRequest.onSendHeaders.addListener(
  (details) => { if (details.tabId >= 0) requestHeaders.set(details.requestId, details.requestHeaders || []); },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['requestHeaders', 'extraHeaders']
);

// FIX: extension-pattern based detection used to run on onBeforeRequest,
// which fires BEFORE onSendHeaders — so details.requestHeaders (or a lookup
// into the map above) was always empty at that point, and detected streams
// never got their referer/origin/cookie/auth headers. Detecting on
// onSendHeaders instead means the headers for *this* request are already
// available directly on `details`, with no timing gap.
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    chrome.tabs.get(details.tabId)
      .then(tab => addStream(details.tabId, details.url, tab?.title || '', details.requestHeaders))
      .catch(() => addStream(details.tabId, details.url, '', details.requestHeaders));
  },
  { urls: STREAM_URL_PATTERNS },
  ['requestHeaders', 'extraHeaders']
);

// FIX: requestHeaders entries were never removed, leaking one entry per
// network request (on every site, not just media requests) for the entire
// lifetime of the service worker. Evict once a request finishes — by then
// both onSendHeaders and onHeadersReceived have already read what they need.
function cleanupRequestHeaders(details) { requestHeaders.delete(details.requestId); }
chrome.webRequest.onCompleted.addListener(cleanupRequestHeaders, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] });
chrome.webRequest.onErrorOccurred.addListener(cleanupRequestHeaders, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] });

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

  // Check for exact match first (existing behavior)
  let stream = map.get(details.url);
  let isNew = false;

  // If no exact match, look for equivalent stream
  if (!stream) {
    stream = findEquivalentStream(map, details.url);
    // If we found an equivalent stream, we'll update it instead of creating new
    if (stream) {
      // Update headers if this stream was first seen without them
      if ((!stream.headers || stream.headers.length === 0)) {
        const normalized = normalizeHeaders(requestHeaders.get(details.requestId));
        if (normalized.length) stream.headers = normalized;
      }
    } else {
      // No equivalent stream found, create a new one
      stream = { url: details.url, type, name: tab?.title || urlName(details.url), quality: null,
        headers: normalizeHeaders(requestHeaders.get(details.requestId)), variants: null, parsing: false, ts: Date.now() };
      // Add to map using the original URL as key
      map.set(details.url, stream);
      isNew = true;
    }
  }

  chrome.tabs.get(details.tabId).then(tab => {
    // Update name if we now have a better page title
    if (tab?.title && (!stream.name || stream.name === urlName(details.url))) {
      stream.name = tab?.title;
    }
    updateBadge(details.tabId, map.size);
    persistStreamStore();
    // Enrich manifest for HLS/DASH streams if we don't have variant info yet
    if ((type === 'HLS' || type === 'DASH') &&
        (!stream.variants || stream.variants.length === 0)) {
      enrichManifest(details.tabId, stream);
    }
    chrome.runtime.sendMessage({ type: 'streams_updated', tabId: details.tabId }).catch(() => {});
  }).catch(() => {});
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders', 'extraHeaders']);

// ── Tab lifecycle ─────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
  lastCookieExtraction.delete(tabId); // FIX: was never cleaned up, small per-tab leak
  persistStreamStore();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId >= 0) {
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

  // Match VDown's initial card state: show the page/video artwork immediately,
  // then replace it with a short generated preview once the pointer enters it.
  const video = document.querySelector('video');
  const image = document.querySelector(
    'meta[property="og:image"],meta[name="twitter:image"],link[rel="image_src"],link[rel="thumbnail"],link[as="image"]'
  );
  const thumbnailUrl = video?.poster || image?.content || image?.href || '';
  return { streams: found, thumbnailUrl };
}

async function scanDomOfTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: domScannerScript,
    });
    const scan = results?.[0]?.result || [];
    // Older injected scanners returned the array directly. Keep accepting it
    // so an already-open page is never made incompatible by this UI update.
    const found = Array.isArray(scan) ? scan : (scan.streams || []);
    found.forEach(({ url, pageTitle }) => addStream(tabId, url, pageTitle));
    const thumbnailUrl = Array.isArray(scan) ? '' : scan.thumbnailUrl;
    if (thumbnailUrl) {
      const streams = tabStreams.get(tabId);
      let changed = false;
      for (const stream of streams?.values() || []) {
        if (!stream.thumbnailUrl) { stream.thumbnailUrl = thumbnailUrl; changed = true; }
      }
      if (changed) {
        for (const stream of [...streams.values()]) mergeInferiorStreamDuplicates(streams, stream);
        updateBadge(tabId, streams.size);
        persistStreamStore();
      }
    }
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

// Browser downloads continue after the extension worker sleeps. Reflect their
// authoritative lifecycle in the same queue used by server-backed downloads.
chrome.downloads.onChanged.addListener(async delta => {
  const job = [...offlineStreamJobs.values()].find(item => item.browserDownloadId === delta.id);
  if (!job) return;
  const patch = {};
  if (delta.bytesReceived?.current != null || delta.totalBytes?.current != null) {
    const received = delta.bytesReceived?.current ?? job.receivedBytes ?? 0;
    const total = delta.totalBytes?.current ?? job.totalBytes ?? 0;
    patch.receivedBytes = received; patch.totalBytes = total;
    patch.progress = { percent: total > 0 ? Math.round(received * 100 / total) : job.progress?.percent || 100, detail: total > 0 ? `${Math.round(received * 100 / total)}% saved` : 'Saving…' };
  }
  if (delta.error?.current) { patch.status = 'failed'; patch.error = delta.error.current; }
  if (delta.state?.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    patch.status = 'complete'; patch.progress = { percent: 100, detail: 'Saved to Streams' }; patch.file = item?.filename || '';
  }
  if (delta.state?.current === 'interrupted') { patch.status = 'failed'; patch.error = delta.error?.current || 'Download interrupted'; }
  updateOfflineJob(job.id, patch);
});

// VDown's browser-only worker is vendored separately so its large generated
// LibAV bundle is not duplicated in this source file. It uses this exact channel.
const vdownChannel = new BroadcastChannel('worker_service');
vdownChannel.addEventListener('message', event => {
  if (event.data?.channel !== 3) return;
  const message = event.data.msg;
  if (message?.name === 'blob_url_from_file') {
    const waiter = opfsBlobWaiters.get(message.data?.request_id);
    if (!waiter) return;
    opfsBlobWaiters.delete(message.data.request_id);
    message.data?.blob_url ? waiter.resolve(message.data.blob_url) : waiter.reject(new Error(message.data?.error || 'Could not prepare the stream file for download.'));
    return;
  }
  const id = message?.data?.download_id;
  if (message?.name === 'download_progress' && id) {
    const waiter = vdownWaiters.get(id);
    waiter?.onProgress?.(message.data.progress);
    notifyStreamProgress(null, id, message.data.progress);
  }
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

async function ensureStreamWorkerHost() {
  // VDown runs LibAV in an offscreen document. A Manifest V3 service worker is
  // short-lived and is not a reliable place to own a dedicated worker.
  if (!chrome.offscreen) throw new Error('This browser does not support the offscreen worker required for stream previews.');
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'pages/stream-worker-host.html',
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Run the local LibAV worker used for offline stream previews and remuxing.'
    });
  } catch (error) {
    // Another service-worker event can race this call; in that case the
    // document already exists and is safe to use.
    if (!(await chrome.offscreen.hasDocument())) throw error;
  }
}

async function ensureVdownWorker() {
  if (vdownWorkerReady) return vdownWorkerReady;
  vdownWorkerReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      vdownChannel.removeEventListener('message', ready);
      reject(new Error('LibAV worker did not start. Confirm the stream-worker files are installed.'));
    }, 10_000);
    const ready = event => {
      if (event.data?.channel === 3 && event.data?.msg?.name === 'is_ready_success') {
        clearTimeout(timer); vdownChannel.removeEventListener('message', ready); resolve();
      }
    };
    vdownChannel.addEventListener('message', ready);
  });
  try {
    await ensureStreamWorkerHost();
    // Same handshake used by VDown. It also handles the case where the worker
    // was created before this service worker woke up.
    vdownChannel.postMessage({ channel: 2, msg: { name: 'is_ready', data: null } });
    return await vdownWorkerReady;
  } catch (error) { vdownWorkerReady = null; throw error; }
}

async function vdownDownloadNow(args, onProgress) {
  await ensureVdownWorker();
  return new Promise((resolve, reject) => {
    vdownWaiters.set(args.download_id, { resolve, reject, onProgress });
    vdownChannel.postMessage({ channel: 2, msg: { name: 'download', data: { download_args: vdownSerialize(args) } } });
  });
}

// LibAV owns a shared virtual filesystem. VDown submits operations through a
// queue; doing the same prevents a hover-preview job from corrupting or
// aborting an Instagram download that starts at the same time.
function vdownDownload(args, onProgress) {
  const task = vdownTaskChain.then(
    () => vdownDownloadNow(args, onProgress),
    () => vdownDownloadNow(args, onProgress)
  );
  vdownTaskChain = task.catch(() => {});
  return task;
}

function workerFailure(result) {
  const reason = result?.ending_reason;
  if (typeof reason === 'string') return reason;
  if (reason?.message) return reason.message;
  if (reason?.details) return reason.details;
  return 'The stream worker could not download this media. It may be protected, expired, or unavailable.';
}

async function workerDownloadUrl(result) {
  if (result?.aborted_no_partial) throw new Error(workerFailure(result));
  return result?.internal_bloburl || opfsBlobUrl(result?.internal_filename);
}

async function opfsBlobUrl(filename) {
  if (!filename) throw new Error('The local stream worker returned neither a file nor a download URL.');
  await ensureVdownWorker();
  const requestId = `opfs_${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { opfsBlobWaiters.delete(requestId); reject(new Error('Timed out while preparing the stream file for download.')); }, 10_000);
    opfsBlobWaiters.set(requestId, {
      resolve: url => { clearTimeout(timer); resolve(url); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    vdownChannel.postMessage({ channel: 2, msg: { name: 'create_blob_url_from_file', data: { request_id: requestId, filename } } });
  });
}

async function prepareStreamPreview(tabId, streamUrl, force = false) {
  const stream = getStreamByUrl(tabId, streamUrl);
  if (force && stream) { stream.previewFile = null; stream.previewFailed = false; }
  if (!stream || stream.previewFile || stream.previewUrl || stream.previewPending) return stream?.previewFile || stream?.previewUrl || null;
  const variants = stream.variants || [];
  const variant = variants.find(item => item.height === 480) || variants.find(item => item.height === 260) || variants[variants.length - 1];
  if ((stream.type === 'HLS' || stream.type === 'DASH') && !variant?.url) return null;
  stream.previewFailed = false;
  stream.previewPending = true;
  try {
    const id = `preview_${crypto.randomUUID()}`;
    const common = { download_id: id, headers: new Headers(stream.headers || []), good_basename: 'preview', subdir: '', save_as: false,
      muxer: 'mp4', carry_get_params: false, extension: 'mp4', is_youtube: false, throttle: false, cache: 'default' };
    let args;
    if (stream.type === 'HLS') {
      args = { ...common, will_use_jsfetch: false, strategy: 'm3u8_video_preview', url: safeUrlObject(variant.url) };
    } else if (stream.type === 'DASH') {
      args = { ...common, will_use_jsfetch: true, strategy: 'mpd_video_preview', url: safeUrlObject(stream.url), entry: variant.workerEntry, duration: 'unknown' };
    } else {
      // This is VDown's http_playlist preview route. Do not point a popup
      // <video> at a cross-origin source: create a short local OPFS preview
      // instead, which is reliable for direct MP4/WebM streams as well.
      args = { ...common, will_use_jsfetch: true, strategy: 'http_video_preview_jsfetch', url: safeUrlObject(stream.url) };
    }
    const result = await vdownDownload(args);
    // Worker Blob URLs are scoped to the worker and cannot be played by the
    // popup. VDown passes the OPFS filename and lets the UI create its own URL.
    stream.previewFile = result.internal_filename || null;
    stream.previewUrl = null;
    return stream.previewFile;
  } catch (error) {
    stream.previewFailed = true;
    console.debug('[Stream preview] unavailable:', error.message || error);
    chrome.runtime.sendMessage({ type: 'stream_preview_error', tabId, streamUrl, error: error.message || String(error) }).catch(() => {});
    return null;
  } finally {
    stream.previewPending = false;
    persistStreamStore();
    chrome.runtime.sendMessage({ type: 'streams_updated', tabId }).catch(() => {});
  }
}

// ── Offline Stream-tab downloader ───────────────────────────────────────────
// This deliberately never calls SERVER. Direct files and muxed HLS are assembled
// through the LibAV worker (vdownDownload); encrypted/adaptive A/V streams the
// worker can't handle are rejected instead of being silently sent to a server
// or producing a corrupt file.
function safeFilename(name, extension) {
  const base = String(name || 'video').replace(/[\\/:*?\"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140) || 'video';
  return `${base}.${extension}`;
}

function notifyStreamProgress(tabId, streamUrl, progress) {
  chrome.runtime.sendMessage({ type: 'stream_download_progress', tabId, streamUrl, progress }).catch(() => {});
}

async function offlineStreamDownload(tabId, streamUrl, variantId) {
  const stream = getStreamByUrl(tabId, streamUrl);
  if (!stream) throw new Error('The selected stream is no longer available. Refresh the page and try again.');
  const variant = stream.variants?.find(v => v.id === variantId) || null;
  const headers = stream.headers || [];
  const jobId = `stream_${crypto.randomUUID()}`;
  const abortController = new AbortController();
  offlineAbortControllers.set(jobId, abortController);
  offlineStreamJobs.set(jobId, { id: jobId, source: 'stream', title: stream.name, url: streamUrl, tabId, status: 'downloading', createdAt: Date.now(),
    progress: { percent: 0, detail: 'Preparing stream…' }, browserDownloadId: null });
  publishOfflineQueue();
  const report = progress => {
    const percent = progress.percent?.is_known ? Math.round(progress.percent.value) :
      (progress.total ? Math.round((progress.completed || 0) * 100 / progress.total) : undefined);
    updateOfflineJob(jobId, { progress: { percent: Number.isFinite(percent) ? percent : 0, detail: progress.total ? `${progress.completed}/${progress.total} segments` : 'Downloading stream…' } });
    notifyStreamProgress(tabId, streamUrl, progress);
  };
  notifyStreamProgress(tabId, streamUrl, { phase: 'starting' });
  let extension, workerBlobUrl = null;
  try { if (stream.type === 'HLS') {
    if (!variant) throw new Error('The HLS qualities are still loading. Please try again in a moment.');
    const id = `stream_${crypto.randomUUID()}`;
    extension = variant.container === 'webm' ? 'webm' : 'mp4';
    updateOfflineJob(jobId, { workerDownloadId: id });
    // VDown keeps all media bytes in its worker/OPFS. Service workers cannot
    // create Blob URLs, so use the same route for both one- and two-source HLS.
    const result = await vdownDownload({ download_id: id, headers: new Headers(headers), good_basename: safeFilename(stream.name, extension).replace(new RegExp(`\\.${extension}$`), ''), subdir: '', save_as: false, will_use_jsfetch: false,
      strategy: variant.audioUrl ? 'm3u8_audio_video_two_sources' : 'm3u8_audio_video_one_source', muxer: extension, url: safeUrlObject(variant.url),
      ...(variant.audioUrl ? { url_audio: safeUrlObject(variant.audioUrl) } : {}), carry_get_params: false,
      extension, is_youtube: false, throttle: false, cache: 'default', duration: 'unknown' }, report);
    workerBlobUrl = await workerDownloadUrl(result);
  } else if (stream.type === 'DASH') {
    if (!variant) throw new Error('The DASH qualities are still loading. Please try again in a moment.');
    const id = `stream_${crypto.randomUUID()}`; extension = variant.container || 'mp4';
    updateOfflineJob(jobId, { workerDownloadId: id });
    const result = await vdownDownload({ download_id: id, headers: new Headers(headers), good_basename: safeFilename(stream.name, extension).replace(new RegExp(`\\.${extension}$`), ''), subdir: '', save_as: false, will_use_jsfetch: true,
      strategy: 'mpd_audio_video_one_source', muxer: extension, url: safeUrlObject(stream.url), carry_get_params: false, entry: variant.workerEntry,
      duration: 'unknown', extension, is_youtube: false, throttle: false, cache: 'default' }, report);
    workerBlobUrl = await workerDownloadUrl(result);
  } else {
    const id = `stream_${crypto.randomUUID()}`;
    extension = (stream.type === 'WebM' ? 'webm' : stream.type || 'mp4').toLowerCase();
    updateOfflineJob(jobId, { workerDownloadId: id });
    const result = await vdownDownload({ download_id: id, headers: new Headers(headers), good_basename: safeFilename(stream.name, extension).replace(new RegExp(`\\.${extension}$`), ''), subdir: '', save_as: false,
      will_use_jsfetch: false, strategy: 'http_audio_video_one_source', url: safeUrlObject(stream.url), carry_get_params: false,
      extension, is_youtube: false, throttle: false, cache: 'default' }, report);
    workerBlobUrl = await workerDownloadUrl(result);
  }
  if (abortController.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!workerBlobUrl) throw new Error('The local stream worker did not return a downloadable file.');
  try {
    updateOfflineJob(jobId, { progress: { percent: 100, detail: 'Saving to Downloads/Streams…' } });
    const id = await chrome.downloads.download({ url: workerBlobUrl, filename: `Streams/${safeFilename(stream.name, extension)}`, conflictAction: 'uniquify', saveAs: false });
    updateOfflineJob(jobId, { browserDownloadId: id, progress: { percent: 100, detail: 'Browser download started' } });
    notifyStreamProgress(tabId, streamUrl, { phase: 'complete', downloadId: id });
    return { downloadId: id, jobId };
  } finally {
    setTimeout(() => {
      if (workerBlobUrl) vdownChannel.postMessage({ channel: 2, msg: { name: 'revoke_blob_url', data: { blob_url: workerBlobUrl } } });
    }, 60_000);
  }
  } catch (error) {
    updateOfflineJob(jobId, abortController.signal.aborted ? { status: 'cancelled', progress: { percent: 0, detail: 'Cancelled' } } : { status: 'failed', error: error.message || String(error) });
    throw error;
  } finally {
    offlineAbortControllers.delete(jobId);
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
      try { addDetectorMedia(tabId, msg.msg.data?.media, sender.tab?.title || ''); }
      catch (error) { console.debug('[VDown detector] ignored malformed media:', error.message || error); }
      sendResponse({ ok: true });
    }
    return true;
  }

  // Popup asking for all detected streams on the active tab
  if (msg.type === 'GET_STREAMS') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      await streamStoreReady;
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
      if (tabId) { tabStreams.delete(tabId); updateBadge(tabId, 0); persistStreamStore(); }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'GET_OFFLINE_STREAM_QUEUE') {
    offlineQueueReady.then(() => sendResponse({ queue: [...offlineStreamJobs.values()] }));
    return true;
  }

  if (msg.type === 'OFFLINE_STREAM_QUEUE_ACTION') {
    const job = offlineStreamJobs.get(msg.id);
    (async () => {
      try {
        if (msg.action === 'cancel' && job) {
          offlineAbortControllers.get(job.id)?.abort();
          if (job.workerDownloadId) vdownChannel.postMessage({ channel: 2, msg: { name: 'abort_download', data: { download_id: job.workerDownloadId } } });
          if (job.browserDownloadId != null) await chrome.downloads.cancel(job.browserDownloadId);
          else updateOfflineJob(job.id, { status: 'cancelled', progress: { percent: 0, detail: 'Cancelled' } });
        }
        if (msg.action === 'remove' && job) { offlineStreamJobs.delete(job.id); publishOfflineQueue(); }
        if (msg.action === 'clear-completed') {
          for (const [id, item] of offlineStreamJobs) if (item.status === 'complete' || item.status === 'failed') offlineStreamJobs.delete(id);
          publishOfflineQueue();
        }
        sendResponse({ ok: true });
      } catch (error) { sendResponse({ ok: false, error: error.message || String(error) }); }
    })();
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

  if (msg.type === 'REQUEST_STREAM_PREVIEW') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      try { sendResponse({ ok: true, previewFile: await prepareStreamPreview(tabs[0]?.id, msg.streamUrl, Boolean(msg.force)) }); }
      catch (error) { sendResponse({ ok: false, error: error.message || String(error) }); }
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