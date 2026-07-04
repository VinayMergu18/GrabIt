/**
 * content.js — Injected into Instagram and YouTube pages.
 *
 * Instagram: Tracks current carousel slide using multiple signals.
 * YouTube: Detects playlist vs single video context.
 *
 * Sends updates to background SW → server via /slide/update.
 */

(function () {
  'use strict';

  const platform = location.hostname.includes('instagram') ? 'instagram' : 'youtube';
  let lastSlideIndex = -1;
  let lastUrl = '';
  let observerActive = false;
  let mutationObs = null;
  let slideInterval = null;

  // ── Slide detection (Instagram only) ─────────────────────────────────────────

  function detectCurrentSlide() {
    if (platform !== 'instagram') return 0;

    // Strategy 1: Active dot indicator
    const dots = document.querySelectorAll('._acav, [class*="PaginationDot"], [aria-label*="Slide"], div[role="listitem"]');
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i];
      if (dot.classList.contains('_acaw') || // active class
          dot.getAttribute('aria-selected') === 'true' ||
          dot.getAttribute('aria-current') === 'true' ||
          window.getComputedStyle(dot).opacity === '1') {
        return i;
      }
    }

    // Strategy 2: Scroller translate transform
    const scroller = document.querySelector('ul._acay, [class*="Carousel"] ul, div[class*="media"] ul');
    if (scroller) {
      const transform = window.getComputedStyle(scroller).transform;
      const matrix = transform.match(/matrix\(.*?,.*?,.*?,.*?,\s*([-\d.]+)/);
      if (matrix) {
        const translateX = parseFloat(matrix[1]);
        const slideWidth = scroller.parentElement?.clientWidth || 468;
        return Math.round(Math.abs(translateX) / slideWidth);
      }
    }

    // Strategy 3: aria-hidden slides
    const slides = document.querySelectorAll('li._acaz, [class*="CarouselSlide"], [class*="media"] > div');
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      if (!slide.getAttribute('aria-hidden') || slide.getAttribute('aria-hidden') === 'false') {
        if (isVisible(slide)) return i;
      }
    }

    return 0;
  }

  function countSlides() {
    if (platform !== 'instagram') return 1;
    const dots = document.querySelectorAll('._acav, [class*="PaginationDot"]');
    if (dots.length > 0) return dots.length;
    const slides = document.querySelectorAll('li._acaz, [class*="CarouselSlide"]');
    return slides.length || 1;
  }

  function detectCurrentSlideMediaType() {
    const slides = document.querySelectorAll('li._acaz, [class*="CarouselSlide"]');
    const slideIndex = detectCurrentSlide();
    const slide = slides[slideIndex];
    if (!slide) return detectMediaTypeFromDOM();
    return slide.querySelector('video') ? 'video' : 'photo';
  }

  function detectMediaTypeFromDOM() {
    if (document.querySelector('video[src], video source')) return 'video';
    if (location.pathname.includes('/reel/')) return 'video';
    return 'photo';
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.left >= 0 && rect.left < window.innerWidth;
  }

  function sendSlideUpdate() {
    const slideIndex = detectCurrentSlide();
    const slideCount = countSlides();
    const mediaType = detectCurrentSlideMediaType();
    const url = location.href;

    // Debounce — only send if changed
    if (slideIndex === lastSlideIndex && url === lastUrl) return;
    lastSlideIndex = slideIndex;
    lastUrl = url;

    chrome.runtime.sendMessage({
      type: 'SLIDE_UPDATE',
      data: { url, slideIndex, slideCount, mediaType, platform }
    }).catch(() => {});
  }

  // ── Observers ─────────────────────────────────────────────────────────────────

  function startObserving() {
    if (observerActive) return;
    observerActive = true;

    // MutationObserver for DOM changes
    mutationObs = new MutationObserver(() => {
      requestAnimationFrame(sendSlideUpdate);
    });

    const target = document.querySelector('main, article, #root') || document.body;
    mutationObs.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'aria-selected', 'class', 'style'] });

    // Interval fallback for CSS transitions
    slideInterval = setInterval(sendSlideUpdate, 500);

    // Click events (navigation buttons)
    document.addEventListener('click', () => setTimeout(sendSlideUpdate, 150), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setTimeout(sendSlideUpdate, 150);
    }, { passive: true });

    // Touch
    document.addEventListener('touchend', () => setTimeout(sendSlideUpdate, 200), { passive: true });

    // Send initial state
    sendSlideUpdate();
  }

  function stopObserving() {
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (slideInterval) { clearInterval(slideInterval); slideInterval = null; }
    observerActive = false;
  }

  // ── Route change detection (SPA) ─────────────────────────────────────────────

  function onRouteChange() {
    const url = location.href;
    const isCarouselPage = platform === 'instagram' && /\/p\//.test(url);
    const isReelPage = platform === 'instagram' && /\/reel\//.test(url);

    if (isCarouselPage || isReelPage) {
      // Wait for DOM to render
      setTimeout(startObserving, 800);
    } else {
      stopObserving();
    }
  }

  // Listen for SPA navigation
  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onRouteChange();
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // Initial check
  onRouteChange();

  // Respond to popup requests
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_SLIDE_STATE') {
      sendResponse({
        slideIndex: detectCurrentSlide(),
        slideCount: countSlides(),
        mediaType: detectCurrentSlideMediaType(),
        url: location.href,
        platform
      });
      return true;
    }
    if (msg.type === 'GET_PAGE_INFO') {
      sendResponse({
        url: location.href,
        title: document.title,
        platform,
        mediaType: detectMediaTypeFromDOM()
      });
      return true;
    }
  });

})();
