/**
 * popup.js — GrabIt popup logic.
 *
 * - Probes current tab on open (Stage 1 instantly, Stage 2 async)
 * - Routes to correct panel based on platform
 * - Real-time queue updates via WebSocket
 * - Settings management
 */

const SERVER = 'http://127.0.0.1:7272';
const WS_URL = 'ws://127.0.0.1:7272';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  serverOnline: false,
  activeTab: 'youtube',
  activeSettingsTab: 'youtube',
  currentTabId: null,
  currentUrl: '',
  ytProbe: null,
  igProbe: null,
  genProbe: null,
  queue: [],
  history: [],
  settings: {},
  downloadIds: {}, // url -> download id
  ws: null,
  wsRetry: null,
  selectedQuality: 'best',
  selectedAudioFmt: 'mp3',
  igSelectedSlide: null // override for "Download Selected Slide"
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SERVER}${path}`, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ` ${type}` : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = ''; }, 2800);
}

function icon(name, size = 14) {
  const icons = {
    download: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`,
    video: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>`,
    audio: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>`,
    photo: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`,
    playlist: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h10M4 18h10"/></svg>`,
    folder: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`,
    file: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
    retry: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`,
    x: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`,
    check: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
    subs: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/></svg>`,
    slides: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"/></svg>`,
    history: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    link: `<svg width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.101 1.102"/></svg>`
  };
  return icons[name] || '';
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
  return (bytes / 1073741824).toFixed(2) + 'GB';
}

function fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return Math.floor(diff/86400000) + 'd ago';
}

// ── Server health ─────────────────────────────────────────────────────────────
async function checkServer() {
  try {
    const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    setServerStatus(data.ok);
    return data.ok;
  } catch {
    setServerStatus(false);
    return false;
  }
}

function setServerStatus(online) {
  state.serverOnline = online;
  const dot = document.getElementById('server-dot');
  const label = document.getElementById('server-label');
  dot.className = online ? 'online' : 'offline';
  label.textContent = online ? 'online' : 'offline';
  label.style.color = online ? 'var(--green)' : 'var(--red)';
}

// ── WebSocket for real-time updates ──────────────────────────────────────────
function connectWS() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  try {
    state.ws = new WebSocket(WS_URL);
    state.ws.onopen = () => { clearTimeout(state.wsRetry); };
    state.ws.onmessage = (e) => {
      try { handleWSMessage(JSON.parse(e.data)); } catch {}
    };
    state.ws.onclose = () => {
      state.wsRetry = setTimeout(connectWS, 3000);
    };
    state.ws.onerror = () => state.ws.close();
  } catch {
    state.wsRetry = setTimeout(connectWS, 5000);
  }
}

function handleWSMessage(msg) {
  if (msg.type === 'queue_update') {
    state.queue = msg.queue || [];
    renderQueue();
    updateQueueBadge();
  }
  if (msg.type === 'download_progress') {
    updateQueueItemProgress(msg.id, msg.progress);
  }
  if (msg.type === 'download_complete') {
    toast('Download complete!', 'success');
    loadHistory();
  }
  if (msg.type === 'download_error') {
    toast('Download failed: ' + (msg.error || ''), 'error');
  }
  if (msg.type === 'slide_update') {
    // Slide DOM tracking removed — slide selection is user-driven via the slide grid
  }
  if (msg.type === 'playlist_progress') {
    updatePlaylistProgress(msg);
  }
  if (msg.type === 'streams_updated') {
    if (state.activeTab === 'streams') loadStreams();
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));

  if (tab === 'queue')    loadQueue();
  if (tab === 'history')  loadHistory();
  if (tab === 'settings') loadSettings();
  if (tab === 'streams')  loadStreams();
}

// ── Current tab detection ─────────────────────────────────────────────────────
async function detectCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  state.currentTabId = tab.id;
  state.currentUrl = tab.url || '';

  if (!state.serverOnline) return;

  // Determine which platform panel to auto-focus
  const url = state.currentUrl;
  const isYT = /youtube\.com|youtu\.be/.test(url);
  const isIG = /instagram\.com/.test(url);

  if (isYT) {
    switchTab('youtube');
    probeYT(url);
  } else if (isIG) {
    switchTab('instagram');
    renderIG(url);
  } else {
    switchTab('generic');
    probeGeneric(url);
  }
}

// ── YouTube probing ───────────────────────────────────────────────────────────
async function probeYT(url) {
  const settings = state.settings?.app || {};

  // Show loading skeleton
  document.getElementById('yt-loading').style.display = 'block';
  document.getElementById('yt-content').innerHTML = '';

  // Stage 1: instant
  try {
    const quick = await api('GET', `/probe/quick?url=${encodeURIComponent(url)}`);
    renderYTQuick(quick, url);
  } catch {}

  // Stage 2: deep probe
  try {
    const deep = await api('POST', '/probe/deep', { url, tabId: state.currentTabId });
    state.ytProbe = deep;
    document.getElementById('yt-loading').style.display = 'none';
    renderYTFull(deep, url);
  } catch (e) {
    document.getElementById('yt-loading').style.display = 'none';
    document.getElementById('yt-content').innerHTML = `
      <div class="empty"><p style="color:var(--red)">Probe failed: ${e.message}</p></div>`;
  }
}

// ── YouTube render — Stage 1 (instant placeholder) ────────────────────────────

function renderYTQuick(quick, url) {
  const typeLabel = {
    video:'Video', short:'Short', live:'Live', music:'Music',
    playlist:'Playlist', mix_playlist:'Mix Playlist'
  }[quick.contentType] || quick.contentType || 'Video';

  document.getElementById('yt-content').innerHTML = `
    <div class="media-card">
      <div class="media-card-inner">
        <div class="thumb-wrap thumb-placeholder">${icon('video', 28)}</div>
        <div class="media-meta">
          <div class="media-title" style="color:var(--text3)">Loading…</div>
          <div class="media-sub">
            <span class="pill yt">YouTube</span>
            <span class="pill">${typeLabel}</span>
          </div>
        </div>
      </div>
    </div>
    <div style="padding:14px 10px;color:var(--text3);font-size:12px;text-align:center">Fetching metadata…</div>`;
}

// ── YouTube render — Stage 2 (full probe result) ──────────────────────────────

