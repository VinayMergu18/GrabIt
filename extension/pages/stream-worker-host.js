// Kept deliberately small to mirror VDown's factory document. The LibAV
// worker communicates with the background through BroadcastChannel, so this
// page only needs to give it a durable MV3 document to live in.
// new Worker(chrome.runtime.getURL('scripts/stream-worker/main.js'), { type: 'module' });

// -------------------------------------------------------
const streamWorker = new Worker(
  chrome.runtime.getURL('scripts/stream-worker/main.js'),
  { type: 'module' }
);

streamWorker.onerror = event => {
  console.error('[GrabIt] LibAV Worker ERROR:', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
};

streamWorker.onmessageerror = event => {
  console.error('[GrabIt] LibAV Worker MESSAGE ERROR:', event);
};
// -------------------------------------------------------

// A few LibAV strategies return their OPFS filename without a Blob URL. The
// service worker cannot create Blob URLs, so expose the same OPFS-to-URL bridge
// VDown uses in its UI from this durable offscreen document.
// const streamChannel = new BroadcastChannel('worker_service');
// streamChannel.addEventListener('message', async event => {
//   if (event.data?.channel !== 2) return;
//   const message = event.data.msg;
//   if (message?.name === 'revoke_blob_url') {
//     URL.revokeObjectURL(message.data?.blob_url);
//     return;
//   }
//   if (message?.name !== 'create_blob_url_from_file') return;
//   const { request_id: requestId, filename } = message.data || {};
//   try {
//     const root = await navigator.storage.getDirectory();
//     const file = await (await root.getFileHandle(filename)).getFile();
//     streamChannel.postMessage({ channel: 3, msg: { name: 'blob_url_from_file', data: { request_id: requestId, blob_url: URL.createObjectURL(file) } } });
//   } catch (error) {
//     streamChannel.postMessage({ channel: 3, msg: { name: 'blob_url_from_file', data: { request_id: requestId, error: error.message || String(error) } } });
//   }
// });



// -------------------------------------------------------
// ── BroadcastChannel for Service Worker ↔ Worker Communication ──
// 
// Channels (matching VDown architecture):
//   Channel 0: FromInjectedToService
//   Channel 1: FromContentToService
//   Channel 2: FromServiceToWorker (receive download requests)
//   Channel 3: FromWorkerToService (send progress/results back)
//   Channel 6: FromServiceToContent
//   Channel 7: FromServiceToInjected
//   Channel 8: FromServiceToService
//
// This offscreen document bridges service worker ↔ download worker communication
// -------------------------------------------------------

const streamChannel = new BroadcastChannel('worker_service');
const ChannelEnum = {
  FromInjectedToService: 0,
  FromContentToService: 1,
  FromServiceToWorker: 2,        // Service → Worker (download requests)
  FromWorkerToService: 3,        // Worker → Service (progress/results)
  FromUntrustedInjectedToTrusted: 4,
  FromTrustedInjectedToUntrusted: 5,
  FromServiceToContent: 6,
  FromServiceToInjected: 7,
  FromServiceToService: 8
};

// Store active downloads for state tracking
const activeDownloads = new Map();

/**
 * Send message to service worker (FromWorkerToService)
 */
function sendToService(message) {
  streamChannel.postMessage({
    channel: ChannelEnum.FromWorkerToService,
    msg: message
  });
}

/**
 * Receive message from service worker (FromServiceToWorker)
 */
streamChannel.addEventListener('message', async event => {
  if (event.data?.channel !== ChannelEnum.FromServiceToWorker) return;

  const message = event.data.msg;
  if (!message?.name) return;

  console.log('[GrabIt Factory] Received from service:', { name: message.name, downloadId: message.data?.download_id });

  try {
    // ── OPFS-to-Blob URL Bridge (for preview) ──
    if (message.name === 'create_blob_url_from_file') {
      await handleCreateBlobUrl(message.data);
      return;
    }

    if (message.name === 'revoke_blob_url') {
      const blobUrl = message.data?.blob_url;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      return;
    }

    // ── Download Request Handler ──
    if (message.name === 'start_download') {
      await handleDownloadRequest(message.data);
      return;
    }

    // ── Abort Download Handler ──
    if (message.name === 'abort_download') {
      handleAbortDownload(message.data);
      return;
    }

    console.warn('[GrabIt Factory] Unknown message:', message.name);

  } catch (error) {
    console.error('[GrabIt Factory] Message handler error:', error);
    sendToService({
      name: 'error',
      data: {
        download_id: message.data?.download_id,
        error: error?.message || String(error)
      }
    });
  }
});

/**
 * Handle OPFS file → Blob URL conversion (for preview)
 */
async function handleCreateBlobUrl(data) {
  const { request_id: requestId, filename } = data || {};

  if (!requestId || typeof filename !== 'string' || !filename.trim()) {
    throw new Error('Missing requestId or filename');
  }

  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename);
    const file = await fileHandle.getFile();
    const blobUrl = URL.createObjectURL(file);

    sendToService({
      name: 'blob_url_from_file',
      data: {
        request_id: requestId,
        blob_url: blobUrl
      }
    });

  } catch (error) {
    console.error('[GrabIt Factory] OPFS → Blob URL failed:', { requestId, filename, error });
    sendToService({
      name: 'blob_url_from_file',
      data: {
        request_id: requestId,
        error: error?.message || String(error)
      }
    });
  }
}

