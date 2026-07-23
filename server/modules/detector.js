/**
 * detector.js — Media detection and probing for GrabIt v4.
 *
 * Single yt-dlp call philosophy: --dump-json returns ALL format metadata we
 * will ever need. Every field — codec, FPS, HDR, bitrate, sample rate, subtitle
 * languages — is extracted from that single response. No second probes.
 *
 * Exports `buildFullFormatsFromMeta` so playlist-worker.js can reuse the same
 * format-extraction logic on individual video metadata without duplicating code.
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync  = promisify(execFile);
const { getCookiesArgs } = require('./cookies');
const { videoCache, playlistCache, videoIdFromUrl, listIdFromUrl } = require('./cache');
const log = require('./logger').child('detector.js');

// ── Platform detection ────────────────────────────────────────────────────────

const PLATFORM_PATTERNS = [
  { platform: 'youtube',   patterns: [/youtube\.com\/watch/, /youtube\.com\/shorts/, /youtube\.com\/playlist/, /youtu\.be\//, /youtube\.com\/live/, /music\.youtube\.com/] },
  { platform: 'instagram', patterns: [/instagram\.com\/(p|reel|stories|tv|s)\//] },
  { platform: 'twitter',   patterns: [/twitter\.com\/.*\/status\//, /x\.com\/.*\/status\//] },
  { platform: 'tiktok',    patterns: [/tiktok\.com\/@.*\/video\//] },
  { platform: 'reddit',    patterns: [/reddit\.com\/r\/.*\/comments\//, /v\.redd\.it/] },
  { platform: 'vimeo',     patterns: [/vimeo\.com\/\d+/] },
  { platform: 'twitch',    patterns: [/twitch\.tv\/videos\//, /clips\.twitch\.tv/] },
  { platform: 'facebook',  patterns: [/facebook\.com\/.*\/videos\//, /fb\.watch/] },
  { platform: 'generic',   patterns: [/.*/] }
];

function detectPlatform(url) {
  for (const { platform, patterns } of PLATFORM_PATTERNS) {
    if (patterns.some(p => p.test(url))) return platform;
  }
  return 'generic';
}

/**
 * YouTube URL type detection.
 *
 * Type hierarchy (most-specific first):
 *   live         — /live path or ?v=...&live=1 or known live URL patterns
 *   short        — /shorts/
 *   music        — music.youtube.com
 *   mix_playlist — list=RD... (YouTube auto-mix)
 *   playlist     — /playlist?list=... with no v= param
 *   video        — everything else (including watch?v=X&list=Y — the list is ignored)
 *
 * CRITICAL: watch?v=X&list=Y is ALWAYS 'video'. Only /playlist?list=... with
 * no v= is a true playlist.
 */
function detectYouTubeType(url) {
  try {
    const u = new URL(url);
    const hasV = u.searchParams.has('v');
    const list = u.searchParams.get('list') || '';

    if (u.pathname.includes('/live') || u.searchParams.get('live') === '1') return 'live';
    if (u.pathname.includes('/shorts/')) return 'short';
    if (u.hostname.includes('music.youtube.com')) return 'music';
    if (list && list.startsWith('RD')) return 'mix_playlist';
    if (list) return 'playlist';
    // No list parameter -> treat as a single video
    return 'video';
  } catch {}
  return 'video';
}