function renderYTFull(probe, url) {
  const isPlaylist = probe.contentType === 'playlist' || probe.contentType === 'mix_playlist';
  const isLive     = probe.contentType === 'live';
  const ageWarn    = probe.ageLimit >= 18 ? `<span class="pill" style="background:#b91c1c">18+</span>` : '';
  const liveLabel  = isLive ? `<span class="pill" style="background:#dc2626;color:#fff">🔴 LIVE</span>` : '';

  // Format upload date nicely: yt-dlp gives "YYYYMMDD"
  let dateStr = '';
  if (probe.uploadDate && !isLive) {
    const d = probe.uploadDate.toString();
    if (d.length === 8) dateStr = `<span class="pill">${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}</span>`;
  }

  const viewStr = probe.viewCount
    ? `<span class="pill">${fmtCount(probe.viewCount)} views</span>` : '';

  document.getElementById('yt-content').innerHTML = `
    <div class="media-card">
      <div class="media-card-inner">
        <div class="thumb-wrap">
          ${probe.thumbnail ? `<img src="${probe.thumbnail}" alt="" loading="lazy">` : icon('video', 28)}
        </div>
        <div class="media-meta">
          <div class="media-title" title="${escHtml(probe.title || '')}">${escHtml(probe.title || 'YouTube Media')}</div>
          <div class="media-sub">
            <span class="pill yt">YouTube</span>
            ${liveLabel}
            ${ageWarn}
            ${probe.duration ? `<span class="pill">${fmtDuration(probe.duration)}</span>` : ''}
            ${isPlaylist ? `<span class="pill blue">${probe.itemCount ?? '?'} videos</span>` : ''}
            ${dateStr}
            ${viewStr}
          </div>
          ${probe.uploader ? `<div style="font-size:11px;color:var(--text3);margin-top:3px">📺 ${escHtml(probe.uploader)}</div>` : ''}
        </div>
      </div>
    </div>
    <div id="yt-actions">
      ${isPlaylist ? renderYTPlaylistUI(probe) : renderYTVideoTabs(probe)}
    </div>`;

  if (isPlaylist) wireYTPlaylist(probe, url);
  else            wireYTTabs(probe, url);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtCount(n) {
  if (!n) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ── YouTube tab bar (Video / Video+Subs / Audio) ──────────────────────────────

function renderYTVideoTabs(probe) {
  const subInfo = probe.subtitleInfo || {};
  const hasSubs = subInfo.hasSubtitles || probe.hasSubtitles;
  const langCount = (subInfo.languages || probe.subtitleLangs || []).length;

  return `
    <div class="yt-tab-bar">
      <button class="yt-tab active" data-yttab="video">📹 Video</button>
      <button class="yt-tab${hasSubs ? '' : ' yt-tab-disabled'}" data-yttab="subs"
        ${hasSubs ? '' : 'disabled title="No subtitles available"'}>
        🎬 Video+Subs${langCount ? ` <span style="font-size:10px;opacity:.7">(${langCount})</span>` : ''}
      </button>
      <button class="yt-tab" data-yttab="audio">🎵 Audio</button>
    </div>
    <div class="yt-tab-panel" id="yt-panel-video">${renderYTVideoPanel(probe)}</div>
    <div class="yt-tab-panel" id="yt-panel-subs" style="display:none">${renderYTSubsPanel(probe)}</div>
    <div class="yt-tab-panel" id="yt-panel-audio" style="display:none">${renderYTAudioPanel(probe)}</div>`;
}

// ── Video panel ───────────────────────────────────────────────────────────────

function renderYTVideoPanel(probe) {
  const fmts = (probe.videoFormats || []).filter(f => !f.isRecommended);
  const rec  = (probe.videoFormats || []).find(f => f.isRecommended);
  if (!fmts.length && !rec) return '<div style="padding:10px;color:var(--text3);font-size:12px">No video formats detected</div>';

  const rows = [...fmts.map((f, i) => videoRow(f, i)), rec ? videoRow(rec, fmts.length) : ''].join('');
  return `
    <div class="yt-quality-label">Select quality — merged video+audio:</div>
    <div class="yt-quality-list">${rows}</div>`;
}

function videoRow(f, idx) {
  const badgeHtml = (f.badges || []).map(b =>
    `<span style="font-size:9px;background:#7c3aed;color:#fff;border-radius:3px;padding:1px 4px;margin-left:3px">${b}</span>`
  ).join('');

  const meta = [
    f.codec  ? `<span style="color:var(--text3);font-size:10px">${f.codec}</span>` : '',
    f.fps    ? `<span style="color:var(--text3);font-size:10px">${f.fps}fps</span>` : '',
    f.bitrate? `<span style="color:var(--text3);font-size:10px">${f.bitrate}kbps</span>` : '',
  ].filter(Boolean).join(' · ');

  return `<button class="yt-quality-row${f.isRecommended ? ' yt-q-star' : ''}${!f.available ? ' yt-q-disabled' : ''}"
    ${f.available ? `data-yt-action="download_video" data-quality="${f.isRecommended ? 'recommended' : (f.height || 'best')}"` : 'disabled'}>
    <span class="yt-q-idx">[${idx}]</span>
    <span class="yt-q-label">
      ${f.label}${f.isRecommended ? ' ⭐' : ''}${badgeHtml}
      ${meta ? `<br><span style="font-weight:400">${meta}</span>` : ''}
    </span>
    <span class="yt-q-size">${f.available ? (fmtSize(f.size) || '?') : 'N/A'}</span>
  </button>`;
}

// ── Video+Subs panel ──────────────────────────────────────────────────────────

function renderYTSubsPanel(probe) {
  const subInfo = probe.subtitleInfo || {};
  const hasSubs = subInfo.hasSubtitles || probe.hasSubtitles;

  if (!hasSubs) return `<div style="padding:14px 10px;color:var(--text3);font-size:12px;text-align:center">
    No subtitles or captions are available for this video.<br>Use the Video tab instead.</div>`;

  const langs = subInfo.languages || [];
  const fmts  = (probe.videoSubFormats || probe.videoFormats || []).filter(f => !f.isRecommended);

  // Language selector section
  const langRows = langs.length ? `
    <div class="yt-quality-label" style="margin-top:8px">Available subtitle tracks:</div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 0 8px">
      ${langs.map(l => `
        <span style="font-size:11px;background:var(--surface2);border-radius:4px;padding:2px 7px;border:1px solid var(--border)">
          ${escHtml(l.name || l.code)}
          <span style="font-size:9px;opacity:.6">${l.isAuto ? 'auto' : 'manual'}</span>
        </span>`).join('')}
    </div>` : '';

  const vidRows = fmts.map((f, i) => `
    <button class="yt-quality-row${!f.available ? ' yt-q-disabled' : ''}"
      ${f.available ? `data-yt-action="download_video_subs" data-quality="${f.height || 'best'}"` : 'disabled'}>
      <span class="yt-q-idx">[${i}]</span>
      <span class="yt-q-label">${f.label} + Subtitles</span>
      <span class="yt-q-size">${f.available ? (fmtSize(f.size) || '?') : 'N/A'}</span>
    </button>`).join('');

  const subsOnlyRow = `
    <button class="yt-quality-row yt-q-special" data-yt-action="download_subs_only" data-quality="best">
      <span class="yt-q-idx">[${fmts.length}]</span>
      <span class="yt-q-label">Subtitles Only</span>
      <span class="yt-q-size">${langs.length} lang${langs.length !== 1 ? 's' : ''}</span>
    </button>`;

  return `
    ${langRows}
    <div class="yt-quality-label">Video quality + embedded subtitles:</div>
    <div class="yt-quality-list">${vidRows}${subsOnlyRow}</div>`;
}

// ── Audio panel ───────────────────────────────────────────────────────────────

function renderYTAudioPanel(probe) {
  const fmts = probe.audioFormats || _defaultAudioFmts();

  const rows = fmts.map(f => {
    const directTag = f.isDirect
      ? `<span style="font-size:9px;background:#065f46;color:#d1fae5;border-radius:3px;padding:1px 4px;margin-left:4px">direct copy</span>` : '';
    const meta = [
      f.codec      ? `<span style="color:var(--text3);font-size:10px">${f.codec}</span>` : '',
      f.bitrate    ? `<span style="color:var(--text3);font-size:10px">${f.bitrate}kbps</span>` : '',
      f.sampleRate ? `<span style="color:var(--text3);font-size:10px">${(f.sampleRate/1000).toFixed(1)}kHz</span>` : '',
    ].filter(Boolean).join(' · ');

    return `<button class="yt-quality-row${f.star ? ' yt-q-star' : ''}" data-yt-action="download_audio" data-audiofmt="${f.fmt}">
      <span class="yt-q-label">
        ${f.label}${f.star ? ' ⭐' : ''}${directTag}
        ${meta ? `<br><span style="font-weight:400">${meta}</span>` : ''}
      </span>
      <span class="yt-q-size">${fmtSize(f.size)}</span>
    </button>`;
  }).join('');

  return `
    <div class="yt-quality-label">Audio format — extracted from video stream:</div>
    <div class="yt-quality-list">${rows}</div>`;
}

function _defaultAudioFmts() {
  return ['mp3','m4a','aac','opus','flac','wav','ogg'].map((fmt, i) => ({
    fmt, label: {mp3:'MP3',m4a:'M4A',aac:'AAC',opus:'Opus',flac:'FLAC',wav:'WAV',ogg:'Ogg Vorbis'}[fmt],
    star: i === 0, size: null, isDirect: false, bitrate: null, codec: null, sampleRate: null
  }));
}

// ── Playlist panel ────────────────────────────────────────────────────────────

function renderYTPlaylistUI(probe) {
  const vt  = probe.videoTotals  || {};
  const at  = probe.audioTotals  || {};
  const cnt = probe.itemCount    ?? '?';
  const dur = probe.duration     ? `· ${fmtDuration(probe.duration)}` : '';

  const loading = `<span id="pl-loading-tag" style="font-size:10px;color:var(--text3)"> Calculating…</span>`;

  const videoRows = [
    { h: 720,  label: '📹 720p'  },
    { h: 1080, label: '📹 1080p' },
    { h: 480,  label: '📹 480p'  },
    { h: 2160, label: '📹 4K'    },
  ].map(({ h, label }) => `
    <button class="yt-quality-row" data-pl-action="download_playlist" data-quality="${h}">
      <span class="yt-q-label">${label}</span>
      <span class="yt-q-size" id="pl-v-${h}">${fmtSize(vt[h]) || '…'}</span>
    </button>`).join('');

  const audioRows = [
    { fmt: 'mp3',  label: '🎵 MP3'  },
    { fmt: 'm4a',  label: '🎵 M4A'  },
    { fmt: 'opus', label: '🎵 Opus' },
    { fmt: 'flac', label: '🎵 FLAC' },
  ].map(({ fmt, label }) => `
    <button class="yt-quality-row" data-pl-action="download_playlist_audio" data-audiofmt="${fmt}">
      <span class="yt-q-label">${label}</span>
      <span class="yt-q-size" id="pl-a-${fmt}">${fmtSize(at[fmt]) || '…'}</span>
    </button>`).join('');

  return `
    <div class="yt-quality-label">
      Playlist — ${cnt} videos ${dur}
      ${probe.enriching ? loading : ''}
    </div>
    <div style="font-size:11px;color:var(--text3);padding:2px 0 6px;font-weight:600">VIDEO</div>
    <div class="yt-quality-list">${videoRows}</div>
    <div style="font-size:11px;color:var(--text3);padding:8px 0 4px;font-weight:600">AUDIO ONLY</div>
    <div class="yt-quality-list">${audioRows}</div>
    <div id="pl-progress-bar" style="display:none;margin-top:8px">
      <div style="height:3px;background:var(--border);border-radius:2px">
        <div id="pl-progress-fill" style="height:3px;background:var(--accent);border-radius:2px;width:0%;transition:width .3s"></div>
      </div>
      <div id="pl-progress-label" style="font-size:10px;color:var(--text3);margin-top:3px;text-align:right"></div>
    </div>`;
}

/**
 * Called from handleWSMessage when a `playlist_progress` event arrives.
 * Updates the size cells and progress bar without re-rendering the whole panel.
 */
function updatePlaylistProgress(msg) {
  const vt = msg.videoTotals  || {};
  const at = msg.audioTotals  || {};

  for (const [h, bytes] of Object.entries(vt)) {
    const el = document.getElementById(`pl-v-${h}`);
    if (el && bytes > 0) el.textContent = fmtSize(bytes);
  }
  for (const [fmt, bytes] of Object.entries(at)) {
    const el = document.getElementById(`pl-a-${fmt}`);
    if (el && bytes > 0) el.textContent = fmtSize(bytes);
  }

  // Progress bar
  const bar   = document.getElementById('pl-progress-bar');
  const fill  = document.getElementById('pl-progress-fill');
  const label = document.getElementById('pl-progress-label');
  if (bar && msg.total > 0) {
    bar.style.display = msg.done ? 'none' : 'block';
    const pct = Math.round((msg.completed / msg.total) * 100);
    if (fill)  fill.style.width = pct + '%';
    if (label) label.textContent = msg.done
      ? ''
      : `Scanning ${msg.completed}/${msg.total} videos (${pct}%)…`;
  }

  // Remove loading tag once done
  if (msg.done) {
    const tag = document.getElementById('pl-loading-tag');
    if (tag) tag.remove();
  }

  // Update total duration if we have it now
  if (msg.totalDuration) {
    const probeDur = document.getElementById('pl-duration');
    if (probeDur) probeDur.textContent = fmtDuration(msg.totalDuration);
  }
}

// ── Wire-up ───────────────────────────────────────────────────────────────────

function wireYTTabs(probe, url) {
  document.querySelectorAll('.yt-tab:not([disabled])').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.yt-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['video', 'subs', 'audio'].forEach(n => {
        const p = document.getElementById(`yt-panel-${n}`);
        if (p) p.style.display = tab.dataset.yttab === n ? 'block' : 'none';
      });
    });
  });

  document.querySelectorAll('[data-yt-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.ytAction;
      const opts   = { quality: btn.dataset.quality, format: btn.dataset.audiofmt };
      startDownload({ url, action, platform: 'youtube', title: probe.title, options: opts });
    });
  });
}

