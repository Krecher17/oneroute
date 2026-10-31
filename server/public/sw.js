// ONEROUTE service worker: lets the app open instantly and show its screens even with no signal.
// Live data (trips, accounts, maps, voice) always goes to the network and is never stored here.
const VERSION = 'oneroute-v2';
const SHELL = [
  '/', '/orb.js', '/socket.io/socket.io.js', '/vendor/maplibre-gl.js', '/vendor/maplibre-gl.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/privacy.html', '/terms.html', '/cookies.html', '/refund.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url)))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Live data is never saved. The socket.io script file itself is (the app cannot start without it); its live connections are not.
const NEVER_CACHE = /^\/(api|live|admin|avatar)(\/|$)|^\/socket\.io\/(?!socket\.io\.js$)/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname) || url.pathname === '/sw.js') return;

  // The app page: always try the network first so updates arrive, fall back to the saved copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === '/') caches.open(VERSION).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match(url.pathname === '/' ? '/' : req, { ignoreSearch: true }).then((hit) => hit || caches.match('/'))),
    );
    return;
  }

  // Scripts, styles and icons: show the saved copy straight away and refresh it in the background
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    }),
  );
});
