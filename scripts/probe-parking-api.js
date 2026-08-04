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

// 확인된 것: tn_pubr_public_prkplce_info_api 경로는 존재하지 않는다.
// 응답이 NO_OPENAPI_SERVICE_ERROR("해당 오픈API 서비스가 없거나 폐기됨")였다.
// 인증 오류가 아니라 서비스 없음이므로 경로 자체가 틀린 것이다.
const CANDIDATES = [
  {
    name: '주차장 정보 (B553881 PrkSttusInfo)',
    url: `https://apis.data.go.kr/B553881/Parking/PrkSttusInfo?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '주차장 운영정보 (B553881 PrkOprInfo)',
    url: `https://apis.data.go.kr/B553881/Parking/PrkOprInfo?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '표준데이터 tn_pubr (api 호스트)',
    url: `https://api.data.go.kr/openapi/tn_pubr_public_prkplce_info_api?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '표준데이터 tn_pubr (apis 호스트)',
    url: `https://apis.data.go.kr/openapi/tn_pubr_public_prkplce_info_api?serviceKey=${KEY}&pageNo=1&numOfRows=3&type=json`,
  },
  {
    name: '세종시 도로안전표지 (지금 쓰는 것 — 대조군)',
    url: `${config.endpoint}/${config.operation}?serviceKey=${KEY}&pageNo=1&numOfRows=1&type=json`,
  },
];

/** 데이터가 왔을 때 바로 연동할 수 있도록 건수와 필드명을 뽑아 둔다. */
function describeData(body) {
  try {
    const json = JSON.parse(body);
    const total =
      json?.response?.body?.totalCount ??
      json?.header?.totalCount ??
      json?.totalCount ??
      json?.body?.totalCount ??
      null;
    const items =
      json?.response?.body?.items?.item ??
      json?.response?.body?.items ??
      json?.body?.items ??
      json?.data ??
      json?.items ??
      null;
    const first = Array.isArray(items) ? items[0] : items;
    if (!first || typeof first !== 'object') return total !== null ? `전체 ${total}건` : '';
    return `전체 ${total ?? '?'}건 · 필드: ${Object.keys(first).join(', ')}`;
  } catch (_) {
    return '';
  }
}

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
    const verdict = classify(response.status, body);
    console.log(`   HTTP ${response.status} · ${response.headers.get('content-type') || '?'}`);
    console.log(`   판정: ${verdict}`);
    if (verdict === '데이터 응답') {
      const summary = describeData(body);
      if (summary) console.log(`   내용: ${summary}`);
    }
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
