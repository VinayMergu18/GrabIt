/**
 * Generic stream detector – injected into all pages to detect media streams.
 * Sends STREAM_DETECTED messages to the background service worker.
 */
(function () {
    'use strict';

    const STREAM_RE = /\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|flv|avi|ogg)(\?|#|$)/i;
    const seenUrls = new Set();

    function sendStreamDetected(url, pageTitle) {
        if (!url || seenUrls.has(url)) return;
        seenUrls.add(url);
        chrome.runtime.sendMessage({
            type: 'STREAM_DETECTED',
            url: url,
            pageTitle: pageTitle || document.title,
            quality: null, // will be guessed by background
            type: null     // will be classified by background
        });
    }

    function checkAndSend(src) {
        if (!src) return;
        try {
            // Resolve relative URLs
            src = new URL(src, location.href).href;
        } catch (e) {
            return;
        }
        if (STREAM_RE.test(src)) {
            sendStreamDetected(src);
        }
    }

    // 1. Check <video>, <audio>, <source> elements
    document.querySelectorAll('video, audio, source').forEach(el => {
        const src = el.src || el.currentSrc || el.getAttribute('src') || '';
        checkAndSend(src);
        // Also check data-src etc.
        const dataSrc = el.dataset.src || el.dataset.videoSrc || el.dataset.hlsUrl || el.dataset.m3u8 || el.dataset.url || '';
        checkAndSend(dataSrc);
    });

    // 2. Check elements with data attributes that may contain URLs
    document.querySelectorAll('[data-src],[data-video-src],[data-hls-url],[data-m3u8],[data-url]').forEach(el => {
        const src = el.dataset.src || el.dataset.videoSrc || el.dataset.hlsUrl || el.dataset.m3u8 || el.dataset.url || '';
        checkAndSend(src);
    });

    // 3. Scan inline JSON / script tags for m3u8/mpd URLs (e.g., Next.js __NEXT_DATA__)
    document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(el => {
        const text = el.textContent || '';
        const rx = /https?:\/\/[^\s"'<>]+\.(m3u8|mpd)(\?[^\s"'<>]*)?/gi;
        let match;
        while ((match = rx.exec(text)) !== null) {
            sendStreamDetected(match[0]);
        }
    });

    // 4. Optional: re-check periodically for SPA navigation
    let lastUrl = location.href;
    const urlObserver = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            // Clear seen URLs for new page? Might want to keep across SPA; we keep.
        }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });

})();