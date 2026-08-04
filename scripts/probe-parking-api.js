'use strict';

/**
 * 주차장 데이터 후보 API를 찔러 보고, 어느 것이 지금 인증키로 열리는지 확인한다.
 *
 *   node scripts/probe-parking-api.js
 *
 * 도로안전표지 데이터가 쓸 만하지 않아(2020년 기준, 한누리대로 20건) 주차
 * 가능 여부를 판단할 수 없다. 대체 데이터로 갈아타기 전에, 어떤 엔드포인트가
 * 실제로 응답하는지부터 확인해야 한다.
 *
 * 응답을 세 가지로 구분한다.
 *   - 데이터 옴          → 바로 쓸 수 있다
 *   - 인증/권한 오류     → 엔드포인트는 맞다. 활용신청만 하면 된다
 *   - 경로 없음/HTML     → 엔드포인트가 틀렸다
 */

const config = require('./../config');

const KEY = config.serviceKey;

/** 공공데이터포털이 권한 문제를 알리는 방식이 제각각이라 넓게 잡는다. */
const AUTH_HINTS = [
  'SERVICE_KEY_IS_NOT_REGISTERED',
  'SERVICE ACCESS DENIED',
  'SERVICE_ACCESS_DENIED',
  'APPLICATION_ERROR',
  'UNREGISTERED',
  '등록되지 않은',
  '활용신청',
  '권한',
  'LIMITED_NUMBER_OF_SERVICE_REQUESTS',
];

const CANDIDATES = [
  {
    name: '전국주차장정보표준데이터 (행안부 표준데이터 API)',
    url: `https://api.data.go.kr/openapi/tn_pubr_public_prkplce_info_api?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '전국주차장정보표준데이터 (apis 호스트)',
    url: `https://apis.data.go.kr/openapi/tn_pubr_public_prkplce_info_api?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '세종시 도로안전표지 (지금 쓰는 것 — 대조군)',
    url: `${config.endpoint}/${config.operation}?serviceKey=${KEY}&pageNo=1&numOfRows=1&type=json`,
  },
];

function classify(status, body) {
  const text = body.slice(0, 2000);
  if (/^\s*</.test(text) && /html/i.test(text)) return '엔드포인트 틀림 (HTML 오류 페이지)';
  if (status === 404) return '엔드포인트 틀림 (404)';
  if (AUTH_HINTS.some((hint) => text.toUpperCase().includes(hint.toUpperCase()))) {
    return '엔드포인트 맞음 — 활용신청 필요';
  }
  if (status === 200 && /"?(items?|body|response)"?/i.test(text)) return '데이터 응답';
  return `판단 보류 (HTTP ${status})`;
}

async function probe(candidate) {
  console.log(`\n── ${candidate.name}`);
  console.log(`   ${candidate.url.replace(KEY, '<인증키>')}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(candidate.url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const body = await response.text();
    console.log(`   HTTP ${response.status} · ${response.headers.get('content-type') || '?'}`);
    console.log(`   판정: ${classify(response.status, body)}`);
    console.log(`   본문: ${body.slice(0, 400).replace(/\s+/g, ' ')}`);
    return { ...candidate, status: response.status, body };
  } catch (error) {
    console.log(`   실패: ${error.message}`);
    return { ...candidate, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`인증키: ${KEY.slice(0, 8)}… (${KEY.length}자)`);
  const results = [];
  for (const candidate of CANDIDATES) results.push(await probe(candidate));

  console.log('\n── 정리 ──────────────────────────────────');
  for (const result of results) {
    const verdict = result.error ? `접속 실패 (${result.error})` : classify(result.status, result.body);
    console.log(`${verdict.padEnd(34)} ${result.name}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  // 확인 스크립트가 빌드를 실패시키면 안 된다.
});
