// Kept deliberately small to mirror VDown's factory document. The LibAV
// worker communicates with the background through BroadcastChannel, so this
// page only needs to give it a durable MV3 document to live in.
new Worker(chrome.runtime.getURL('scripts/stream-worker/main.js'), { type: 'module' });

// A few LibAV strategies return their OPFS filename without a Blob URL. The
// service worker cannot create Blob URLs, so expose the same OPFS-to-URL bridge
// VDown uses in its UI from this durable offscreen document.
const streamChannel = new BroadcastChannel('worker_service');
streamChannel.addEventListener('message', async event => {
  if (event.data?.channel !== 2) return;
  const message = event.data.msg;
  if (message?.name === 'revoke_blob_url') {
    URL.revokeObjectURL(message.data?.blob_url);
    return;
  }
  if (message?.name !== 'create_blob_url_from_file') return;
  const { request_id: requestId, filename } = message.data || {};
  try {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(filename)).getFile();
    streamChannel.postMessage({ channel: 3, msg: { name: 'blob_url_from_file', data: { request_id: requestId, blob_url: URL.createObjectURL(file) } } });
  } catch (error) {
    streamChannel.postMessage({ channel: 3, msg: { name: 'blob_url_from_file', data: { request_id: requestId, error: error.message || String(error) } } });
  }
});