function detectInstagramType(url) {
  const clean = url.split('?')[0].replace(/\/$/, '');
  if (/\/reel\/|\/reels\//.test(clean))  return 'reel';
  if (/\/stories\//.test(clean))         return 'story';
  if (/\/tv\//.test(clean))              return 'igtv';
  if (/\/p\//.test(clean))               return 'post';
  if (/\/s\//.test(clean))               return 'highlight';
  return 'post';
}

// ── Stage 1: instant (<1ms) ───────────────────────────────────────────────────

function quickAnalyze(url) {
  const platform = detectPlatform(url);
  const result   = { platform, url, stage: 1 };

  if (platform === 'youtube') {
    result.contentType = detectYouTubeType(url);
    result.actions     = getYouTubeActions(result.contentType);
  } else if (platform === 'instagram') {
    result.contentType = detectInstagramType(url);
    result.actions     = getInstagramActions(result.contentType);
  } else {
    result.contentType = 'unknown';
    result.actions     = ['download'];
  }
  return result;
}

// ── Action lists ──────────────────────────────────────────────────────────────

function getYouTubeActions(type) {
  if (type === 'playlist' || type === 'mix_playlist')
    return ['download_playlist', 'download_playlist_audio', 'download_playlist_subtitles'];
  if (type === 'live')
    return ['download_live'];
  return ['download_video', 'download_audio', 'download_video_subtitles'];
}

function getInstagramActions(type, mediaType = null, slideCount = 0) {
  if (type === 'reel')  return ['download_reel', 'download_reel_audio'];
  if (type === 'story') return ['download_story'];
  if (type === 'igtv')  return ['download_video', 'download_audio'];
  if (slideCount > 1) {
    const a = ['download_all_slides'];
    if (mediaType === 'photo' || mediaType === 'mixed') a.push('download_photos_only');
    if (mediaType === 'video' || mediaType === 'mixed') a.push('download_videos_only');
    return a;
  }
  return mediaType === 'video' ? ['download_video', 'download_audio'] : ['download_photo'];
}

// ── Binaries ──────────────────────────────────────────────────────────────────

function getYtDlpBin()    { return process.platform === 'win32' ? 'yt-dlp.exe'     : 'yt-dlp'; }
function getGalleryDlBin(){ return process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl'; }

function extractProcError(e, prefix = '') {
  const noise = /^\[download\]|^WARNING:|^\s*$/i;
  const meaningful = (src) =>
    (src || '').split('\n').map(l => l.trim()).filter(l => l && !noise.test(l)).slice(-5).join(' | ');
  const msg = meaningful(e.stderr) || meaningful(e.stdout) || e.message?.split('\n')[0] || String(e);

  // Add timeout context if available
  if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
    return `${msg} (Operation timed out)`;
  }

  return prefix ? `${prefix}: ${msg}` : msg;
}

// ── Format extraction helpers ─────────────────────────────────────────────────

/** Map yt-dlp vcodec string → human label */
function codecLabel(vcodec = '') {
  const c = vcodec.toLowerCase();
  if (c.startsWith('av01') || c.startsWith('av1'))  return 'AV1';
  if (c.startsWith('vp09') || c.startsWith('vp9'))  return 'VP9';
  if (c.startsWith('vp08') || c.startsWith('vp8'))  return 'VP8';
  if (c.startsWith('hvc1') || c.startsWith('hev1') || c.startsWith('hevc')) return 'HEVC';
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('theora'))                        return 'Theora';
  return vcodec.split('.')[0].toUpperCase() || '';
}

/** Map yt-dlp acodec string → human label */
function acodecLabel(acodec = '') {
  const c = acodec.toLowerCase();
  if (c.includes('opus'))                     return 'Opus';
  if (c.startsWith('mp4a') || c === 'aac')   return 'AAC';
  if (c.startsWith('mp3') || c === 'mp3')    return 'MP3';
  if (c.includes('vorbis'))                  return 'Vorbis';
  if (c.includes('flac'))                    return 'FLAC';
  if (c.includes('alac'))                    return 'ALAC';
  if (c.includes('pcm') || c === 'wav')      return 'PCM';
  if (c.startsWith('dtse') || c === 'dts')   return 'DTS';
  if (c.startsWith('ac-3') || c === 'ac3')   return 'AC-3';
  if (c.startsWith('ec-3') || c === 'eac3')  return 'E-AC-3';
  return acodec.split('.')[0].toUpperCase() || '';
}

/**
 * Detect HDR / HFR / 3D flags from a format object.
 * Returns array of short badge strings e.g. ['HDR10', 'HFR'] or [].
 */
function formatBadges(f) {
  const badges = [];
  const dr  = (f.dynamic_range || '').toUpperCase();
  const note = (f.format_note || '').toUpperCase();

  if (dr === 'DOLBY_VISION' || note.includes('DOLBY VISION') || note.includes('DV')) badges.push('DV');
  else if (dr === 'HDR10+' || note.includes('HDR10+'))  badges.push('HDR10+');
  else if (dr === 'HDR10'  || note.includes('HDR10'))   badges.push('HDR10');
  else if (dr === 'HLG'    || note.includes('HLG'))     badges.push('HLG');
  else if (dr === 'HDR'    || note.includes('HDR'))     badges.push('HDR');

  const fps = f.fps || 0;
  if (fps > 50) badges.push('HFR');
  return badges;
}

/** Estimate bytes from a format's bitrate + duration. */
function estimateBytes(f, duration) {
  if (f.filesize)       return f.filesize;
  if (f.filesize_approx) return f.filesize_approx;
  const kbps = f.tbr || f.vbr || f.abr;
  return kbps && duration ? Math.round(kbps * 1000 / 8 * duration) : 0;
}

// ── Video format builder ──────────────────────────────────────────────────────

const TIER_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

/**
 * Build the full video-format resolution ladder from yt-dlp metadata.
 *
 * For each standard tier (144p → 2160p):
 *   - Find the best video-only stream ≤ that height (highest bitrate wins on tie)
 *   - Attach codec, FPS, HDR badges, estimated size (video + best audio)
 *   - Mark tiers with no matching stream as unavailable
 *
 * Returns an array ordered by height ASC, then a "Recommended" entry last.
 */
function buildVideoFormats(meta) {
  const dur       = meta.duration || 0;
  const allFmts   = (meta.formats || []).filter(f => f.ext);

  // Audio companion for merged-size estimates
  const audioOnly = allFmts.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const bestAudio  = audioOnly.sort((a, b) =>
    (estimateBytes(b, dur)) - (estimateBytes(a, dur)) || (b.abr || 0) - (a.abr || 0))[0] || null;
  const audioBytes = bestAudio ? (estimateBytes(bestAudio, dur) || 0) : 0;

  // Video-only streams, grouped by height → keep highest-tbr per height
  const videoOnly = allFmts.filter(f => f.vcodec && f.vcodec !== 'none' && f.height && (!f.acodec || f.acodec === 'none'));
  const byHeight  = {};
  for (const f of videoOnly) {
    const h = f.height;
    const score = (f.tbr || f.vbr || 0);
    if (!byHeight[h] || score > (byHeight[h].tbr || byHeight[h].vbr || 0)) byHeight[h] = f;
  }

  // All available heights, sorted descending for fast lookup
  const availHeights = Object.keys(byHeight).map(Number).sort((a, b) => b - a);

  const tiers = TIER_HEIGHTS.map(height => {
    // Best stream at or below this tier
    const h = availHeights.find(ah => ah <= height);
    if (!h) return { label: `${height}p`, height, available: false, size: null, codec: null, fps: null, badges: [] };

    const f      = byHeight[h];
    const vBytes = estimateBytes(f, dur);
    const size   = (vBytes + audioBytes) || null;

    return {
      label:     `${height}p`,
      height,
      format_id: f.format_id,
      ext:       'mp4',
      codec:     codecLabel(f.vcodec),
      fps:       f.fps  ? Math.round(f.fps)  : null,
      bitrate:   f.tbr  ? Math.round(f.tbr)  : null, // kbps
      badges:    formatBadges(f),
      size,
      available: true,
      isRecommended: false
    };
  });

  // Recommended: best at or under 720p (sweet spot for size/quality)
  const recH = availHeights.find(h => h <= 720) || availHeights[availHeights.length - 1];
  if (recH) {
    const f      = byHeight[recH];
    const vBytes = estimateBytes(f, dur);
    tiers.push({
      label: 'Recommended', height: recH, format_id: f.format_id, ext: 'mp4',
      codec: codecLabel(f.vcodec), fps: f.fps ? Math.round(f.fps) : null,
      bitrate: f.tbr ? Math.round(f.tbr) : null,
      badges: formatBadges(f),
      size: (vBytes + audioBytes) || null,
      available: true, isRecommended: true
    });
  }

  // Fallback: use combined streams if no video-only found
  if (!tiers.some(t => t.available && !t.isRecommended)) {
    const combined = allFmts.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
      .sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));
    for (const tier of tiers) {
      if (tier.isRecommended) continue;
      const f = combined.find(c => c.height <= tier.height);
      if (f) Object.assign(tier, {
        format_id: f.format_id, codec: codecLabel(f.vcodec),
        fps: f.fps ? Math.round(f.fps) : null, badges: formatBadges(f),
        size: estimateBytes(f, dur) || null, available: true
      });
    }
  }

  return { tiers, audioBytes, bestAudio };
}

// ── Audio format builder ──────────────────────────────────────────────────────

/**
 * Audio format table shown in the "Audio Only" tab.
 *
 * For each output format we want to offer (mp3, m4a, aac, opus, flac, wav, ogg):
 *   - If the source codec matches, no transcode → use real measured size
 *   - Otherwise estimate from: min(source_abr, target_max_kbps) × duration
 *   - Show real bitrate, codec label, sample rate from the detected source stream
 *
 * We always show all formats; the user can choose their preferred container.
 */
function buildAudioFormats(meta) {
  const dur      = meta.duration || 0;
  const allFmts  = (meta.formats || []).filter(f => f.ext);

  // Collect all audio-only streams; we may use different sources per output format
  const audioOnly = allFmts
    .filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (estimateBytes(b, dur)) - (estimateBytes(a, dur)) || (b.abr || 0) - (a.abr || 0));

  const best   = audioOnly[0] || null;
  const realAbr = best?.abr  || null;
  const realAsr = best?.asr  || null;
  const realACodec = best?.acodec || '';

  // Source codec detection
  const sourceIsOpus  = realACodec.toLowerCase().includes('opus');
  const sourceIsAAC   = realACodec.toLowerCase().startsWith('mp4a') || realACodec === 'aac';
  const sourceIsVorbis= realACodec.toLowerCase().includes('vorbis');
  const realBytes     = best ? (estimateBytes(best, dur) || 0) : 0;

  // Output format specs: [fmt, label, maxKbps, star, isLossless]
  const SPECS = [
    ['mp3',  'MP3',     192, true,  false],
    ['m4a',  'M4A',     128, false, false],
    ['aac',  'AAC',     160, false, false],
    ['opus', 'Opus',    160, false, false],
    ['flac', 'FLAC',    900, false, true ],
    ['wav',  'WAV',    1411, false, true ],
    ['ogg',  'Ogg Vorbis', 160, false, false],
  ];

  return SPECS.map(([fmt, label, maxKbps, star, isLossless]) => {
    // Direct copy (no re-encode): source codec matches target
    const isDirect = (fmt === 'm4a' && sourceIsAAC) ||
                     (fmt === 'aac' && sourceIsAAC) ||
                     (fmt === 'opus' && sourceIsOpus) ||
                     (fmt === 'ogg' && sourceIsVorbis);

    let size, bitrate;
    if (isDirect && realBytes) {
      // Copy the actual measured bytes
      size    = realBytes;
      bitrate = realAbr;
    } else if (isLossless) {
      // Lossless: estimate from full PCM rate then compression ratio
      const pcmKbps = realAsr ? (realAsr * 16 * 2 / 1000) : 1411; // 16-bit stereo PCM
      const kbps    = fmt === 'flac' ? Math.round(pcmKbps * 0.55) : pcmKbps;
      size    = dur ? Math.round(kbps * 1000 / 8 * dur) : null;
      bitrate = kbps;
    } else {
      // Lossy: cap at source bitrate to avoid inflating output estimate
      const kbps = realAbr ? Math.min(realAbr, maxKbps) : maxKbps;
      size    = dur ? Math.round(kbps * 1000 / 8 * dur) : null;
      bitrate = kbps;
    }

    return {
      fmt, label, star, size, isDirect,
      bitrate: bitrate ? Math.round(bitrate) : null,
      codec:   acodecLabel(isDirect ? realACodec : fmt),
      sampleRate: realAsr || null
    };
  });
}

// ── Subtitle info builder ─────────────────────────────────────────────────────

/**
 * Build per-language subtitle info from yt-dlp metadata.
 *
 * yt-dlp exposes:
 *   meta.subtitles           = { lang: [{ext, url, ...}] }   ← manual
 *   meta.automatic_captions  = { lang: [{ext, url, ...}] }   ← auto-generated
 *
 * We prefer manual subtitles; auto-generated are labeled accordingly.
 * Size estimate: SRT/VTT is pure text. ~300 bytes/minute for typical dialogue,
 * more for dense content. We use 400 B/min as a conservative upper bound.
 *
 * NOTE: Always returns hasSubtitles: true so the Video+Subs tab is available
 * even when no subtitle tracks are present (subtitle overhead will be 0).
 */
function buildSubtitleInfo(meta) {
  const dur      = meta.duration || 0;
  const manualLangs  = Object.keys(meta.subtitles || {});
  const autoLangs    = Object.keys(meta.automatic_captions || {});
  const allLangs     = [...new Set([...manualLangs, ...autoLangs])];

  // Subtitle text is tiny. Typical SRT: ~400 B/min for dialogue.
  const subBytesPerMin = 400;
  const subOverheadBytes = dur ? Math.round(subBytesPerMin * (dur / 60)) : 0;

  const langNames = new Intl.DisplayNames(['en'], { type: 'language' });
  const getDisplayName = (code) => {
    try { return langNames.of(code.split('-')[0]) || code; }
    catch { return code; }
  };

  const languages = allLangs.map(code => {
    const isManual = manualLangs.includes(code);
    const formats  = (meta.subtitles?.[code] || meta.automatic_captions?.[code] || []).map(f => f.ext);
    return {
      code,
      name:     getDisplayName(code),
      isManual,
      isAuto:   !isManual,
      formats:  [...new Set(formats)],
      size:     subOverheadBytes
    };
  }).sort((a, b) => {
    // Manual first, then by code
    if (a.isManual !== b.isManual) return a.isManual ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  // Always indicate that subtitles are available (even if none) so the Video+Subs tab is shown.
  return { hasSubtitles: true, languages, subOverheadBytes };
}

// ── Main YouTube result builder ───────────────────────────────────────────────

/**
 * Build the complete probe result from raw yt-dlp metadata.
 * This is the single source of truth for all three tabs: Video, Subs, Audio.
 * Exported for reuse by playlist-worker.js.
 */
function buildFullFormatsFromMeta(meta) {
  const { tiers, audioBytes, bestAudio } = buildVideoFormats(meta);
  const audioFormats  = buildAudioFormats(meta);
  const subtitleInfo  = buildSubtitleInfo(meta);

  // Build Video+Subs tiers: same ladder + subtitle overhead per tier
  const videoSubFormats = subtitleInfo.hasSubtitles
    ? tiers.map(f => ({
        ...f,
        size: f.size ? f.size + subtitleInfo.subOverheadBytes : f.size,
        label: f.isRecommended ? 'Recommended' : f.label
      }))
    : tiers.map(f => ({ ...f, available: false }));

  return {
    videoFormats:    tiers,
    videoSubFormats,
    audioFormats,
    subtitleInfo,
    bestAudioBytes:  audioBytes
  };
}

function buildYouTubeResult(url, meta, type) {
  const formats      = buildFullFormatsFromMeta(meta);
  const isLive       = meta.is_live || meta.live_status === 'is_live';
  const wasLive      = meta.live_status === 'was_live';

  return {
    platform:        'youtube',
    contentType:     isLive ? 'live' : (type || 'video'),
    title:           meta.title,
    uploader:        meta.uploader || meta.channel,
    channelId:       meta.channel_id || null,
    duration:        meta.duration,
    thumbnail:       meta.thumbnail,
    viewCount:       meta.view_count,
    likeCount:       meta.like_count  || null,
    uploadDate:      meta.upload_date,
    description:     (meta.description || '').slice(0, 280),
    isLive,
    wasLive,
    ageLimit:        meta.age_limit   || 0,
    categories:      meta.categories  || [],
    tags:            (meta.tags || []).slice(0, 8),
    videoFormats:    formats.videoFormats,
    videoSubFormats: formats.videoSubFormats,
    audioFormats:    formats.audioFormats,
    subtitleInfo:    formats.subtitleInfo,
    hasSubtitles:    formats.subtitleInfo.hasSubtitles,
    subtitleLangs:   formats.subtitleInfo.languages.map(l => l.code),
    estimatedSize:   meta.filesize_approx || null,
    actions:         getYouTubeActions(isLive ? 'live' : (type || 'video')),
    stage:           2
  };
}

// ── YouTube probing ───────────────────────────────────────────────────────────

async function probeYouTube(url) {
  const type = detectYouTubeType(url);
  if (type === 'playlist' || type === 'mix_playlist') return probeYouTubePlaylist(url, type);
  return probeYouTubeSingle(url, type);
}

/**
 * runYtDlpProbe — Centralised, fully-logged yt-dlp execFileAsync wrapper.
 *
 * Logs: the exact command, every byte of stdout/stderr, exit code, timing.
 * Returns: { stdout, stderr } on success.
 * Throws: descriptive Error on failure, but always logs first.
 */
async function runYtDlpProbe(fn, args, opts = {}) {
  const bin     = getYtDlpBin();
  const timeout = opts.timeout || 30000;
  const t0      = Date.now();

  log.cmd(fn, bin, args);

  let stdout = '', stderr = '', exitCode = 0;
  try {
    const r = await execFileAsync(bin, args, {
      timeout,
      maxBuffer: opts.maxBuffer || 50 * 1024 * 1024
    });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
    exitCode = 0;
    log.out(fn, stdout, stderr, 0);
    log.ok(fn, `yt-dlp finished in ${Date.now() - t0}ms`, { exitCode, stdoutBytes: stdout.length, stderrBytes: stderr.length });
    return { stdout, stderr };
  } catch (e) {
    exitCode = e.code ?? e.exitCode ?? '?';
    stdout   = e.stdout || '';
    stderr   = e.stderr || '';

    log.error(fn, `yt-dlp FAILED (exit ${exitCode}) after ${Date.now() - t0}ms`, {
      exitCode,
      stdout:  stdout.slice(0, 3000) || '(empty)',
      stderr:  stderr.slice(0, 3000) || '(empty)',
      message: e.message?.split('\n')[0]
    });

    // Salvage: yt-dlp sometimes writes valid JSON to stdout BEFORE exiting non-zero
    if (stdout.trim()) {
      log.warn(fn, 'yt-dlp exited non-zero but stdout has data — attempting salvage', { bytes: stdout.length });
      return { stdout, stderr, salvaged: true };
    }
    throw e; // re-throw so caller can try next strategy
  }
}

/** Try to parse the first valid JSON object with an 'id' field from yt-dlp output */
function parseYtDlpJson(fn, raw) {
  const lines = (raw || '').trim().split('\n').filter(Boolean);
  log.debug(fn, `Parsing ${lines.length} output line(s) for JSON`);
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o?.id) {
        log.ok(fn, 'JSON parsed OK', { id: o.id, title: o.title?.slice(0, 80), formatsCount: o.formats?.length ?? 0 });
        return o;
      }
    } catch (parseErr) {
      // not JSON — log only if it looks like an error message worth surfacing
      if (/^ERROR|^WARNING/i.test(line.trim())) {
        log.warn(fn, 'yt-dlp message in output', { line: line.trim().slice(0, 200) });
      }
    }
  }
  return null;
}

