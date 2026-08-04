'use strict';

/**
 * 실제 공공데이터포털 호출 없이 파싱 → 정규화 → 분류 경로를 검증한다.
 * 로컬 목 서버를 띄우고 config의 endpoint를 그쪽으로 돌려 전 구간을 태운다.
 *
 *   node test/smoke.js
 */

const http = require('http');
const assert = require('assert');

const { parseXml } = require('../lib/xml');
const { classifyParking, extractCoordinates, normalizeRecords } = require('../lib/normalize');
const { encodeServiceKey, extractItems, parseBody, fetchAll } = require('../lib/api');
const { parseLatLng, distanceMeters, isInSejong } = require('../lib/geocode');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ------------------------------------------------------------- XML 파서 */

test('XML 파서가 item 목록과 CDATA를 읽는다', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header>
    <body><items>
      <item><표지명><![CDATA[주차금지]]></표지명><위도>36.4801</위도><경도>127.2890</경도></item>
      <item><표지명>노상주차장</표지명><위도>36.5100</위도><경도>127.2600</경도></item>
    </items><totalCount>2</totalCount></body></response>`;
  const parsed = parseXml(xml);
  const items = extractItems(parsed);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0]['표지명'], '주차금지');
  assert.strictEqual(items[1]['위도'], '36.5100');
});

test('XML 파서가 결과 1건(배열 아님)도 레코드로 인식한다', () => {
  const xml = `<response><body><items><item><표지명>주차금지</표지명><위도>36.48</위도><경도>127.28</경도></item></items></body></response>`;
  const items = extractItems(parseXml(xml));
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0]['표지명'], '주차금지');
});

/* --------------------------------------------------------------- 인증키 */

test('이미 인코딩된 인증키는 다시 인코딩하지 않는다', () => {
  const encoded = 'abc%2Bdef%3D%3D';
  assert.strictEqual(encodeServiceKey(encoded), encoded);
});

test('디코딩된 인증키는 한 번 인코딩한다', () => {
  assert.strictEqual(encodeServiceKey('abc+def=='), 'abc%2Bdef%3D%3D');
});

/* --------------------------------------------------------------- 좌표 */

test('필드명이 달라도 좌표를 찾는다', () => {
  assert.deepStrictEqual(
    { lat: 36.48, lng: 127.289 },
    pick(extractCoordinates({ latitude: '36.48', longitude: '127.289' }))
  );
  assert.deepStrictEqual({ lat: 36.48, lng: 127.289 }, pick(extractCoordinates({ 위도: 36.48, 경도: 127.289 })));
  assert.deepStrictEqual({ lat: 36.48, lng: 127.289 }, pick(extractCoordinates({ ycrd: '36.48', xcrd: '127.289' })));
});

test('위경도가 뒤바뀐 데이터를 교정한다', () => {
  const { lat, lng } = extractCoordinates({ 위도: '127.289', 경도: '36.48' });
  assert.strictEqual(lat, 36.48);
  assert.strictEqual(lng, 127.289);
});

test('세종시 범위 밖 좌표는 버린다', () => {
  const { lat, lng } = extractCoordinates({ 위도: '37.5665', 경도: '126.9780' });
  assert.strictEqual(lat, null);
  assert.strictEqual(lng, null);
});

test('이름 없는 필드도 값 범위로 좌표를 추정한다', () => {
  const { lat, lng, source } = extractCoordinates({ colA: '36.5012', colB: '127.2501' });
  assert.strictEqual(lat, 36.5012);
  assert.strictEqual(lng, 127.2501);
  assert.match(source, /추정/);
});

function pick({ lat, lng }) {
  return { lat, lng };
}

/* --------------------------------------------------------------- 분류 */

test('정차·주차금지를 주차금지보다 먼저 잡는다', () => {
  assert.strictEqual(classifyParking({ 표지명: '정차·주차금지' }).category, 'no_stop_no_park');
  assert.strictEqual(classifyParking({ 표지명: '정차.주차금지' }).category, 'no_stop_no_park');
  assert.strictEqual(classifyParking({ 비고: '주정차금지 구간' }).category, 'no_stop_no_park');
});

test('주차금지 / 주차장을 구분한다', () => {
  assert.strictEqual(classifyParking({ 표지명: '주차금지' }).category, 'no_park');
  assert.strictEqual(classifyParking({ 표지명: '노상주차장' }).category, 'parking_allowed');
  assert.strictEqual(classifyParking({ 표지명: '주차장' }).category, 'parking_allowed');
});

test('주차와 무관한 표지는 other로 남긴다', () => {
  assert.strictEqual(classifyParking({ 표지명: '횡단보도', 노선명: '한누리대로' }).category, 'other');
});

test('표지명이 없으면 표지번호로 분류한다', () => {
  const result = classifyParking({ 표지번호: '218', 노선명: '한누리대로' });
  assert.strictEqual(result.category, 'no_stop_no_park');
  assert.strictEqual(result.matchedBy, 'signCode');
});

/* ------------------------------------------------------- 목 서버 전 구간 */

const MOCK_ITEMS = [
  { 표지관리번호: 'A-1', 표지명: '주차금지', 노선명: '한누리대로', 도로종류: '시도', 차로수: '4', 위도: '36.4801', 경도: '127.2890' },
  { 표지관리번호: 'A-2', 표지명: '정차·주차금지', 노선명: '갈매로', 도로종류: '시도', 차로수: '6', 위도: '36.5041', 경도: '127.2617' },
  { 표지관리번호: 'A-3', 표지명: '노상주차장', 노선명: '도움5로', 도로종류: '시도', 차로수: '2', 위도: '36.5062', 경도: '127.2588' },
  { 표지관리번호: 'A-4', 표지명: '횡단보도', 노선명: '조치원1길', 도로종류: '시도', 차로수: '2', 위도: '36.6011', 경도: '127.2971' },
  { 표지관리번호: 'A-5', 표지명: '주차금지', 노선명: '금남구즉로', 도로종류: '시도', 차로수: '2', 위도: '', 경도: '' },
];

function startMockServer(mode, serverPageCap) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const pageNo = Number(url.searchParams.get('pageNo') || 1);
      const requested = Number(url.searchParams.get('numOfRows') || 10);
      // 실제 세종시 API는 numOfRows를 무시하고 페이지당 고정 건수만 돌려준다.
      const numOfRows = serverPageCap ? Math.min(requested, serverPageCap) : requested;
      const type = url.searchParams.get('type');
      // 페이징이 동작하지 않고 늘 1페이지만 돌려주는 서버.
      const effectivePage = mode === 'sameEveryPage' ? 1 : pageNo;
      const slice = MOCK_ITEMS.slice((effectivePage - 1) * numOfRows, effectivePage * numOfRows);

      // 뒤쪽 페이지에서 서버가 죽는 상황. 실제로 이 API에서 관측됐다.
      if (mode === 'failAfterFirst' && pageNo > 1) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('SERVICE ERROR');
        return;
      }

      // 실제 지자체 API처럼, JSON을 요청해도 XML만 돌려주는 모드를 재현한다.
      if (mode === 'xmlOnly' || type === 'xml') {
        const items = slice
          .map(
            (item) =>
              `<item>${Object.entries(item)
                .map(([k, v]) => `<${k}>${v}</${k}>`)
                .join('')}</item>`
          )
          .join('');
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE</resultMsg></header><body><items>${items}</items><numOfRows>${numOfRows}</numOfRows><pageNo>${pageNo}</pageNo><totalCount>${MOCK_ITEMS.length}</totalCount></body></response>`
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          response: {
            header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
            body: { items: { item: slice }, numOfRows, pageNo, totalCount: MOCK_ITEMS.length },
          },
        })
      );
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function runPipeline(mode, numOfRows, serverPageCap) {
  const server = await startMockServer(mode, serverPageCap);
  const { port } = server.address();
  try {
    const result = await fetchAll({
      endpoint: `http://127.0.0.1:${port}/mock`,
      operation: 'sj_00000270',
      serviceKey: 'test%2Bkey%3D%3D',
      numOfRows,
      maxRecords: 1000,
      maxPages: 60,
      deadlineMs: 30000,
      timeoutMs: 5000,
      retries: 0,
      extraParams: {},
    });
    return { result, signs: normalizeRecords(result.items) };
  } finally {
    server.close();
  }
}

