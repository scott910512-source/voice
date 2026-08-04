'use strict';

/**
 * 주소 → 좌표 변환.
 *
 * 설정된 키에 따라 국내 지오코더를 우선 사용하고, 키가 없으면 Nominatim(OSM)으로
 * 내려간다. 국내 도로명주소는 VWorld/카카오가 정확하므로 가능하면 키를 넣는 편이 좋다.
 */

const { SEJONG_BOUNDS } = require('./normalize');

async function getJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'sejong-parking-sign-map/1.0', ...headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** VWorld 지오코더. 도로명(road)으로 먼저 찾고 지번(parcel)으로 재시도한다. */
async function viaVworld(address, key) {
  for (const type of ['road', 'parcel']) {
    const url =
      `https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326` +
      `&type=${type}&address=${encodeURIComponent(address)}&format=json&key=${encodeURIComponent(key)}`;
    const data = await getJson(url);
    const point = data?.response?.result?.point;
    if (data?.response?.status === 'OK' && point) {
      return {
        lat: Number(point.y),
        lng: Number(point.x),
        matched: data.response.refined?.text || address,
        provider: `vworld:${type}`,
      };
    }
  }
  throw new Error('VWorld에서 주소를 찾지 못했습니다.');
}

/** 카카오 로컬 API. JavaScript 키가 아니라 REST API 키가 필요하다. */
async function viaKakao(address, restKey) {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
  const data = await getJson(url, { Authorization: `KakaoAK ${restKey}` });
  const doc = data?.documents?.[0];
  if (!doc) throw new Error('카카오에서 주소를 찾지 못했습니다.');
  return {
    lat: Number(doc.y),
    lng: Number(doc.x),
    matched: doc.road_address?.address_name || doc.address_name || address,
    provider: 'kakao',
  };
}

/** 네이버 클라우드 플랫폼 Geocoding. Maps용 Client ID/Secret이 필요하다. */
async function viaNaver(address, clientId, clientSecret) {
  const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`;
  const data = await getJson(url, {
    'x-ncp-apigw-api-key-id': clientId,
    'x-ncp-apigw-api-key': clientSecret,
  });
  const item = data?.addresses?.[0];
  if (!item) throw new Error('네이버에서 주소를 찾지 못했습니다.');
  return { lat: Number(item.y), lng: Number(item.x), matched: item.roadAddress || item.jibunAddress, provider: 'naver' };
}

/** 키가 하나도 없을 때 쓰는 무키 폴백. 국내 도로명 정확도는 떨어진다. */
async function viaNominatim(address) {
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr` +
    `&q=${encodeURIComponent(address)}`;
  const data = await getJson(url);
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit) throw new Error('주소를 찾지 못했습니다.');
  return { lat: Number(hit.lat), lng: Number(hit.lon), matched: hit.display_name, provider: 'nominatim' };
}

/**
 * "36.48, 127.289" 처럼 좌표를 직접 입력한 경우를 먼저 처리한다.
 * 주소 검색이 막힌 환경에서도 위치를 지정할 수 있는 탈출구다.
 */
function parseLatLng(input) {
  const match = String(input).trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  let lat = Number(match[1]);
  let lng = Number(match[2]);
  if (lat > 100 && lng < 100) [lat, lng] = [lng, lat];
  return { lat, lng, matched: `${lat}, ${lng}`, provider: 'input' };
}

async function geocode(address, keys) {
  const direct = parseLatLng(address);
  if (direct) return direct;

  const attempts = [];
  const providers = [];

  if (keys.vworldKey) providers.push(() => viaVworld(address, keys.vworldKey));
  if (keys.kakaoRestKey) providers.push(() => viaKakao(address, keys.kakaoRestKey));
  if (keys.naverClientId && keys.naverClientSecret) {
    providers.push(() => viaNaver(address, keys.naverClientId, keys.naverClientSecret));
  }
  providers.push(() => viaNominatim(address));

  for (const provider of providers) {
    try {
      const result = await provider();
      if (Number.isFinite(result.lat) && Number.isFinite(result.lng)) return result;
      attempts.push('좌표가 비어 있음');
    } catch (error) {
      attempts.push(error.message);
    }
  }
  throw new Error(`주소를 좌표로 바꾸지 못했습니다. (${attempts.join(' | ')})`);
}

/** 두 지점 사이 거리(m). 하버사인. */
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function isInSejong(point) {
  return (
    point.lat >= SEJONG_BOUNDS.minLat &&
    point.lat <= SEJONG_BOUNDS.maxLat &&
    point.lng >= SEJONG_BOUNDS.minLng &&
    point.lng <= SEJONG_BOUNDS.maxLng
  );
}

module.exports = { geocode, parseLatLng, distanceMeters, isInSejong };
