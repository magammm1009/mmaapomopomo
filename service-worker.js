// 마끝마 뽀모 PWA Service Worker
// v1.1.1 — GitHub 외피(index/config/sw)는 항상 최신본, Apps Script iframe은 절대 건드리지 않음

const CACHE_NAME = 'pomo-pwa-static-v1.1.1';
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
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('pomo-pwa-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ✅ Apps Script iframe 및 외부 요청은 서비스워커가 건드리면 안 됨
  if (url.origin !== self.location.origin) return;

  // ✅ GET 외에는 그대로 브라우저 처리
  if (req.method !== 'GET') return;

  const isLiveShellFile =
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/config.js') ||
    url.pathname.endsWith('/service-worker.js');

  // ✅ 앱 껍데기/설정 파일은 항상 네트워크 최신본 우선
  if (req.mode === 'navigate' || isLiveShellFile) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .catch(async () => {
          if (req.mode === 'navigate') {
            return (await caches.match('./offline.html')) || Response.error();
          }
          return Response.error();
        })
    );
    return;
  }

  // ✅ 아이콘/매니페스트/오프라인 화면 같은 정적 파일만 캐시 우선
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (!res || !res.ok || res.type === 'opaque') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => Response.error());
    })
  );
});
