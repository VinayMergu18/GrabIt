# GrabIt – Media Download Helper

A lightweight, open‑source browser extension that detects and downloads video, audio, and other media streams from thousands of websites. Forked and modernized from the classic *Video Download Helper* project.

---

## Table of Contents
- [Features](#features)
- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Universal detection** – Works on YouTube, Instagram, Vimeo, Dailymotion, and many other sites via site‑specific injectors.
- **Unified UI** – Popup, sidebar, and detached history views built with custom elements and shadow DOM.
- **Smart naming** – Powerful DSL (`smartnaming.js`) to generate file names from metadata (title, resolution, date, etc.).
- **Cookie handling** – Import/export Netscape‑format cookies for sites that require authentication.
- **History & stats** – Persistent download history (`history.json`) with timestamps, sizes, MIME types, and retry logic.
- **Internationalization** – Full i18n support via `_locales` JSON files.
- **Privacy‑first** – All data stays locally; no telemetry or external tracking.
- **MIT licensed** – Free for personal and commercial use.

---

## Supported Platforms

| Browser | Minimum Version |
|---------|-----------------|
| Chrome  | 88+ |
| Edge    | 88+ |
| Firefox | 91+ |
| Opera   | 75+ |

The extension uses the WebExtensions API, so it runs as a **service worker** (manifest V3) where supported, falling back to a background page otherwise.

---

## Installation

### As an Unpacked Extension (development / testing)

1. **Clone / download** the repository.
2. Open the browser’s extensions page:
   - Chrome/Edge: `chrome://extensions`
   - Firefox: `about:debugging#/runtime/this-firefox`
3. Enable **Developer mode** (Chrome/Edge) or click **Load Temporary Add‑on** (Firefox).
4. Click **Load unpacked** and select the `extension/` folder (the directory that contains `manifest.json`).
5. The GrabIt icon should appear in the toolbar. Navigate to a supported site (e.g., YouTube) to see the detection bar.

### Packaging for Distribution

```bash
# Chrome / Edge .zip → .crx
cd extension
zip -r ../GrabIt.zip *
# Drag GrabIt.zip onto chrome://extensions with Developer mode on

# Firefox .xpi (requires web-ext)
npm install -g web-ext
cd extension
web-ext build
# The generated .xpi is in web-ext-artifacts/
```

---

## Usage

1. **Navigate** to a page containing media (video, audio, livestream, etc.).
2. The GrabIt icon will animate when detectable streams are found.
3. Click the icon to open the **popup** (or sidebar if pinned).
4. The popup lists all detected streams with icons, format, resolution, and size estimates.
5. Click a stream to start the download. The file is saved to your default download folder (or a custom folder set in Settings).
6. Monitor progress in the popup or open the **History** view from the toolbar button.
7. Adjust preferences (theme, download folder, concurrency, smart‑naming rules, cookie import) via the **Settings** gear inside the popup.

---

## Configuration

All user‑specific data lives in the extension’s storage area and is persisted as JSON files:

| File            | Purpose |
|-----------------|---------|
| `settings.json` | User preferences (theme, download folder, max concurrent downloads, etc.) |
| `history.json`  | Array of download objects (id, URL, filename, timestamps, status, MIME type, size, etc.) |
| `cookies.txt`   | Netscape‑format cookie file for authenticated downloads (import/export via UI) |

These files are created automatically on first run; you can back them up or share them across profiles.

---

## Development

### Project Structure
```
GrabIt/
├─ extension/                 # Code packaged into the browser extension
│  ├─ manifest.json           # Extension manifest
│  ├─ _locales/               # i18n JSON files (en, it, ru, …)
│  ├─ content/                # UI pages and shared scripts
│  │   ├─ popup.html
│  │   ├─ sidebar.html
│  │   ├─ history.html
│  │   ├─ panel.js            # Core UI logic (custom elements)
│  │   ├─ register_components.js
│  │   ├─ details.js
│  │   ├─ translate.js
│  │   ├─ smartnaming.js
│  │   └─ injected/           # Site‑specific detectors (youtube.js, …)
│  ├─ service/                # Background / service‑worker
│  │   └─ main.js
│  └─ data/                   # Runtime‑generated storage (not in repo)
├─ VDown/                     # Legacy mirror (kept for compatibility)
└─ README.md
```

### Build Steps
No build step is required for basic development—just edit files under `extension/` and reload the extension in the browser.

#### Linting / Formatting (optional)
The project follows a 2‑space indentation style with semicolons. You can enforce it with:

```bash
npm install --global prettier
prettier --write "extension/**/*.{js,html,json}"
```

#### Debugging
- **Background / service worker**: Open the extension page → click “Service worker” (Chrome/Edge) or “Debug” (Firefox) to inspect the console.
- **Content / injected scripts**: Open DevTools on the target page, then select the **Extensions** context or look for `moz-extension://…` sources.
- **UI panels (popup/sidebar)**: Right‑click the GrabIt icon → “Inspect popup” (or sidebar) to open DevTools for that context.

---

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/awesome-feature`.
3. Make your changes, adhering to the existing code style.
4. If you add new UI strings, add them to `_locales/en/messages.json` and copy to other locales.
5. Ensure the extension still loads without errors (check background and content‑script consoles).
6. Commit with a clear message: `git commit -m "feat: add XYZ option to settings"`.
7. Push to your fork and open a Pull Request against the `main` branch.

### Reporting Issues
When opening an issue, include:
- Browser name and version.
- Extension version (see `manifest.json`).
- Steps to reproduce.
- Any relevant console errors.
- For site‑specific problems, provide a sample URL and note whether the detection bar appears.

---

## License

GrabIt is released under the **MIT License**. See the [`LICENSE`](LICENSE) file for the full text.

---

*Developed with ❤️ for the open‑source community.*