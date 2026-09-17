/* ============================================================
   tîşk - SERVICE WORKER
   - Page: network first, so a newly published index.html shows
     right away; the cached copy is used only when offline.
   - Icons and manifest: cache first.
   - Apps Script and every other cross-origin request is never
     intercepted, so login, submissions and photo uploads always
     go straight to the network.
   Bump CACHE_VERSION whenever the list of cached files changes.
   ============================================================ */

const CACHE_VERSION = 'tisk-pwa-v1';
const PAGE_URL = new URL('index.html', self.registration.scope).href;
const STATIC_ASSETS = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'fonts/cormorant-garamond-600-tisk.woff2'
].map(function (path) {
  return new URL(path, self.registration.scope).href;
});

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) {
        return cache.addAll([PAGE_URL].concat(STATIC_ASSETS));
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) {
              cache.put(PAGE_URL, copy);
            });
          }
          return response;
        })
        .catch(function () {
          return caches.match(PAGE_URL);
        })
    );
    return;
  }

  if (STATIC_ASSETS.indexOf(url.href) !== -1) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        return cached || fetch(request);
      })
    );
  }
});
