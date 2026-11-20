// cctv.js: talk to the footfall Mac helper (go2rtc v1.9.15) from the page.
//
// The helper serves this page itself on http://127.0.0.1:41984, so the page,
// the API and the video share one origin. That is what lets the counter draw
// the video to a canvas and read its pixels (getImageData) without a security
// error. On any other host (GitHub Pages, a file:// copy) helperAvailable()
// says false without making a single request.
//
// Playback is MSE over go2rtc's WebSocket (/api/ws): fragmented MP4 pushed into
// a MediaSource. It works in desktop Chrome and desktop Safari (ManagedMediaSource
// on Safari 17+), needs no extra port and no STUN server, and the video stays
// same-origin. The MSE handling follows go2rtc's own player, www/video-rtc.js
// (MIT, Alexey Khit; see vendor/go2rtc/LICENSE), cut down to what is needed here.

const HELPER_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// helper/go2rtc.yaml api.listen. Checked before any request, so a local dev
// server on another port gets no stray /api 404 in its console either.
export const HELPER_PORT = '41984';

// Codecs offered to go2rtc, in the order its own player offers them. Only the
// ones this browser can decode are sent, and go2rtc picks one the camera has.
const VIDEO_CODECS = [
  'avc1.640029',      // H.264 High 4.1
  'avc1.64002A',      // H.264 High 4.2
  'avc1.640033',      // H.264 High 5.1
  'hvc1.1.6.L153.B0', // H.265 Main 5.1 (many CCTV cameras send this)
];

// Keep only the last few seconds buffered: this is a live counter, not a recorder.
const KEEP_SECONDS = 5;

let availableCache = null;

/** True only when this page is being served by the helper. */
export async function helperAvailable({ timeoutMs = 1500 } = {}) {
  if (availableCache !== null) return availableCache;
  const loc = globalThis.location;
  if (!loc || loc.protocol !== 'http:' || !HELPER_HOSTS.has(loc.hostname) || loc.port !== HELPER_PORT) {
    availableCache = false;
    return false;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('/api', { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) return (availableCache = false);
    const info = await res.json();
    // go2rtc's /api answers with its version; any other server on this port does not.
    availableCache = typeof info?.version === 'string';
  } catch {
    availableCache = false;
  } finally {
    clearTimeout(timer);
  }
  return availableCache;
}

/**
 * rtsp://user:secret@host/path -> rtsp://user:***@host/path (never show a password).
 * Masks every address inside a longer text too, e.g. an error message.
 */
export function maskAddress(address) {
  if (typeof address !== 'string') return '';
  return address.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*)@/gi, (m, scheme, cred) => {
    // go2rtc's own /api/streams already masks the whole user:password as "***".
    if (cred === '***') return m;
    const user = cred.split(':')[0];
    return `${scheme}${user ? user + ':' : ''}***@`;
  });
}

function sourceAddress(stream) {
  const p = (stream?.producers || []).find(x => x && typeof x.url === 'string' && x.url);
  return p ? p.url : '';
}

/** [{name, address}] with the password masked. */
export async function listCameras() {
  const res = await fetch('/api/streams', { cache: 'no-store' });
  if (!res.ok) throw new Error(`helper answered ${res.status}`);
  const all = (await res.json()) || {};
  return Object.keys(all).sort().map(name => ({
    name,
    address: maskAddress(sourceAddress(all[name])),
  }));
}

function nameFor(address) {
  let host = 'camera';
  try {
    // URL() parses rtsp:// as an opaque-ish URL but still finds the host.
    host = new URL(address).hostname || host;
  } catch { /* keep default */ }
  return ('cam-' + host).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/, '');
}

/**
 * Add a camera by its RTSP address. The helper keeps it in helper/cameras.yaml
 * on this Mac. Returns {name, address} with the password masked.
 */
export async function addCamera(address, name) {
  const addr = String(address || '').trim();
  if (!/^rtsps?:\/\/[^\s]+$/i.test(addr)) {
    throw new Error('A camera address starts with rtsp:// (for example rtsp://192.168.1.20:554/stream1)');
  }
  const n = String(name || nameFor(addr)).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!n) throw new Error('camera name is empty');
  const q = new URLSearchParams({ name: n, src: addr });
  const res = await fetch('/api/streams?' + q.toString(), { method: 'PUT' });
  if (!res.ok) {
    // go2rtc's error text can echo the source; mask it before it reaches the page.
    const text = maskAddress((await res.text()).trim().replaceAll(addr, maskAddress(addr)));
    throw new Error(`helper refused the camera: ${text || res.status}`);
  }
  return { name: n, address: maskAddress(addr) };
}

