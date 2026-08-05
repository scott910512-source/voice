'use strict';

/**
 * 서버 없이 도는 정적 웹앱(PWA)을 docs/ 에 만든다.
 * GitHub Pages가 docs/ 를 그대로 서빙하고, 폴더째 받아 index.html을
 * 더블클릭해도 동작한다.
 *
 *   node scripts/build-static.js            공공데이터를 받아서 빌드
 *   node scripts/build-static.js --no-fetch 기존 데이터를 두고 화면만 다시 빌드
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const { fetchData } = require('./fetch-data');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOCS_DIR = path.join(ROOT, 'docs');
const DATA_FILE = path.join(DOCS_DIR, 'data', 'signs.js');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/**
 * 데이터를 JSON이 아니라 JS 파일로 쓴다.
 * file:// 로 열었을 때 fetch는 CORS로 막히지만 <script>는 로드되기 때문이다.
 */
function writeDataFile(payload) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const body = `/* 자동 생성 파일. scripts/build-static.js 가 만든다. 직접 수정하지 말 것. */\nwindow.__SEJONG_DATA__ = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(DATA_FILE, body);
  return body.length;
}

function writeManifest() {
  const manifest = {
    name: '세종 지도 보기 (2D·3D)',
    short_name: '세종 지도',
    description: 'VWorld 국내 지도를 2D와 3D로 봅니다.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#2563eb',
    lang: 'ko',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  fs.writeFileSync(path.join(DOCS_DIR, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
}

/**
 * 빌드 결과물 전체의 내용 해시.
 *
 * 서비스워커 버전을 데이터 시각으로만 잡으면, 데이터가 그대로인 채 코드만
 * 고친 배포에서는 sw.js가 한 글자도 바뀌지 않는다. 그러면 브라우저가 새
 * 서비스워커를 설치하지 않아 사용자는 옛 코드를 계속 쓰게 된다. 실제로
 * 그래서 강력 새로고침을 해야만 수정이 반영됐다. 내용이 바뀌면 버전도
 * 바뀌도록 파일 내용에서 해시를 만든다.
 */
function contentHash(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'sw.js') {
        hash.update(path.relative(dir, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/**
 * 앱 셸과 데이터를 캐시해 오프라인에서도 열리게 한다.
 * 버전이 바뀌면 이전 캐시를 지우고 새로 받는다.
 */
function writeServiceWorker(version) {
  const assets = [
    './',
    'index.html',
    'style.css',
    'view2d.js',
    'vworld-data.js',
    'sw-register.js',
    'data/signs.js',
    'manifest.webmanifest',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'vendor/leaflet/leaflet.js',
    'vendor/leaflet/leaflet.css',
    '3d.html',
    '3d.js',
    'vendor/maplibre/maplibre-gl.js',
    'vendor/maplibre/maplibre-gl.css',
  ];

  const sw = `/* 자동 생성 파일. scripts/build-static.js 가 만든다. */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'sejong-map-' + VERSION;
const ASSETS = ${JSON.stringify(assets, null, 2)};

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
`;
  fs.writeFileSync(path.join(DOCS_DIR, 'sw.js'), sw);
}

async function build() {
  const skipFetch = process.argv.includes('--no-fetch');

  let previous = null;
  if (fs.existsSync(DATA_FILE)) {
    const text = fs.readFileSync(DATA_FILE, 'utf8');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) previous = JSON.parse(text.slice(start, end + 1));
  }

  let data;
  if (skipFetch && previous) {
    console.log('공공데이터 조회를 건너뛰고 기존 데이터를 사용합니다.');
    data = previous;
  } else if (skipFetch) {
    console.log('기존 데이터가 없어 빈 데이터로 빌드합니다.');
    data = { generatedAt: null, meta: { counts: {} }, fields: [], signs: [] };
  } else {
    // 화면은 더 이상 도로안전표지 데이터를 쓰지 않는다(지도 인증키만 쓴다).
    // 그래서 공공데이터 조회가 실패해도 빌드를 멈추지 않는다. 실패했다고
    // 배포까지 막히면 지도조차 못 보게 된다.
    try {
      data = await fetchData();
    } catch (error) {
      console.log('');
      console.log(`공공데이터 조회 실패: ${error.message}`);
      console.log('화면은 이 데이터를 쓰지 않으므로 그대로 진행합니다.');
      data = previous || { generatedAt: null, meta: { counts: {} }, fields: [], signs: [] };
    }
  }

  if (fs.existsSync(DOCS_DIR)) fs.rmSync(DOCS_DIR, { recursive: true });
  copyDir(PUBLIC_DIR, DOCS_DIR);

  // GitHub Pages가 _로 시작하는 경로를 Jekyll로 처리하지 않도록 막는다.
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');

  const payload = {
    ...data,
    defaultAddress: config.defaultAddress,
    defaultRadius: config.defaultRadius,
    // 네이버·카카오 JS 키와 VWorld 키는 브라우저에 노출되는 것이 정상인
    // 클라이언트 키다(콘솔에서 도메인으로 사용을 제한한다). 설정돼 있으면
    // 정적 배포에도 넣어 국내 지도로 뜨게 한다. 없으면 오픈소스 타일을 쓴다.
    map: {
      naverClientId: config.map.naverClientId,
      kakaoJsKey: config.map.kakaoJsKey,
      vworldKey: config.map.vworldKey,
    },
  };

  const bytes = writeDataFile(payload);
  writeManifest();
  // 매니페스트·데이터까지 쓴 뒤에 해시를 낸다. 그래야 데이터만 바뀐 배포도 잡힌다.
  const version = contentHash(DOCS_DIR);
  writeServiceWorker(version);

  const mapProvider = config.map.naverClientId
    ? '네이버 지도'
    : config.map.kakaoJsKey
      ? '카카오맵'
      : config.map.vworldKey
        ? 'VWorld 국내 배경지도'
        : 'OpenStreetMap (지도 키 미설정)';

  console.log('');
  console.log(`docs/ 빌드 완료 · 표지 ${data.signs.length}건 · 데이터 ${Math.round(bytes / 1024)}KB`);
  console.log(`지도: ${mapProvider}`);
  console.log(`버전: ${version}`);
}

build().catch((error) => {
  console.error(`빌드 실패: ${error.message}`);
  process.exit(1);
});
