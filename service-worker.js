// 마끝마 뽀모 PWA Service Worker
// v3.1.0 — 접속자 표시 기준 통일 패치

const CACHE_NAME = 'pomo-github-standalone-v3-20260709-presence-v4';
const STATIC_ASSETS = [
  './offline.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('pomo-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Apps Script/Firebase/Google CDN 등 외부 요청은 서비스워커가 건드리지 않음
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  const p = url.pathname;
  const isShell =
    req.mode === 'navigate' ||
    p.endsWith('/') ||
    p.endsWith('/index.html') ||
    p.endsWith('/index%20(1).html') ||
    p.endsWith('/config.js') ||
    p.endsWith('/service-worker.js') ||
    p.endsWith('/kill-sw.html');

  if (isShell) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .catch(async () => {
          if (req.mode === 'navigate') return (await caches.match('./offline.html')) || Response.error();
          return Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (!res || !res.ok || res.type === 'opaque') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => null);
        return res;
      }).catch(() => Response.error());
    })
  );
});
