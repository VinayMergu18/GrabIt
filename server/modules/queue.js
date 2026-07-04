/**
 * queue.js — Download queue manager.
 *
 * Key fixes:
 *  - cancelDownload actually kills the child process (taskkill on Win, SIGTERM→SIGKILL on *nix)
 *  - Deduplication: same URL+action won't be re-queued while active
 *  - Temp file cleanup on cancel
 *  - processQueue is re-entrant safe
 *  - broadcastQueueUpdate sends items array (not queue)
 *  - Completed items pruned after 30 min to avoid unbounded memory
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { broadcastQueueUpdate, broadcastComplete, broadcastError } = require('./websocket');
const { addHistory, getSettings } = require('./db');
const {
  downloadYouTubeVideo, downloadYouTubeVideoWithSubs, downloadYouTubeAudio, downloadYouTubePlaylist,
  downloadInstagramReel, downloadInstagramReelAudio, downloadInstagramPhoto,
  downloadInstagramCarouselAll, downloadInstagramCarouselFiltered,
  downloadInstagramCarouselSlide, downloadInstagramSlide, downloadInstagramSlideAudio,
  downloadGeneric, downloadStream, verifyFile
} = require('./downloader');

const fs = require('fs');

const queue = new Map();
let running = 0;
let draining = false;

const STATUSES = {
  QUEUED:      'queued',
  DOWNLOADING: 'downloading',
  VERIFYING:   'verifying',
  COMPLETE:    'complete',
  FAILED:      'failed',
  CANCELLED:   'cancelled'
};

// Prune old completed/cancelled after 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, item] of queue.entries()) {
    if ((item.status === STATUSES.COMPLETE || item.status === STATUSES.CANCELLED) &&
        item.completedAt && item.completedAt < cutoff) {
      queue.delete(id);
    }
  }
}, 5 * 60 * 1000);

function cfg() {
  const s = getSettings();
  return {
    maxConcurrent: Math.max(
      s.youtube?.concurrentDownloads   || 2,
      s.instagram?.concurrentDownloads || 2,
      s.generic?.concurrentDownloads   || 2
    ),
    retries: {
      youtube:   s.youtube?.retryCount   || 3,
      instagram: s.instagram?.retryCount || 3,
      generic:   s.generic?.retryCount   || 2
    }
  };
}

function serialize(item) {
  return {
    id: item.id, url: item.url, title: item.title,
    platform: item.platform, action: item.action,
    status: item.status, progress: item.progress,
    error: item.error, addedAt: item.addedAt,
    startedAt: item.startedAt, completedAt: item.completedAt,
    file: item.file, folder: item.folder,
    retryCount: item.retryCount, priority: item.priority, options: item.options
  };
}

function broadcast() {
  broadcastQueueUpdate(Array.from(queue.values()).map(serialize));
}

function initQueue() { console.log('[Queue] Initialized'); }

function addToQueue(params) {
  // Dedup: same url+action already active?
  for (const item of queue.values()) {
    if (item.url === params.url && item.action === params.action &&
        (item.status === STATUSES.QUEUED || item.status === STATUSES.DOWNLOADING)) {
      console.log(`[Queue] Dedup: ${params.action} ${params.url}`);
      return item.id;
    }
  }

  const c  = cfg();
  const id = uuidv4();
  queue.set(id, {
    id,
    url:         params.url,
    title:       params.title || 'Loading...',
    platform:    params.platform,
    action:      params.action,
    options:     params.options || {},
    status:      STATUSES.QUEUED,
    progress:    { percent: 0, speed: null, eta: null, totalSize: null },
    error:       null,
    addedAt:     Date.now(),
    startedAt:   null,
    completedAt: null,
    file:        null,
    folder:      null,
    retryCount:  0,
    maxRetries:  params.maxRetries ?? (c.retries[params.platform] || 2),
    priority:    params.priority || 0,
    cancelled:   false,
    proc:        null,
    tempFiles:   []
  });

  broadcast();
  setImmediate(drain);
  return id;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    const c = cfg();
    while (running < c.maxConcurrent) {
      const next = Array.from(queue.values())
        .filter(i => i.status === STATUSES.QUEUED)
        .sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt)[0];
      if (!next) break;

      next.status    = STATUSES.DOWNLOADING;
      next.startedAt = Date.now();
      running++;
      broadcast();

      runItem(next).finally(() => {
        running = Math.max(0, running - 1);
        broadcast();
        setImmediate(drain);
      });
    }
  } finally {
    draining = false;
  }
}

async function runItem(item) {
  try {
    const result = await executeDownload(item);

    if (item.cancelled) {
      item.status = STATUSES.CANCELLED; item.completedAt = Date.now();
      cleanTempFiles(item); return;
    }

    item.status = STATUSES.VERIFYING; broadcast();
    const v = result.file ? await verifyFile(result.file) : { ok: true };

    item.status      = STATUSES.COMPLETE;
    item.completedAt = Date.now();
    item.file        = result.file   || null;
    item.folder      = result.folder || null;
    item.verified    = v.ok;
    item.progress    = { ...item.progress, percent: 100 };

    addHistory({
      id: item.id, url: item.url, title: item.title,
      platform: item.platform, action: item.action,
      file: item.file, folder: item.folder,
      size: v.size || null, status: 'complete',
      verified: v.ok, downloadedAt: Date.now()
    });

    broadcastComplete(item.id, { file: item.file, folder: item.folder, verified: v.ok });

  } catch (err) {
    if (item.cancelled) {
      item.status = STATUSES.CANCELLED; item.completedAt = Date.now();
      cleanTempFiles(item); return;
    }
    if (item.retryCount < item.maxRetries) {
      item.retryCount++;
      item.status = STATUSES.QUEUED;
      item.error  = `Retry ${item.retryCount}/${item.maxRetries}: ${err.message.slice(0, 120)}`;
      item.proc   = null;
      console.warn(`[Queue] Retry ${item.retryCount} for ${item.id}`);
    } else {
      item.status      = STATUSES.FAILED;
      item.completedAt = Date.now();
      item.error       = err.message.slice(0, 300);
      broadcastError(item.id, item.error);
    }
  }
}

function cleanTempFiles(item) {
  for (const f of (item.tempFiles || [])) {
    try {
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (st.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
      else fs.unlinkSync(f);
    } catch {}
  }
  item.tempFiles = [];
}

async function executeDownload(item) {
  const { url, platform, action, options, id } = item;

  if (platform === 'youtube') {
    if (action === 'download_video')           return downloadYouTubeVideo(url, options, id, item);
    if (action === 'download_video_subs' || action === 'download_video_subtitles')
      return downloadYouTubeVideoWithSubs(url, { ...options, subsOnly: false }, id, item);
    if (action === 'download_subs_only')       return downloadYouTubeVideoWithSubs(url, { ...options, subsOnly: true }, id, item);
    if (action === 'download_audio')           return downloadYouTubeAudio(url, options, id, item);
    if (action.startsWith('download_playlist'))
      return downloadYouTubePlaylist(url, { ...options, audioOnly: action.includes('audio'), subtitles: action.includes('subtitle') }, id, item);
  }

  if (platform === 'instagram') {
    if (action === 'download_reel')            return downloadInstagramReel(url, options, id, item);
    if (action === 'download_story')           return downloadInstagramReel(url, options, id, item);
    if (action === 'download_reel_audio' || action === 'download_story_audio')
      return downloadInstagramReelAudio(url, options, id, item);
    if (action === 'download_photo')           return downloadInstagramPhoto(url, options, id, item);
    if (action === 'download_video')           return downloadInstagramReel(url, options, id, item);
    if (action === 'download_audio')           return downloadInstagramReelAudio(url, options, id, item);
    if (action === 'download_all_slides')      return downloadInstagramCarouselAll(url, options, id, item);
    if (action === 'download_photos_only') {
      const idx = (options.slides || []).filter(s => s.mediaType === 'photo').map(s => s.index + 1).join(',');
      if (!idx) throw new Error('No photo slides');
      return downloadInstagramCarouselFiltered(url, idx, options, id, item);
    }
    if (action === 'download_videos_only') {
      const idx = (options.slides || []).filter(s => s.mediaType === 'video').map(s => s.index + 1).join(',');
      if (!idx) throw new Error('No video slides');
      return downloadInstagramCarouselFiltered(url, idx, options, id, item);
    }
    if (action === 'download_slide') {
      const slideObj = options.slide || { index: options.slideIndex || 0 };
      return downloadInstagramSlide(url, slideObj, options, id, item);
    }
    if (action === 'download_slide_audio') {
      const slideObj = options.slide || { index: options.slideIndex || 0 };
      return downloadInstagramSlideAudio(url, slideObj, options, id, item);
    }
    if (action === 'download_current_slide' || action === 'download_selected_slide')
      return downloadInstagramCarouselSlide(url, options.slideIndex || 0, options, id, item);
  }

  if (action === 'download_stream') return downloadStream(url, options, id, item);

  return downloadGeneric(url, options, id, item);
}

function getQueue()  { return Array.from(queue.values()).map(serialize); }
function getItem(id) { const i = queue.get(id); return i ? serialize(i) : null; }

function cancelDownload(id) {
  const item = queue.get(id);
  if (!item) return false;
  item.cancelled = true;

  if (item.status === STATUSES.QUEUED) {
    item.status = STATUSES.CANCELLED; item.completedAt = Date.now();
    broadcast(); return true;
  }

  if (item.proc) {
    const proc = item.proc;
    if (process.platform === 'win32') {
      try { require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    } else {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }
    item.proc = null;
  }
  broadcast(); return true;
}

function removeFromQueue(id) {
  cancelDownload(id);
  setTimeout(() => { queue.delete(id); broadcast(); }, 250);
}

function retryDownload(id) {
  const item = queue.get(id);
  if (!item || (item.status !== STATUSES.FAILED && item.status !== STATUSES.CANCELLED)) return false;
  item.status = STATUSES.QUEUED; item.cancelled = false; item.error = null;
  item.retryCount = 0; item.proc = null; item.progress = { percent: 0 };
  item.completedAt = null;
  broadcast(); setImmediate(drain); return true;
}

function setPriority(id, priority) {
  const item = queue.get(id);
  if (!item) return false;
  item.priority = priority; broadcast(); return true;
}

function clearCompleted() {
  for (const [id, item] of queue.entries()) {
    if (item.status === STATUSES.COMPLETE || item.status === STATUSES.CANCELLED) queue.delete(id);
  }
  broadcast();
}

module.exports = {
  initQueue, addToQueue, getQueue, getItem,
  cancelDownload, removeFromQueue, retryDownload,
  setPriority, clearCompleted, STATUSES
};