function wireYTPlaylist(probe, url) {
  document.querySelectorAll('[data-pl-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      startDownload({
        url, action: btn.dataset.plAction, platform: 'youtube', title: probe.title,
        options: { quality: btn.dataset.quality || '720', format: btn.dataset.audiofmt || 'mp3' }
      });
    });
  });
}

// ── Web Stream Detection ──────────────────────────────────────────────────────

const TYPE_COLOURS = {
  HLS:  { bg: '#fef3c7', border: '#d97706', text: '#92400e' },
  DASH: { bg: '#ede9fe', border: '#7c3aed', text: '#4c1d95' },
  MP4:  { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  WebM: { bg: '#dbeafe', border: '#2563eb', text: '#1e3a8a' },
  MKV:  { bg: '#f0fdf4', border: '#15803d', text: '#14532d' },
  MOV:  { bg: '#fdf2f8', border: '#9d174d', text: '#500724' },
  TS:   { bg: '#fef9c3', border: '#ca8a04', text: '#713f12' },
  FLV:  { bg: '#fce7f3', border: '#db2777', text: '#831843' },
};

function typeBadge(type) {
  const s = TYPE_COLOURS[type] || { bg: '#f3f4f6', border: '#6b7280', text: '#111827' };
  return `<span style="font-size:10px;font-weight:700;background:${s.bg};color:${s.text};border:1px solid ${s.border};border-radius:4px;padding:1px 6px">${type}</span>`;
}

async function loadStreams() {
  const c = document.getElementById('streams-content');
  if (!c) return;
  c.innerHTML = '<div style="padding:14px;color:var(--text3);font-size:12px;text-align:center">Scanning page…</div>';

  let streams = [], tabId = null;
  try {
    const resp = await new Promise((res, rej) => {
      chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (r) => {
        if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
        else res(r);
      });
    });
    streams = resp?.streams || [];
    tabId   = resp?.tabId;
  } catch (e) {
    c.innerHTML = `<div style="padding:14px;color:var(--red);font-size:12px">Error: ${e.message}</div>`;
    return;
  }

  renderStreams(c, streams);
}

