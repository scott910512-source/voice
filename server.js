'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const { fetchAll, fetchPage, buildUrl } = require('./lib/api');
const { normalizeRecords, summarizeSchema, SEJONG_BOUNDS } = require('./lib/normalize');
const { geocode, distanceMeters, isInSejong } = require('./lib/geocode');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** 전체 조회 결과 캐시. 일일 트래픽 5,000건을 아끼기 위한 것. */
let cache = null;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function loadSigns({ force = false } = {}) {
  const fresh = cache && Date.now() - cache.fetchedAt < config.cacheTtlMs;
  if (fresh && !force) return { ...cache, cached: true };

  const result = await fetchAll(config);
  const signs = normalizeRecords(result.items);
  cache = {
    fetchedAt: Date.now(),
    signs,
    meta: {
      totalCount: result.totalCount,
      fetchedCount: result.fetchedCount,
      truncated: result.truncated,
      format: result.format,
      mappable: signs.filter((s) => s.mappable).length,
    },
    rawItems: result.items,
  };
  return { ...cache, cached: false };
}

function summarize(signs) {
  const counts = { no_stop_no_park: 0, no_park: 0, parking_allowed: 0, other: 0 };
  for (const sign of signs) counts[sign.parking.category] = (counts[sign.parking.category] || 0) + 1;
  return counts;
}

function withinBbox(sign, bbox) {
  if (!bbox) return true;
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return sign.lng >= minLng && sign.lng <= maxLng && sign.lat >= minLat && sign.lat <= maxLat;
}

function parseBbox(value) {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

async function handleSigns(req, res, url) {
  const force = url.searchParams.get('refresh') === '1';
  const data = await loadSigns({ force });

  const categories = (url.searchParams.get('category') || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  const bbox = parseBbox(url.searchParams.get('bbox'));
  const mappableOnly = url.searchParams.get('mappableOnly') !== '0';

  let signs = data.signs;
  if (categories.length) signs = signs.filter((s) => categories.includes(s.parking.category));
  if (query) {
    signs = signs.filter((s) => JSON.stringify(s.raw).toLowerCase().includes(query));
  }
  if (bbox) signs = signs.filter((s) => s.mappable && withinBbox(s, bbox));
  if (mappableOnly) signs = signs.filter((s) => s.mappable);

  json(res, 200, {
    ok: true,
    cached: data.cached,
    fetchedAt: new Date(data.fetchedAt).toISOString(),
    meta: {
      ...data.meta,
      returned: signs.length,
      counts: summarize(data.signs),
      bounds: SEJONG_BOUNDS,
    },
    signs,
  });
}

/** 특정 주소 주변의 주차 표지를 거리순으로 돌려준다. */
async function handleNear(req, res, url) {
  const address = (url.searchParams.get('address') || config.defaultAddress).trim();
  const radius = Number(url.searchParams.get('radius')) || config.defaultRadius;
  const categories = (url.searchParams.get('category') || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const center = await geocode(address, config.geocode);
  const data = await loadSigns({});

  let signs = data.signs.filter((s) => s.mappable);
  if (categories.length) signs = signs.filter((s) => categories.includes(s.parking.category));

  const nearby = signs
    .map((sign) => ({ ...sign, distance: Math.round(distanceMeters(center, sign)) }))
    .filter((sign) => sign.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  const counts = { no_stop_no_park: 0, no_park: 0, parking_allowed: 0, other: 0 };
  nearby.forEach((s) => (counts[s.parking.category] += 1));

  json(res, 200, {
    ok: true,
    center,
    radius,
    // 세종시 밖으로 지오코딩되면 결과가 0건이 나오는데, 원인을 알 수 있게 알려준다.
    warning: isInSejong(center) ? null : '검색된 좌표가 세종특별자치시 범위 밖입니다. 주소를 다시 확인하세요.',
    counts,
    total: nearby.length,
    signs: nearby,
  });
}

async function handleSchema(req, res) {
  const data = await loadSigns({});
  const unmapped = data.signs.filter((s) => !s.mappable);
  json(res, 200, {
    ok: true,
    totalCount: data.meta.totalCount,
    fetchedCount: data.meta.fetchedCount,
    mappable: data.meta.mappable,
    unmappable: unmapped.length,
    coordSourceSample: data.signs.find((s) => s.mappable)?.coordSource || null,
    fields: summarizeSchema(data.rawItems),
    sampleRecord: data.rawItems[0] || null,
  });
}

async function handleProbe(req, res) {
  // 원본 응답을 그대로 확인하기 위한 진단용 엔드포인트.
  const page = await fetchPage(config, 1);
  json(res, 200, {
    ok: true,
    requestedType: page.requestedType,
    format: page.format,
    totalCount: page.totalCount,
    resultMsg: page.resultMsg,
    sampleItems: page.items.slice(0, 3),
    requestUrl: buildUrl({
      endpoint: config.endpoint,
      operation: config.operation,
      serviceKey: 'SERVICE_KEY_HIDDEN',
      pageNo: 1,
      numOfRows: config.numOfRows,
      type: 'json',
      extra: config.extraParams,
    }),
  });
}

function handleConfig(req, res) {
  json(res, 200, {
    ok: true,
    map: {
      provider: config.map.naverClientId
        ? 'naver'
        : config.map.kakaoJsKey
          ? 'kakao'
          : config.map.vworldKey
            ? 'vworld'
            : 'osm',
      naverClientId: config.map.naverClientId,
      kakaoJsKey: config.map.kakaoJsKey,
      vworldKey: config.map.vworldKey,
    },
    defaultAddress: config.defaultAddress,
    defaultRadius: config.defaultRadius,
    bounds: SEJONG_BOUNDS,
  });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/signs') return await handleSigns(req, res, url);
    if (url.pathname === '/api/near') return await handleNear(req, res, url);
    if (url.pathname === '/api/schema') return await handleSchema(req, res);
    if (url.pathname === '/api/probe') return await handleProbe(req, res);
    if (url.pathname === '/api/config') return handleConfig(req, res);
    return serveStatic(req, res, url);
  } catch (error) {
    json(res, 502, {
      ok: false,
      error: error.message,
      hint: '인증키(SERVICE_KEY), 엔드포인트, 네트워크(사내망/방화벽)를 확인하세요. /api/probe 로 원본 응답을 볼 수 있습니다.',
    });
  }
});

server.listen(config.port, () => {
  console.log(`세종 주차표지 지도 서버: http://localhost:${config.port}`);
  console.log(`  · 데이터  : ${config.endpoint}/${config.operation}`);
  console.log(`  · 지도    : ${handleConfigProvider()}`);
});

function handleConfigProvider() {
  if (config.map.naverClientId) return '네이버 지도 (NAVER_MAP_CLIENT_ID)';
  if (config.map.kakaoJsKey) return '카카오맵 (KAKAO_MAP_JS_KEY)';
  if (config.map.vworldKey) return 'VWorld 국내 배경지도 (VWORLD_KEY)';
  return 'OSM 기본 타일 (지도 키 미설정)';
}

module.exports = server;