async function probeYouTubeSingle(url, type) {
  const FN      = 'probeYouTubeSingle';
  const videoId = videoIdFromUrl(url);

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'youtube',
        contentType: type || 'video',
        title: 'Blocked URL',
        uploader: null,
        channelId: null,
        duration: 0,
        thumbnail: null,
        viewCount: 0,
        likeCount: null,
        uploadDate: null,
        description: `Blocked URL for security/redundancy reasons: ${url}`,
        isLive: false,
        wasLive: false,
        ageLimit: 0,
        categories: [],
        tags: [],
        videoFormats: [],
        videoSubFormats: [],
        audioFormats: [],
        subtitleInfo: { hasSubtitles: false, languages: [], subOverheadBytes: 0 },
        bestAudioBytes: 0,
        estimatedSize: null,
        actions: [],
        stage: 2
      };
    }
  }

  log.info(FN, 'Starting probe', { url, type, videoId });

  // ── Cache hit ──────────────────────────────────────────────────────────────
  if (videoId) {
    const cached = videoCache.get(videoId);
    if (cached) {
      log.ok(FN, 'Cache hit — skipping yt-dlp', { videoId, title: cached.title?.slice(0, 80) });
      return buildYouTubeResult(url, cached, type);
    }
  }

  const cookieArgs = getCookiesArgs('yt-dlp');
  const BASE       = ['--no-playlist', '--quiet', '--no-warnings', ...cookieArgs];

  /**
   * Retry cascade — each strategy is tried in order.
   * We stop at the first one that produces parseable JSON.
   *
   * Strategy 1: --no-check-formats (skip HTTP HEAD checks for format URLs)
   * Strategy 2: No extra flags (plain dump-json, some yt-dlp builds behave differently)
   * Strategy 3: Permissive format selector — "b*" matches ANYTHING including
   *             restricted or partially-available format sets. This is the key
   *             fix for "Requested format is not available": without an explicit
   *             --format flag, yt-dlp defaults to "bestvideo+bestaudio" which
   *             can fail; "b*" is the wildcard fallback that always resolves.
   * Strategy 4: --ignore-no-formats-error (yt-dlp ≥ 2023.03+)
   */
  const strategies = [
    { name: 'no-check-formats',        args: ['--dump-json', '--no-check-formats',                               ...BASE, url] },
    { name: 'plain-dump-json',          args: ['--dump-json',                                                     ...BASE, url] },
    { name: 'permissive-format',        args: ['--dump-json', '--no-check-formats', '--format', 'b*',             ...BASE, url] },
    { name: 'ignore-no-formats-error',  args: ['--dump-json', '--no-check-formats', '--ignore-no-formats-error',  ...BASE, url] },
  ];

  let lastRawError = null;

  for (let i = 0; i < strategies.length; i++) {
    const { name, args } = strategies[i];
    log.info(FN, `Strategy ${i + 1}/${strategies.length}: ${name}`, { url });

    let result;
    try {
      result = await runYtDlpProbe(FN, args, { timeout: 30000 });
    } catch (e) {
      lastRawError = e;
      log.warn(FN, `Strategy ${name} failed — trying next`, {
        reason: extractProcError(e).slice(0, 300)
      });
      continue;
    }

    const meta = parseYtDlpJson(FN, result.stdout);
    if (meta) {
      if (result.salvaged) log.warn(FN, 'Using salvaged stdout (yt-dlp exited non-zero)');
      if (videoId) videoCache.set(videoId, meta);
      log.ok(FN, `Probe succeeded via strategy: ${name}`, { videoId, title: meta.title?.slice(0, 80) });
      return buildYouTubeResult(url, meta, type);
    }

    log.warn(FN, `Strategy ${name} produced no parseable JSON — trying next`);
    lastRawError = new Error('No valid JSON in stdout');
  }

  // All strategies exhausted
  const finalErr = extractProcError(lastRawError, 'yt-dlp probe failed');
  log.error(FN, `All ${strategies.length} strategies failed`, { url, finalErr });
  throw new Error(finalErr);
}

