// 마끝마 뽀모 PWA Service Worker
// v1.2.0 — iframe 차단 보정판 / 외피 파일은 항상 네트워크 우선

const CACHE_NAME = 'pomo-pwa-static-v1.2.0';
const STATIC_ASSETS = [
  './offline.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 아이콘 파일이 누락되어도 서비스워커 설치 자체가 실패하지 않게 방어
    await Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('pomo-pwa-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Apps Script/Firebase/Google 외부 요청은 절대 건드리지 않음
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  const isShellFile =
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/config.js') ||
    url.pathname.endsWith('/service-worker.js');

  // 외피/설정/탐색은 항상 최신 네트워크 우선
  if (req.mode === 'navigate' || isShellFile) {
    event.respondWith((async () => {
      try {
        return await fetch(req, { cache: 'no-store' });
      } catch (e) {
        if (req.mode === 'navigate') {
          return (await caches.match('./offline.html')) || Response.error();
        }
        return Response.error();
      }
    })());
    return;
  }

  // 아이콘/매니페스트/오프라인 화면만 캐시 우선
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type !== 'opaque') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
