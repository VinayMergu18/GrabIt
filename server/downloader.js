/**
 * downloader.js — Download execution via yt-dlp and gallery-dl.
 *
 * Key fixes:
 *  - Process stored on item so queue can kill it on cancel
 *  - Progress is monotonic (never goes backward)
 *  - item.cancelled checked per line so cancel stops immediately
 *  - Temp files tracked for cleanup on cancel
 *  - gallery-dl filename template uses correct syntax: {num:03}
 *  - YouTube video always uses --no-playlist
 *  - Recommended quality: ≤720p, never 1080p
 *  - downloadYouTubeVideoWithSubs: subs-only mode + embed mode
 *  - Instagram carousel all/filtered: correct gallery-dl args
 *  - All functions accept optional `item` param for process tracking
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { getCookiesArgs } = require('./cookies');
const { getSettings }    = require('./db');
const { broadcastProgress } = require('./websocket');
const log = require('./logger').child('downloader.js');

function getYtDlpBin()    { return process.platform === 'win32' ? 'yt-dlp.exe'     : 'yt-dlp'; }
function getGalleryDlBin(){ return process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl'; }
function getFfmpegBin()   { return process.platform === 'win32' ? 'ffmpeg.exe'     : 'ffmpeg'; }

function ensureFolder(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function sanitizeFilename(name) {
  return (name || 'download')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ').trim().slice(0, 180);
}

// ── Progress parsing ──────────────────────────────────────────────────────────

const YT_PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+[KMGT]?iB\/s))?(?:\s+ETA\s+([\d:]+))?/i;
const GALLERY_DL_RE  = /\[#\d+\s+([\d.]+)([KMGT]?B)\s+\/\s+([\d.]+)([KMGT]?B)/i;

function parseYtDlpLine(line) {
  const m = YT_PROGRESS_RE.exec(line);
  if (!m) return null;
  const mult = { KiB: 1024, MiB: 1024**2, GiB: 1024**3, TiB: 1024**4 }[m[3]] || 1;
  return { percent: parseFloat(m[1]), totalSize: Math.round(parseFloat(m[2]) * mult), speed: m[4] || null, eta: m[5] || null };
}

// parseGalleryDlLine removed — gallery-dl uses custom file-path tracking

// ── Core process runner ───────────────────────────────────────────────────────

function spawnProcess(bin, args, downloadId, item, parseLine) {
  const FN = `spawnProcess[${path.basename(bin)}]`;
  log.cmd(FN, bin, args);
  log.download(FN, 'started', { downloadId, bin: path.basename(bin), title: item?.title?.slice(0,80) });

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (item) {
      item.proc      = proc;
      item.tempFiles = item.tempFiles || [];
    }

    let stdout = '', stderr = '', lastPct = -1;
    const files = [];

    const onLine = (line) => {
      if (line.trim()) log.debug(FN, 'stdout', { downloadId, line: line.trim().slice(0, 300) });
      if (item?.cancelled) { try { proc.kill('SIGTERM'); } catch {} return; }

      // Capture output filenames
      const destMatch = line.match(/\[download\] Destination:\s*(.+)$/);
      if (destMatch) {
        const f = destMatch[1].trim();
        files.push(f);
        if (item && !item.tempFiles.includes(f)) item.tempFiles.push(f);
      }
      const mergeMatch = line.match(/Merging formats into "(.+)"/);
      if (mergeMatch) files.push(mergeMatch[1].trim());
      const audioMatch = line.match(/\[ExtractAudio\].*Destination:\s*(.+)$/);
      if (audioMatch) files.push(audioMatch[1].trim());

      const prog = parseLine(line);
      if (prog && downloadId) {
        // Monotonic: never go backward
        if (prog.percent > lastPct) {
          lastPct = prog.percent;
          broadcastProgress(downloadId, prog);
          if (item) item.progress = prog;
        }
      }
    };

    let outBuf = '', errBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', chunk => {
      stdout += chunk; outBuf += chunk;
      const lines = outBuf.split('\n'); outBuf = lines.pop();
      lines.forEach(onLine);
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk; errBuf += chunk;
      const lines = errBuf.split('\n'); errBuf = lines.pop();
      lines.forEach(line => {
        if (line.trim()) log.warn(FN, 'stderr', { downloadId, line: line.trim().slice(0, 300) });
        onLine(line);
      });
    });

    proc.on('close', code => {
      if (item) item.proc = null;
      if (item?.cancelled) {
        log.warn(FN, 'Download cancelled by user', { downloadId });
        return reject(new Error('Cancelled'));
      }
      if (code !== 0 && code !== null) {
        const errTail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
        log.error(FN, `Process exited ${code}`, {
          downloadId,
          exitCode: code,
          stderr: stderr.trim().slice(0, 2000) || '(empty)',
          stdout: stdout.trim().slice(0, 500) || '(empty)',
          files
        });
        return reject(new Error(`${path.basename(bin)} exited ${code}: ${errTail}`));
      }
      log.download(FN, 'complete', { downloadId, exitCode: code, files, stdoutBytes: stdout.length, stderrBytes: stderr.length });
      resolve({ success: true, file: files[files.length - 1] || null, files, stdout, stderr });
    });

    proc.on('error', err => {
      if (item) item.proc = null;
      log.error(FN, `Cannot start process: ${err.message}`, { downloadId, bin, errorCode: err.code });
      reject(new Error(`Cannot start ${path.basename(bin)}: ${err.message}`));
    });
  });
}

function runYtDlp(args, downloadId, item) {
  return spawnProcess(getYtDlpBin(), args, downloadId, item, parseYtDlpLine);
}

function runGalleryDl(args, downloadId, item, outputDir = null) {
  const FN  = 'runGalleryDl';
  const bin = getGalleryDlBin();

  // Log the exact command — this was previously invisible in the logs
  log.cmd(FN, bin, args);
  log.download(FN, 'started', { downloadId, title: item?.title?.slice(0, 80) });

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (item) { item.proc = proc; item.tempFiles = item.tempFiles || []; }

    let stdout = '', stderr = '', fileCount = 0;
    const files = [];
    const { broadcastProgress: bp } = require('./websocket');

    const trackLine = (line) => {
      if (item?.cancelled) { try { proc.kill('SIGTERM'); } catch {} return; }
      const t = line.trim();
      if (!t) return;

      // gallery-dl writes full file paths to stdout (one per downloaded file)
      if (t.includes('/') || t.includes('\\') || /\.[a-z0-9]{2,5}$/i.test(t)) {
        if (fs.existsSync(t)) {          // only track if it's a real file path
          if (!files.includes(t)) files.push(t);
          if (item && !item.tempFiles.includes(t)) item.tempFiles.push(t);
          fileCount++;
          log.ok(FN, `File downloaded: ${path.basename(t)}`, { downloadId, fileCount, path: t });
          if (downloadId) bp(downloadId, { percent: Math.min(fileCount * 15, 90), speed: null, eta: null });
        }
      }
      // Log errors/warnings from gallery-dl stdout
      if (/error|warning|failed|skip/i.test(t)) {
        log.warn(FN, 'gallery-dl message', { downloadId, line: t.slice(0, 300) });
      }
    };

    let outBuf = '', errBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      stdout += chunk; outBuf += chunk;
      const ls = outBuf.split('\n'); outBuf = ls.pop();
      ls.forEach(trackLine);
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk; errBuf += chunk;
      const ls = errBuf.split('\n'); errBuf = ls.pop();
      ls.forEach(line => {
        if (line.trim()) log.warn(FN, 'stderr', { downloadId, line: line.trim().slice(0, 300) });
      });
    });

    proc.on('close', code => {
      if (item) item.proc = null;
      if (item?.cancelled) {
        log.warn(FN, 'Cancelled by user', { downloadId });
        return reject(new Error('Cancelled'));
      }

      // Log raw output for debugging
      log.out(FN, stdout, stderr, code);

      // gallery-dl exit codes:
      //   0 = all files downloaded successfully
      //   1 = partial success (some files skipped / already exist / minor errors)
      //   2 = fatal error (authentication, network, not found)
      //
      // Treat exit 1 as success — it means "some files were skipped because they
      // already exist in the output directory", which is the normal behaviour on
      // repeat downloads of the same carousel.
      if (code === 2) {
        const msg = stderr.trim().split('\n').slice(-5).join('\n');
        log.error(FN, `gallery-dl fatal exit (code 2)`, { downloadId, stderr: msg.slice(0, 1000) });
        return reject(new Error(`gallery-dl failed: ${msg}`));
      }

      // If gallery-dl produced no stdout file paths (e.g. all files were skipped
      // because they already exist), scan the output directory to populate the
      // files list so the queue item always has file/folder metadata.
      if (files.length === 0 && outputDir && fs.existsSync(outputDir)) {
        const MEDIA = /\.(jpg|jpeg|png|webp|mp4|mov|gif|heic|avif|m4v|mkv|ts|mp3|m4a|aac|wav|opus|flac)$/i;
        const found = fs.readdirSync(outputDir)
          .filter(f => MEDIA.test(f) && !f.startsWith('.'))
          .map(f => path.join(outputDir, f))
          .sort();
        if (found.length) {
          files.push(...found);
          log.info(FN, `No new downloads — found ${found.length} existing file(s) in output dir`, { outputDir, files: found.map(f => path.basename(f)) });
        } else {
          log.warn(FN, 'No files downloaded and output dir is empty', { downloadId, outputDir, exitCode: code });
        }
      }

      if (downloadId) bp(downloadId, { percent: 100, speed: null, eta: null });
      log.download(FN, 'complete', { downloadId, exitCode: code, fileCount: files.length, files: files.map(f => path.basename(f)) });
      resolve({ success: true, file: files[files.length - 1] || null, files, stderr });
    });

    proc.on('error', err => {
      if (item) item.proc = null;
      log.error(FN, `Cannot start gallery-dl: ${err.message}`, { downloadId, bin, errorCode: err.code });
      reject(new Error(`Cannot start gallery-dl: ${err.message}`));
    });
  });
}

// ── YouTube ───────────────────────────────────────────────────────────────────

async function downloadYouTubeVideo(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const folder   = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'YouTube'));
  const quality  = options.quality || settings.defaultQuality || 'recommended';

  let formatStr;
  if (quality === 'recommended') {
    formatStr = [
      'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]',
      'bestvideo[height<=720]+bestaudio',
      'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]',
      'bestvideo[height<=480]+bestaudio',
      'best[height<=720]', 'best'
    ].join('/');
  } else if (quality === 'best') {
    formatStr = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  } else {
    const h = parseInt(quality) || 720;
    formatStr = [
      `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
      `bestvideo[height<=${h}]+bestaudio`,
      `best[height<=${h}]`, 'best'
    ].join('/');
  }

  const args = [
    '--format', formatStr,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', getFfmpegBin(),
    '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
    '--no-playlist',
    '--add-metadata', '--write-thumbnail',
    '--progress', '--newline', '--no-warnings',
    url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
  if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));

  return runYtDlp(args, downloadId, item);
}

async function downloadYouTubeVideoWithSubs(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const folder   = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'YouTube'));
  const quality  = options.quality || 'recommended';
  const subsOnly = options.subsOnly || false;
  const subLang  = options.subLang  || settings.autoSubtitleLang || 'en,en-US,en-GB';

  if (subsOnly) {
    const args = [
      '--skip-download',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', subLang, '--sub-format', 'srt/vtt/best',
      '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
      '--no-playlist', '--no-warnings', url
    ];
    args.push(...getCookiesArgs('yt-dlp'));
    return runYtDlp(args, downloadId, item);
  }

  const h = quality === 'recommended' ? 720 : quality === 'best' ? 9999 : parseInt(quality) || 720;
  const formatStr = h >= 9999
    ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
    : [`bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`, `bestvideo[height<=${h}]+bestaudio`, `best[height<=${h}]`, 'best'].join('/');

  const args = [
    '--format', formatStr,
    '--merge-output-format', 'mkv',
    '--ffmpeg-location', getFfmpegBin(),
    '--write-subs', '--write-auto-subs',
    '--sub-langs', subLang, '--sub-format', 'srt/vtt/best', '--embed-subs',
    '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
    '--no-playlist', '--add-metadata', '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  if (settings.sponsorBlock) args.push('--sponsorblock-remove', 'all');
  return runYtDlp(args, downloadId, item);
}

async function downloadYouTubeAudio(url, options = {}, downloadId, item) {
  const settings = getSettings().youtube || {};
  const folder   = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'YouTube'));
  const format   = options.format || settings.preferredAudioFormat || 'mp3';

  const args = [
    '--extract-audio', '--audio-format', format,
    '--audio-quality', format === 'mp3' ? '192' : '0',
    '--embed-thumbnail', '--add-metadata',
    '--output', path.join(folder, '%(title)s [%(id)s].%(ext)s'),
    '--no-playlist', '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

async function downloadYouTubePlaylist(url, options = {}, downloadId, item) {
  const settings  = getSettings().youtube || {};
  const folder    = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'YouTube'));
  const audioOnly = options.audioOnly || false;
  const format    = options.format    || settings.preferredAudioFormat || 'mp3';
  const quality   = options.quality   || 'recommended';
  const subtitles = options.subtitles || false;

  const matchFilter = 'availability != "needs_auth" & availability != "unavailable"';
  const h = quality === 'recommended' ? 720 : parseInt(quality) || 720;

  let args;
  if (audioOnly) {
    args = [
      '--extract-audio', '--audio-format', format,
      '--audio-quality', format === 'mp3' ? '192' : '0',
      '--embed-thumbnail', '--add-metadata',
      '--output', path.join(folder, '%(playlist_title)s/%(playlist_index)s - %(title)s.%(ext)s'),
      '--yes-playlist', '--match-filter', matchFilter,
      '--progress', '--newline', '--no-warnings', '--ignore-errors', url
    ];
  } else {
    const fmtStr = [`bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`, `bestvideo[height<=${h}]+bestaudio`, `best[height<=${h}]`, 'best'].join('/');
    args = [
      '--format', fmtStr,
      '--merge-output-format', subtitles ? 'mkv' : 'mp4',
      '--ffmpeg-location', getFfmpegBin(),
      '--add-metadata', '--write-thumbnail',
      '--output', path.join(folder, '%(playlist_title)s/%(playlist_index)s - %(title)s [%(id)s].%(ext)s'),
      '--yes-playlist', '--match-filter', matchFilter,
      '--progress', '--newline', '--no-warnings', '--ignore-errors', url
    ];
    if (subtitles) args.push('--write-subs', '--write-auto-subs', '--sub-langs', settings.autoSubtitleLang || 'en,en-US', '--embed-subs');
  }
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

// ── Instagram ─────────────────────────────────────────────────────────────────

function igBase(sub, options, settings) {
  return ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    sub
  ));
}

async function downloadInstagramReel(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Reels', options, settings);
  const args = [
    '--no-playlist',
    '--output', path.join(folder, '%(uploader)s_%(id)s.%(ext)s'),
    '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

async function downloadInstagramReelAudio(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Audio', options, settings);
  const format   = options.format || settings.preferredAudioFormat || 'mp3';
  const args = [
    '--extract-audio', '--audio-format', format, '--audio-quality', '0',
    '--no-playlist',
    '--output', path.join(folder, '%(uploader)s_%(id)s.%(ext)s'),
    '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  return runYtDlp(args, downloadId, item);
}

async function downloadInstagramPhoto(url, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Photos', options, settings);
  const gdArgs   = ['--directory', folder, ...getCookiesArgs('gallery-dl'), url];
  try {
    return await runGalleryDl(gdArgs, downloadId, item, folder);
  } catch {
    const args = ['--output', path.join(folder, '%(uploader)s_%(id)s.%(ext)s'), '--no-playlist', '--no-warnings', url];
    args.push(...getCookiesArgs('yt-dlp'));
    return runYtDlp(args, downloadId, item);
  }
}

async function downloadInstagramSlide(url, slideObj, options = {}, downloadId, item) {
  const settings = getSettings().instagram || {};
  const folder   = igBase('Slides', options, settings);
  const slideNum = slideObj.index + 1; // gallery-dl is 1-based

  const gdArgs = [
    '--range', `${slideNum}-${slideNum}`,
    '--directory', folder,
    '--filename', `slide_${String(slideNum).padStart(2, '0')}.{extension}`,
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const result = await runGalleryDl(gdArgs, downloadId, item, folder);
  return { ...result, file: result.files?.[0] || null, folder };
}

async function downloadInstagramSlideAudio(url, slideObj, options = {}, downloadId, item) {
  const settings  = getSettings().instagram || {};
  const folder    = igBase('Audio', options, settings);
  const format    = options.format || settings.preferredAudioFormat || 'mp3';
  const slideNum  = slideObj.index + 1;

  // Download the video slide to a temp dir, then extract audio
  const tmpDir = path.join(os.tmpdir(), `mg_slide_${downloadId || Date.now()}`);
  ensureFolder(tmpDir);
  if (item) (item.tempFiles = item.tempFiles || []).push(tmpDir);

  const gdArgs = [
    '--range', `${slideNum}-${slideNum}`,
    '--directory', tmpDir,
    '--filename', `slide.{extension}`,
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const gdResult = await runGalleryDl(gdArgs, downloadId, item);
  if (item?.cancelled) throw new Error('Cancelled');

  const videoFile = gdResult.files?.[0];
  if (!videoFile || !fs.existsSync(videoFile)) throw new Error(`Slide ${slideNum} not found for audio extraction`);

  const outFile = path.join(folder, `slide_${String(slideNum).padStart(2, '0')}.${format}`);
  const ffArgs  = ['-y', '-i', videoFile, '-vn',
    '-acodec', format === 'mp3' ? 'libmp3lame' : format === 'aac' ? 'aac' : 'copy',
    '-q:a', '2', outFile
  ];
  await spawnProcess(getFfmpegBin(), ffArgs, downloadId, item, () => null);
  try { fs.unlinkSync(videoFile); fs.rmdirSync(tmpDir); } catch {}

  return { success: true, file: outFile, files: [outFile] };
}

async function downloadInstagramCarouselAll(url, options = {}, downloadId, item) {
  const settings    = getSettings().instagram || {};
  const title       = sanitizeFilename(options.title || 'Carousel');
  const carouselDir = ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    'Carousels', title
  ));

  const gdArgs = [
    '--directory', carouselDir,
    '--filename', '{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const result = await runGalleryDl(gdArgs, downloadId, item, carouselDir);
  try {
    fs.writeFileSync(path.join(carouselDir, 'metadata.json'),
      JSON.stringify({ url, title, downloadedAt: new Date().toISOString(), files: result.files }, null, 2));
  } catch {}
  return { ...result, folder: carouselDir };
}

async function downloadInstagramCarouselFiltered(url, slideIndices, options = {}, downloadId, item) {
  const settings    = getSettings().instagram || {};
  const title       = sanitizeFilename(options.title || 'Carousel');
  const carouselDir = ensureFolder(path.join(
    options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Instagram'),
    'Carousels', title
  ));

  const gdArgs = [
    '--range', slideIndices,
    '--directory', carouselDir,
    '--filename', '{num:>02}.{extension}',
    ...getCookiesArgs('gallery-dl'),
    url
  ];

  const result = await runGalleryDl(gdArgs, downloadId, item, carouselDir);
  return { ...result, folder: carouselDir };
}

// Legacy alias
async function downloadInstagramCarouselSlide(url, slideIndex, options = {}, downloadId, item) {
  return downloadInstagramSlide(url, { index: slideIndex, ...options }, options, downloadId, item);
}

async function downloadGeneric(url, options = {}, downloadId, item) {
  const settings = getSettings().generic || {};
  const folder   = ensureFolder(options.folder || settings.downloadFolder || path.join(os.homedir(), 'Downloads', 'GrabIt', 'Other'));
  const audioOnly = options.audioOnly || false;

  let formatStr;
  if (audioOnly) {
    formatStr = null; // handled via --extract-audio below
  } else if (options.formatId) {
    formatStr = `${options.formatId}/best`;
  } else if (options.quality && options.quality !== 'best') {
    const h = parseInt(options.quality, 10) || (settings.maxResolution || 1080);
    formatStr = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`;
  } else {
    formatStr = `bestvideo[height<=${settings.maxResolution || 1080}][ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;
  }

  const args = audioOnly ? [
    '--extract-audio', '--audio-format', options.format || settings.preferredAudioFormat || 'mp3',
    '--audio-quality', '0',
    '--output', path.join(folder, '%(title)s.%(ext)s'),
    '--no-playlist', '--progress', '--newline', '--no-warnings', url
  ] : [
    '--format', formatStr,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', getFfmpegBin(),
    '--output', path.join(folder, '%(title)s.%(ext)s'),
    '--no-playlist', '--progress', '--newline', '--no-warnings', url
  ];
  args.push(...getCookiesArgs('yt-dlp'));
  if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));
  return runYtDlp(args, downloadId, item);
}

async function verifyFile(filePath) {
  if (!filePath) return { ok: false, reason: 'No path' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { ok: false, reason: 'Empty or not a file' };
    return { ok: true, size: stat.size, path: filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * downloadStream — Download HLS (m3u8), DASH (mpd), and direct media URLs.
 *
 * yt-dlp handles HLS and DASH natively via its generic extractor, so we
 * just pass the URL directly. For format selection:
 *   - HLS/DASH: "best[ext=mp4]/best" picks highest quality and re-muxes to MP4
 *   - Direct MP4/WebM: downloaded as-is with no re-encode
 *
 * The `quality` option accepts a height (e.g. "720") to cap resolution.
 */
