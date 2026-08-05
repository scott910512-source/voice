(function () {
  'use strict';

  /**
   * 2D 지도 보기.
   *
   * VWorld 배경지도를 Leaflet으로 띄우고 주소로 이동한다. 3D 화면과 같은
   * 인증키·같은 배경 종류를 쓰고, 보고 있는 위치를 그대로 넘겨준다.
   */

  const SEJONG_CENTER = { lat: 36.48, lng: 127.289 };
  const DEFAULT_ADDRESS = '세종특별자치시 연동면 명학산단로 110-5';

  const statusEl = document.getElementById('status');
  const metaEl = document.getElementById('meta');
  const addressEl = document.getElementById('address');
  const locateEl = document.getElementById('locate');
  const resultEl = document.getElementById('locate-result');
  const layerEl = document.getElementById('layer2d');
  const noticeEl = document.getElementById('map-notice');
  const to3dEl = document.getElementById('to-3d');
  const parcelsEl = document.getElementById('parcels2d');
  const zoningEl = document.getElementById('zoning2d');
  const priceModeEl = document.getElementById('pricemode2d');
  const legendEl = document.getElementById('legend2d');

  const { fetchParcels, fetchZoning, applyPriceColors, priceSummary, formatPrice, areaGuard } =
    window.VWorldData;

  /**
   * 겹쳐 보기 조회 범위.
   *
   * 화면에 보이는 만큼만 받는다. 한 요청이 가져올 수 있는 개수가 정해져 있어
   * 무작정 넓히면 일부만 잘려 오는데, 그러면 "받아왔는데 반만 있는" 상태가
   * 되어 아무 표시가 없는 것보다 나쁘다. 그래서 최대 반경을 두고, 그보다 더
   * 멀리 축소하면 아예 받지 않고 확대하라고 알린다.
   */
  const PARCEL_VIEW = { minZoom: 15, min: 250, max: 1200, hint: '필지·공시지가는 지도를 더 확대하면 표시됩니다.' };
  const ZONING_VIEW = { minZoom: 12, min: 400, max: 2500, hint: '용도지역은 지도를 더 확대하면 표시됩니다.' };

  /** 3D 화면과 같은 목록. 확장자가 레이어마다 다르다. */
  const VWORLD_LAYERS = {
    base: { layer: 'Base', ext: 'png' },
    gray: { layer: 'gray', ext: 'png' },
    midnight: { layer: 'midnight', ext: 'png' },
    satellite: { layer: 'Satellite', ext: 'jpeg' },
    hybrid: { layer: 'Hybrid', ext: 'png' },
  };

  const data = window.__SEJONG_DATA__ || {};
  const vworldKey = (data.map && data.map.vworldKey) || '';

  const L = window.L;
  const map = L.map('map').setView([SEJONG_CENTER.lat, SEJONG_CENTER.lng], 13);
  let marker = null;
  let baseLayer = null;
  let overlayLayer = null;
  let switched = false;
  let parcelLayer = null;
  let zoningLayer = null;
  let parcelKinds = null;
  let zoningKinds = null;
  // 색 기준만 바꿀 때 다시 받지 않도록 받아 둔 필지를 들고 있는다.
  let parcelGeoJson = null;
  let parcelSummary = '';
  let zoningCount = 0;
  const parcelGuard = areaGuard();
  const zoningGuard = areaGuard();

  function tileUrl(kind) {
    const spec = VWORLD_LAYERS[kind] || VWORLD_LAYERS.base;
    // WMTS 경로는 /{z}/{TileRow}/{TileCol} 이라 {y}/{x} 순서다.
    return `https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/${spec.layer}/{z}/{y}/{x}.${spec.ext}`;
  }

  function openStreetMap() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    });
  }

  function setLayer(kind) {
    [baseLayer, overlayLayer].forEach((layer) => layer && map.removeLayer(layer));
    overlayLayer = null;

    if (!vworldKey) {
      baseLayer = openStreetMap().addTo(map);
      return;
    }

    // 하이브리드는 위성 위에 도로·지명을 겹치는 레이어라 단독으로는 비어 보인다.
    baseLayer = L.tileLayer(tileUrl(kind === 'hybrid' ? 'satellite' : kind), {
      maxZoom: 19,
      attribution: '© VWorld (국토교통부)',
    });

    // VWorld가 도메인을 거절하면 지도가 회색으로 남는다. 원인을 알 수 없으면
    // 앱이 고장난 것처럼 보이므로, 연속 실패하면 OSM으로 내리고 알린다.
    let failures = 0;
    baseLayer.on('tileerror', () => {
      failures += 1;
      if (switched || failures < 5) return;
      switched = true;
      map.removeLayer(baseLayer);
      openStreetMap().addTo(map);
      noticeEl.textContent =
        'VWorld 지도를 불러오지 못해 OpenStreetMap으로 전환했습니다. VWorld 콘솔의 인증키 설정에 이 사이트 주소가 등록되어 있는지 확인하세요.';
      noticeEl.hidden = false;
    });
    baseLayer.addTo(map);

    if (kind === 'hybrid') {
      overlayLayer = L.tileLayer(tileUrl('hybrid'), { maxZoom: 19 }).addTo(map);
    }
  }


  /* ------------------------------------------------ 필지 · 용도지역 */

  function legendGroup(title, kinds) {
    if (!kinds || !kinds.size) return null;
    const box = document.createElement('span');
    box.className = 'legend__group';
    const head = document.createElement('b');
    head.textContent = title;
    box.appendChild(head);
    for (const [label, color] of kinds) {
      const row = document.createElement('span');
      row.className = 'legend__item';
      const dot = document.createElement('i');
      dot.style.background = color;
      row.append(dot, document.createTextNode(label));
      box.appendChild(row);
    }
    return box;
  }

  function renderLegend() {
    legendEl.textContent = '';
    const priceTitle = priceModeEl.value === 'fixed' ? '공시지가 (고정 구간, 원/㎡)' : '공시지가 (이 화면 안에서 비교, 원/㎡)';
    const zoneTitle = zoningCount ? `용도지역 (${zoningCount}구역)` : '용도지역';
    const groups = [legendGroup(priceTitle, parcelKinds), legendGroup(zoneTitle, zoningKinds)].filter(Boolean);
    groups.forEach((g) => legendEl.appendChild(g));
    legendEl.hidden = groups.length === 0;
  }

  /**
   * 필지 경계는 공시지가가 있든 없든 똑같이 또렷해야 한다. 도로·구거·
   * 국공유지처럼 공시지가가 없는 필지를 회색으로 덮어 버리면 경계도 같이
   * 뭉개져 '필지가 없는 땅'처럼 보인다. 색은 가격만 나타내고, 값이 없으면
   * 채우지 않는다.
   */
  function parcelStyle(feature) {
    const priced = Number(feature.properties.priced) === 1;
    return {
      color: '#334155',
      weight: 1,
      opacity: 0.85,
      fillColor: feature.properties.color,
      fillOpacity: priced ? 0.55 : 0.05,
    };
  }

  /** 필지를 클릭하면 지번·공시지가·면적을 띄운다. */
  function parcelPopup(props) {
    const price = Number(props.price);
    const lines = [props.jibun ? `<b>지번 ${props.jibun}</b>` : '<b>지번 미상</b>'];
    lines.push(formatPrice(price) + (props.year ? ` · ${props.year}년 공시` : ''));
    // rank 0(가장 싼 필지)도 보여야 하므로 값 존재로 판단한다.
    if (price > 0) lines.push(`이 화면 기준 백분위 ${Number(props.rank) || 0} <small>(0 = 가장 쌈, 100 = 가장 비쌈)</small>`);
    if (price <= 0) lines.push('<i>공시지가가 함께 오지 않은 필지입니다 (도로·구거·국공유지 등)</i>');
    if (props.area) lines.push(`면적 ${Number(props.area).toLocaleString('ko-KR')}㎡`);
    return lines.join('<br>');
  }

  /** 받아 둔 필지에 색만 다시 입힌다. 기준을 바꿔도 다시 받지 않는다. */
  function restyleParcels() {
    if (!parcelGeoJson || !parcelLayer) return;
    const styled = applyPriceColors(parcelGeoJson, priceModeEl.value);
    parcelKinds = styled.kinds;
    parcelSummary = priceSummary(styled.stats);
    parcelLayer.setStyle(parcelStyle);
    parcelLayer.eachLayer((layer) => layer.setPopupContent(parcelPopup(layer.feature.properties)));
    renderLegend();
  }

  /** 보고 있는 화면을 덮는 반경. 반경 상자가 화면보다 조금 넓게 잡힌다. */
  function viewRadius(spec) {
    const bounds = map.getBounds();
    const half = map.distance(bounds.getNorthEast(), bounds.getSouthWest()) / 2;
    return Math.round(Math.max(spec.min, Math.min(spec.max, half)));
  }

  function viewCenter() {
    const center = map.getCenter();
    return { lat: center.lat, lng: center.lng };
  }

  function note(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  async function loadParcels(force) {
    const clear = () => {
      if (parcelLayer) {
        map.removeLayer(parcelLayer);
        parcelLayer = null;
      }
      parcelKinds = null;
      parcelGeoJson = null;
    };

    if (!parcelsEl.checked) {
      parcelGuard.reset();
      clear();
      renderLegend();
      return;
    }
    if (map.getZoom() < PARCEL_VIEW.minZoom) {
      parcelGuard.reset();
      clear();
      renderLegend();
      note(PARCEL_VIEW.hint);
      return;
    }

    const center = viewCenter();
    const radius = viewRadius(PARCEL_VIEW);
    const token = parcelGuard.claim(center, radius, force);
    if (!token) return; // 조금 움직인 정도라 이미 받아 둔 것으로 충분하다.

    note('필지·공시지가를 받는 중…');
    const result = await fetchParcels(vworldKey, center, radius, priceModeEl.value);
    // 응답을 기다리는 사이 지도가 더 움직였으면 늦은 결과는 버린다.
    if (!parcelGuard.fresh(token)) return;

    clear();
    if (result && result.geojson) {
      parcelGeoJson = result.geojson;
      parcelKinds = result.kinds;
      parcelSummary = priceSummary(result.stats);
      parcelLayer = L.geoJSON(result.geojson, {
        style: parcelStyle,
        onEachFeature: (f, layer) => layer.bindPopup(parcelPopup(f.properties)),
      }).addTo(map);
      const missing = result.geojson.features.length - result.priced;
      note(
        [
          `필지 ${result.geojson.features.length}개 · 공시지가 있는 필지 ${result.priced}개 (반경 ${radius}m)`,
          parcelSummary,
          missing ? `공시지가가 없는 필지 ${missing}개는 색을 채우지 않고 경계만 그립니다 (도로·구거·국공유지 등).` : '',
          result.capped ? '한 번에 받을 수 있는 최대치라 일부가 빠졌을 수 있습니다. 확대해서 보세요.' : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    } else if (result && result.failed) {
      parcelGeoJson = null;
      parcelGuard.reset();
      note(`필지를 받지 못했습니다: ${result.failed.join(' / ')}`, 'error');
    }
    renderLegend();
  }

  async function loadZoning(force) {
    const clear = () => {
      if (zoningLayer) {
        map.removeLayer(zoningLayer);
        zoningLayer = null;
      }
      zoningKinds = null;
      zoningCount = 0;
    };

    if (!zoningEl.checked || map.getZoom() < ZONING_VIEW.minZoom) {
      zoningGuard.reset();
      clear();
      renderLegend();
      return;
    }

    const center = viewCenter();
    const radius = viewRadius(ZONING_VIEW);
    const token = zoningGuard.claim(center, radius, force);
    if (!token) return;

    const result = await fetchZoning(vworldKey, center, radius);
    if (!zoningGuard.fresh(token)) return;

    clear();
    if (result && result.geojson) {
      zoningKinds = result.kinds;
      zoningCount = result.geojson.features.length;
      zoningLayer = L.geoJSON(result.geojson, {
        style: (f) => ({ color: f.properties.color, weight: 1, fillColor: f.properties.color, fillOpacity: 0.3 }),
        onEachFeature: (f, layer) =>
          layer.bindPopup(
            `<b>${f.properties.zone}</b><br>${f.properties.group}` +
              '<br><small>용도지역은 토지이용계획확인원 기준입니다. 등기부·토지대장에는 나오지 않습니다.</small>'
          ),
      }).addTo(map);
      // 필지가 위로 오도록 용도지역을 아래에 둔다.
      zoningLayer.bringToBack();
    } else if (result && result.failed) {
      // 조용히 비어 있으면 앱이 고장난 것인지 자료가 없는 것인지 알 수 없다.
      zoningGuard.reset();
      note(`용도지역을 받지 못했습니다: ${result.failed.join(' / ')}`, 'error');
    }
    renderLegend();
  }

  function parseLatLng(input) {
    const m = String(input).trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    let lat = Number(m[1]);
    let lng = Number(m[2]);
    if (lat > 100 && lng < 100) [lat, lng] = [lng, lat];
    return { lat, lng, label: `${lat}, ${lng}` };
  }

  async function geocode(text) {
    const direct = parseLatLng(text);
    if (direct) return direct;
    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=' + encodeURIComponent(text);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`주소 검색 실패 (HTTP ${response.status})`);
    const found = await response.json();
    if (!Array.isArray(found) || !found.length) {
      throw new Error('주소를 찾지 못했습니다. 줄여서 넣거나 "36.48, 127.28" 처럼 좌표를 입력해 보세요.');
    }
    return { lat: Number(found[0].lat), lng: Number(found[0].lon), label: found[0].display_name };
  }

  /** 3D로 넘어갈 때 지금 보고 있는 자리를 그대로 이어 간다. */
  function syncTo3dLink() {
    const center = viewCenter();
    to3dEl.href = `3d.html?at=${center.lat},${center.lng}&name=${encodeURIComponent(addressEl.value)}`;
  }

  function show(point) {
    if (marker) marker.remove();
    marker = L.marker([point.lat, point.lng]).addTo(map);
    map.setView([point.lat, point.lng], 17);
    resultEl.textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    statusEl.textContent = point.label;
    syncTo3dLink();
    loadParcels(true);
    loadZoning(true);
  }

  async function locate() {
    const text = addressEl.value.trim();
    if (!text) return;
    locateEl.disabled = true;
    statusEl.textContent = '위치를 찾는 중…';
    delete statusEl.dataset.tone;
    try {
      show(await geocode(text));
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.dataset.tone = 'error';
    } finally {
      locateEl.disabled = false;
    }
  }

  /** 지도를 끌 때마다 조회하면 요청이 쏟아진다. 손을 뗀 뒤에 한 번만 받는다. */
  function debounce(fn, ms) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  layerEl.addEventListener('change', () => setLayer(layerEl.value));
  parcelsEl.addEventListener('change', () => loadParcels(true));
  priceModeEl.addEventListener('change', restyleParcels);
  zoningEl.addEventListener('change', () => loadZoning(true));
  locateEl.addEventListener('click', locate);

  // 지도를 옮기면 그 자리 기준으로 다시 받는다. 조금 움직인 정도라면
  // areaGuard 가 걸러 내므로 실제 요청은 화면이 꽤 바뀌었을 때만 나간다.
  map.on(
    'moveend',
    debounce(() => {
      syncTo3dLink();
      loadParcels(false);
      loadZoning(false);
    }, 400)
  );
  addressEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') locate();
  });

  // 패널 레이아웃이 잡히기 전에 크기를 재면 지도 칸 일부가 비어 버린다.
  // pan:false 를 줘야 크기만 다시 재고 보고 있던 중심이 밀리지 않는다.
  const refit = () => map.invalidateSize({ pan: false, animate: false });
  if (window.ResizeObserver) {
    new ResizeObserver(refit).observe(document.getElementById('map'));
  } else {
    window.addEventListener('resize', refit);
  }

  setLayer(layerEl.value);
  metaEl.textContent = vworldKey ? '지도: VWorld 국내 배경지도' : '지도: OpenStreetMap (VWorld 키 없음)';

  const params = new URLSearchParams(location.search);
  const given = parseLatLng(params.get('at') || '');
  if (given) {
    addressEl.value = params.get('name') || given.label;
    show(given);
  } else {
    addressEl.value = DEFAULT_ADDRESS;
    locate();
  }
})();
