'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULT_ENDPOINT, DEFAULT_OPERATION } = require('./lib/api');

/** 의존성 없이 .env를 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다. */
function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

/**
 * 포털에서 발급받은 일반 인증키(Encoding). 운영 시에는 .env / 환경변수로 덮어쓴다.
 * 키를 코드에 남기고 싶지 않다면 SERVICE_KEY 환경변수만 설정하면 된다.
 */
const FALLBACK_SERVICE_KEY =
  '0r12dGCCu8TOF%2BupSP4ZBLBIoEDfURRfuPo02NDCNkI7bOLBd5rvljznDu4KVxT%2B%2BFuYrEMyAqf%2F9OqRJFqJPA%3D%3D';

function intFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const config = {
  port: intFromEnv('PORT', 3000),
  endpoint: process.env.API_ENDPOINT || DEFAULT_ENDPOINT,
  operation: process.env.API_OPERATION || DEFAULT_OPERATION,
  serviceKey: process.env.SERVICE_KEY || FALLBACK_SERVICE_KEY,
  numOfRows: intFromEnv('NUM_OF_ROWS', 500),
  // 일일 트래픽이 5,000건이므로 한 번의 전체 조회가 그 안에서 끝나도록 상한을 둔다.
  maxRecords: intFromEnv('MAX_RECORDS', 3000),
  timeoutMs: intFromEnv('API_TIMEOUT_MS', 15000),
  retries: intFromEnv('API_RETRIES', 3),
  cacheTtlMs: intFromEnv('CACHE_TTL_MS', 6 * 60 * 60 * 1000),
  extraParams: {},
  map: {
    // 네이버 지도 JS v3 (ncpKeyId). 설정하면 네이버 지도를 사용한다.
    naverClientId: process.env.NAVER_MAP_CLIENT_ID || '',
    // 카카오맵 JS SDK 앱키. 네이버 키가 없을 때 사용한다.
    kakaoJsKey: process.env.KAKAO_MAP_JS_KEY || '',
    // 국토교통부 VWorld 인증키. 위 둘이 없을 때 국내 배경지도 타일로 사용한다.
    vworldKey: process.env.VWORLD_KEY || '',
  },
};

module.exports = config;