/**
 * Handle download start request from service worker
 * This is called when user clicks "Download" in the popup
 */
async function handleDownloadRequest(downloadArgs) {
  const { download_id: downloadId, strategy, url } = downloadArgs || {};

  if (!downloadId || !strategy || !url) {
    throw new Error('Invalid download arguments: missing downloadId, strategy, or url');
  }

  console.log('[GrabIt Factory] Starting download:', { downloadId, strategy, url });

  // Track this download
  activeDownloads.set(downloadId, {
    id: downloadId,
    strategy,
    url,
    status: 'initializing',
    startTime: Date.now()
  });

  try {
    // Send acknowledgment to service
    sendToService({
      name: 'download_started',
      data: {
        download_id: downloadId,
        strategy,
        timestamp: Date.now()
      }
    });

    // Execute download based on strategy
    // For now, delegate to service worker via message back
    // The service will handle actual download execution (via server or yt-dlp)
    
    // Send progress update
    sendToService({
      name: 'download_progress',
      data: {
        download_id: downloadId,
        progress: {
          status: 'queued',
          percent: 0,
          fetched_bytes_count: 0,
          total_bytes_count: 0,
          is_known: false
        }
      }
    });

  } catch (error) {
    console.error('[GrabIt Factory] Download request error:', { downloadId, error });
    activeDownloads.delete(downloadId);

    sendToService({
      name: 'download_error',
      data: {
        download_id: downloadId,
        error: error?.message || String(error)
      }
    });
  }
}

/**
 * Handle abort/cancel request
 */
function handleAbortDownload(data) {
  const { download_id: downloadId } = data || {};

  if (!downloadId) {
    console.warn('[GrabIt Factory] Abort request missing downloadId');
    return;
  }

  console.log('[GrabIt Factory] Aborting download:', downloadId);

  const download = activeDownloads.get(downloadId);
  if (download) {
    download.status = 'aborted';
    download.abortedAt = Date.now();
  }

  activeDownloads.delete(downloadId);

  sendToService({
    name: 'download_aborted',
    data: {
      download_id: downloadId,
      timestamp: Date.now()
    }
  });
}

// Notify service worker that this factory is ready
console.log('[GrabIt Factory] Worker host initialized, ready for downloads');
sendToService({
  name: 'factory_ready',
  data: {
    timestamp: Date.now()
  }
});

// -------------------------------------------------------
