/**
 * playlist-worker.js — Progressive playlist size enrichment.
 *
 * Takes the flat entry list from `--flat-playlist` (which has no format/size
 * info) and probes each video concurrently in a pool of up to MAX_WORKERS
 * yt-dlp processes. As each video resolves we:
 *   1. Accumulate bytes per quality tier (144p → 2160p) and per audio format.
 *   2. Broadcast a `playlist_progress` WS event so the UI can show live totals.
 *   3. Cache each video's metadata for later single-video probes.
 *
 * Design rationale:
 *   - MAX_WORKERS = 5: empirically avoids YouTube 429 throttling while still
 *     being 5× faster than sequential probing.
 *   - Each worker uses the same cookies as regular probing.
 *   - Unavailable/deleted/private videos are silently skipped (counted in
 *     `skipped`). The UI already knows the video is unavailable from the flat
 *     probe title field.
 *   - We cap at PROBE_LIMIT entries to avoid hour-long probes for 1000-video
 *     playlists. Size totals are extrapolated linearly for the remainder.
 *   - Callers get a `cancel()` function to abort in-flight work if the user
 *     navigates away.
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { getCookiesArgs }              = require('./cookies');
const { videoCache, formatCache }     = require('./cache');
const { broadcastPlaylistProgress }   = require('./websocket');
const { buildFullFormatsFromMeta }    = require('./detector');

const MAX_WORKERS  = 5;
const PROBE_LIMIT  = 200; // max videos to individually probe per playlist
const EXEC_TIMEOUT = 25000;
const EXEC_BUFFER  = 20 * 1024 * 1024;

function getYtDlpBin() { return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'; }

/**
 * Quality tier heights we aggregate sizes for.
 * Must match the TIERS array in detector.js buildVideoFormats().
 */
const TIER_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];
const AUDIO_FMTS   = ['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav', 'ogg'];

/**
 * @param {string}   playlistId  Playlist/list ID (for WS events)
 * @param {string}   tabId       Extension tab ID (for WS routing)
 * @param {object[]} entries     Flat entry objects from yt-dlp --flat-playlist
 * @param {string}   cookieFile  Path to cookies file (may be null)
 * @returns {{ cancel: () => void }} control handle
 */