/**
 * Playlist probe — two phases:
 *
 * Phase 1 (this function, synchronous-ish):
 *   --flat-playlist gives us title, uploader, item count, thumbnail, and
 *   per-entry basic info (id, title, duration) in one fast yt-dlp call.
 *   Returns immediately with contentType='playlist' and per-tier size=null
 *   ("Calculating...") so the UI can render instantly.
 *
 * Phase 2 (background, playlist-worker.js):
 *   The caller (routes/probe.js) starts the worker pool after this returns.
 *   Workers probe individual videos concurrently and broadcast
 *   `playlist_progress` WS events as they complete.
 */
async function probeYouTubePlaylist(url, type = 'playlist') {
  const FN     = 'probeYouTubePlaylist';
  const listId = listIdFromUrl(url);

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'youtube',
        contentType: type,
        playlistId: null,
        title: 'Blocked URL',
        uploader: null,
        thumbnail: null,
        itemCount: 0,
        totalCount: 0,
        duration: 0,
        videoTotals: {},
        audioTotals: {},
        entries: [],
        enriching: false,
        actions: [],
        stage: 2
      };
    }
  }

  log.info(FN, 'Starting playlist probe', { url, type, listId });

  if (listId) {
    const cached = playlistCache.get(listId);
    if (cached) { log.ok(FN, 'Cache hit', { listId, itemCount: cached.itemCount }); return cached; }
  }

  const args = [
    '--dump-json', '--flat-playlist',
    '--quiet', '--no-warnings',
    ...getCookiesArgs('yt-dlp'),
    url
  ];

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await runYtDlpProbe(FN, args, { timeout: 60000, maxBuffer: 200 * 1024 * 1024 }));
  } catch (e) {
    if (e.stdout?.trim()) { stdout = e.stdout; log.warn(FN, 'Using salvaged stdout after error'); }
    else { log.error(FN, 'Playlist probe failed', e); throw new Error(extractProcError(e, 'Playlist probe failed')); }
  }

  const UNAVAIL = new Set(['unavailable', 'needs_auth', 'subscriber_only', 'premium_only']);
  const allParsed = (stdout || '').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const container = allParsed.find(e => e._type === 'playlist');
  const entries   = allParsed.filter(e => {
    if (!e.id || e._type === 'playlist') return false;
    if (UNAVAIL.has(e.availability)) return false;
    if (/^\[(Deleted|Private) video\]$/.test(e.title || '')) return false;
    return true;
  });

  const knownDuration = entries.reduce((s, e) => s + (e.duration || 0), 0);

  const result = {
    platform:     'youtube',
    contentType:  type,
    playlistId:   listId || container?.id,
    title:        container?.title || entries[0]?.playlist_title || 'Playlist',
    uploader:     container?.uploader || container?.channel || entries[0]?.uploader,
    thumbnail:    container?.thumbnails?.[0]?.url || entries[0]?.thumbnail,
    itemCount:    entries.length,
    totalCount:   allParsed.filter(e => e._type !== 'playlist').length,
    duration:     knownDuration,
    // Per-tier sizes start null; playlist-worker fills them via WS
    videoTotals:  Object.fromEntries([144,240,360,480,720,1080,1440,2160].map(h => [h, null])),
    audioTotals:  Object.fromEntries(['mp3','m4a','aac','opus','flac','wav','ogg'].map(f => [f, null])),
    entries,      // raw flat entries — passed to playlist-worker
    enriching:    entries.length > 0,
    actions:      getYouTubeActions(type),
    stage:        2
  };

  if (listId) playlistCache.set(listId, result);
  return result;
}

