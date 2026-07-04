# GrabIt v3.0

Fast, local-first media downloader. YouTube, Instagram, and any website. Chrome/Brave/Edge extension + local Node.js server.

---

## Requirements

| Tool | Install |
|------|---------|
| Node.js 18+ | https://nodejs.org |
| yt-dlp | https://github.com/yt-dlp/yt-dlp/releases — place `yt-dlp.exe` in PATH or in `server/` |
| gallery-dl | `pip install gallery-dl` — needed for Instagram carousels |
| ffmpeg | https://ffmpeg.org — needed for merging video+audio tracks |

---

## Setup

### 1 — Start the server

**Windows (recommended):**
```
Double-click start-server.bat
```
or in PowerShell:
```powershell
pwsh -File start-server.ps1
```

**Linux / Mac:**
```bash
./start-server.sh
```

The server runs at `http://127.0.0.1:7272`. Keep the window open while downloading.

### 2 — Load the extension

1. Open Chrome/Brave → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The GrabIt icon appears in the toolbar — pin it

### 3 — Use it

- Navigate to a YouTube video, playlist, Instagram post, reel, story, or any page with video
- Click the GrabIt icon
- The server auto-detects what's on the page
- Pick your action and click Download

---

## Features

### YouTube
- Videos at any quality (4K, 1080p, 720p, …)
- Audio-only (MP3, AAC, FLAC, WAV, Opus, M4A)
- Playlists — video or audio-only
- Subtitles (embed or sidecar)
- Shorts, Music, Live archives
- SponsorBlock segment removal

### Instagram
- Reels — video or audio-only
- Single photos and videos
- Carousels — current slide / selected slide / all slides
- Mixed carousels (photos + videos) — correct per-slide type detection
- Stories and highlights
- Carousel folder structure: `Title/Photos/`, `Title/Videos/`, `Title/metadata.json`
- Current slide tracked live via DOM + accessibility attributes

### Any Website
- Falls back to yt-dlp which supports 1000+ sites
- Video or audio-only

### Download Manager
- Pause / Resume / Cancel / Retry
- Priority queue
- Real-time progress (speed, ETA, size)
- File verification after download
- Download history with re-download

---

## Instagram Authentication

The server auto-extracts cookies from Brave/Chrome/Edge on startup (via yt-dlp's `--cookies-from-browser`). This handles login-gated content.

If auto-extract fails:
1. Open **Settings → Instagram → Re-extract cookies from browser**
2. Or set a manual `cookies.txt` path in **Settings → Instagram → Session file path**

Cookies are cached for 6 hours and refreshed automatically.

---

## Download Folders

Default locations (all configurable in Settings):

| Platform | Default path |
|----------|-------------|
| YouTube | `~/Downloads/GrabIt/YouTube/` |
| Instagram | `~/Downloads/GrabIt/Instagram/` |
| Generic | `~/Downloads/GrabIt/Generic/` |

> **Note**: The default location is a subfolder (`GrabIt/<Platform>`) inside the user's system Downloads folder.
> To change the download location for a platform:
> 1. Open the GrabIt extension popup.
> 2. Click the gear icon to open Settings.
> 3. Navigate to the platform section (YouTube, Instagram, or Generic).
> 4. Set the "Download Folder" field to your desired path (e.g., `~/Downloads` to save directly in the Downloads folder, leaving the subfolder blank).
> 5. Save settings. The server will use this path for future downloads.

---

## Architecture

```
Extension (UI only)
    ↕ REST + WebSocket
Local Server (source of truth)
    ├── detector.js   — Stage 1 (instant) + Stage 2 (deep probe)
    ├── downloader.js — yt-dlp + gallery-dl execution
    ├── queue.js      — priority queue, retry, cancel
    ├── cookies.js    — auto browser cookie extraction
    ├── db.js         — JSON file persistence (history, settings)
    └── websocket.js  — real-time progress broadcast
```

**Rule:** The server decides everything. The extension only displays what the server returns.

---

## Troubleshooting

**"Server offline" in extension**
→ Make sure `start-server.bat` / `start-server.ps1` is running and shows "Server ready"

**Instagram probe fails**
→ Open Settings → Instagram → Re-extract cookies. Make sure you're logged in to Instagram in Brave/Chrome first.

**yt-dlp not found**
→ Place `yt-dlp.exe` in `GrabIt/server/` directory, or add it to your system PATH

**Carousel downloads wrong slide**
→ Wait for the slide indicator to update in the popup (it syncs live from the page). The server always uses the last-reported slide index.

**ffmpeg errors during merge**
→ Install ffmpeg and add to PATH: https://ffmpeg.org/download.html

---

## File structure

```
GrabIt/
├── extension/
│   ├── manifest.json
│   ├── icons/
│   ├── pages/popup.html
│   └── scripts/
│       ├── background/sw.js
│       ├── content/content.js
│       └── popup/popup.js
├── server/
│   ├── index.js
│   ├── data/           ← created at runtime (history, settings, cookies)
│   └── modules/
│       ├── db.js
│       ├── websocket.js
│       ├── detector.js
│       ├── downloader.js
│       ├── queue.js
│       ├── cookies.js
│       └── routes/
│           ├── probe.js
│           ├── download.js
│           ├── queue.js
│           ├── history.js
│           ├── settings.js
│           └── slide.js
├── start-server.bat
├── start-server.ps1
└── start-server.sh
```