export async function removeCamera(name) {
  const res = await fetch('/api/streams?' + new URLSearchParams({ src: name }), { method: 'DELETE' });
  if (!res.ok) throw new Error(`helper answered ${res.status}`);
}

function wsURL(name) {
  const loc = globalThis.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/api/ws?src=${encodeURIComponent(name)}`;
}

/**
 * Play camera `name` live in `video`. Returns stop(). `onStatus` (optional)
 * gets short plain strings: 'connecting', 'playing <codec>', 'reconnecting',
 * 'stopped', or 'error: ...'.
 */
export function attach(video, name, { onStatus = () => {}, reconnectMs = 3000 } = {}) {
  const MS = globalThis.ManagedMediaSource || globalThis.MediaSource;
  if (!MS) {
    onStatus('error: this browser cannot play the camera (no Media Source support)');
    return () => {};
  }

  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  let stopped = false;
  let ws = null;
  let retry = 0;
  let objectURL = '';

  const cleanupMedia = () => {
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = ''; }
    video.removeAttribute('src');
    video.srcObject = null;
    try { video.load(); } catch { /* nothing to reset */ }
  };

  const connect = () => {
    if (stopped) return;
    onStatus('connecting');
    const ms = new MS();
    let sb = null;
    // Data that arrives while the SourceBuffer is busy waits here.
    const pending = [];

    const appendNext = () => {
      if (!sb || sb.updating || pending.length === 0) return;
      const chunks = pending.splice(0);
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { all.set(new Uint8Array(c), off); off += c.byteLength; }
      try { sb.appendBuffer(all); } catch { /* buffer full or closed; next update retries */ }
    };

    const keepLive = () => {
      if (!sb || sb.updating || !sb.buffered || sb.buffered.length === 0) return;
      const end = sb.buffered.end(sb.buffered.length - 1);
      const start = end - KEEP_SECONDS;
      const start0 = sb.buffered.start(0);
      if (start > start0) {
        try {
          sb.remove(start0, start);
          if (ms.setLiveSeekableRange) ms.setLiveSeekableRange(start, end);
        } catch { /* removal can race with close */ }
      }
      if (video.currentTime < start) video.currentTime = start;
      // Speed up a little when behind, so the counter sees "now", not 5 s ago.
      const gap = end - video.currentTime;
      video.playbackRate = gap > 0.5 ? Math.min(gap, 2) : 1;
    };

    ms.addEventListener('sourceopen', () => {
      if (stopped) return;
      const offer = VIDEO_CODECS.filter(c => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join(',');
      if (!offer) { onStatus('error: this browser cannot decode H.264 or H.265 video'); return; }
      ws = new WebSocket(wsURL(name));
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'mse', value: offer })));
      ws.addEventListener('message', ev => {
        if (typeof ev.data === 'string') {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === 'mse' && !sb) {
            try {
              sb = ms.addSourceBuffer(msg.value);
            } catch {
              onStatus('error: the camera sends a video format this browser cannot play');
              return;
            }
            sb.mode = 'segments';
            sb.addEventListener('updateend', () => { appendNext(); keepLive(); });
            retry = 0;
            const codec = (/codecs="([^"]+)"/.exec(msg.value) || [])[1] || msg.value;
            onStatus('playing ' + codec);
            video.play().catch(() => { /* autoplay is allowed for muted video */ });
          } else if (msg.type === 'error') {
            onStatus('error: ' + maskAddress(String(msg.value || 'camera not reachable')));
            // go2rtc leaves the socket open after an error; close it so 'close' retries.
            try { ws.close(); } catch { /* already closing */ }
          }
          return;
        }
        pending.push(ev.data);
        appendNext();
      });
      ws.addEventListener('close', () => {
        ws = null;
        if (stopped) return;
        onStatus('reconnecting');
        cleanupMedia();
        // Back off a little each time, so a camera that is off is not hammered.
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, reconnectMs * retry);
      });
    }, { once: true });

    if (globalThis.ManagedMediaSource && MS === globalThis.ManagedMediaSource) {
      video.disableRemotePlayback = true;
      video.srcObject = ms;
    } else {
      objectURL = URL.createObjectURL(ms);
      video.src = objectURL;
    }
  };

  connect();

  return function stop() {
    if (stopped) return;
    stopped = true;
    if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
    cleanupMedia();
    onStatus('stopped');
  };
}
