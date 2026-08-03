// facebook_untrusted.js - Lightweight wrapper for communication with isolated world
// This runs in the MAIN world and communicates with the ISOLATED world detector

// Set up communication channel similar to youtube_untrusted.js
var h = new BroadcastChannel("worker_service");
var r = {
  FromInjectedToService: 0,
  FromContentToService: 1,
  FromServiceToWorker: 2,
  FromWorkerToService: 3,
  FromUntrustedInjectedToTrusted: 4,
  FromTrustedInjectedToUntrusted: 5,
  FromServiceToContent: 6,
  FromServiceToInjected: 7,
  FromServiceToService: 8,
};
function i(o, a = 0) {
  let e = 3735928559 ^ a,
    t = 1103547991 ^ a;
  for (let n = 0, s; n < o.length; n++)
    ((s = o.charCodeAt(n)),
      (e = Math.imul(e ^ s, 2654435761)),
      (t = Math.imul(t ^ s, 1597334677)));
  return (
    (e = Math.imul(e ^ (e >>> 16), 2246822507)),
    (e ^= Math.imul(t ^ (t >>> 13), 3266489909)),
    (t = Math.imul(t ^ (t >>> 16), 2246822507)),
    (t ^= Math.imul(e ^ (e >>> 13), 3266489909)),
    4294967296 * (2097151 & t) + (e >>> 0)
  );
}
var d = new BroadcastChannel(`injected-${i(window.location.href)}`);
function m(o) {
  let a = r.FromUntrustedInjectedToTrusted;
  d.postMessage({ msg: o, channel: a });
}
function l(o) {
  let a = (e) => {
    let t = e.data.msg;
    e.data.channel == r.FromTrustedInjectedToUntrusted && o(t);
  };
  return (
    d.addEventListener("message", a),
    () => {
      d.removeEventListener("message", a);
    }
  );
}
// Note: Unlike youtube_untrusted.js, facebook doesn't seem to have
// specific initialization code like youtube_on_visitor_data
// This is just a basic communication setup