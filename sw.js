/**
 * LeafDiag — Service Worker
 * Stratégie : Cache-First pour assets statiques
 *             Network-First pour OpenCV.js (gros fichier externe)
 */

const CACHE_NAME    = 'leafdoctor-v2';
const CACHE_OPENCV  = 'leafdoctor-opencv-v1';

// Assets locaux mis en cache à l'installation
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// OpenCV.js — mis en cache séparément (lourd ~8 Mo)
const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';

// ─── Installation ────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      // Cache des assets locaux
      caches.open(CACHE_NAME).then(cache =>
        cache.addAll(STATIC_ASSETS).catch(err =>
          console.warn('[SW] Certains assets non mis en cache :', err)
        )
      ),
      // Cache OpenCV.js en arrière-plan (ne bloque pas l'install)
      fetch(OPENCV_URL)
        .then(res => caches.open(CACHE_OPENCV).then(c => c.put(OPENCV_URL, res)))
        .catch(() => console.warn('[SW] OpenCV.js non mis en cache (hors-ligne?)'))
    ])
  );
  self.skipWaiting();
});

// ─── Activation — nettoyage anciens caches ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CACHE_OPENCV)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch — stratégie par type ──────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // OpenCV.js : Cache-First (gros fichier, change rarement)
  if (url.includes('opencv.js')) {
    event.respondWith(
      caches.open(CACHE_OPENCV).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            cache.put(event.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // Assets locaux : Cache-First
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            if (res && res.status === 200 && res.type !== 'opaque') {
              cache.put(event.request, res.clone());
            }
            return res;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // Tout le reste : Network avec fallback cache
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request)
    )
  );
});

// ─── Message : forcer mise à jour ────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