test('JSON 응답 전 구간: 조회 → 정규화 → 분류', async () => {
  const { result, signs } = await runPipeline('json', 500);
  assert.strictEqual(result.format, 'json');
  assert.strictEqual(result.fetchedCount, 5);

  const categories = signs.map((s) => s.parking.category);
  assert.deepStrictEqual(categories, ['no_park', 'no_stop_no_park', 'parking_allowed', 'other', 'no_park']);
  assert.strictEqual(signs.filter((s) => s.mappable).length, 4);
  assert.strictEqual(signs[0].name, '주차금지');
  assert.strictEqual(signs[0].lat, 36.4801);
});

test('XML만 돌려주는 API에도 자동 폴백한다', async () => {
  const { result, signs } = await runPipeline('xmlOnly', 500);
  assert.strictEqual(result.format, 'xml');
  assert.strictEqual(signs.length, 5);
  assert.strictEqual(signs[1].parking.category, 'no_stop_no_park');
});

test('페이지가 나뉘어도 전체를 모은다', async () => {
  const { result } = await runPipeline('json', 2);
  assert.strictEqual(result.fetchedCount, 5);
  assert.strictEqual(result.totalCount, 5);
});

test('numOfRows를 무시하고 적게 주는 API에서도 전체를 모은다', async () => {
  // 실제 세종시 API의 동작. numOfRows=500을 보내도 페이지당 2건만 온다.
  const { result, signs } = await runPipeline('json', 500, 2);
  assert.strictEqual(result.fetchedCount, 5, `기대 5건, 실제 ${result.fetchedCount}건`);
  assert.strictEqual(result.pageSize, 2);
  assert.strictEqual(signs.length, 5);
});

