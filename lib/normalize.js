'use strict';

/**
 * 세종특별자치시 도로안전표지 응답을 지도에 바로 올릴 수 있는 형태로 정규화한다.
 *
 * 공공데이터포털의 지자체 API는 기관마다 필드명이 제각각이고(위도/latitude/lat/y좌표 …)
 * 예고 없이 바뀌기도 한다. 그래서 필드명을 하나로 못박지 않고
 * (1) 후보 이름 목록, (2) 값의 형태(세종시 위경도 범위 안의 숫자인지)
 * 두 가지로 좌표와 주소를 찾아낸다.
 */

// 세종특별자치시 행정구역을 넉넉히 감싸는 범위.
const SEJONG_BOUNDS = {
  minLat: 36.35,
  maxLat: 36.78,
  minLng: 127.06,
  maxLng: 127.42,
};

const LAT_KEYS = ['위도', 'lat', 'latitude', 'la', 'ycrd', 'ycoord', 'y', 'ypos', 'gpsy', 'wgs84lat', 'lat_y'];
const LNG_KEYS = ['경도', 'lng', 'lon', 'lot', 'longitude', 'lo', 'xcrd', 'xcoord', 'x', 'xpos', 'gpsx', 'wgs84lon', 'lon_x'];
const ADDR_KEYS = ['소재지도로명주소', '소재지지번주소', '주소', 'addr', 'address', 'rdnmadr', 'lnmadr', 'location', '설치위치', '위치'];
const NAME_KEYS = ['표지명', '안전표지명', '노선명', 'roadname', 'signname', 'name', 'nm'];

/** 주차 관련 판정에 쓰는 키워드. 앞에 있는 규칙이 먼저 매칭된다. */
const PARKING_RULES = [
  {
    category: 'no_stop_no_park',
    label: '정차·주차 금지',
    // 정차까지 금지되는 가장 강한 규제. '주차금지'를 포함하므로 반드시 먼저 검사한다.
    patterns: [/정차\s*[·.ㆍ‧・,및]*\s*주차\s*금지/, /주정차\s*금지/, /정차\s*및\s*주차\s*금지/],
    signCodes: ['218'],
  },
  {
    category: 'no_park',
    label: '주차 금지',
    patterns: [/주차\s*금지/],
    signCodes: ['219'],
  },
  {
    category: 'parking_allowed',
    label: '주차 가능',
    patterns: [/노상\s*주차장/, /주차장/, /주차\s*가능/, /주차\s*허용/],
    signCodes: ['319'],
  },
];

function flattenValues(record) {
  const parts = [];
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(walk);
      return;
    }
    parts.push(String(value));
  };
  walk(record);
  return parts.join(' ');
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-().]/g, '');
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function pickByKeys(record, candidates) {
  const normalizedCandidates = candidates.map(normalizeKey);
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    const nk = normalizeKey(key);
    if (normalizedCandidates.includes(nk)) return { key, value };
  }
  // 완전 일치가 없으면 부분 일치(예: 'sign_lat_wgs84')까지 허용한다.
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    const nk = normalizeKey(key);
    if (normalizedCandidates.some((c) => c.length >= 3 && nk.includes(c))) return { key, value };
  }
  return null;
}

/**
 * 좌표를 찾는다. 이름으로 먼저 찾고, 실패하면 세종시 범위에 들어가는 숫자쌍을 찾는다.
 * 위도/경도가 뒤바뀌어 들어오는 데이터도 흔해서 범위로 한 번 더 교정한다.
 */