function startPlaylistEnrichment(playlistId, tabId, entries, cookieFile) {
  let cancelled = false;
  const cancel  = () => { cancelled = true; };

  const probeEntries = entries.slice(0, PROBE_LIMIT);
  const total        = entries.length;
  const probeCount   = probeEntries.length;

// Accumulators
const videoTotals = Object.fromEntries(TIER_HEIGHTS.map(h => [h, 0]));
const subtitleTotals = Object.fromEntries(TIER_HEIGHTS.map(h => [h, 0]));
const audioTotals = Object.fromEntries(AUDIO_FMTS.map(f => [f, 0]));
const totalDuration = { value: 0 };

// Aggregated subtitle languages across the playlist.
// Map keeps one entry per language and lets manual subtitles win over auto.
const subtitleLanguages = new Map();

// console.log('entries:', entries);
// console.log('Array?', Array.isArray(entries));
// console.log('type:', typeof entries);

  let completed = 0;
  let skipped   = 0;

  // Broadcast initial state immediately
  _broadcast(playlistId, tabId, {
    completed,
    total: probeCount,
    skipped,
    videoTotals: { ...videoTotals },
    subtitleTotals: { ...subtitleTotals },
    audioTotals: { ...audioTotals },
    subtitleInfo: {
      hasSubtitles: false,
      languages: [],
      subOverheadBytes: 0
    },
    totalDuration: 0,
    done: false
  });
  // Run the worker pool
  _runPool(probeEntries, MAX_WORKERS, async (entry) => {
    if (cancelled) return;

    const videoId = entry.id;
    const url     = entry.webpage_url || `https://www.youtube.com/watch?v=${videoId}`;

    try {
      // Check format cache first (avoids redundant yt-dlp calls)
      let formats = formatCache.get(videoId);

      if (!formats) {
        const meta = await _probeVideo(url, cookieFile);
        if (!meta) { skipped++; return; }

        videoCache.set(videoId, meta);
        formats = buildFullFormatsFromMeta(meta);
        formatCache.set(videoId, formats);
        totalDuration.value += meta.duration || 0;
      }

      // Accumulate subtitle languages across all videos.
      // If the same language exists as both manual and automatic,
      // keep the manual version.
      const subInfo = formats.subtitleInfo;

      if (subInfo?.languages?.length) {
        for (const lang of subInfo.languages) {
          const existing = subtitleLanguages.get(lang.code);

          if (!existing || (lang.isManual && !existing.isManual)) {
            subtitleLanguages.set(lang.code, { ...lang });
          }
        }
      }

      // Accumulate subtitle overhead per quality tier.
      // buildFullFormatsFromMeta() already adds subtitle overhead to
      // videoSubFormats, so use the difference between the two ladders.
      const videoFormats = formats.videoFormats || [];
      const videoSubFormats = formats.videoSubFormats || [];

      for (const tier of TIER_HEIGHTS) {
        const videoBest = videoFormats
          .filter(f => f.available && f.size && f.height <= tier)
          .sort((a, b) => b.height - a.height)[0];

        const subBest = videoSubFormats
          .filter(f => f.available && f.size && f.height <= tier)
          .sort((a, b) => b.height - a.height)[0];

        if (videoBest && subBest) {
          const overhead = Math.max(0, subBest.size - videoBest.size);
          subtitleTotals[tier] += overhead;
        }
      }

      // Accumulate video sizes per quality tier.
      // Subtitle overhead is kept separate from videoTotals.
          for (const tier of TIER_HEIGHTS) {
          const best = videoFormats
          .filter(f => f.available && f.size && f.height <= tier)
          .sort((a, b) => b.height - a.height)[0];

if (best) {
  videoTotals[tier] += best.size;
}
      }
      // Accumulate audio format sizes
      for (const fmt of AUDIO_FMTS) {
        const match = formats.audioFormats.find(f => f.fmt === fmt);
        if (match?.size) audioTotals[fmt] += match.size;
      }
      completed++;
    } catch {
      skipped++;
    }

    if (cancelled) return;

    // Broadcast progress after every completed video
    const videoTotalsExtrap = _extrapolate(
      videoTotals,
      completed,
      probeCount,
      total
    );
    const subtitleTotalsExtrap = _extrapolate(
      subtitleTotals,
      completed,
      probeCount,
      total
    );
    const audioTotalsExtrap = _extrapolate(
      audioTotals,
      completed,
      probeCount,
      total
    );
    const totalSubtitleOverheadEst = (subtitleTotalsExtrap && subtitleTotalsExtrap[144]) || 0;

    _broadcast(playlistId, tabId, {
      completed,
      total: probeCount,
      skipped,

      videoTotals: videoTotalsExtrap,
      subtitleTotals: subtitleTotalsExtrap,
      audioTotals: audioTotalsExtrap,

      subtitleInfo: {
        hasSubtitles: subtitleLanguages.size > 0,
        languages: Array.from(subtitleLanguages.values()),
        subOverheadBytes: totalSubtitleOverheadEst
      },

      totalDuration: totalDuration.value,
      done: false
    });
  }).then(() => {
    if (cancelled) return;
    const videoTotalsExtrap = _extrapolate(
      videoTotals,
      completed,
      probeCount,
      total
    );
    const subtitleTotalsExtrap = _extrapolate(
      subtitleTotals,
      completed,
      probeCount,
      total
    );
    const audioTotalsExtrap = _extrapolate(
      audioTotals,
      completed,
      probeCount,
      total
    );
    const totalSubtitleOverheadEst = (subtitleTotalsExtrap && subtitleTotalsExtrap[144]) || 0;

    _broadcast(playlistId, tabId, {
      completed,
      total: probeCount,
      skipped,

      videoTotals: videoTotalsExtrap,
      subtitleTotals: subtitleTotalsExtrap,
      audioTotals: audioTotalsExtrap,

      subtitleInfo: {
        hasSubtitles: subtitleLanguages.size > 0,
        languages: Array.from(subtitleLanguages.values()),
        subOverheadBytes: totalSubtitleOverheadEst
      },

      totalDuration: totalDuration.value,
      done: true
    });
  });

  return { cancel };
}

/** Linear extrapolation: if we probed `completed` of `probeCount` but there
 *  are `total` entries, scale up the totals proportionally. */
function _extrapolate(totals, completed, probeCount, total) {
  if (completed === 0 || probeCount >= total) return { ...totals };
  const scale = total / completed;
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v * scale)]));
}

function _broadcast(playlistId, tabId, data) {
  broadcastPlaylistProgress(playlistId, tabId, data);
}

async function _probeVideo(url, cookieFile) {
  const ytdlp = getYtDlpBin();
  const cookies = cookieFile ? ['--cookies', cookieFile] : [];
  const args = [
    '--dump-json', '--no-playlist', '--no-check-formats',
    '--quiet', '--no-warnings',
    ...cookies,
    url
  ];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(ytdlp, args, { timeout: EXEC_TIMEOUT, maxBuffer: EXEC_BUFFER }));
  } catch (e) {
    if (e.stdout?.trim()) { stdout = e.stdout; }
    else return null; // unavailable — skip silently
  }

  for (const line of (stdout || '').trim().split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      if (obj?.id) return obj;
    } catch {}
  }
  console.log("[Probe] No JSON:", url);
  return null;
}

/** Generic async worker pool. */
async function _runPool(items, concurrency, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

module.exports = { startPlaylistEnrichment };
