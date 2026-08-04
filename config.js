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

/** VWorld 인증키. VWORLD_KEY 환경변수로 덮어쓸 수 있다. */
const FALLBACK_VWORLD_KEY = '87C1B279-734F-3853-8538-F4B325EFC201';

function intFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const config = {
  port: intFromEnv('PORT', 3000),
  endpoint: process.env.API_ENDPOINT || DEFAULT_ENDPOINT,
  operation: process.env.API_OPERATION || DEFAULT_OPERATION,
  serviceKey: process.env.SERVICE_KEY || FALLBACK_SERVICE_KEY,
  // 이 API는 numOfRows를 무시하고 페이지당 20건만 준다. 값은 남겨두되
  // 페이지 순회는 실제 수신 건수를 기준으로 한다.
  numOfRows: intFromEnv('NUM_OF_ROWS', 100),
  // 일일 트래픽이 5,000건이므로 한 번의 전체 조회가 그 안에서 끝나도록 상한을 둔다.
  maxRecords: intFromEnv('MAX_RECORDS', 3000),
  maxPages: intFromEnv('MAX_PAGES', 60),
  // 전체 조회 시간 상한. 뒤쪽 페이지에서 응답이 멎어도 여기서 끊고
  // 받은 만큼으로 진행한다.
  deadlineMs: intFromEnv('FETCH_DEADLINE_MS', 90000),
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
    // VWorld 키는 지도를 띄우려면 페이지에 그대로 실려야 하는 클라이언트
    // 키다(타일 URL과 스크립트 URL에 들어간다). 숨길 수 있는 값이 아니고,
    // VWorld 콘솔에서 도메인을 등록해 사용을 제한하는 방식이다.
    vworldKey: process.env.VWORLD_KEY || FALLBACK_VWORLD_KEY,
  },
  geocode: {
    // 주소 검색용 키. 지도 키와 종류가 다르다(카카오는 REST 키, 네이버는 Secret 필요).
    vworldKey: process.env.VWORLD_KEY || FALLBACK_VWORLD_KEY,
    kakaoRestKey: process.env.KAKAO_REST_KEY || '',
    naverClientId: process.env.NAVER_MAP_CLIENT_ID || '',
    naverClientSecret: process.env.NAVER_MAP_CLIENT_SECRET || '',
  },
  // 화면을 처음 열었을 때 중심이 될 위치.
  defaultAddress: process.env.DEFAULT_ADDRESS || '세종특별자치시 연동면 내판리 715',
  defaultRadius: intFromEnv('DEFAULT_RADIUS_M', 500),
};

module.exports = config;
