# GrabIt – Video Download Helper Extension  
*(a fork/rename of the original **Video Download Helper** project)*  

---

## Table of Contents
1. [Overview](#overview)  
2. [Directory Layout](#directory-layout)  
3. [Manifest & Background](#manifest--background)  
4. [Content Scripts & UI](#content-scripts--ui)  
5. [Injected Page Scripts](#injected-page-scripts)  
6. [Localization (i18n)](#localization-i18n)  
7. [Data Persistence](#data-persistence)  
8. [How the Parts Work Together](#how-the-parts-work-together)  
9. [Building / Running the Extension](#building--running-the-extension)  
10. [Contributing](#contributing)  
11. [License](#license)  

---  

## Overview
GrabIt is a browser‑extension that adds a toolbar button and detection bar to help users download videos, audio, and other media from thousands of websites.  
When a supported media element is detected on a page, GrabIt shows a small icon in the address bar (or a toolbar button) that opens a popup/sidebar UI listing the available streams.  
The user can then start a download, view history, change settings, or access advanced tools (smart‑naming, cookie extractor, etc.).  

The codebase is split into three logical layers:

| Layer | Responsibility |
|-------|----------------|
| **Manifest & Background** | Declares permissions, registers the service‑worker that lives for the lifetime of the extension, handles install/update logic, message routing, and long‑lived APIs (alarms, storage, etc.). |
| **Content Scripts & UI** | Scripts that run in the context of the web page *or* inside the extension’s own UI (popup.html, sidebar.html). They build the detection bar, the popup/sidebar panels, and handle user interactions. |
| **Injected Page Scripts** | Scripts that are injected into the target web page to sniff media elements, intercept network requests, and communicate with the extension via `runtime.sendMessage`. |
| **Localization** | JSON files under `_locales/<lang>/messages.json` provide all UI strings. |
| **Data Persistence** | JSON files (`history.json`, `settings.json`, `cookies.txt`) store download history, user preferences, and imported cookies. |

Below each file (or group of files) is explained in detail.

## How to Use
1. Load the extension as an unpacked extension in Chrome/Edge/Firefox via `chrome://extensions` (or `about:debugging#/runtime/this-firefox`).  
2. Pin the toolbar button for quick access.  
3. Navigate to a supported site (YouTube, Instagram, or any page with video/audio).  
4. Click the GrabIt icon; a popup/sidebar will appear showing detected media streams.  
5. Choose the desired format/resolution and click the download button.  
6. Monitor progress in the popup or open the History view from the toolbar button.  
7. Adjust settings (download folder, format preferences, etc.) via the Settings gear icon in the popup.

---  

## Directory Layout
```
GrabIt/
├─ extension/                     # All code that is packaged into the .crx/.xpi
│  ├─ manifest.json               # Extension manifest (permissions, background, etc.)
│  ├─ _locales/                   # i18n strings (en, it, ru, …)
│  │   ├─ en/messages.json
│  │   ├─ it/messages.json
│  │   └─ ru/messages.json
│  ├─ content/                    # Scripts that run in a web page or as extension UI
│  │   ├─ popup.html              # Popup UI (toolbar button)
│  │   ├─ sidebar.html            # Sidebar UI (when pinned)
│  │   ├─ history.html            # Detached history view (opened from popup)
│  │   ├─ panel.js                # Logic for popup & sidebar panels
│  │   ├─ register_components.js  # Custom element definitions used by the UI
│  │   ├─ details.js              # Details pane (shown when a download is selected)
│  │   ├─ translate.js            # Translation helper UI (crowd‑in translation)
│  │   ├─ smartnaming.js          # Filename‑generation helpers (regex, functions)
│  │   └─ injected/               # Scripts that are injected into web pages
│  │       └─ youtube.js          # YouTube‑specific detection & messaging
│  ├─ service/                    # Background / service‑worker code
│  │   └─ main.js                 # Core background logic (install, messaging, etc.)
│  └─ data/                       # Persistent storage (not shipped, created at runtime)
│      ├─ history.json
│      ├─ settings.json
│      └─ cookies.txt
└─ VDown/                         # Legacy folder kept for compatibility (same structure as extension/)
    … (mirrors the above) …
```

> **Note:** The repository contains two parallel trees (`extension/` and `VDown/`). The build process copies the contents of `extension/` into the final packaged extension; `VDown/` is kept for historical reasons and is not used by the runtime.

---  

## Manifest & Background  

### `manifest.json`
* Core descriptor read by Chrome/Edge/Firefox at install time.
* Declares:
  * **name**, **description**, **version**, **icons**.
  * **permissions** – `tabs`, `storage`, `downloads`, `webNavigation`, `webRequest`, `<all_urls>`, `unlimitedStorage`, `contextMenus`, `nativeMessaging`, etc.
  * **background** – points to `service/main.js` (service worker).
  * **action** – default icon & tooltip for the toolbar button.
  * **action** – link to `options.html` (not present in this fork; options are handled via popup/sidebar).
  * **content_scripts** – lists the scripts that run in matching web pages (`smartnaming.js`, `register_components.js`, `panel.js`, `injected/youtube.js`, etc.).
  * **web_accessible_resources** – allows the extension to inject its own HTML/CSS/JS into pages.
  * **externally_connectable** – enables communication with native apps (if any).

### `service/main.js`
* The **service worker** (background script) that lives for the lifetime of the extension.
* Key responsibilities:
  * **Install/Update handling** – shows a one‑time “welcome” tab on first install or after an update (the URL is stored in the `wm` variable – currently set to `about:blank` to disable it).
  * **Message routing** – forwards messages between content scripts, injected scripts, and UI panels via `runtime.onMessage`.
  * **Long‑lived APIs** – sets up alarms (e.g., periodic cleanup), listens to `downloads.onChanged`/`onErased` to update history, and watches `webNavigation` events for page‑level detection.
  * **Storage initialization** – reads/writes `settings.json` and `history.json` through the `storage` API.
  * **Utility helpers** – provides wrappers around `browser.tabs`, `browser.storage`, `browser.downloads`, etc., used throughout the codebase.

> The service worker does **not** contain any UI; all visual elements are implemented as content scripts or extension‑pages (popup/sidebar).

---  

## Content Scripts & UI  

### UI Files (HTML)  
| File | Purpose |
|------|---------|
| `popup.html` | Shown when the user clicks the toolbar button. Contains a flex‑column layout with a hidden premium banner (`#premium_banner`), a settings panel (`<com-settings>`), a main view (`<com-main>`), and a toolbar (`<com-toolbar>`). |
| `sidebar.html` | Similar to `popup.html` but displayed in the browser sidebar when the user pins the extension. |
| `history.html` | A detached view that lists all downloaded items; opened from the popup/sidebar “History” button. |

All three files share the same CSS custom properties (`--spacing-medium`, `--theme-box-bg`, etc.) defined in their `<style>` blocks.

### JavaScript Modules  

#### `panel.js`
* **Core UI logic** for the popup and sidebar.  
* Defines a set of custom elements (`<com-settings>`, `<com-main>`, `<com-toolbar>`) via the helper functions in `register_components.js`.  
* Handles:
  * Rendering the list of detected media streams (buttons with icons, quality labels, etc.).
  * Responding to user clicks – starts a download via `browser.downloads.download`.
  * Updating the UI when a download completes/fails (using messages from the background).
  * Managing the “premium banner” visibility (the banner is kept in the DOM but hidden via CSS – see the “Hide banner without breaking layout” section below).
  * Opening the history view (`browser.tabs.create({url: history.html})`) and the settings view.

#### `register_components.js`
* Small library that defines **custom elements** used by the UI:
  * `<com-settings>` – persistence of user preferences (tabbed UI for General, Appearance, Behavior, etc.).
  * `<com-main>` – main >` – the main content area that switches between “detected media list”, “details pane”, and “translation helper”.
  * `<com-toolbar>` – toolbar with buttons for History, Settings, etc.
  * `<com-media-button-origin>` – the small button that shows the source site’s favicon and, when clicked, would open the origin URL (now disabled via `onclick = null`).

These components are built using the **Custom Elements v1** API (via the `ae`, `O`, `d` helper functions seen in the code) and are styled with shadow DOM.

#### `details.js`
* Populates the **details pane** shown when a user selects a specific download from the list.  
* Displays file size, MIME type, source URL, referrer, cookies used, and allows the user to change the filename or add custom headers.

#### `translate.js`
* Implements the **crowd‑translation helper** UI that lets volunteers translate the extension’s strings.  
* It loads the JSON files from `_locales/` and presents a side‑by‑side editor.

#### `smartnaming.js`
* Provides a **filename‑generation language** (a tiny DSL) that lets users define rules for naming downloaded files based on metadata (site, title, resolution, date, etc.).  
* Exposes a large list of functions (e.g., `file`, `folder`, `dateFormat`, `md5Digest`, `base64Encode`, …) that can be used in the “Smart naming” rules configured in settings.

#### `injected/youtube.js`
* **YouTube‑specific detector** that runs inside YouTube pages.  
* It intercepts the player’s network requests, extracts video/audio formats, and sends a message to the extension (`runtime.sendMessage`) with a list of available streams.  
* Also responsible for injecting the small “download” button that appears under the YouTube player (if enabled).

> Other site‑specific injectors (e.g., for Vimeo, Dailymotion) would live in the same `injected/` folder; they follow the same pattern.

---  

## Injected Page Scripts  

Any script listed under the `content_scripts` section of `manifest.json` with `"matches": ["<all_urls>"]` is injected into **every** page the user visits (subject to site‑specific allow/deny rules).  

The main injected files are:

| File | Role |
|------|------|
| `smartnaming.js` | Makes the smart‑naming function library available to the page so that the background can evaluate naming rules via `runtime.sendMessage`. |
| `register_components.js` | Supplies the custom‑element definitions needed by the popup/sidebar when they are opened as a tab (e.g., `history.html`). |
| `panel.js` | Provides runtime helpers (e.g., `browser.runtime.sendMessage`) that the UI uses to talk to the background. |
| `injected/youtube.js` (and any future site‑specific injectors) | Detects media on the host page and streams the information back to the extension. |

Communication flow (simplified):

1. **Content script** (e.g., `youtube.js`) detects a media element → sends a message:  
   `{type: "mediaDetected", data: [...streams...]}` to `runtime.sendMessage`.
2. **Background** (`service/main.js`) receives the message, forwards it to any open UI panels (`panel.js`) via `runtime.onMessage` + `tabs.sendMessage` to the tab that opened the popup/sidebar.
3. **UI** (`panel.js`) renders the streams as clickable buttons.
4. When the user clicks a download button, the UI sends a `{type: "downloadRequested", …}` message to the background.
5. **Background** calls `browser.downloads.download` with the URL, headers, filename, etc.
6. The `downloads.onChanged` listener (also in `service/main.js`) updates `history.json` and notifies the UI to refresh the download state.

---  

## Localization (i18n)  

All user‑visible strings are stored in JSON files under `_locales/<lang>/messages.json`.  

* At runtime, the extension uses `browser.i18n.getMessage("messageKey")` to retrieve the appropriate string for the current browser locale.  
* The UI elements use the `data-i18n="messageKey"` attribute; the custom‑element base class automatically replaces the element’s `textContent` with the localized string during `onMounted`.  

**Example:**  
In `popup.html` the line  

```html
<p><span data-i18n="get_premium_description_button"></span> - <span data-i18n="get_premium_button"></span> 🚀</p>
```  

reads the two keys from the locale file.  
In the English locale (`_locales/en/messages.json`) those keys are currently:

```json
"get_premium_button": { "message": "" },
"get_premium_description_button": { "message": "Downloader_MoD" }
```

(The actual visible text is suppressed by setting the banner’s CSS to `display:none` or `visibility:hidden`; see the next section.)

Adding a new language is as simple as copying `en/messages.json` to a new locale folder and translating the values.

---  

## Data Persistence  

| File (created at runtime) | Content |
|---------------------------|---------|
| `history.json` | Array of download objects – each object contains `id`, `url`, `filename`, `startTime`, `endTime`, `state` (`in_progress`, `completed`, `interrupted`), `mimeType`, `fileSize`, and any custom metadata (referrer, cookies, etc.). |
| `settings.json` | Key‑value store of user preferences: theme (`light`/`dark`/`system`), default download folder, smart‑naming rules, cookie‑import settings, concurrency limits, etc. |
| `cookies.txt` | Netscape‑format cookie file that users can import/export via the “Cookie extractor” tool; used when a download requires specific cookies (e.g., for sites that rely on session auth). |

These files are **not** part of the source tree; they are created in the extension’s storage area (`browser.storage.local`) the first time the extension runs.  
The background script (`service/main.js`) reads/writes them via the storage API, and the UI panels read them to display current settings or history.

---  

## How the Parts Work Together  

Below is a typical end‑to‑end scenario when the user visits a YouTube video and decides to download it:

1. **Page Load** → YouTube’s HTML is parsed.  
2. **Injected script** `injected/youtube.js` runs (declared in `manifest.json` under `content_scripts`).  
   * It creates a `MutationObserver` to watch for the YouTube player.  
   * When the player is ready, it extracts the list of available formats (video‑only, audio‑only, combined) via `ytplayer.getConfig()` or by intercepting network requests.  
   * It builds a message: `{type: "mediaDetected", url: pageUrl, streams: [...]}` and sends it via `browser.runtime.sendMessage`.  
3. **Background** (`service/main.js`) receives the message in its `runtime.onMessage` listener.  
   * It stores the latest detection for the current tab ID (so that if the user opens the popup while still on the same page, the UI can instantly show the streams).  
   * It forwards the message to any open UI panels: if a popup or sidebar is open for that tab, it calls `browser.tabs.sendMessage(tabId, message)`.  
4. **UI** (`panel.js`) receives the message in its own listener (registered via `browser.runtime.onMessage` when the popup/sidebar loads).  
   * It renders each stream as a button: icon (video/audio), resolution, format, size estimate, and a downward‑arrow download icon.  
   * The button’s `onclick` handler sends a `{type: "downloadRequested", streamId, …}` message back to the background.  
5. **Background** receives the download request, builds a `downloads.download` options object:  
   * `url`: the direct media URL.  
   * `filename`: result of applying the user’s smart‑naming rules (via a call to the smart‑naming library exposed through a messaging RPC).  
   * `headers`: any extra headers (including cookies from `cookies.txt` if required).  
   * `saveAs`: false (uses the default download folder unless the user changed it).  
   * It then calls `browser.downloads.download`.  
6. **Download Progress** → The `downloads.onChanged` listener in `service/main.js` fires for each state change.  
   * On progress (`state.progress`), it updates the corresponding download object in `history.json`.  
   * On completion or error, it marks the object as `completed` or `interrupted` and stores any error details.  
7. **UI Update** → The background sends a `{type: "historyUpdate", downloadObject}` to all open panels.  
   * `panel.js` refreshes the list item (shows a check‑mark, file size, or error toast).  
   * If the user opens the history view (`history.html`), it reads `history.json` directly and displays a table with sorting/filtering.  
8. **User Interaction** → The user can:  
   * Open **Settings** (`<com-settings>`) to change theme, toggle the premium banner, set concurrent download limit, import/export cookies, etc.  
   * Open **Smart Naming** editor to define filename rules.  
   * Use the **Cookie extractor** tool (a separate popup) to gather cookies from a site and store them in `cookies.txt`.  
   * View **Details** (`details.js`) for any download to see the exact headers, referrer, etc.  

All communication is asynchronous and uses the standard `browser.runtime` messaging API, which works across the extension’s different contexts (content scripts, UI pages, service worker).

---  

## Building / Running the Extension  

The extension is a plain‑manifest V2/WebExtension; no build step is strictly required—just load the directory.

### Loading as an Unpacked Extension
1. Open the browser’s extensions page:  
   * Chrome/Edge: `chrome://extensions`  
   * Firefox: `about:debugging#/runtime/this-firefox`  
2. Enable **Developer mode** (Chrome/Edge) or click **Load Temporary Add‑on** (Firefox).  
3. Click **Load unpacked** and select the `extension/` folder (the root that contains `manifest.json`).  
4. The toolbar icon should appear. Navigate to a supported site (e.g., YouTube) – the detection bar/icon will show up.

### Testing Changes
* Edit any `.js`, `.html`, or `.json` file.  
* Save the file.  
* In the extensions page, click the **Reload** button for the extension (Chrome/Edge) or press **R** on the temporary add‑on card (Firefox) to reload the extension with your changes.  
* No compilation step is needed.

### Packaging (Optional)
If you need to create a `.crx` or `.xpi` for distribution:

* **Chrome/Edge**:  
  ```bash
  cd extension
  zip -r ../GrabIt.zip *
  ```
  Then drag the `GrabIt.zip` onto `chrome://extensions` with Developer mode enabled, or use the Chrome Web Store developer dashboard.

* **Firefox**:  
  ```bash
  cd extension
  web-ext build   # requires `web-ext` npm package installed globally
  ```
  The generated `.xpi` can be uploaded to addons.mozilla.org.

### Debugging Tips
* Open the **background console**:  
  * Chrome/Edge: Open extensions page → click **Service worker** link under the extension → inspect.  
  * Firefox: In the debugger page, click **Debug** → then open the **Console** tab for the background worker.  
* For content scripts or injected scripts, open the DevTools of the tab you’re inspecting, then select the **Extension** context from the dropdown (or look for files under `webpack://` or `moz-extension://...`).  
* Use `console.log` liberally; the background and content scripts both output to their respective consoles.

---  

## Contributing  

1. **Fork** the repository on GitHub.  
2. Create a feature branch: `git checkout -b feature/awesome-thing`.  
3. Make your changes, adhering to the existing code style (2‑space indentation, semicolons, descriptive variable names).  
   * UI changes should keep the `#premium_banner` element in the DOM and hide it via CSS (`height:0; overflow:hidden;`) to preserve layout – see the note below.  
4. Add or update locale strings if you introduce new UI text.  
5. Ensure the extension still loads and runs without errors (check the background and content‑script consoles).  
6. Commit with a clear message: `git commit -m "feat: add XYZ option to settings"`.  
7. Push to your fork and open a Pull Request against the `main` branch.  

### Reporting Bugs
* Include browser version, extension version (as shown in `manifest.json`), steps to reproduce, and any console errors.  
* If the issue is site‑specific, provide a URL (or a test case) and note whether the detection bar appears.

---  

## License  

GrabIt is released under the **MIT License** – see the `LICENSE` file in the repository root for the full text.  

---  

### TL;DR Summary for Developers  

* **manifest.json** – declares permissions, points to `service/main.js` as background, lists content scripts.  
* **service/main.js** – service worker that handles install/update, messaging, download/API hooks, and persists `history.json`/`settings.json`.  
* **content/** – HTML UI files (`popup.html`, `sidebar.html`, `history.html`) + JS that implements custom elements (`register_components.js`), panel logic (`panel.js`), details (`details.js`), translation helper (`translate.js`), smart naming (`smartnaming.js`), and site‑specific detectors (`injected/*.js`).  
* **_locales/** – JSON files for every supported language; UI uses `data-i18n` attributes.  
* **data/`history.json`, `settings.json`, `cookies.txt`** – created at runtime; store download history, user preferences, and imported cookies.  

All parts communicate via `browser.runtime.sendMessage` / `onMessage`, keeping the background as the central hub while the UI remains responsive and the detection scripts stay lightweight on the web page.

Enjoy GrabIt! 🚀

---  