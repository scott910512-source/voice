'use strict';

/**
 * 공공데이터를 받아 정적 배포용 데이터로 만든다.
 * 서버 없이 동작하는 웹앱(GitHub Pages / 로컬 파일)이 이 결과를 읽는다.
 *
 *   node scripts/fetch-data.js
 *
 * CI에서 실행되므로 실제 응답 구조를 로그로 남긴다. 지자체 API는 필드명이
 * 문서와 다른 경우가 있어, 실패했을 때 원인을 로그만 보고 알 수 있어야 한다.
 */

const config = require('../config');
const { fetchAll } = require('../lib/api');
const { normalizeRecords, summarizeSchema } = require('../lib/normalize');

async function fetchData() {
  console.log(`요청: ${config.endpoint}/${config.operation}`);
  console.log(`인증키: ${config.serviceKey.slice(0, 8)}… (${config.serviceKey.length}자)`);

  const result = await fetchAll(config);
  const signs = normalizeRecords(result.items);

  const counts = { no_stop_no_park: 0, no_park: 0, parking_allowed: 0, other: 0 };
  signs.forEach((s) => (counts[s.parking.category] += 1));
  const mappable = signs.filter((s) => s.mappable).length;

  console.log('');
  console.log('── 응답 요약 ────────────────────────────────');
  console.log(`형식        : ${result.format} (요청 type=${result.requestedType})`);
  console.log(`전체 건수   : ${result.totalCount}`);
  console.log(`수신 건수   : ${result.fetchedCount}`);
  console.log(`페이지 크기 : ${result.pageSize}`);
  console.log(`소요 시간   : ${(result.elapsedMs / 1000).toFixed(1)}초`);
  if (result.notes && result.notes.length) {
    result.notes.forEach((note) => console.log(`페이지 메모  : ${note}`));
  }
  console.log(`좌표 인식   : ${mappable} / ${signs.length}`);
  console.log(`좌표 출처   : ${signs.find((s) => s.mappable)?.coordSource || '없음'}`);
  console.log('');
  console.log('── 주차 분류 ────────────────────────────────');
  console.log(`주차 가능      : ${counts.parking_allowed}`);
  console.log(`주차 금지      : ${counts.no_park}`);
  console.log(`정차·주차 금지 : ${counts.no_stop_no_park}`);
  console.log(`주차 무관      : ${counts.other}`);
  console.log('');
  console.log('── 실제 응답 필드 ───────────────────────────');
  for (const field of summarizeSchema(result.items)) {
    console.log(`${field.field.padEnd(22)} 값있음 ${String(field.nonEmpty).padStart(5)}건  예: ${field.samples.join(' / ')}`);
  }
  console.log('');
  console.log('── 첫 레코드 원본 ───────────────────────────');
  console.log(JSON.stringify(result.items[0], null, 2));

  if (mappable === 0) {
    console.log('');
    console.log('[경고] 좌표를 인식하지 못했습니다. lib/normalize.js의 LAT_KEYS/LNG_KEYS에');
    console.log('       위 필드명을 추가해야 합니다.');
  }
  if (counts.parking_allowed + counts.no_park + counts.no_stop_no_park === 0) {
    console.log('');
    console.log('[경고] 주차 관련 표지가 0건입니다. 이 데이터셋에 표지 종류 필드가 없을 수 있습니다.');
    console.log('       위 필드 목록에서 표지명에 해당하는 값을 확인하고');
    console.log('       lib/normalize.js의 PARKING_RULES 키워드를 맞춰야 합니다.');
  }

  const coverage = summarizeCoverage(signs);
  console.log('');
  console.log('── 데이터가 포함하는 범위 ─────────────────────');
  console.log(`노선   : ${coverage.routes.join(', ') || '없음'}`);
  console.log(`읍면동 : ${coverage.areas.join(', ') || '없음'}`);
  if (coverage.bounds) {
    console.log(
      `좌표   : 위도 ${coverage.bounds.minLat}~${coverage.bounds.maxLat} / 경도 ${coverage.bounds.minLng}~${coverage.bounds.maxLng}`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    source: `${config.endpoint}/${config.operation}`,
    meta: {
      totalCount: result.totalCount,
      fetchedCount: result.fetchedCount,
      uniqueCount: result.uniqueCount,
      truncated: result.truncated,
      format: result.format,
      mappable,
      counts,
      notes: result.notes,
    },
    coverage,
    fields: summarizeSchema(result.items),
    signs,
  };
}

/**
 * 이 데이터가 실제로 어디를 담고 있는지 요약한다.
 * 주소를 검색했는데 아무것도 안 나올 때, 표지가 없는 것인지
 * 데이터에 그 동네가 아예 없는 것인지 구분해 주기 위한 것이다.
 */
function summarizeCoverage(signs) {
  const mapped = signs.filter((s) => s.mappable);
  const routes = [...new Set(signs.map((s) => s.route || s.raw.roadRouteNm).filter(Boolean))];
  const areas = [
    ...new Set(
      signs
        .map((s) => String(s.address || '').match(/세종특별자치시\s*([가-힣]+(?:동|면|리|읍))/)?.[1])
        .filter(Boolean)
    ),
  ];
  const bounds = mapped.length
    ? {
        minLat: Number(Math.min(...mapped.map((s) => s.lat)).toFixed(6)),
        maxLat: Number(Math.max(...mapped.map((s) => s.lat)).toFixed(6)),
        minLng: Number(Math.min(...mapped.map((s) => s.lng)).toFixed(6)),
        maxLng: Number(Math.max(...mapped.map((s) => s.lng)).toFixed(6)),
      }
    : null;
  return { routes, areas, bounds };
}

module.exports = { fetchData };

if (require.main === module) {
  fetchData()
    .then(() => console.log('\n완료'))
    .catch((error) => {
      console.error(`\n실패: ${error.message}`);
      process.exit(1);
    });
}