test('페이징이 동작하지 않는 API에서 중복을 걸러낸다', async () => {
  // 실제 세종시 API의 동작. pageNo를 올려도 같은 레코드가 다시 온다.
  const server = await startMockServer('sameEveryPage', 2);
  const { port } = server.address();
  try {
    const result = await fetchAll({
      endpoint: `http://127.0.0.1:${port}/mock`,
      operation: 'sj_00000270',
      serviceKey: 'k',
      numOfRows: 500,
      maxRecords: 1000,
      maxPages: 60,
      deadlineMs: 30000,
      timeoutMs: 5000,
      retries: 0,
      extraParams: {},
    });
    assert.strictEqual(result.uniqueCount, 2, `기대 고유 2건, 실제 ${result.uniqueCount}건`);
    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.notes.some((n) => n.includes('서버 페이징 미동작')), `메모 없음: ${result.notes}`);
  } finally {
    server.close();
  }
});

test('뒤쪽 페이지가 실패해도 앞에서 받은 것은 살린다', async () => {
  const { result, signs } = await runPipeline('failAfterFirst', 500, 2);
  assert.strictEqual(result.fetchedCount, 2, `기대 2건, 실제 ${result.fetchedCount}건`);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.notes.some((note) => note.includes('2페이지 실패')), `메모 없음: ${result.notes}`);
  assert.strictEqual(signs.length, 2);
});

test('세종시 실제 응답 형태를 그대로 처리한다', () => {
  const record = {
    roadKnd: '시도',
    roadRouteNo: '1번',
    roadRouteNm: '한누리대로',
    roadRouteDrc: 3,
    cartrkCo: 0,
    addr: '세종특별자치시대평동264-9',
    la: 36.470988,
    lo: 127.273696,
    se: 2,
    roadSflblAsortSn: 218,
    dc: '주정차금지',
    mngInstNm: '세종특별자치시',
  };
  const [sign] = normalizeRecords([record]);
  assert.strictEqual(sign.lat, 36.470988);
  assert.strictEqual(sign.lng, 127.273696);
  assert.strictEqual(sign.coordSource, 'la/lo');
  assert.strictEqual(sign.name, '주정차금지');
  assert.strictEqual(sign.route, '한누리대로');
  assert.strictEqual(sign.address, '세종특별자치시대평동264-9');
  assert.strictEqual(sign.parking.category, 'no_stop_no_park');
  assert.strictEqual(sign.parking.signCode, '218');
});

