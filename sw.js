/* Incognitho service worker: app files network-first, recognition models cache-first (they are versioned) */
const VERSION = 'incognitho-v1.0';
const APP = ['./', 'index.html', 'style.css', 'app.js', 'detect.js', 'track.js', 'mask.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const MODELS = 'incognitho-models-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== MODELS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/cdn\.jsdelivr\.net|storage\.googleapis\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(caches.open(MODELS).then(async c => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => { if (res.ok) { const cl = res.clone(); caches.open(VERSION).then(c => c.put(req, cl)); } return res; }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
