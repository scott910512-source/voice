'use strict';

/**
 * VWorld 인증키가 실제로 동작하는지 확인한다.
 *
 *   node scripts/check-map-key.js [주소]
 *
 * VWorld는 발급 시 등록한 도메인에서만 키를 받아준다. 그래서 Referer를
 * 붙인 요청과 붙이지 않은 요청을 둘 다 보내, 키가 틀린 것인지 도메인
 * 등록이 안 된 것인지 구분할 수 있게 한다.
 */

const config = require('../config');
const { geocode } = require('../lib/geocode');

const KEY = config.map.vworldKey;
const REFERER = process.env.VWORLD_REFERER || 'https://scott910512-source.github.io/voice/';

async function probe(label, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const type = response.headers.get('content-type') || '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
    const preview = isPng ? `PNG 이미지 ${buffer.length}바이트` : buffer.toString('utf8').slice(0, 300).replace(/\s+/g, ' ');

    console.log(`\n[${label}]`);
    console.log(`  HTTP ${response.status} · ${type}`);
    console.log(`  ${preview}`);
    return { ok: response.ok, isPng, type, body: buffer };
  } catch (error) {
    console.log(`\n[${label}]`);
    console.log(`  실패: ${error.message}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!KEY) {
    console.log('VWORLD_KEY가 설정되어 있지 않습니다.');
    process.exit(1);
  }
  console.log(`인증키: ${KEY.slice(0, 8)}… (${KEY.length}자)`);
  console.log(`Referer: ${REFERER}`);

  // 1) Leaflet에 그대로 붙는 WMTS 배경지도 타일. 지금 코드가 쓰는 방식이다.
  const tileUrl = `https://api.vworld.kr/req/wmts/1.0.0/${KEY}/Base/13/3489/6989.png`;
  await probe('WMTS 타일 · Referer 있음', tileUrl, { Referer: REFERER });
  await probe('WMTS 타일 · Referer 없음', tileUrl, {});

  // 2) VWorld 자체 지도 엔진을 불러오는 스크립트. Leaflet 대신 쓰는 방식이다.
  const initUrl = `https://map.vworld.kr/js/vworldMapInit.js.do?version=2.0&apiKey=${KEY}`;
  await probe('vworldMapInit.js.do', initUrl, { Referer: REFERER });

  // 3) 주소 검색(지오코딩). 되면 주소로 위치를 찾는 기능이 정확해진다.
  const address = process.argv[2] || config.defaultAddress;
  console.log(`\n[지오코딩] "${address}"`);
  try {
    const point = await geocode(address, { ...config.geocode, vworldKey: KEY });
    console.log(`  성공: ${point.lat}, ${point.lng}`);
    console.log(`  매칭: ${point.matched}`);
    console.log(`  제공: ${point.provider}`);
  } catch (error) {
    console.log(`  실패: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
