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
const streamChannel = new BroadcastChannel('worker_service');

streamChannel.addEventListener('message', async event => {
  if (event.data?.channel !== 2) return;

  const message = event.data.msg;

  if (message?.name === 'revoke_blob_url') {
    const blobUrl = message.data?.blob_url;

    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }

    return;
  }

  if (message?.name !== 'create_blob_url_from_file') return;

  const {
    request_id: requestId,
    filename
  } = message.data || {};

  if (!requestId) return;

  try {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new Error('Missing OPFS filename.');
    }

    const root = await navigator.storage.getDirectory();

    const fileHandle = await root.getFileHandle(filename);
    const file = await fileHandle.getFile();

    const blobUrl = URL.createObjectURL(file);

    streamChannel.postMessage({
      channel: 3,
      msg: {
        name: 'blob_url_from_file',
        data: {
          request_id: requestId,
          blob_url: blobUrl
        }
      }
    });

  } catch (error) {
    console.error('[GrabIt] OPFS → Blob URL failed:', {
      requestId,
      filename,
      error
    });

    streamChannel.postMessage({
      channel: 3,
      msg: {
        name: 'blob_url_from_file',
        data: {
          request_id: requestId,
          error: error?.message || String(error)
        }
      }
    });
  }
});
// -------------------------------------------------------