function renderStreams(container, streams) {
  if (!streams.length) {
    container.innerHTML = `
      <div style="padding:20px 16px;text-align:center">
        <div style="font-size:28px;margin-bottom:8px">📡</div>
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">No streams detected yet</div>
        <div style="color:var(--text3);font-size:12px;line-height:1.5">
          Play or hover over a video on this page,<br>then click 🔄 to refresh.
        </div>
      </div>`;
    return;
  }

  // Group by type
  const groups = {};
  for (const s of streams) {
    (groups[s.type] = groups[s.type] || []).push(s);
  }

  const TYPE_ORDER = ['HLS','DASH','MP4','WebM','MKV','MOV','FLV','TS','Stream'];
  const sorted     = TYPE_ORDER.filter(t => groups[t]);

  container.innerHTML = sorted.map(type => `
    <div class="yt-quality-label" style="margin-top:8px">${typeBadge(type)} ${type === 'HLS' ? 'HLS Streams (m3u8)' : type === 'DASH' ? 'DASH Streams (mpd)' : `${type} Files`} <span style="color:var(--text3)">(${groups[type].length})</span></div>
    <div class="yt-quality-list">
      ${groups[type].map((s, i) => streamRow(s, i)).join('')}
    </div>`).join('');

  // Bind download buttons
  container.querySelectorAll('[data-stream-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url  = btn.dataset.streamUrl;
      const type = btn.dataset.streamType;
      const name = btn.dataset.streamName;
      const qual = btn.dataset.quality || '';
      startDownload({
        url,
        action:   'download_stream',
        platform: 'generic',
        title:    name,
        options:  { streamType: type, name, quality: qual }
      });
      btn.textContent = '⏳';
      btn.disabled    = true;
    });
  });
}

function streamRow(s, idx) {
  // Shorten URL for display: show host + last path segment
  let display = s.url;
  try {
    const u = new URL(s.url);
    const seg = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
    display = u.hostname + (seg ? '/' + seg : '');
    if (display.length > 60) display = display.slice(0, 57) + '…';
  } catch {}

  const qualBadge = s.quality
    ? `<span style="font-size:10px;background:var(--surface2);border-radius:3px;padding:1px 5px;margin-left:4px">${s.quality}</span>` : '';

  const time = s.ts ? new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  return `<div class="yt-quality-row" style="flex-direction:column;align-items:flex-start;gap:3px;cursor:default;padding:8px 10px">
    <div style="display:flex;align-items:center;gap:6px;width:100%">
      ${typeBadge(s.type)}${qualBadge}
      <span style="font-size:11px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.name)}">${escHtml(s.name)}</span>
      <button class="btn btn-primary" style="font-size:11px;padding:3px 10px;white-space:nowrap"
        data-stream-url="${escHtml(s.url)}" data-stream-type="${s.type}" data-stream-name="${escHtml(s.name)}" data-quality="">
        ⬇ Download
      </button>
    </div>
    <div style="font-size:10px;color:var(--text3);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" title="${escHtml(s.url)}">${escHtml(display)}</div>
    ${time ? `<div style="font-size:10px;color:var(--text3)">Detected at ${time}</div>` : ''}
  </div>`;
}

// ── Instagram probing ─────────────────────────────────────────────────────────
/**
 * Instagram panel — no probe required.
 *
 * The URL is already known from the active tab. The user picks their
 * content type (Reel / Carousel-Photos) via two sub-tabs and hits
 * download directly. No gallery-dl probe, no cookie auth error blocking the UI.
 *
 * Reel tab:    Download Reel | Audio Only
 * Photos tab:  Download All Slides | Download Current Slide (by number input)
 *
 * If the user needs cookies they'll see the error only when download starts,
 * not before they can even see the UI.
 */