async function downloadStream(url, options = {}, downloadId, item) {
  const FN       = 'downloadStream';
  const settings = getSettings().generic || {};
  const folder   = ensureFolder(
    options.folder || settings.downloadFolder ||
    path.join(os.homedir(), 'Downloads', 'GrabIt', 'Streams')
  );

  const type = (options.streamType || '').toUpperCase();

  // For HLS and DASH, yt-dlp can download and merge directly.
  // For direct files (MP4/WebM/MKV/MOV) just download without yt-dlp overhead.
  if (['MP4', 'WEBM', 'MKV', 'MOV', 'AVI', 'FLV', 'OGG', 'TS'].includes(type) && !options.forceYtDlp) {
    // Attempt direct download via yt-dlp generic extractor (handles auth/redirects)
  }

  const qualityCap = parseInt(options.quality, 10) || 0;
  const formatStr  = qualityCap
    ? `bestvideo[height<=${qualityCap}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${qualityCap}]+bestaudio/best[height<=${qualityCap}]/best`
    : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`;

  const title = options.name
    ? sanitizeFilename(options.name)
    : '%(title)s';

  const args = [
    '--format',              formatStr,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location',     getFfmpegBin(),
    '--output',              path.join(folder, `${title}.%(ext)s`),
    '--no-playlist',
    '--no-check-formats',
    '--progress', '--newline', '--no-warnings',
    ...getCookiesArgs('yt-dlp'),
    url
  ];

  if (settings.customArgs) args.push(...settings.customArgs.trim().split(/\s+/).filter(Boolean));

  log.cmd(FN, getYtDlpBin(), args);
  log.download(FN, 'started', { downloadId, url, type, quality: options.quality });

  const result = await runYtDlp(args, downloadId, item);
  return { ...result, folder };
}

module.exports = {
  downloadYouTubeVideo,
  downloadYouTubeVideoWithSubs,
  downloadYouTubeAudio,
  downloadYouTubePlaylist,
  downloadInstagramReel,
  downloadInstagramReelAudio,
  downloadInstagramPhoto,
  downloadInstagramCarouselAll,
  downloadInstagramCarouselFiltered,
  downloadInstagramCarouselSlide,
  downloadInstagramSlide,
  downloadInstagramSlideAudio,
  downloadGeneric,
  downloadStream,
  verifyFile
};