// ── Instagram probing ─────────────────────────────────────────────────────────

async function probeInstagram(url, currentSlide = 0) {
  const FN   = 'probeInstagram';
  const type = detectInstagramType(url);

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'instagram',
        contentType: type,
        mediaType: 'unknown',
        title: 'Blocked URL',
        uploader: null,
        thumbnail: null,
        duration: 0,
        slideCount: 0,
        slides: [],
        currentSlideType: 'unknown',
        actions: [],
        source: 'blocked',
        stage: 2
      };
    }
  }

  log.info(FN, 'Starting probe', { url, type, currentSlide });
  if (type === 'reel' || type === 'story' || type === 'igtv') {
    return probeInstagramYtDlp(url, type);
  }
  try {
    return await probeInstagramGalleryDl(url, type);
  } catch (e) {
    const msg = extractProcError(e);
    const is401 = /403|401|login|cookie|private|auth/i.test(msg);
    log.error(FN, 'gallery-dl probe failed', { msg, is401 });
    throw new Error(is401
      ? 'Instagram requires login. Go to Settings → Instagram → Refresh Cookies, then try again.'
      : `gallery-dl probe failed: ${msg}`);
  }
}

async function probeInstagramGalleryDl(url, type) {
  const FN  = 'probeInstagramGalleryDl';
  const bin = getGalleryDlBin();

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'instagram',
        contentType: type,
        mediaType: 'unknown',
        title: 'Blocked URL',
        uploader: null,
        thumbnail: null,
        slideCount: 0,
        slides: [],
        actions: [],
        source: 'blocked',
        stage: 2
      };
    }
  }

  const args = ['--dump-json', '--no-download', ...getCookiesArgs('gallery-dl'), url];

  log.cmd(FN, bin, args);

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }));
    log.out(FN, stdout, stderr, 0);
  } catch (e) {
    log.out(FN, e.stdout, e.stderr, e.code);
    if (e.stdout?.trim()) { stdout = e.stdout; log.warn(FN, 'Salvaging stdout after error'); }
    else { log.error(FN, 'gallery-dl failed', e); throw new Error(extractProcError(e)); }
  }

  const allParsed = (stdout || '').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (!allParsed.length) throw new Error('No data returned — post may be private or cookies missing');

  const MEDIA_EXTS  = new Set(['jpg','jpeg','png','webp','mp4','mov','heic','gif','avif']);
  const CDN_PATTERN = /\.(jpg|jpeg|png|webp|mp4|mov|heic|gif|avif)(\?|$)/i;

  const items = allParsed.filter(item => {
    if (!item.url) return false;
    if (/instagram\.com\/(p|reel|tv|stories)\//i.test(item.url)) return false;
    const ext = (item.extension || '').toLowerCase();
    if (MEDIA_EXTS.has(ext)) return true;
    if (item.video === true || item.type === 'GraphVideo' || item.type === 'GraphImage') return true;
    if (CDN_PATTERN.test(item.url)) return true;
    return false;
  });

  if (!items.length) throw new Error('No media items found. Post may be private or cookies are expired.');

  const mediaTypes = items.map(item => {
    const ext = (item.extension || '').toLowerCase();
    return (ext === 'mp4' || ext === 'mov' || item.video === true || item.type === 'GraphVideo') ? 'video' : 'photo';
  });

  const hasVideos = mediaTypes.includes('video');
  const hasPhotos = mediaTypes.includes('photo');
  const mediaType = hasVideos && hasPhotos ? 'mixed' : hasVideos ? 'video' : 'photo';
  const contentType = items.length > 1 ? 'carousel' : (mediaTypes[0] === 'video' ? 'video' : type);

  return {
    platform: 'instagram', contentType, mediaType,
    title:    items[0]?.description?.slice(0, 100) || items[0]?.title || 'Instagram Post',
    uploader: items[0]?.uploader || items[0]?.username || null,
    thumbnail:items[0]?.thumbnail || items[0]?.url || null,
    slideCount: items.length, currentSlide: 0,
    currentSlideType: mediaTypes[0] || 'photo',
    slides: items.map((item, i) => ({
      index: i, mediaType: mediaTypes[i], mediaUrl: item.url,
      thumbnail: item.thumbnail || item.url,
      filename: item.filename || null,
      extension: (item.extension || (mediaTypes[i] === 'video' ? 'mp4' : 'jpg')).toLowerCase(),
      duration: item.duration || null
    })),
    actions: getInstagramActions(contentType, mediaType, items.length),
    source: 'gallery-dl', stage: 2
  };
}