function renderIG(url) {
  const c   = document.getElementById('ig-content');
  const type = detectIGTypeFromUrl(url);  // 'reel' | 'carousel' | 'unknown'

  // Auto-select the right tab based on URL
  const defaultTab = type === 'reel' ? 'reel' : 'photos';

  const audioFmtOpts = ['mp3','aac','m4a','opus','flac','wav']
    .map(f => `<option value="${f}">${f.toUpperCase()}</option>`).join('');

  c.innerHTML = `
    <div class="ig-type-bar">
      <button class="ig-type-tab ${defaultTab === 'reel' ? 'active' : ''}" data-igtab="reel">
        🎬 Reel / Video
      </button>
      <button class="ig-type-tab ${defaultTab === 'photos' ? 'active' : ''}" data-igtab="photos">
        📷 Photos / Carousel
      </button>
    </div>

    <!-- Reel tab -->
    <div class="ig-tab-panel" id="ig-panel-reel" style="display:${defaultTab === 'reel' ? 'block' : 'none'}">
      <div class="ig-section-label">Download reel or video post</div>
      <div class="select-row" style="margin-top:6px">
        <label>Audio fmt</label>
        <select id="ig-reel-audio-fmt">${audioFmtOpts}</select>
      </div>
      <div class="actions" style="margin-top:8px">
        <button class="btn btn-primary" id="ig-dl-reel">
          ${icon('video')} <span class="btn-label">Download Reel</span>
        </button>
        <button class="btn btn-secondary" id="ig-dl-reel-audio">
          ${icon('audio')} <span class="btn-label">Audio Only</span>
        </button>
      </div>
    </div>

    <!-- Photos / Carousel tab -->
    <div class="ig-tab-panel" id="ig-panel-photos" style="display:${defaultTab === 'photos' ? 'block' : 'none'}">
      <div class="ig-section-label">Download photo post or carousel slides</div>
      <div class="ig-slide-row">
        <label class="ig-slide-label">Slide number</label>
        <div class="ig-slide-input-wrap">
          <button class="ig-slide-btn" id="ig-slide-dec">−</button>
          <input type="number" id="ig-slide-num" value="1" min="1" max="20" class="ig-slide-num-input">
          <button class="ig-slide-btn" id="ig-slide-inc">+</button>
        </div>
        <span class="ig-slide-hint">enter slide # to download one</span>
      </div>
      <div class="actions" style="margin-top:8px">
        <button class="btn btn-primary" id="ig-dl-all">
          ${icon('slides')} <span class="btn-label">Download All Slides</span>
        </button>
        <button class="btn btn-secondary" id="ig-dl-slide">
          ${icon('photo')} <span class="btn-label">Download Slide #<span id="ig-slide-preview">1</span></span>
        </button>
      </div>
    </div>

    <div class="ig-url-display" title="${url}">${url.replace('https://www.instagram.com/', 'instagram.com/')}</div>
  `;

  // Tab switching
  c.querySelectorAll('.ig-type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      c.querySelectorAll('.ig-type-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      ['reel', 'photos'].forEach(name => {
        const p = document.getElementById(`ig-panel-${name}`);
        if (p) p.style.display = tab.dataset.igtab === name ? 'block' : 'none';
      });
    });
  });

  // Slide number controls
  const slideInput   = document.getElementById('ig-slide-num');
  const slidePreview = document.getElementById('ig-slide-preview');
  const updatePreview = () => { if (slidePreview) slidePreview.textContent = slideInput?.value || '1'; };

  document.getElementById('ig-slide-dec')?.addEventListener('click', () => {
    const v = Math.max(1, parseInt(slideInput.value || 1) - 1);
    slideInput.value = v; updatePreview();
  });
  document.getElementById('ig-slide-inc')?.addEventListener('click', () => {
    const v = Math.min(20, parseInt(slideInput.value || 1) + 1);
    slideInput.value = v; updatePreview();
  });
  slideInput?.addEventListener('input', updatePreview);

  // Reel downloads
  document.getElementById('ig-dl-reel')?.addEventListener('click', () => {
    startDownload({ url, action: 'download_reel', platform: 'instagram',
      title: 'Instagram Reel', options: {} });
  });
  document.getElementById('ig-dl-reel-audio')?.addEventListener('click', () => {
    const fmt = document.getElementById('ig-reel-audio-fmt')?.value || 'mp3';
    startDownload({ url, action: 'download_reel_audio', platform: 'instagram',
      title: 'Instagram Reel Audio', options: { format: fmt } });
  });

  // Photo / carousel downloads
  document.getElementById('ig-dl-all')?.addEventListener('click', () => {
    // Extract a readable name from the URL path (e.g. "CxYzAbc1234" from /p/CxYzAbc1234/)
    const postId = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[2] || 'Carousel';
    startDownload({ url, action: 'download_all_slides', platform: 'instagram',
      title: `Carousel_${postId}`, options: {} });
  });
  document.getElementById('ig-dl-slide')?.addEventListener('click', () => {
    const slideNum = Math.max(1, parseInt(document.getElementById('ig-slide-num')?.value || 1));
    const slideObj = { index: slideNum - 1 };
    startDownload({ url, action: 'download_slide', platform: 'instagram',
      title: `Slide_${slideNum}`, options: { slide: slideObj, slideIndex: slideNum - 1 } });
  });
}

