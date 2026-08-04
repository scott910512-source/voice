/* 자동 생성 파일. scripts/build-static.js 가 만든다. */
const VERSION = "2026-08-04T04:55:49.827Z";
const CACHE = 'sejong-parking-' + VERSION;
const ASSETS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "map.js",
  "data/signs.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css"
];

self.addEventListener('install', (event) => {
  // 개별 자산 하나가 실패해도 설치는 끝나야 한다. 지도 타일처럼 없어도 되는 것이 있다.
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(ASSETS.map((url) => cache.add(url)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 지도 타일과 주소 검색은 캐시하지 않는다. 용량이 크고 자주 바뀐다.
  if (url.origin !== self.location.origin) return;

  // 앱 셸은 캐시 우선. 오프라인에서도 즉시 뜨는 것이 중요하다.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match('index.html'));
    })
  );
});