async function probeInstagramYtDlp(url, type) {
  const FN   = 'probeInstagramYtDlp';
  const args = ['--dump-json', '--quiet', '--no-warnings', '--no-playlist', '--no-check-formats', ...getCookiesArgs('yt-dlp'), url];

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'instagram',
        contentType: type,
        mediaType: 'unknown',
        title: 'Blocked URL',
        uploader: null,
        thumbnail: null,
        duration: 0,
        slideCount: 0,
        slides: [],
        actions: [],
        source: 'blocked',
        stage: 2
      };
    }
  }

  log.info(FN, 'Starting yt-dlp Instagram probe', { url, type });

  let stdout;
  try {
    ({ stdout } = await runYtDlpProbe(FN, args, { timeout: 25000 }));
  } catch (e) {
    if (e.stdout?.trim()) { stdout = e.stdout; log.warn(FN, 'Salvaging stdout'); }
    else { log.error(FN, 'yt-dlp Instagram probe failed', e); throw new Error(extractProcError(e, 'yt-dlp Instagram probe')); }
  }

  const meta = parseYtDlpJson(FN, stdout);
  if (!meta) { log.error(FN, 'No valid JSON in output'); throw new Error('No valid metadata in yt-dlp output'); }

  const mediaType = (meta.ext === 'mp4' || (meta.vcodec && meta.vcodec !== 'none')) ? 'video' : 'photo';
  return {
    platform: 'instagram', contentType: type, mediaType,
    title:    meta.description?.slice(0, 100) || meta.title || `Instagram ${type}`,
    uploader: meta.uploader || meta.channel || null,
    thumbnail:meta.thumbnail || null,
    duration: meta.duration || 0,
    slideCount: 1, slides: [],
    actions:  getInstagramActions(type, mediaType, 1),
    source: 'yt-dlp', stage: 2
  };
}