function detectIGTypeFromUrl(url) {
  if (/\/reel\/|\/reels\//i.test(url)) return 'reel';
  if (/\/p\//i.test(url)) return 'carousel';
  if (/\/stories\//i.test(url)) return 'reel';
  if (/\/tv\//i.test(url)) return 'reel';
  return 'unknown';
}

// Legacy stub — no longer used but kept to avoid reference errors
async function refreshIGSlideState() {}

// ── Generic probing ───────────────────────────────────────────────────────────
async function probeGeneric(url) {
  document.getElementById('gen-loading').style.display = 'block';
  document.getElementById('gen-content').innerHTML = '';

  if (!url || !/^https?:\/\//.test(url)) {
    document.getElementById('gen-loading').style.display = 'none';
    document.getElementById('gen-content').innerHTML =
      `<div class="empty">${icon('link', 32)}<p>Open a page with media to detect it</p></div>`;
    return;
  }

  try {
    const probe = await api('POST', '/probe/deep', { url, tabId: state.currentTabId });
    state.genProbe = probe;
    document.getElementById('gen-loading').style.display = 'none';
    renderGenericFull(probe, url);
  } catch (e) {
    document.getElementById('gen-loading').style.display = 'none';
    document.getElementById('gen-content').innerHTML =
      `<div class="empty"><p style="color:var(--text3)">No downloadable media found on this page.</p></div>`;
  }
}

function renderGenericFull(probe, url) {
  const c = document.getElementById('gen-content');
  if (probe.error) {
    c.innerHTML = `<div class="empty"><p style="color:var(--text3)">Could not extract media from this page.</p><p style="color:var(--text3);font-size:11px">${probe.error}</p></div>`;
    return;
  }

  const protocolLabel = { hls: 'HLS Stream (m3u8)', dash: 'DASH Stream', direct: 'Direct File', page: 'Web Page' }[probe.protocol] || '';
  const formats = probe.formats || [];
  const audioFormats = probe.audioFormats || [];

  c.innerHTML = `
    <div class="media-card">
      <div class="media-card-inner">
        <div class="thumb-wrap">${probe.thumbnail ? `<img src="${probe.thumbnail}" alt="">` : icon('video', 28)}</div>
        <div class="media-meta">
          <div class="media-title">${probe.title || new URL(url).hostname}</div>
          <div class="media-sub">
            <span class="pill">${new URL(url).hostname}</span>
            ${protocolLabel ? `<span class="pill blue">${protocolLabel}</span>` : ''}
            ${probe.duration ? `<span class="pill">${fmtDuration(probe.duration)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div id="gen-actions">
      ${formats.length ? renderGenericQualityList(formats) : `
        <div class="actions">
          <button class="btn btn-primary" id="gen-dl-video">${icon('video')} <span class="btn-label">Download Video</span></button>
          <button class="btn btn-secondary" id="gen-dl-audio">${icon('audio')} <span class="btn-label">Audio Only</span></button>
        </div>`}
      ${formats.length && audioFormats.length ? renderGenericAudioList(audioFormats) : ''}
    </div>`;

  const vBtn = document.getElementById('gen-dl-video');
  const aBtn = document.getElementById('gen-dl-audio');
  if (vBtn) vBtn.onclick = () => startDownload({ url, action: 'download_video', platform: 'generic', title: probe.title });
  if (aBtn) aBtn.onclick = () => startDownload({ url, action: 'download_video', platform: 'generic', title: probe.title, options: { audioOnly: true } });

  document.querySelectorAll('[data-gen-quality]').forEach(btn => {
    btn.addEventListener('click', () => {
      startDownload({
        url, action: 'download_video', platform: 'generic', title: probe.title,
        options: { quality: btn.dataset.genQuality, formatId: btn.dataset.formatId || undefined }
      });
    });
  });
  document.querySelectorAll('[data-gen-audiofmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      startDownload({
        url, action: 'download_video', platform: 'generic', title: probe.title,
        options: { audioOnly: true, format: btn.dataset.genAudiofmt }
      });
    });
  });
}

function renderGenericQualityList(formats) {
  return `
    <div class="yt-quality-label">Select quality:</div>
    <div class="yt-quality-list">
      ${formats.map((f, i) => `
        <button class="yt-quality-row" data-gen-quality="${f.height || 'best'}" data-format-id="${f.format_id || ''}">
          <span class="yt-q-idx">[${i}]</span>
          <span class="yt-q-label">${f.label}</span>
          <span class="yt-q-size">${fmtSize(f.size)}</span>
        </button>`).join('')}
    </div>`;
}

function renderGenericAudioList(audioFormats) {
  return `
    <div class="yt-quality-label" style="margin-top:8px">Audio only:</div>
    <div class="yt-quality-list">
      ${audioFormats.map(f => `
        <button class="yt-quality-row${f.star ? ' yt-q-star' : ''}" data-gen-audiofmt="${f.fmt}">
          <span class="yt-q-label">${f.label}${f.star ? ' ⭐' : ''}</span>
          <span class="yt-q-size">${fmtSize(f.size)}</span>
        </button>`).join('')}
    </div>`;
}

// ── URL input mode ────────────────────────────────────────────────────────────
function initURLInputMode() {
  const setupPanel = (panelId, inputId, goId, probeFn) => {
    const go = document.getElementById(goId);
    const input = document.getElementById(inputId);
    if (!go || !input) return;
    go.addEventListener('click', () => {
      const url = input.value.trim();
      if (url) probeFn(url);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const url = input.value.trim(); if (url) probeFn(url); }
    });
  };

  setupPanel('youtube', 'yt-url-input', 'yt-url-go', (u) => probeYT(u));
  setupPanel('instagram', 'ig-url-input', 'ig-url-go', (u) => renderIG(u));
  setupPanel('generic', 'gen-url-input', 'gen-url-go', (u) => probeGeneric(u));
}

function applyURLInputMode(enabled) {
  ['yt-url-input-wrap', 'ig-url-input-wrap', 'gen-url-input-wrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = enabled ? 'flex' : 'none';
  });
}

// ── Download ──────────────────────────────────────────────────────────────────
async function startDownload({ url, action, platform, title, options = {}, priority = 0 }) {
  if (!state.serverOnline) { toast('Server offline', 'error'); return; }
  try {
    const result = await api('POST', '/download/start', { url, action, platform, title, options, priority });
    state.downloadIds[url] = result.id;
    toast('Added to queue');
    switchTab('queue');
    loadQueue();
  } catch (e) {
    toast('Failed to queue: ' + e.message, 'error');
  }
}

// ── Queue rendering ───────────────────────────────────────────────────────────
async function loadQueue() {
  try {
    state.queue = await api('GET', '/queue');
    renderQueue();
    updateQueueBadge();
  } catch {}
}

function updateQueueBadge() {
  const active = state.queue.filter(i => i.status === 'queued' || i.status === 'downloading').length;
  const badge = document.getElementById('queue-count');
  badge.textContent = active;
  badge.style.display = active > 0 ? 'inline-flex' : 'none';
}

function updateQueueItemProgress(id, progress) {
  const bar = document.querySelector(`[data-qid="${id}"] .progress-bar`);
  const meta = document.querySelector(`[data-qid="${id}"] .qi-speed`);
  if (bar && progress) {
    bar.style.width = `${progress.percent || 0}%`;
  }
  if (meta && progress) {
    meta.textContent = [progress.speed, progress.eta ? `ETA ${progress.eta}` : '', progress.totalSize].filter(Boolean).join(' · ');
  }
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!list) return;

  const items = state.queue;
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">${icon('download', 36)}<p>No downloads yet</p></div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const statusClass = item.status;
    const pct = item.progress?.percent || 0;
    const isActive = item.status === 'downloading';
    const isDone = item.status === 'complete';
    const isFailed = item.status === 'failed';

    return `<div class="queue-item" data-qid="${item.id}">
      <div class="qi-header">
        <div class="qi-title" title="${item.title || item.url}">${item.title || item.url}</div>
        <div class="qi-status ${statusClass}">${
          isActive ? `<div class="spinner" style="width:12px;height:12px;border-width:1.5px"></div>` : ''
        } ${item.status}</div>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar ${isDone ? 'complete' : ''}" style="width:${isDone ? 100 : pct}%"></div>
      </div>
      <div class="qi-meta">
        <span class="qi-speed">${[item.progress?.speed, item.progress?.eta ? `ETA ${item.progress.eta}` : ''].filter(Boolean).join(' · ')}</span>
        <span>${item.progress?.totalSize || ''}</span>
      </div>
      ${item.error ? `<div style="font-size:11px;color:var(--red);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.error}">${item.error}</div>` : ''}
      <div class="qi-actions">
        ${isFailed || item.status === 'cancelled' ? `<button class="qi-btn success" data-qaction="retry" data-id="${item.id}">${icon('retry', 12)} Retry</button>` : ''}
        ${isDone && item.file ? `<button class="qi-btn" data-qaction="open-file" data-file="${item.file}">Open File</button>` : ''}
        ${isDone && item.folder ? `<button class="qi-btn" data-qaction="open-folder" data-folder="${item.folder}">Open Folder</button>` : ''}
        ${isDone && item.file && !item.folder ? `<button class="qi-btn" data-qaction="open-folder" data-file="${item.file}">Open Folder</button>` : ''}
        ${!isDone && !isFailed ? `<button class="qi-btn danger" data-qaction="cancel" data-id="${item.id}">${icon('x', 11)} Cancel</button>` : ''}
        ${isDone || isFailed ? `<button class="qi-btn danger" data-qaction="remove" data-id="${item.id}">${icon('x', 11)}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  // Wire queue actions
  list.querySelectorAll('[data-qaction]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.qaction;
      const id = btn.dataset.id;
      if (action === 'cancel') { await api('POST', `/queue/${id}/cancel`); }
      if (action === 'retry') { await api('POST', `/queue/${id}/retry`); }
      if (action === 'remove') { await api('DELETE', `/queue/${id}`); }
      if (action === 'open-file') { await api('POST', '/download/open-file', { filePath: btn.dataset.file }); }
      if (action === 'open-folder') { await api('POST', '/download/open-folder', { folderPath: btn.dataset.folder, filePath: btn.dataset.file }); }
      loadQueue();
    });
  });

  // Clear completed
  document.getElementById('clear-completed-btn').onclick = async () => {
    await api('POST', '/queue/clear-completed');
    loadQueue();
  };
}

// ── History rendering ─────────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const q = document.getElementById('hist-search')?.value || '';
    state.history = await api('GET', `/history${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    renderHistory();
  } catch {}
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (state.history.length === 0) {
    list.innerHTML = `<div class="empty">${icon('history', 36)}<p>No downloads yet</p></div>`;
    return;
  }

  list.innerHTML = state.history.slice(0, 80).map(item => {
    const typeIcon = item.platform === 'youtube' ? icon('video', 14) :
                     item.platform === 'instagram' ? icon('photo', 14) : icon('file', 14);
    return `<div class="hist-item">
      <div class="hist-icon">${typeIcon}</div>
      <div class="hist-body">
        <div class="hist-title" title="${item.title || item.url}">${item.title || item.url}</div>
        <div class="hist-meta">
          <span class="pill ${item.platform === 'youtube' ? 'yt' : item.platform === 'instagram' ? 'ig' : ''}" style="padding:1px 4px">${item.platform}</span>
          <span>${timeAgo(item.downloadedAt || item.addedAt)}</span>
          ${item.size ? `<span>${fmtSize(item.size)}</span>` : ''}
          ${item.verified === true ? `<span class="verified-badge">${icon('check', 11)} ok</span>` :
            item.verified === false ? `<span class="failed-badge">verify failed</span>` : ''}
        </div>
      </div>
      <div class="hist-actions">
        ${item.file ? `<button class="hist-btn" data-haction="open-file" data-file="${item.file}" title="Open file">▶</button>` : ''}
        <button class="hist-btn" data-haction="redownload" data-id="${item.id}" title="Re-download">↩</button>
        <button class="hist-btn" data-haction="copy-url" data-url="${item.url}" title="Copy URL">${icon('link', 11)}</button>
        <button class="hist-btn" data-haction="delete" data-id="${item.id}" title="Remove">×</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-haction]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.haction;
      if (action === 'open-file') await api('POST', '/download/open-file', { filePath: btn.dataset.file });
      if (action === 'redownload') { await api('POST', `/history/${btn.dataset.id}/redownload`); switchTab('queue'); loadQueue(); }
      if (action === 'copy-url') { await navigator.clipboard.writeText(btn.dataset.url); toast('URL copied'); }
      if (action === 'delete') { await api('DELETE', `/history/${btn.dataset.id}`); loadHistory(); }
    });
  });

  document.getElementById('clear-hist-btn').onclick = async () => {
    if (!confirm('Clear all history?')) return;
    await api('DELETE', '/history/all');
    loadHistory();
  };

  document.getElementById('hist-search').addEventListener('input', () => {
    clearTimeout(document.getElementById('hist-search')._timer);
    document.getElementById('hist-search')._timer = setTimeout(loadHistory, 200);
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    state.settings = await api('GET', '/settings');
    renderSettings();
  } catch {}
}

function renderSettings() {
  const c = document.getElementById('settings-content');
  const s = state.settings;
  const tab = state.activeSettingsTab;

  let html = '';

  if (tab === 'youtube') {
    const yt = s.youtube || {};
    html = `
      <div class="settings-section">
        <div class="settings-section-title">Download Location</div>
        <div class="folder-row">
          <input class="settings-input" data-section="youtube" data-key="downloadFolder" value="${yt.downloadFolder || ''}">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Quality</div>
        <div class="settings-row">
          <div class="settings-label">Default quality</div>
          <select class="settings-select" data-section="youtube" data-key="defaultQuality">
            <option value="best" ${yt.defaultQuality === 'best' ? 'selected' : ''}>Best</option>
            <option value="2160" ${yt.defaultQuality === '2160' ? 'selected' : ''}>4K</option>
            <option value="1440" ${yt.defaultQuality === '1440' ? 'selected' : ''}>1440p</option>
            <option value="1080" ${yt.defaultQuality === '1080' ? 'selected' : ''}>1080p</option>
            <option value="720" ${yt.defaultQuality === '720' ? 'selected' : ''}>720p</option>
            <option value="480" ${yt.defaultQuality === '480' ? 'selected' : ''}>480p</option>
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Audio format</div>
          <select class="settings-select" data-section="youtube" data-key="preferredAudioFormat">
            ${['mp3','aac','flac','wav','opus','m4a'].map(f => `<option value="${f}" ${yt.preferredAudioFormat === f ? 'selected':''}>${f.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Subtitles</div>
        <div class="settings-row">
          <div class="settings-label">Embed subtitles by default</div>
          ${toggleHtml('youtube', 'embedSubtitles', yt.embedSubtitles)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Subtitle language</div>
          <input class="settings-input" data-section="youtube" data-key="autoSubtitleLang" value="${yt.autoSubtitleLang || 'en'}" style="max-width:80px">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Behaviour</div>
        <div class="settings-row">
          <div class="settings-label">Concurrent downloads</div>
          <select class="settings-select" data-section="youtube" data-key="concurrentDownloads">
            ${[1,2,3,4,5].map(n => `<option value="${n}" ${yt.concurrentDownloads == n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Auto-retry on failure</div>
          ${toggleHtml('youtube', 'autoRetry', yt.autoRetry)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Retry attempts</div>
          <select class="settings-select" data-section="youtube" data-key="retryCount">
            ${[0,1,2,3,5].map(n => `<option value="${n}" ${yt.retryCount == n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Remove SponsorBlock segments</div>
          ${toggleHtml('youtube', 'sponsorBlock', yt.sponsorBlock)}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Advanced</div>
        <div class="settings-label" style="margin-bottom:4px">Custom yt-dlp args</div>
        <input class="settings-input" data-section="youtube" data-key="customArgs" value="${yt.customArgs || ''}" placeholder="e.g. --no-warnings">
      </div>`;
  }

  if (tab === 'instagram') {
    const ig = s.instagram || {};
    html = `
      <div class="settings-section">
        <div class="settings-section-title">Download Location</div>
        <div class="folder-row">
          <input class="settings-input" data-section="instagram" data-key="downloadFolder" value="${ig.downloadFolder || ''}">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Quality & Format</div>
        <div class="settings-row">
          <div class="settings-label">Video quality</div>
          <select class="settings-select" data-section="instagram" data-key="preferredVideoQuality">
            <option value="best" ${ig.preferredVideoQuality === 'best' ? 'selected':''}>Best</option>
            <option value="1080" ${ig.preferredVideoQuality === '1080' ? 'selected':''}>1080p</option>
            <option value="720" ${ig.preferredVideoQuality === '720' ? 'selected':''}>720p</option>
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Audio format</div>
          <select class="settings-select" data-section="instagram" data-key="preferredAudioFormat">
            ${['mp3','aac','flac','wav'].map(f => `<option value="${f}" ${ig.preferredAudioFormat === f ? 'selected':''}>${f.toUpperCase()}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Carousel folders</div>
          ${toggleHtml('instagram', 'createCarouselFolders', ig.createCarouselFolders)}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Authentication</div>
        <div class="settings-row">
          <div class="settings-label">Cookie source</div>
          <select class="settings-select" data-section="instagram" data-key="cookieSource">
            <option value="auto" ${ig.cookieSource === 'auto' ? 'selected':''}>Auto-extract</option>
            <option value="file" ${ig.cookieSource === 'file' ? 'selected':''}>File path</option>
          </select>
        </div>
        <div style="margin-top:4px">
          <div class="settings-label" style="margin-bottom:4px">Session file path</div>
          <input class="settings-input" data-section="instagram" data-key="sessionFile" value="${ig.sessionFile || ''}" placeholder="Optional: path to cookies.txt">
        </div>
        <button class="btn btn-secondary" id="refresh-cookies-btn" style="margin-top:8px">
          ${icon('retry')} <span class="btn-label">Re-extract cookies from browser</span>
        </button>
        <div id="cookie-status-text" style="font-size:11px;margin-top:5px;color:var(--text2)">Checking...</div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Behaviour</div>
        <div class="settings-row">
          <div class="settings-label">Concurrent downloads</div>
          <select class="settings-select" data-section="instagram" data-key="concurrentDownloads">
            ${[1,2,3].map(n => `<option value="${n}" ${ig.concurrentDownloads == n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Auto-retry</div>
          ${toggleHtml('instagram', 'autoRetry', ig.autoRetry)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Retry attempts</div>
          <select class="settings-select" data-section="instagram" data-key="retryCount">
            ${[0,1,2,3,5].map(n => `<option value="${n}" ${ig.retryCount == n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }

  if (tab === 'generic') {
    const gen = s.generic || {};
    html = `
      <div class="settings-section">
        <div class="settings-section-title">Download Location</div>
        <div class="folder-row">
          <input class="settings-input" data-section="generic" data-key="downloadFolder" value="${gen.downloadFolder || ''}">
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Quality & Format</div>
        <div class="settings-row">
          <div class="settings-label">Max resolution</div>
          <select class="settings-select" data-section="generic" data-key="maxResolution">
            ${['4320','2160','1440','1080','720','480'].map(r => `<option value="${r}" ${gen.maxResolution === r ? 'selected':''}>${r}p</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Video format</div>
          <select class="settings-select" data-section="generic" data-key="preferredVideoFormat">
            ${['mp4','mkv','webm'].map(f => `<option value="${f}" ${gen.preferredVideoFormat === f ? 'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Audio format</div>
          <select class="settings-select" data-section="generic" data-key="preferredAudioFormat">
            ${['mp3','aac','flac','wav','opus'].map(f => `<option value="${f}" ${gen.preferredAudioFormat === f ? 'selected':''}>${f.toUpperCase()}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Behaviour</div>
        <div class="settings-row">
          <div class="settings-label">Concurrent downloads</div>
          <select class="settings-select" data-section="generic" data-key="concurrentDownloads">
            ${[1,2,3,4].map(n => `<option value="${n}" ${gen.concurrentDownloads == n ? 'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
        <div class="settings-row">
          <div class="settings-label">Auto-retry</div>
          ${toggleHtml('generic', 'autoRetry', gen.autoRetry)}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Advanced</div>
        <input class="settings-input" data-section="generic" data-key="customArgs" value="${gen.customArgs || ''}" placeholder="Custom yt-dlp arguments">
      </div>`;
  }

  if (tab === 'app') {
    const app = s.app || {};
    const log = state.settings.logging || {};
    html = `
      <div class="settings-section">
        <div class="settings-section-title">Interface</div>
        <div class="settings-row">
          <div class="settings-label">
            URL Input Mode
            <div class="settings-sub">Show URL paste box in each tab</div>
          </div>
          ${toggleHtml('app', 'urlInputMode', app.urlInputMode)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Show verification badge</div>
          ${toggleHtml('app', 'showVerificationBadge', app.showVerificationBadge)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Notifications</div>
          ${toggleHtml('app', 'notificationsEnabled', app.notificationsEnabled)}
        </div>
        <div class="settings-row">
          <div class="settings-label">Open folder after download</div>
          ${toggleHtml('app', 'openFolderAfterDownload', app.openFolderAfterDownload)}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Logging</div>
        <div class="settings-row">
          <div class="settings-label">Enable logging</div>
          <div class="settings-sub">Log detailed info to logs/ folder</div>
          ${toggleHtml('logging', 'enabled', log.enabled ?? false)}
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Server</div>
        <div class="settings-row">
          <div class="settings-label">Server status</div>
          <span style="font-size:12px;color:${state.serverOnline ? 'var(--green)' : 'var(--red)'}">${state.serverOnline ? '● Online' : '● Offline'}</span>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          Run <code style="background:var(--bg3);padding:2px 5px;border-radius:3px;color:var(--accent)">node index.js</code> in the server folder to start.
        </div>
      </div>
      <div class="settings-section" style="margin-top:12px">
        <button class="btn btn-danger" id="reset-settings-btn" style="width:100%">Reset all settings to defaults</button>
      </div>`;
  }

  c.innerHTML = html;

  // Auto-save on change
  c.querySelectorAll('[data-section][data-key]').forEach(el => {
    el.addEventListener('change', async () => {
      const section = el.dataset.section;
      const key = el.dataset.key;
      const value = el.type === 'checkbox' ? el.checked : el.value;
      const patch = { [key]: value };
      try {
        state.settings = await api('PATCH', `/settings/${section}`, patch);
        if (key === 'urlInputMode') applyURLInputMode(value);
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      }
    });
  });

  document.getElementById('reset-settings-btn')?.addEventListener('click', async () => {
    if (!confirm('Reset all settings to defaults?')) return;
    state.settings = await api('POST', '/settings/reset');
    renderSettings();
    toast('Settings reset');
  });

  document.getElementById('refresh-cookies-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refresh-cookies-btn');
    if (btn) btn.disabled = true;
    toast('Re-extracting cookies from browser...');
    try {
      const result = await api('POST', '/cookies/refresh');
      const s = result.status || {};
      if (result.ok) {
        toast(`Cookies extracted from ${s.extractedFrom || 'browser'} ✓`, 'success');
      } else {
        toast('Auto-extract failed — set a cookies.txt path in Session File below', 'error');
      }
      // Refresh status label if present
      const statusEl = document.getElementById('cookie-status-text');
      if (statusEl) {
        statusEl.textContent = result.ok
          ? `✓ Active (from ${s.extractedFrom || 'browser'}, ${s.ageMinutes || 0}m ago)`
          : '✗ No cookies — downloads may fail for private posts';
        statusEl.style.color = result.ok ? 'var(--green)' : 'var(--red)';
      }
    } catch (e) {
      toast('Cookie refresh failed: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Load and show cookie status when settings open on instagram tab
  if (document.getElementById('cookie-status-text')) {
    api('GET', '/cookies/status').then(s => {
      const el = document.getElementById('cookie-status-text');
      if (!el) return;
      if (s.hasFile) {
        el.textContent = `✓ Active (from ${s.extractedFrom || 'file'}, ${s.ageMinutes || 0}m ago)`;
        el.style.color = 'var(--green)';
      } else {
        el.textContent = '✗ No cookies — click Refresh to extract from browser';
        el.style.color = 'var(--red)';
      }
    }).catch(() => {});
  }
}

function toggleHtml(section, key, value) {
  const id = `toggle-${section}-${key}`;
  return `<label class="toggle">
    <input type="checkbox" id="${id}" data-section="${section}" data-key="${key}" ${value ? 'checked' : ''}>
    <div class="toggle-track"></div>
    <div class="toggle-thumb"></div>
  </label>`;
}

// Settings sub-tabs
function initSettingsTabs() {
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeSettingsTab = btn.dataset.stab;
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderSettings();
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();
  initSettingsTabs();
  initURLInputMode();

  // Check server
  const online = await checkServer();
  if (online) {
    // Load settings first to apply URL input mode
    try {
      state.settings = await api('GET', '/settings');
      applyURLInputMode(state.settings?.app?.urlInputMode || false);
    } catch {}

    // Detect current tab
    await detectCurrentTab();
    loadQueue();
  }

  document.getElementById('streams-refresh')?.addEventListener('click', loadStreams);
  document.getElementById('streams-clear')?.addEventListener('click', async () => {
    await new Promise(res => chrome.runtime.sendMessage({ type: 'CLEAR_STREAMS' }, res));
    loadStreams();
  });

  // Connect WebSocket for real-time updates
  connectWS();

  // Periodically refresh queue
  setInterval(loadQueue, 3000);
  setInterval(checkServer, 10000);
}

document.addEventListener('DOMContentLoaded', init);
