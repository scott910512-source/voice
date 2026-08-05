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
  const legendEl = document.getElementById('legend2d');

  const { fetchParcels, fetchZoning, formatPrice } = window.VWorldData;

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
  let lastPoint = null;

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
    const groups = [legendGroup('공시지가', parcelKinds), legendGroup('용도지역', zoningKinds)].filter(Boolean);
    groups.forEach((g) => legendEl.appendChild(g));
    legendEl.hidden = groups.length === 0;
  }

  /** 필지를 클릭하면 지번·공시지가·면적을 띄운다. */
  function parcelPopup(props) {
    const lines = [props.jibun ? `<b>지번 ${props.jibun}</b>` : '<b>지번 미상</b>'];
    lines.push(formatPrice(Number(props.price)) + (props.year ? ` · ${props.year}년 공시` : ''));
    if (props.area) lines.push(`면적 ${Number(props.area).toLocaleString('ko-KR')}㎡`);
    return lines.join('<br>');
  }

  async function loadParcels(point) {
    if (parcelLayer) {
      map.removeLayer(parcelLayer);
      parcelLayer = null;
    }
    if (!parcelsEl.checked || !point) {
      parcelKinds = null;
      renderLegend();
      return;
    }
    statusEl.textContent = '필지·공시지가를 받는 중…';
    const result = await fetchParcels(vworldKey, point, 500);
    if (result && result.geojson) {
      parcelKinds = result.kinds;
      parcelLayer = L.geoJSON(result.geojson, {
        style: (f) => ({ color: '#475569', weight: 0.6, fillColor: f.properties.color, fillOpacity: 0.55 }),
        onEachFeature: (f, layer) => layer.bindPopup(parcelPopup(f.properties)),
      }).addTo(map);
      statusEl.textContent = `필지 ${result.geojson.features.length}개 · 공시지가 있는 필지 ${result.priced}개`;
    } else {
      parcelKinds = null;
      statusEl.textContent = result && result.failed ? `필지를 받지 못했습니다: ${result.failed.join(' / ')}` : '';
      if (result && result.failed) statusEl.dataset.tone = 'error';
    }
    renderLegend();
  }

  async function loadZoning(point) {
    if (zoningLayer) {
      map.removeLayer(zoningLayer);
      zoningLayer = null;
    }
    if (!zoningEl.checked || !point) {
      zoningKinds = null;
      renderLegend();
      return;
    }
    const result = await fetchZoning(vworldKey, point, 900);
    if (result && result.geojson) {
      zoningKinds = result.kinds;
      zoningLayer = L.geoJSON(result.geojson, {
        style: (f) => ({ color: f.properties.color, weight: 1, fillColor: f.properties.color, fillOpacity: 0.3 }),
        onEachFeature: (f, layer) => layer.bindPopup(`<b>${f.properties.zone}</b><br>${f.properties.group}`),
      }).addTo(map);
      // 필지가 위로 오도록 용도지역을 아래에 둔다.
      zoningLayer.bringToBack();
    } else {
      zoningKinds = null;
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

  function show(point) {
    if (marker) marker.remove();
    marker = L.marker([point.lat, point.lng]).addTo(map);
    map.setView([point.lat, point.lng], 17);
    resultEl.textContent = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    statusEl.textContent = point.label;
    // 3D로 넘어갈 때 지금 보고 있는 위치를 그대로 이어 간다.
    to3dEl.href = `3d.html?at=${point.lat},${point.lng}&name=${encodeURIComponent(addressEl.value)}`;
    lastPoint = point;
    loadParcels(point);
    loadZoning(point);
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

  layerEl.addEventListener('change', () => setLayer(layerEl.value));
  parcelsEl.addEventListener('change', () => loadParcels(lastPoint));
  zoningEl.addEventListener('change', () => loadZoning(lastPoint));
  locateEl.addEventListener('click', locate);
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