// ── Generic probing ───────────────────────────────────────────────────────────

const DIRECT_MEDIA_EXT = /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|ts|mp3|m4a|aac|wav|flac|ogg)(\?|#|$)/i;

function classifyStreamProtocol(url, meta) {
  if (meta?.protocol) {
    if (/m3u8/i.test(meta.protocol)) return 'hls';
    if (/dash/i.test(meta.protocol)) return 'dash';
    if (/^https?$/i.test(meta.protocol)) return 'direct';
    return meta.protocol;
  }
  const clean = url.split('?')[0];
  if (/\.m3u8$/i.test(clean)) return 'hls';
  if (/\.mpd$/i.test(clean))  return 'dash';
  if (DIRECT_MEDIA_EXT.test(url)) return 'direct';
  return 'page';
}

async function probeGeneric(url) {
  const FN       = 'probeGeneric';

  // Block known problematic URLs early to avoid wasting resources
  const BLOCKED_URL_PATTERNS = [
    /^https?:\/\/127\.0\.0\.1:/,
    /^https?:\/\/localhost:/,
    /^https?:\/\/\[::1\]/
  ];

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      log.warn(FN, 'Blocking known problematic URL', { url });
      return {
        platform: 'generic',
        contentType: 'unknown',
        url,
        error: `Blocked URL for security/redundancy reasons: ${url}`,
        actions: [],
        stage: 2
      };
    }
  }

  const protocol = classifyStreamProtocol(url, null);
  log.info(FN, 'Starting generic probe', { url, protocol });

  // Strategies tried in order — first one that produces parseable JSON wins.
  // Strategy 3 ("permissive format") is the key fix for sites like hanime.tv
  // where yt-dlp's default format selector ("bestvideo+bestaudio") fails with
  // "Requested format is not available" even though the video IS accessible.
  const BASE = ['--no-playlist', '--quiet', '--no-warnings', ...getCookiesArgs('yt-dlp')];
  const strategies = [
    { name: 'no-check-formats',       args: ['--dump-json', '--no-check-formats',                              ...BASE, url] },
    { name: 'permissive-format-b*',   args: ['--dump-json', '--no-check-formats', '--format', 'b*',            ...BASE, url] },
    { name: 'ignore-no-formats',      args: ['--dump-json', '--no-check-formats', '--ignore-no-formats-error', ...BASE, url] },
    { name: 'plain',                  args: ['--dump-json',                                                     ...BASE, url] },
  ];

  let lastError = null;
  for (let i = 0; i < strategies.length; i++) {
    const { name, args } = strategies[i];
    log.info(FN, `Strategy ${i + 1}/${strategies.length}: ${name}`, { url });
    let result;
    try {
      result = await runYtDlpProbe(FN, args, { timeout: 25000 });
    } catch (e) {
      lastError = e;
      log.warn(FN, `Strategy ${name} failed`, { reason: extractProcError(e).slice(0, 200) });
      continue;
    }
    const meta = parseYtDlpJson(FN, result.stdout);
    if (meta) {
      log.ok(FN, `Probe succeeded via strategy: ${name}`, { id: meta.id, title: meta.title?.slice(0, 60) });
      return buildGenericResult(url, meta);
    }
    log.warn(FN, `Strategy ${name} produced no JSON`);
    lastError = new Error('No valid JSON in stdout');
  }

  // All yt-dlp strategies failed — try ffprobe for direct media/stream URLs
  log.warn(FN, 'All yt-dlp strategies failed', { url });
  if (DIRECT_MEDIA_EXT.test(url)) {
    try {
      log.info(FN, 'Falling back to ffprobe', { url });
      const r = await probeDirectStream(url);
      log.ok(FN, 'ffprobe succeeded');
      return r;
    } catch (e2) {
      log.error(FN, 'ffprobe also failed', e2);
      return { platform: detectPlatform(url), contentType: 'unknown', url,
        protocol, error: extractProcError(e2), actions: ['download'], stage: 2 };
    }
  }

  const finalErr = extractProcError(lastError, 'Generic probe failed');
  log.error(FN, 'All probes failed', { url, finalErr });
  return { platform: detectPlatform(url), contentType: 'unknown', url, error: finalErr, actions: ['download'], stage: 2 };
}