function extractCoordinates(record) {
  const inLat = (n) => n !== null && n >= SEJONG_BOUNDS.minLat && n <= SEJONG_BOUNDS.maxLat;
  const inLng = (n) => n !== null && n >= SEJONG_BOUNDS.minLng && n <= SEJONG_BOUNDS.maxLng;

  const latHit = pickByKeys(record, LAT_KEYS);
  const lngHit = pickByKeys(record, LNG_KEYS);
  let lat = latHit ? toNumber(latHit.value) : null;
  let lng = lngHit ? toNumber(lngHit.value) : null;
  let source = latHit && lngHit ? `${latHit.key}/${lngHit.key}` : null;

  if (inLng(lat) && inLat(lng) && !(inLat(lat) && inLng(lng))) {
    [lat, lng] = [lng, lat];
    source = source ? `${source} (좌표 뒤바뀜 교정)` : source;
  }

  if (!inLat(lat) || !inLng(lng)) {
    // 이름 기반 탐지 실패. 값의 범위만으로 후보를 찾는다.
    const latCandidates = [];
    const lngCandidates = [];
    for (const [key, value] of Object.entries(record)) {
      const num = toNumber(value);
      if (num === null) continue;
      if (inLat(num)) latCandidates.push({ key, num });
      if (inLng(num)) lngCandidates.push({ key, num });
    }
    if (latCandidates.length && lngCandidates.length) {
      const latPick = latCandidates[0];
      const lngPick = lngCandidates.find((c) => c.key !== latPick.key) || null;
      if (lngPick) {
        lat = latPick.num;
        lng = lngPick.num;
        source = `${latPick.key}/${lngPick.key} (값 범위 추정)`;
      }
    }
  }

  if (!inLat(lat) || !inLng(lng)) return { lat: null, lng: null, source: null };
  return { lat, lng, source };
}

function extractSignCode(record) {
  for (const [key, value] of Object.entries(record)) {
    const nk = normalizeKey(key);
    if (!/(code|번호|no|번|종별|구분)/.test(nk)) continue;
    const text = String(value ?? '').trim();
    const match = text.match(/\b(\d{3})\b/);
    if (match) return match[1];
  }
  return null;
}

/**
 * 주차 관련 표지인지 분류한다.
 * 필드명을 모르는 상태에서도 동작하도록 레코드의 모든 문자열을 이어붙여 검사한다.
 */
function classifyParking(record) {
  const haystack = flattenValues(record).replace(/\s+/g, ' ');
  const signCode = extractSignCode(record);

  for (const rule of PARKING_RULES) {
    const textHit = rule.patterns.find((p) => p.test(haystack));
    if (textHit) {
      return {
        category: rule.category,
        label: rule.label,
        matchedBy: 'text',
        evidence: (haystack.match(textHit) || [])[0] || null,
        signCode,
      };
    }
  }

  for (const rule of PARKING_RULES) {
    if (signCode && rule.signCodes.includes(signCode)) {
      return {
        category: rule.category,
        label: rule.label,
        matchedBy: 'signCode',
        evidence: `표지번호 ${signCode}`,
        signCode,
      };
    }
  }

  return { category: 'other', label: '주차 무관 표지', matchedBy: null, evidence: null, signCode };
}

function extractText(record, candidates) {
  const hit = pickByKeys(record, candidates);
  if (!hit) return null;
  const text = String(hit.value ?? '').trim();
  return text || null;
}

function normalizeRecord(record, index) {
  const { lat, lng, source } = extractCoordinates(record);
  const parking = classifyParking(record);
  return {
    id: `sign-${index}`,
    lat,
    lng,
    coordSource: source,
    mappable: lat !== null && lng !== null,
    name: extractText(record, NAME_KEYS),
    address: extractText(record, ADDR_KEYS),
    parking,
    raw: record,
  };
}

function normalizeRecords(records) {
  return records.map(normalizeRecord);
}

/** 응답에 실제로 어떤 필드가 들어있는지 진단용으로 요약한다. */
function summarizeSchema(records) {
  const fields = new Map();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'object' && value !== null) continue;
      if (!fields.has(key)) fields.set(key, { field: key, samples: [], nonEmpty: 0 });
      const entry = fields.get(key);
      const text = String(value ?? '').trim();
      if (text) {
        entry.nonEmpty += 1;
        if (entry.samples.length < 3 && !entry.samples.includes(text)) entry.samples.push(text);
      }
    }
  }
  return [...fields.values()].sort((a, b) => b.nonEmpty - a.nonEmpty);
}

module.exports = {
  SEJONG_BOUNDS,
  PARKING_RULES,
  normalizeRecords,
  classifyParking,
  extractCoordinates,
  summarizeSchema,
};