test('빈 문자열 필드가 값 있는 필드를 가리지 않는다', () => {
  // 세종시 응답은 roadNmAddr(도로명주소)가 늘 비어 있고 addr(지번)에만 값이 있다.
  // 빈 값을 먼저 고르면 주소가 통째로 사라진다.
  const [sign] = normalizeRecords([
    { roadNmAddr: '', addr: '세종특별자치시대평동264-9', dc: '주정차금지', la: 36.470949, lo: 127.273471 },
  ]);
  assert.strictEqual(sign.address, '세종특별자치시대평동264-9');
});

test('주소에 든 "주차장"에 속아 분류하지 않는다', () => {
  // 표지명(dc)은 주차와 무관한데 주소에 주차장이 들어간 경우.
  const [sign] = normalizeRecords([
    { dc: '최고속도제한표지', addr: '세종특별자치시 주차장길 12', la: 36.47, lo: 127.27 },
  ]);
  assert.strictEqual(sign.parking.category, 'other');
});

test('표지명 필드가 없으면 레코드 전체를 훑는다', () => {
  const [sign] = normalizeRecords([{ 비고: '주정차금지 구간', la: 36.47, lo: 127.27 }]);
  assert.strictEqual(sign.parking.category, 'no_stop_no_park');
  assert.strictEqual(sign.parking.matchedBy, 'text');
});

test('JSON 본문 판별이 형식을 올바르게 구분한다', () => {
  assert.strictEqual(parseBody('{"a":1}').format, 'json');
  assert.strictEqual(parseBody('<a><b>1</b></a>').format, 'xml');
});

/* --------------------------------------------------------- 위치 기반 조회 */

test('좌표를 직접 입력하면 지오코딩 없이 인식한다', () => {
  assert.deepStrictEqual(pick(parseLatLng('36.4801, 127.2890')), { lat: 36.4801, lng: 127.289 });
  assert.deepStrictEqual(pick(parseLatLng('36.4801 127.2890')), { lat: 36.4801, lng: 127.289 });
  assert.strictEqual(parseLatLng('세종시 연동면 명학산단로 110-5'), null);
});

test('경도/위도 순서로 입력해도 교정한다', () => {
  assert.deepStrictEqual(pick(parseLatLng('127.2890, 36.4801')), { lat: 36.4801, lng: 127.289 });
});

test('거리 계산이 실제 거리와 맞는다', () => {
  // 위도 1도 ≈ 111km. 0.001도면 약 111m.
  const meters = distanceMeters({ lat: 36.48, lng: 127.289 }, { lat: 36.481, lng: 127.289 });
  assert.ok(Math.abs(meters - 111) < 2, `기대 ~111m, 실제 ${meters}m`);
  assert.strictEqual(Math.round(distanceMeters({ lat: 36.48, lng: 127.289 }, { lat: 36.48, lng: 127.289 })), 0);
});

test('세종시 범위 판정', () => {
  assert.strictEqual(isInSejong({ lat: 36.48, lng: 127.289 }), true);
  assert.strictEqual(isInSejong({ lat: 37.5665, lng: 126.978 }), false);
});

test('반경 안의 표지만 거리순으로 남긴다', () => {
  const center = { lat: 36.4801, lng: 127.289 };
  const signs = normalizeRecords([
    { 표지명: '주차금지', 위도: '36.4801', 경도: '127.2890' }, // 0m
    { 표지명: '주차금지', 위도: '36.4810', 경도: '127.2890' }, // 약 100m
    { 표지명: '노상주차장', 위도: '36.5041', 경도: '127.2617' }, // 수 km
  ]);
  const nearby = signs
    .map((s) => ({ ...s, distance: Math.round(distanceMeters(center, s)) }))
    .filter((s) => s.distance <= 500)
    .sort((a, b) => a.distance - b.distance);

  assert.strictEqual(nearby.length, 2);
  assert.strictEqual(nearby[0].distance, 0);
  assert.ok(nearby[1].distance > 90 && nearby[1].distance < 120);
});

/* ---------------------------------------------------------------- 실행 */

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}\n      ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 통과`);
  process.exit(failed ? 1 : 0);
})();
