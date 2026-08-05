(function () {
  'use strict';

  /**
   * VWorld 데이터 API 공용 모듈.
   *
   * 2D와 3D 화면이 같은 레이어(용도지역·필지·공시지가)를 쓰기 때문에, 조회와
   * 색 규칙을 한 곳에 둔다. 화면마다 복사해 두면 한쪽만 고치는 일이 생긴다.
   *
   * 레이어 이름과 필드명을 확신할 수 없어 후보를 순서대로 시도한다. 이 코드를
   * 만든 환경에서는 VWorld에 닿지 못해 실물로 확인할 수 없었다.
   */

  function pickField(props, candidates) {
    const keys = Object.keys(props || {});
    for (const candidate of candidates) {
      const hit = keys.find((k) => k.toLowerCase().replace(/[_\s]/g, '') === candidate.toLowerCase().replace(/[_\s]/g, ''));
      if (hit && String(props[hit]).trim() !== '') return props[hit];
    }
    return null;
  }

  function bboxAround(point, radiusM) {
    const dLat = radiusM / 111000;
    const dLng = radiusM / (111000 * Math.cos((point.lat * Math.PI) / 180));
    return [point.lng - dLng, point.lat - dLat, point.lng + dLng, point.lat + dLat];
  }

  /** 두 좌표 사이 대략적인 거리(m). 몇백 m 범위를 재는 용도라 평면 근사로 충분하다. */
  function distanceM(a, b) {
    const dLat = (b.lat - a.lat) * 111000;
    const dLng = (b.lng - a.lng) * 111000 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  /**
   * 지도를 움직일 때마다 같은 자리를 다시 받지 않게 하고, 늦게 도착한 응답이
   * 더 새로운 응답을 덮어쓰지 않게 한다.
   *
   * claim() 은 다시 받아야 하면 토큰을, 받을 필요가 없으면 null을 준다.
   * 응답이 온 뒤 fresh(토큰) 이 false면 그 사이 지도가 더 움직인 것이므로 버린다.
   */
  function areaGuard(moveRatio) {
    const ratio = typeof moveRatio === 'number' ? moveRatio : 0.4;
    let at = null;
    let radius = 0;
    let seq = 0;

    return {
      claim(center, nextRadius, force) {
        const near = at && nextRadius === radius && distanceM(at, center) <= radius * ratio;
        if (near && !force) return null;
        at = center;
        radius = nextRadius;
        return (seq += 1);
      },
      /** 레이어를 끄거나 실패했을 때. 다음 claim이 반드시 다시 받도록 되돌린다. */
      reset() {
        at = null;
        radius = 0;
        return (seq += 1);
      },
      fresh(token) {
        return token === seq;
      },
    };
  }

  /**
   * VWorld 데이터 API는 브라우저에서 부를 때 CORS 헤더가 없을 수 있어
   * JSONP(callback)로 받는다. 타일과 달리 fetch로는 막힐 수 있기 때문이다.
   */
  function jsonp(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const name = `__vw_cb_${Math.floor(performance.now() * 1000) % 1e9}_${jsonp.seq = (jsonp.seq || 0) + 1}`;
      const script = document.createElement('script');
      let done = false;

      const cleanup = () => {
        done = true;
        delete window[name];
        script.remove();
      };
      const timer = setTimeout(() => {
        if (done) return;
        cleanup();
        reject(new Error('응답 없음'));
      }, timeoutMs);

      window[name] = (data) => {
        if (done) return;
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      script.onerror = () => {
        if (done) return;
        clearTimeout(timer);
        cleanup();
        reject(new Error('불러오기 실패'));
      };
      script.src = `${url}&callback=${name}`;
      document.head.appendChild(script);
    });
  }

  /* ------------------------------------------ 후보 레이어 동시 조회 */

  /** 한 요청이 가져올 수 있는 최대 개수. VWorld 데이터 API의 상한이다. */
  const FEATURE_LIMIT = 1000;
  const TIMEOUT_MS = 10000;

  /**
   * 한 번 맞는 이름을 찾으면 기억한다. 지도를 움직일 때마다 후보를 처음부터
   * 다시 던지면 요청 수가 후보 개수만큼 곱해진다.
   */
  const resolvedLayer = {};

  function dataUrl(layer, vworldKey, bbox) {
    const [minx, miny, maxx, maxy] = bbox;
    return (
      `https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&format=json` +
      `&size=${FEATURE_LIMIT}&page=1&data=${layer}&geomFilter=BOX(${minx},${miny},${maxx},${maxy})` +
      `&key=${encodeURIComponent(vworldKey)}&domain=${encodeURIComponent(location.hostname || 'localhost')}`
    );
  }

  /**
   * 후보 레이어를 동시에 던지고 먼저 성공한 것을 쓴다.
   *
   * 순서대로 시도하면 틀린 이름 하나마다 제한 시간을 통째로 기다리게 되어,
   * 결과가 나올 때까지 후보 개수만큼 시간이 곱해진다. 건물은 후보가 넷이라
   * 최악의 경우 40초를 기다린 뒤에야 화면이 채워졌다.
   *
   * 성공하면 {layer, features}, 모두 실패하면 {failed: [사유]}.
   */
  function fetchFeatures(kind, candidates, vworldKey, point, radiusM) {
    if (!vworldKey) return Promise.resolve(null);
    const bbox = bboxAround(point, radiusM);
    const order = resolvedLayer[kind] ? [resolvedLayer[kind]] : candidates;

    return new Promise((resolve) => {
      const tried = [];
      let pending = order.length;
      let settled = false;
      let errored = false;

      const fail = (layer, message, isError) => {
        tried.push(`${layer}: ${message}`);
        if (isError) errored = true;
        pending -= 1;
        if (settled || pending > 0) return;
        settled = true;
        // 이름이 틀렸거나 응답이 없었으면 기억해 둔 것을 지워 다음에 다시 훑게
        // 한다. 다만 '결과 없음'은 그 자리에 자료가 없다는 뜻이라, 이름은
        // 맞는 것이므로 그대로 둔다.
        if (errored) delete resolvedLayer[kind];
        resolve({ failed: tried });
      };

      for (const layer of order) {
        window.VWorldData.jsonp(dataUrl(layer, vworldKey, bbox), TIMEOUT_MS).then((data) => {
          const features = data?.response?.result?.featureCollection?.features;
          if (!Array.isArray(features) || !features.length) {
            // 자료가 없는 것인지 이름이 틀린 것인지는 응답 상태로 가른다.
            const status = data?.response?.status;
            fail(layer, '결과 없음', status !== 'OK' && status !== 'NOT_FOUND');
            return;
          }
          if (settled) return;
          settled = true;
          resolvedLayer[kind] = layer;
          resolve({ layer, features, capped: features.length >= FEATURE_LIMIT });
        }, (error) => fail(layer, error.message, true));
      }
    });
  }

  /* --------------------------------------------------------- 용도지역 */

  /**
   * 용도지역지구도. 주거·상업·공업·녹지 같은 지정 용도를 색으로 구분한다.
   * 건물과 같은 VWorld 데이터 API를 쓰므로 인증키가 따로 필요 없다.
   *
   * 레이어 이름은 확신할 수 없어 후보를 순서대로 시도한다. 이 환경에서는
   * VWorld에 닿지 못해 어느 이름이 맞는지 확인할 수 없었다.
   */
  const VWORLD_ZONING_LAYERS = ['LT_C_UQ111', 'LT_C_UQ111_TMP', 'LT_C_UPISUQ111'];

  const ZONE_NAME_FIELDS = ['dgm_nm', 'prpos_area_dstrc_nm', 'uname', 'zone_nm', '용도지역명', 'name'];

  /** 용도 이름에서 큰 갈래를 뽑아 색을 정한다. 세부 지정은 종류가 너무 많다. */
  const ZONE_COLORS = [
    { test: /전용주거|일반주거|준주거|주거/, label: '주거지역', color: '#f6d365' },
    { test: /중심상업|일반상업|근린상업|유통상업|상업/, label: '상업지역', color: '#e8657a' },
    { test: /전용공업|일반공업|준공업|공업/, label: '공업지역', color: '#7b6bd6' },
    { test: /보전녹지|생산녹지|자연녹지|녹지/, label: '녹지지역', color: '#5aa469' },
    { test: /보전관리|생산관리|계획관리|관리/, label: '관리지역', color: '#c9a227' },
    { test: /농림/, label: '농림지역', color: '#8f9e5b' },
    { test: /자연환경보전/, label: '자연환경보전', color: '#3f7f7a' },
  ];

  /**
   * 회색으로 남는 두 경우를 갈라 둔다. 하나는 '이름은 왔는데 우리 분류표에
   * 없는 지정'이고, 다른 하나는 '이름 자체가 안 온 것'이다. 원인이 다르니
   * 범례에서도 달라야 한다. 아예 폴리곤이 없는 자리는 이 함수까지 오지도
   * 않는다 — 그건 용도지역이 지정되지 않았거나 자료가 없는 땅이다.
   */
  function zoneStyle(name) {
    const text = String(name || '').trim();
    if (!text) return { label: '이름 없음', color: '#cbd5e1' };
    const hit = ZONE_COLORS.find((z) => z.test.test(text));
    return hit || { label: '기타 지정', color: '#94a3b8' };
  }

  async function fetchZoning(vworldKey, point, radiusM) {
    const found = await fetchFeatures('zoning', VWORLD_ZONING_LAYERS, vworldKey, point, radiusM);
    if (!found || !found.features) return found;

    const kinds = new Map();
    const out = found.features.map((feature) => {
      const name = pickField(feature.properties || {}, ZONE_NAME_FIELDS);
      const style = zoneStyle(name);
      kinds.set(style.label, style.color);
      return {
        type: 'Feature',
        properties: { zone: String(name || '용도 미상'), group: style.label, color: style.color },
        geometry: feature.geometry,
      };
    });

    return {
      geojson: { type: 'FeatureCollection', features: out },
      layer: found.layer,
      capped: found.capped,
      kinds,
    };
  }

  /* ------------------------------------------------- 필지 · 공시지가 */

  /**
   * 연속지적도. 필지 경계에 PNU·지번·공시년도·공시지가가 함께 들어 있어,
   * 한 번 받으면 경계와 땅값을 같이 보여줄 수 있다. 건물·용도지역과 같은
   * VWorld 데이터 API라 인증키가 따로 필요 없다.
   */
  const VWORLD_PARCEL_LAYERS = ['LP_PA_CBND_BUBUN', 'LP_PA_CBND_BONBUN'];

  const PRICE_FIELDS = ['jiga', 'pblntf_pclnd', 'pblntfpclnd', 'landprice', '공시지가'];
  const JIBUN_FIELDS = ['jibun', 'addr', 'ldcode_nm', '지번'];
  const AREA_FIELDS = ['lndpcl_ar', 'area', 'ar', '면적'];
  const YEAR_FIELDS = ['jiga_year', 'stdr_year', 'base_year', '공시년도'];

  /** 낮은 값 → 높은 값. 두 방식(고정·분포)이 같은 램프를 쓴다. */
  const PRICE_RAMP = [
    '#fff7ec',
    '#fee8c8',
    '#fdd49e',
    '#fdbb84',
    '#fc8d59',
    '#ef6548',
    '#d7301f',
    '#b30000',
    '#7f0000',
  ];
  const NO_PRICE_COLOR = '#cbd5e1';

  /**
   * 고정 구간. 원/㎡ 기준.
   *
   * 처음에는 다섯 칸이었는데 맨 위가 '150만원 이상'이라, 값이 고르게 높은
   * 곳에서는 화면 전체가 한 색이 됐다. 위쪽을 갈라 아홉 칸으로 늘렸다.
   */
  const PRICE_BREAKS = [
    { max: 50000, label: '5만 미만' },
    { max: 150000, label: '5~15만' },
    { max: 300000, label: '15~30만' },
    { max: 500000, label: '30~50만' },
    { max: 1000000, label: '50~100만' },
    { max: 1500000, label: '100~150만' },
    { max: 3000000, label: '150~300만' },
    { max: 10000000, label: '300~1000만' },
    { max: Infinity, label: '1000만 이상' },
  ];

  function priceStyle(value) {
    if (!Number.isFinite(value) || value <= 0) return { label: '값 없음', color: NO_PRICE_COLOR };
    const index = PRICE_BREAKS.findIndex((b) => value < b.max);
    return { label: PRICE_BREAKS[index].label, color: PRICE_RAMP[index] };
  }

  /** 원/㎡ 를 사람이 읽는 형태로. 국내 실무는 평당으로도 본다. */
  function formatPrice(value) {
    if (!Number.isFinite(value) || value <= 0) return '공시지가 없음';
    const perPyeong = Math.round(value * 3.305785);
    return `${value.toLocaleString('ko-KR')}원/㎡ (평당 ${perPyeong.toLocaleString('ko-KR')}원)`;
  }

  /** 범례에 넣을 짧은 표기. 12,300 → 1.2만 */
  function shortPrice(value) {
    if (!Number.isFinite(value)) return '-';
    if (value >= 100000000) return `${trimZero(value / 100000000, 1)}억`;
    if (value >= 10000) return `${trimZero(value / 10000, value >= 1000000 ? 0 : 1)}만`;
    return Math.round(value).toLocaleString('ko-KR');
  }

  function trimZero(value, digits) {
    return value.toFixed(digits).replace(/\.0$/, '');
  }

  /**
   * 화면에 있는 값의 분포로 구간을 나눈다.
   *
   * 고정 구간은 지역이 바뀌면 한 칸에 다 몰린다. 세종 산업단지처럼 값이
   * 고르게 높은 곳에서는 전부 맨 윗칸이 되어 색으로 구분이 되지 않았다.
   * 분위로 나누면 어디를 보든 색이 갈라지고, 그 화면 안에서 어디가 비싼지
   * 바로 보인다. 대신 지도를 옮기면 같은 금액이라도 색이 달라질 수 있다.
   */
  function quantileEdges(sorted, buckets) {
    const edges = [];
    for (let i = 1; i < buckets; i += 1) {
      const at = Math.floor((sorted.length * i) / buckets);
      const value = sorted[Math.min(sorted.length - 1, at)];
      // 같은 값이 많으면 경계가 겹친다. 겹친 칸은 합친다.
      if (value > sorted[0] && edges[edges.length - 1] !== value) edges.push(value);
    }
    return edges;
  }

  function rampColor(index, count) {
    if (count <= 1) return PRICE_RAMP[PRICE_RAMP.length - 1];
    return PRICE_RAMP[Math.round((index * (PRICE_RAMP.length - 1)) / (count - 1))];
  }

  const QUANTILE_BUCKETS = 8;

  /**
   * 필지에 색을 입히고 범례·요약을 만든다. 다시 받지 않고 기준만 바꿀 수
   * 있도록 조회와 분리해 두었다.
   *
   * mode: 'auto' 화면 분포 기준 / 'fixed' 고정 구간
   */
  function applyPriceColors(geojson, mode) {
    const features = (geojson && geojson.features) || [];
    const sorted = features
      .map((f) => Number(f.properties.price))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);

    const kinds = new Map();
    const stats = sorted.length
      ? {
          count: sorted.length,
          min: sorted[0],
          mid: sorted[Math.floor(sorted.length / 2)],
          max: sorted[sorted.length - 1],
        }
      : null;

    // 값이 하나뿐이면 나눌 것이 없어 고정 구간으로 보여 준다.
    const useQuantile = mode !== 'fixed' && sorted.length >= 2 && sorted[0] !== sorted[sorted.length - 1];

    if (!useQuantile) {
      for (const feature of features) {
        const style = priceStyle(Number(feature.properties.price));
        feature.properties.color = style.color;
        feature.properties.band = style.label;
        feature.properties.rank = rankOf(sorted, Number(feature.properties.price));
      }
      const ordered = new Map();
      PRICE_BREAKS.forEach((b, i) => {
        if (features.some((f) => f.properties.band === b.label)) ordered.set(b.label, PRICE_RAMP[i]);
      });
      if (features.some((f) => f.properties.band === '값 없음')) ordered.set('값 없음', NO_PRICE_COLOR);
      return { kinds: ordered, stats, mode: 'fixed' };
    }

    const edges = quantileEdges(sorted, QUANTILE_BUCKETS);
    const count = edges.length + 1;
    const bounds = [sorted[0], ...edges, sorted[sorted.length - 1]];

    for (const feature of features) {
      const price = Number(feature.properties.price);
      if (!Number.isFinite(price) || price <= 0) {
        feature.properties.color = NO_PRICE_COLOR;
        feature.properties.band = '값 없음';
        feature.properties.rank = 0;
        continue;
      }
      const index = edges.filter((e) => price >= e).length;
      feature.properties.color = rampColor(index, count);
      feature.properties.band =
        index === count - 1
          ? `${shortPrice(bounds[index])} 이상`
          : `${shortPrice(bounds[index])}~${shortPrice(bounds[index + 1])}`;
      feature.properties.rank = rankOf(sorted, price);
    }

    for (let i = 0; i < count; i += 1) {
      const label = i === count - 1 ? `${shortPrice(bounds[i])} 이상` : `${shortPrice(bounds[i])}~${shortPrice(bounds[i + 1])}`;
      kinds.set(label, rampColor(i, count));
    }
    if (features.some((f) => f.properties.band === '값 없음')) kinds.set('값 없음', NO_PRICE_COLOR);
    return { kinds, stats, mode: 'auto' };
  }

  /** 이 화면 안에서 상위 몇 %인지. 100이면 가장 비싸다. */
  function rankOf(sorted, price) {
    if (!sorted.length || !Number.isFinite(price) || price <= 0) return 0;
    const below = sorted.filter((v) => v < price).length;
    return Math.round((below / sorted.length) * 100);
  }

  /** 상태줄에 넣을 한 줄 요약. */
  function priceSummary(stats) {
    if (!stats) return '';
    return `최저 ${shortPrice(stats.min)} · 중앙 ${shortPrice(stats.mid)} · 최고 ${shortPrice(stats.max)} (원/㎡)`;
  }

  async function fetchParcels(vworldKey, point, radiusM, mode) {
    const found = await fetchFeatures('parcel', VWORLD_PARCEL_LAYERS, vworldKey, point, radiusM);
    if (!found || !found.features) return found;

    let priced = 0;
    const out = found.features.map((feature) => {
      const props = feature.properties || {};
      const price = Number(String(pickField(props, PRICE_FIELDS) ?? '').replace(/[^\d.]/g, ''));
      if (Number.isFinite(price) && price > 0) priced += 1;
      return {
        type: 'Feature',
        properties: {
          price: Number.isFinite(price) ? price : 0,
          jibun: String(pickField(props, JIBUN_FIELDS) ?? ''),
          area: String(pickField(props, AREA_FIELDS) ?? ''),
          year: String(pickField(props, YEAR_FIELDS) ?? ''),
        },
        geometry: feature.geometry,
      };
    });

    const geojson = { type: 'FeatureCollection', features: out };
    const styled = applyPriceColors(geojson, mode);

    return {
      geojson,
      layer: found.layer,
      capped: found.capped,
      kinds: styled.kinds,
      stats: styled.stats,
      scaleMode: styled.mode,
      priced,
    };
  }


  window.VWorldData = {
    // 건물 조회도 같은 헬퍼를 쓰므로 함께 내보낸다.
    jsonp,
    bboxAround,
    distanceM,
    areaGuard,
    pickField,
    fetchFeatures,
    fetchZoning,
    fetchParcels,
    applyPriceColors,
    priceSummary,
    formatPrice,
    shortPrice,
    priceStyle,
    zoneStyle,
    PRICE_BREAKS,
    FEATURE_LIMIT,
  };
})();