function buildGenericResult(url, meta) {
  const dur      = meta.duration || 0;
  const allFmts  = (meta.formats || []).filter(f => f.ext);
  const videoLike= allFmts.filter(f => f.vcodec && f.vcodec !== 'none');
  const audioOnly= allFmts.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const bestAudio= audioOnly.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const audioBytes = bestAudio ? (estimateBytes(bestAudio, dur) || 0) : 0;

  const formats = videoLike
    .map(f => ({
      format_id: f.format_id,
      label:  f.height ? `${f.height}p` : (f.format_note || f.resolution || f.ext.toUpperCase()),
      height: f.height || null,
      ext:    f.ext,
      codec:  codecLabel(f.vcodec),
      fps:    f.fps ? Math.round(f.fps) : null,
      badges: formatBadges(f),
      protocol: classifyStreamProtocol(url, f),
      size: (estimateBytes(f, dur) + (f.acodec && f.acodec !== 'none' ? 0 : audioBytes)) || null
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .filter((f, i, arr) => arr.findIndex(o => o.label === f.label) === i)
    .slice(0, 8);

  return {
    platform:   detectPlatform(url), contentType: dur ? 'video' : 'media',
    title:      meta.title, uploader: meta.uploader, duration: dur,
    thumbnail:  meta.thumbnail, url: meta.webpage_url || url,
    protocol:   classifyStreamProtocol(url, meta),
    formats, audioFormats: buildAudioFormats(meta),
    estimatedSize: meta.filesize_approx || (formats[0]?.size ?? null),
    actions: ['download_video', 'download_audio'], stage: 2
  };
}

async function probeDirectStream(url) {
  const ffprobeBin = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const { stdout } = await execFileAsync(ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-rw_timeout', '15000000', url],
    { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });

  const info      = JSON.parse(stdout);
  const streams   = info.streams || [];
  const vStream   = streams.find(s => s.codec_type === 'video');
  const aStream   = streams.find(s => s.codec_type === 'audio');
  const dur       = parseFloat(info.format?.duration) || 0;
  const protocol  = classifyStreamProtocol(url, null);
  const totalBps  = parseInt(info.format?.bit_rate, 10) || 0;
  const totalBytes= parseInt(info.format?.size, 10) || (totalBps && dur ? Math.round(totalBps / 8 * dur) : null);
  const audioBps  = parseInt(aStream?.bit_rate, 10) || 0;
  const audioBytes= audioBps && dur ? Math.round(audioBps / 8 * dur) : (totalBytes ? Math.round(totalBytes * 0.12) : 0);

  return {
    platform: detectPlatform(url), contentType: vStream ? 'video' : (aStream ? 'audio' : 'media'),
    title: url.split('/').pop().split('?')[0] || 'Direct Stream',
    uploader: null, duration: dur, thumbnail: null, url, protocol,
    formats: vStream ? [{ format_id: 'direct', label: vStream.height ? `${vStream.height}p` : 'Video',
      height: vStream.height || null, ext: protocol === 'hls' ? 'mp4' : (vStream.codec_name || 'mp4'),
      codec: codecLabel(vStream.codec_name || ''), fps: vStream.r_frame_rate ? Math.round(eval(vStream.r_frame_rate)) : null,
      protocol, size: totalBytes || null }] : [],
    audioFormats: buildAudioFormats({ duration: dur, formats: aStream ? [{ acodec: aStream.codec_name, abr: audioBps / 1000, asr: aStream.sample_rate, ext: aStream.codec_name, filesize: audioBytes }] : [] }),
    estimatedSize: totalBytes,
    actions: vStream ? ['download_video', 'download_audio'] : ['download_audio'],
    stage: 2, source: 'ffprobe'
  };
}

module.exports = {
  quickAnalyze,
  detectPlatform,
  detectInstagramType,
  detectYouTubeType,
  probeYouTube,
  probeInstagram,
  probeGeneric,
  getInstagramActions,
  getYouTubeActions,
  buildFullFormatsFromMeta  // re-exported for playlist-worker.js
};
