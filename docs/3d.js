(function () {
  'use strict';

  /**
   * 3D 지도 화면.
   *
   * 1순위: VWorld 3D(WebGL) API. webglMapInit.js.do 를 불러 vw 엔진을 쓴다.
   * 2순위: MapLibre GL + VWorld 배경지도 타일을 기울여 보는 방식.
   *
   * VWorld 3D는 2D 타일과 별개 서비스라, 같은 인증키로 2D가 떠도 3D는 빈
   * 응답이 오는 경우가 있다(실제로 관측됐다). 그때 화면이 검은 채로 끝나면
   * 안 되므로, 이미 동작이 확인된 2D 타일을 기울여 대신 보여준다. 지형·건물
   * 입체는 없지만 시점은 3D다.
   */

  // 기본 주소는 좌표를 박아두지 않고 실제로 찾아간다. 주소만 바꾸고 좌표를
  // 그대로 두면 엉뚱한 곳이 열리는데, 실제로 한 번 그랬다.
  const DEFAULT_ADDRESS = '세종특별자치시 연동면 명학산단로 110-5';
  const SEJONG_CENTER = { lat: 36.48, lng: 127.289, label: '세종특별자치시' };

  const statusEl = document.getElementById('status3d');
  const diagEl = document.getElementById('diag');
  const placeEl = document.getElementById('place');
  const tiltEl = document.getElementById('tilt');
  const goEl = document.getElementById('go');
  const layerEl = document.getElementById('layer');
  const buildingsEl = document.getElementById('buildings');
  const labelsEl = document.getElementById('labels');
  const sourceEl = document.getElementById('source');
  const to2dEl = document.getElementById('to-2d');
  const zoningEl = document.getElementById('zoning');
  const parcelsEl = document.getElementById('parcels');
  const priceModeEl = document.getElementById('pricemode');
  const legendEl = document.getElementById('legend');

  let engine = null; // { kind: 'vworld' | 'maplibre', moveTo(point, tilt) }
  let vworldKey = '';

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  function diag(lines) {
    diagEl.textContent = lines.filter(Boolean).join('\n');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`불러오기 실패: ${src}`));
      document.head.appendChild(el);
    });
  }

  function loadStyle(href) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`스타일 로드 실패: ${href}`));
      document.head.appendChild(el);
    });
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
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) throw new Error('주소를 찾지 못했습니다.');
    return { lat: Number(data[0].lat), lng: Number(data[0].lon), label: data[0].display_name };
  }

  /* ------------------------------------------------------- VWorld 3D 시도 */

  /**
   * webglMapInit.js.do 는 로더다. 받아진 뒤 실제 엔진을 비동기로 더 불러오므로
   * onload 직후에는 vw가 없다. 준비될 때까지 기다린다.
   */
  function waitForVw(timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const vw = window.vw;
        if (vw && (typeof vw.Map === 'function' || typeof vw.MapController === 'function')) {
          resolve({ ok: true, waitedMs: Date.now() - startedAt });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve({ ok: false, waitedMs: Date.now() - startedAt, partial: !!vw });
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  function vworldCamera(point, tilt, height) {
    return new window.vw.CameraPosition(
      new window.vw.CoordZ(point.lng, point.lat, height),
      new window.vw.Direction(0, Number(tilt), 0)
    );
  }

  function initVworld(point, tilt) {
    const vw = window.vw;
    const attempts = [];

    for (const Ctor of ['Map', 'MapController']) {
      if (typeof vw[Ctor] !== 'function') continue;
      try {
        const map = new vw[Ctor]({
          mapId: 'vmap',
          initPosition: vworldCamera(point, tilt, 800),
          logo: true,
          navigation: true,
        });
        if (map && (typeof map.moveTo === 'function' || typeof map.getCurrentPosition === 'function')) {
          return { map, mode: `${Ctor}(options 3.0)` };
        }
        attempts.push(`${Ctor}: 조작 메서드 없음`);
      } catch (error) {
        attempts.push(`${Ctor}: ${error.message}`);
      }
    }
    throw new Error(`초기화 실패 (${attempts.join(' | ') || '진입점 없음'})`);
  }

  /** VWorld 3D를 끝까지 시도한다. 성공하면 엔진을, 실패하면 실패 사유를 돌려준다. */
  async function tryVworld(point, tilt) {
    const base = 'https://map.vworld.kr/js/webglMapInit.js.do';
    const domain = location.hostname || 'localhost';
    const candidates = [
      { label: '3.0', src: `${base}?version=3.0&apiKey=${encodeURIComponent(vworldKey)}` },
      {
        label: '3.0 + domain',
        src: `${base}?version=3.0&apiKey=${encodeURIComponent(vworldKey)}&domain=${encodeURIComponent(domain)}`,
      },
    ];

    // 스크립트가 전역에 무엇을 만들었는지 보려고 앞뒤를 비교한다.
    const before = new Set(Object.keys(window));
    const tried = [];

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      try {
        setStatus(`VWorld 3D를 불러오는 중… (${candidate.label})`);
        await loadScript(candidate.src);
        const ready = await waitForVw(i === 0 ? 10000 : 4000);
        if (ready.ok) {
          const result = initVworld(point, tilt);
          return { ok: true, engine: result, label: candidate.label, waitedMs: ready.waitedMs };
        }
        tried.push(`${candidate.label}: vw 없음 (${Math.round(ready.waitedMs / 1000)}초)`);
      } catch (error) {
        tried.push(`${candidate.label}: ${error.message}`);
      }
    }

    const added = Object.keys(window).filter((k) => !before.has(k));
    return { ok: false, tried, added };
  }

  /* ------------------------------------------ MapLibre + VWorld 타일 대안 */

  /** VWorld가 제공하는 배경지도 종류. 확장자가 레이어마다 다르다. */
  const VWORLD_LAYERS = {
    base: { layer: 'Base', ext: 'png' },
    gray: { layer: 'gray', ext: 'png' },
    midnight: { layer: 'midnight', ext: 'png' },
    satellite: { layer: 'Satellite', ext: 'jpeg' },
    hybrid: { layer: 'Hybrid', ext: 'png' },
  };

  function vworldTiles(kind) {
    const spec = VWORLD_LAYERS[kind] || VWORLD_LAYERS.base;
    // WMTS 경로는 /{z}/{TileRow}/{TileCol} 이라 {y}/{x} 순서다.
    return `https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/${spec.layer}/{z}/{y}/{x}.${spec.ext}`;
  }

  /* ------------------------------------------------------------ 건물 3D */

  /**
   * 건물을 세우려면 건물 외곽선과 높이가 필요한데 VWorld 배경지도 타일은
   * 그림일 뿐이라 그 정보가 없다. VWorld 3D가 막혀 있으므로 OpenStreetMap
   * 건물 데이터를 Overpass로 받아 직접 세운다. 인증키가 필요 없다.
   *
   * 다만 OSM 건물은 도심 위주로 채워져 있어, 산업단지나 시골은 비어 있을 수
   * 있다. 그래서 몇 동을 세웠는지 화면에 알려 준다.
   */
  const OVERPASS = 'https://overpass-api.de/api/interpreter';

  // 용도지역·필지·공시지가 조회는 2D 화면과 함께 쓰는 공용 모듈에 있다.
  const {
    pickField,
    fetchFeatures,
    fetchZoning,
    fetchParcels,
    applyPriceColors,
    priceSummary,
    priceScaleNote,
    formatPrice,
    areaGuard,
    distanceM,
  } = window.VWorldData;

  /**
   * 겹쳐 보기 조회 범위. 2D 화면과 같은 생각이다. 화면에 보이는 만큼만 받고,
   * 너무 축소하면 아예 받지 않는다. 한 요청의 개수 상한 때문에 넓히면 일부만
   * 잘려 오는데, 그 상태가 아무 표시가 없는 것보다 나쁘다.
   */
  const PRICE_TITLES = {
    fixed: '공시지가 (고정 구간, 원/㎡)',
    smooth: '공시지가 (이 화면 안 순위, 원/㎡)',
    quantile: '공시지가 (이 화면 분포, 원/㎡)',
  };

  const BUILDING_VIEW = { minZoom: 14, min: 400, max: 900 };
  const PARCEL_VIEW = { minZoom: 15, min: 250, max: 1200 };
  const ZONING_VIEW = { minZoom: 12, min: 400, max: 2500 };

  /** 지도를 끌 때마다 조회하면 요청이 쏟아진다. 손을 뗀 뒤에 한 번만 받는다. */
  function debounce(fn, ms) {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  /* ------------------------------------------- VWorld 국가 건물 데이터 */

  /**
   * 국토교통부 GIS건물통합정보. 연속지적도 기반 건물 외곽선에 건축물대장
   * 속성(층수 등)을 붙인 데이터이고, VWorld 데이터 API로 받을 수 있다.
   *
   * OSM 건물은 도심 위주라 산업단지나 시골이 비는데, 이쪽은 전국을 덮는다.
   * 그래서 이걸 먼저 시도하고 안 되면 OSM으로 내려간다.
   *
   * 레이어 이름을 확신할 수 없어 후보를 순서대로 시도한다. 이 환경에서는
   * VWorld에 닿지 못해 어느 이름이 맞는지 확인할 수 없었다.
   */
  const VWORLD_BUILDING_LAYERS = ['LT_C_BLDGINFO', 'LT_C_SPBD', 'LT_C_BULD', 'LT_C_BLDG'];

  const HEIGHT_FIELDS = ['gro_flo_co', 'grofloco', 'gro_flo_cnt', 'flr_cnt', 'bldg_hg', 'height', '층수', '지상층수'];
  const NAME_FIELDS = ['bldnm', 'buld_nm', 'bld_nm', 'bldg_nm', 'name', '건물명'];

  async function fetchVworldBuildings(point, radiusM) {
    const found = await fetchFeatures('building', VWORLD_BUILDING_LAYERS, vworldKey, point, radiusM);
    if (!found || !found.features) return found;

    const labels = [];
    const out = found.features.map((feature) => {
      const props = feature.properties || {};
      const floors = parseFloat(String(pickField(props, HEIGHT_FIELDS) ?? '').replace(/[^\d.]/g, ''));
      // 층수로 오는 값이면 3m를 곱하고, 이미 미터면 그대로 쓴다.
      const height = Number.isFinite(floors) && floors > 0 ? (floors < 200 ? floors * 3 : floors) : 6;
      const name = pickField(props, NAME_FIELDS);
      if (name) {
        const c = centroidOf(feature.geometry);
        if (c) labels.push({ name: String(name), lat: c.lat, lng: c.lng });
      }
      return { type: 'Feature', properties: { height }, geometry: feature.geometry };
    });

    return {
      geojson: { type: 'FeatureCollection', features: out },
      labels: sortNearest(labels, point, 60),
      layer: found.layer,
    };
  }

  function centroidOf(geometry) {
    if (!geometry) return null;
    const rings =
      geometry.type === 'Polygon'
        ? geometry.coordinates
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates.flat()
          : [];
    const ring = rings[0];
    if (!Array.isArray(ring) || !ring.length) return null;
    const lng = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    return { lat, lng };
  }

  function sortNearest(labels, center, limit) {
    const seen = new Set();
    const unique = [];
    for (const label of labels) {
      if (seen.has(label.name)) continue;
      seen.add(label.name);
      const dLat = label.lat - center.lat;
      const dLng = (label.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180);
      unique.push({ ...label, d2: dLat * dLat + dLng * dLng });
    }
    unique.sort((a, b) => a.d2 - b.d2);
    return unique.slice(0, limit);
  }


  function buildingHeight(tags) {
    const direct = parseFloat(String(tags.height || '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(direct) && direct > 0) return direct;
    const levels = parseFloat(tags['building:levels']);
    if (Number.isFinite(levels) && levels > 0) return levels * 3;
    return 6; // 태그가 없으면 2층 정도로 본다.
  }

  function toGeoJson(elements) {
    const features = [];
    for (const el of elements) {
      // way 는 geometry 를 그대로, relation 은 outer 링만 쓴다.
      const rings =
        el.type === 'way' && Array.isArray(el.geometry)
          ? [el.geometry]
          : el.type === 'relation' && Array.isArray(el.members)
            ? el.members.filter((m) => m.role === 'outer' && Array.isArray(m.geometry)).map((m) => m.geometry)
            : [];

      for (const ring of rings) {
        if (!ring || ring.length < 4) continue;
        const coords = ring.map((p) => [p.lon, p.lat]);
        // 폴리곤은 첫 점과 끝 점이 같아야 한다.
        if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
          coords.push(coords[0]);
        }
        features.push({
          type: 'Feature',
          properties: { height: buildingHeight(el.tags || {}) },
          geometry: { type: 'Polygon', coordinates: [coords] },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  /** 이름이 붙은 지점을 뽑는다. 건물 이름은 중심점에 놓는다. */
  function toLabels(elements, center, limit) {
    const seen = new Set();
    const labels = [];
    for (const el of elements) {
      const name = el.tags && el.tags.name;
      if (!name || seen.has(name)) continue;

      let lat = null;
      let lng = null;
      if (typeof el.lat === 'number') {
        lat = el.lat;
        lng = el.lon;
      } else if (el.center) {
        lat = el.center.lat;
        lng = el.center.lon;
      } else if (Array.isArray(el.geometry) && el.geometry.length) {
        // 중심점이 없으면 외곽선 평균으로 대신한다.
        const pts = el.geometry.filter((p) => p && typeof p.lat === 'number');
        if (!pts.length) continue;
        lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
        lng = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
      }
      if (lat === null || lng === null) continue;

      seen.add(name);
      const dLat = lat - center.lat;
      const dLng = (lng - center.lng) * Math.cos((center.lat * Math.PI) / 180);
      labels.push({ name, lat, lng, d2: dLat * dLat + dLng * dLng });
    }
    // 화면이 글자로 덮이지 않게 가까운 것부터 자른다.
    labels.sort((a, b) => a.d2 - b.d2);
    return labels.slice(0, limit);
  }

  async function fetchBuildings(point, radiusM) {
    // 건물 외곽선과 함께, 이름이 붙은 장소(상호·시설)도 같이 받는다.
    // 배경지도 그림에는 글자가 그려져 있지만 데이터가 아니라 읽을 수 없다.
    const around = `(around:${radiusM},${point.lat},${point.lng})`;
    const query =
      `[out:json][timeout:25];(` +
      `way["building"]${around};` +
      `relation["building"]${around};` +
      `node["name"]["amenity"]${around};` +
      `node["name"]["shop"]${around};` +
      `node["name"]["office"]${around};` +
      `node["name"]["tourism"]${around};` +
      `);out center geom ${1500};`;

    const response = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
    });
    if (!response.ok) throw new Error(`건물 데이터 조회 실패 (HTTP ${response.status})`);
    const data = await response.json();
    const elements = data.elements || [];
    return { geojson: toGeoJson(elements), labels: toLabels(elements, point, 60) };
  }

  function styleFor(kind) {
    const sources = {
      base: {
        type: 'raster',
        tiles: [vworldTiles(kind === 'hybrid' ? 'satellite' : kind)],
        tileSize: 256,
        attribution: '© VWorld (국토교통부)',
      },
    };
    const layers = [{ id: 'base', type: 'raster', source: 'base' }];

    // 하이브리드는 위성 위에 도로·지명을 겹치는 레이어라 단독으로는 비어 보인다.
    if (kind === 'hybrid') {
      sources.overlay = { type: 'raster', tiles: [vworldTiles('hybrid')], tileSize: 256 };
      layers.push({ id: 'overlay', type: 'raster', source: 'overlay' });
    }
    return { version: 8, sources, layers };
  }

  async function startFallback(point, tilt, reason) {
    await loadStyle('vendor/maplibre/maplibre-gl.css');
    await loadScript('vendor/maplibre/maplibre-gl.js');
    if (!window.maplibregl) throw new Error('MapLibre 로드 실패');

    const maplibregl = window.maplibregl;
    const map = new maplibregl.Map({
      container: 'vmap',
      style: styleFor(layerEl ? layerEl.value : 'base'),
      center: [point.lng, point.lat],
      zoom: 16.5,
      pitch: pitchFrom(tilt),
      bearing: -20,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    // 위성 영상은 일반 지도와 별도 레이어라, 한쪽만 안 나오는 경우가 있다.
    // 배경이 빈 채로 남으면 원인을 알 수 없으므로 타일 오류를 세어 알린다.
    let tileErrors = 0;
    map.on('error', (event) => {
      const failed = event && event.sourceId === 'base';
      if (!failed) return;
      tileErrors += 1;
      if (tileErrors === 5) {
        const kind = layerEl && layerEl.value === 'satellite' ? '위성 영상' : '일반 지도';
        setStatus(`VWorld ${kind} 타일을 불러오지 못하고 있습니다.\n인증키에 해당 레이어 사용 권한이 있는지 확인하세요.`, 'error');
      }
    });

    const marker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([point.lng, point.lat]).addTo(map);

    let buildingCount = null;
    let labelCount = null;
    let buildingSource = null;
    let nationalNote = '';
    let zoningNote = '';
    let parcelNote = '';
    let parcelKinds = null;
    let parcelScaleMode = 'quantile';
    let zoningKinds = null;
    let labelMarkers = [];
    const buildingGuard = areaGuard();
    const parcelGuard = areaGuard();
    const zoningGuard = areaGuard();

    /**
     * 상호·건물명은 HTML 마커로 그린다.
     * MapLibre의 글자 레이어는 글리프 서버가 있어야 하는데, 한글 글리프를
     * 따로 호스팅하지 않으려고 DOM으로 그린다. 개수를 제한해 화면이 글자로
     * 덮이지 않게 한다.
     */
    function renderLabels(labels) {
      labelMarkers.forEach((m) => m.remove());
      labelMarkers = [];
      labelCount = labels.length;
      if (!labelsEl || !labelsEl.checked) return;

      for (const label of labels) {
        const el = document.createElement('div');
        el.className = 'poi-label';
        el.textContent = label.name;
        labelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([label.lng, label.lat]).addTo(map));
      }
    }

    let zoningGeoJson = null;
    let parcelGeoJson = null;

    /** 필지를 공시지가 구간별 색으로 깐다. 용도지역과 겹치면 아래에 둔다. */
    function addParcelLayer(geojson) {
      if (map.getLayer('parcel-fill')) map.removeLayer('parcel-fill');
      if (map.getLayer('parcel-line')) map.removeLayer('parcel-line');
      if (map.getSource('parcel')) map.removeSource('parcel');
      if (!geojson) return;

      map.addSource('parcel', { type: 'geojson', data: geojson });
      const below = map.getLayer('zoning-fill') ? 'zoning-fill' : map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
      // 공시지가가 없는 필지도 경계는 똑같이 또렷해야 한다. 회색으로 덮으면
      // 경계까지 뭉개져 '필지가 없는 땅'처럼 보인다. 색은 가격만 나타낸다.
      map.addLayer(
        {
          id: 'parcel-fill',
          type: 'fill',
          source: 'parcel',
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['case', ['==', ['get', 'priced'], 1], 0.55, 0.05],
          },
        },
        below
      );
      map.addLayer(
        {
          id: 'parcel-line',
          type: 'line',
          source: 'parcel',
          paint: { 'line-color': '#334155', 'line-width': 1, 'line-opacity': 0.85 },
        },
        below
      );
    }

    /** 보고 있는 화면을 덮는 반경. 기울여 보면 화면이 멀리까지 보여 상한을 둔다. */
    function viewRadius(spec) {
      const bounds = map.getBounds();
      const half = distanceM(
        { lat: bounds.getSouth(), lng: bounds.getWest() },
        { lat: bounds.getNorth(), lng: bounds.getEast() }
      ) / 2;
      if (!Number.isFinite(half)) return spec.min;
      return Math.round(Math.max(spec.min, Math.min(spec.max, half)));
    }

    function viewCenter() {
      const center = map.getCenter();
      return { lat: center.lat, lng: center.lng };
    }

    async function loadParcels(force) {
      if (!parcelsEl || !parcelsEl.checked || map.getZoom() < PARCEL_VIEW.minZoom) {
        parcelGuard.reset();
        parcelGeoJson = null;
        parcelKinds = null;
        addParcelLayer(null);
        parcelNote = parcelsEl && parcelsEl.checked ? '필지: 확대하면 표시됩니다' : '';
        renderAllLegends();
        return;
      }

      const at = viewCenter();
      const radius = viewRadius(PARCEL_VIEW);
      const token = parcelGuard.claim(at, radius, force);
      if (!token) return;

      const result = await fetchParcels(vworldKey, at, radius, priceModeEl ? priceModeEl.value : 'auto');
      if (!parcelGuard.fresh(token)) return; // 그 사이 지도가 더 움직였다.

      if (result && result.geojson) {
        parcelGeoJson = result.geojson;
        addParcelLayer(parcelGeoJson);
        parcelKinds = result.kinds;
        parcelNote =
          `필지 ${result.geojson.features.length}개 · 공시지가 있는 필지 ${result.priced}개 ` +
          `(${result.layer}, 반경 ${radius}m)` +
          (result.capped ? ' — 최대치라 일부 누락' : '') +
          (result.stats ? ` · ${priceSummary(result.stats)}` : '');
        parcelScaleMode = result.scaleMode;
        const scaleNote = priceScaleNote({ ...result, mode: result.scaleMode });
        if (scaleNote) parcelNote += ` · ${scaleNote}`;
      } else {
        parcelGuard.reset();
        parcelGeoJson = null;
        parcelKinds = null;
        addParcelLayer(null);
        parcelNote = result && result.failed ? `필지 없음: ${result.failed.join(' / ')}` : '';
      }
      renderAllLegends();
    }


    /** 용도지역을 반투명 면으로 깔고 범례를 만든다. 건물보다 아래에 둔다. */
    function addZoningLayer(geojson) {
      if (map.getLayer('zoning-fill')) map.removeLayer('zoning-fill');
      if (map.getLayer('zoning-line')) map.removeLayer('zoning-line');
      if (map.getSource('zoning')) map.removeSource('zoning');
      if (!geojson) return;

      map.addSource('zoning', { type: 'geojson', data: geojson });
      // 건물이 있으면 그 아래에 깔아야 건물이 가려지지 않는다.
      const below = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;
      map.addLayer(
        {
          id: 'zoning-fill',
          type: 'fill',
          source: 'zoning',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.35 },
        },
        below
      );
      map.addLayer(
        {
          id: 'zoning-line',
          type: 'line',
          source: 'zoning',
          paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.9 },
        },
        below
      );
    }

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

    function renderAllLegends() {
      if (!legendEl) return;
      legendEl.textContent = '';
      const priceTitle = PRICE_TITLES[parcelScaleMode] || PRICE_TITLES.quantile;
      const groups = [legendGroup(priceTitle, parcelKinds), legendGroup('용도지역', zoningKinds)].filter(Boolean);
      groups.forEach((g) => legendEl.appendChild(g));
      legendEl.hidden = groups.length === 0;
    }

    function renderLegend(kinds) {
      zoningKinds = kinds;
      renderAllLegends();
    }

    /** 클릭한 자리의 용도지역 이름을 알려 준다. */
    map.on('click', (event) => {
      const layers = ['parcel-fill', 'zoning-fill'].filter((id) => map.getLayer(id));
      if (!layers.length) return;
      const hits = map.queryRenderedFeatures(event.point, { layers });
      const parcel = hits.find((h) => h.layer.id === 'parcel-fill');
      const zone = hits.find((h) => h.layer.id === 'zoning-fill');

      const lines = [];
      if (parcel) {
        const p = parcel.properties;
        const price = Number(p.price);
        lines.push(p.jibun ? `지번 ${p.jibun}` : '지번 미상');
        lines.push(formatPrice(price) + (p.year ? ` · ${p.year}년 공시` : ''));
        // rank 0(가장 싼 필지)도 보여야 하므로 값 존재로 판단한다.
        if (price > 0) lines.push(`이 화면 기준 백분위 ${Number(p.rank) || 0} (0 = 가장 쌈, 100 = 가장 비쌈)`);
        if (price <= 0) lines.push('공시지가가 함께 오지 않은 필지입니다 (도로·구거·국공유지 등)');
        if (p.area) lines.push(`면적 ${Number(p.area).toLocaleString('ko-KR')}㎡`);
      }
      if (zone) lines.push(`${zone.properties.zone} (${zone.properties.group})`);
      if (lines.length) setStatus(lines.join('\n'), 'ok');
    });

    async function loadZoning(force) {
      if (!zoningEl || !zoningEl.checked || map.getZoom() < ZONING_VIEW.minZoom) {
        zoningGuard.reset();
        zoningGeoJson = null;
        addZoningLayer(null);
        renderLegend(null);
        zoningNote = '';
        return;
      }

      const at = viewCenter();
      const radius = viewRadius(ZONING_VIEW);
      const token = zoningGuard.claim(at, radius, force);
      if (!token) return;

      const result = await fetchZoning(vworldKey, at, radius);
      if (!zoningGuard.fresh(token)) return;

      if (result && result.geojson) {
        zoningGeoJson = result.geojson;
        addZoningLayer(zoningGeoJson);
        renderLegend(result.kinds);
        zoningNote = `용도지역 ${result.geojson.features.length}구역 (${result.layer}, 반경 ${radius}m)`;
      } else {
        zoningGuard.reset();
        zoningGeoJson = null;
        addZoningLayer(null);
        renderLegend(null);
        zoningNote = result && result.failed ? `용도지역 없음: ${result.failed.join(' / ')}` : '';
      }
    }

    /** 배경을 바꾸면 스타일이 새로 깔리므로 건물 레이어를 다시 얹어야 한다. */
    function addBuildingLayer(geojson) {
      if (map.getLayer('buildings-3d')) map.removeLayer('buildings-3d');
      if (map.getSource('buildings')) map.removeSource('buildings');
      map.addSource('buildings', { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'buildings-3d',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          'fill-extrusion-color': '#b9c4d4',
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.9,
          'fill-extrusion-vertical-gradient': true,
        },
      });
    }

    let lastGeoJson = null;
    let buildingRadius = BUILDING_VIEW.min;

    async function loadBuildings(force) {
      if (!buildingsEl || !buildingsEl.checked || map.getZoom() < BUILDING_VIEW.minZoom) {
        buildingGuard.reset();
        renderLabels([]);
        if (map.getLayer('buildings-3d')) map.removeLayer('buildings-3d');
        lastGeoJson = null;
        buildingCount = null;
        return;
      }

      const at = viewCenter();
      const radius = viewRadius(BUILDING_VIEW);
      const token = buildingGuard.claim(at, radius, force);
      if (!token) return;

      try {
        // 출처 선택. 국가 데이터는 전국을 덮고 층수가 정확하지만 연속지적도
        // 기반이라 항공사진과 어긋날 수 있다. OSM은 사진을 보고 그린 것이라
        // 사진과 잘 맞는 대신 도심 밖이 비어 있다. 그래서 고를 수 있게 한다.
        const want = sourceEl ? sourceEl.value : 'auto';
        let geojson = null;
        let labels = [];

        let national = null;
        if (want !== 'osm') {
          setStatus('국가 건물 데이터를 받는 중…');
          national = await fetchVworldBuildings(at, radius);
        }

        if (national && national.geojson) {
          geojson = national.geojson;
          labels = national.labels;
          buildingSource = `국토부 GIS건물통합정보 (${national.layer}) — 지적도 기반이라 사진과 어긋날 수 있음`;
        } else {
          // 국가 데이터가 안 되면 OSM으로 내려간다.
          setStatus('건물·상호 데이터를 받는 중…');
          const osm = await fetchBuildings(at, radius);
          geojson = osm.geojson;
          labels = osm.labels;
          buildingSource = 'OpenStreetMap (항공사진과 잘 맞음)';
          nationalNote =
            want === 'osm' ? '' : national && national.failed ? national.failed.join(' / ') : '';
        }

        // 그 사이 지도가 더 움직였으면 늦게 온 결과는 버린다.
        if (!buildingGuard.fresh(token)) return;

        lastGeoJson = geojson;
        buildingRadius = radius;
        buildingCount = geojson.features.length;
        if (buildingCount) addBuildingLayer(geojson);
        renderLabels(labels);
        describe(at);
      } catch (error) {
        buildingGuard.reset();
        buildingCount = null;
        labelCount = null;
        setStatus(`건물 데이터를 받지 못했습니다.\n${error.message}`, 'error');
      }
    }

    function describe(at) {
      const buildings =
        buildingCount === null
          ? ''
          : buildingCount === 0
            ? '이 주변은 OpenStreetMap에 등록된 건물이 없어 세울 것이 없습니다.'
            : `건물 ${buildingCount.toLocaleString('ko-KR')}동을 세웠습니다.` +
              (labelCount ? ` 상호·건물명 ${labelCount}개.` : ' 등록된 상호명은 없습니다.');
      setStatus([`${placeEl.value}`, buildings].filter(Boolean).join('\n'), 'ok');
      diag([
        `방식: MapLibre + VWorld 타일 + ${buildingSource || '건물 없음'}`,
        `이유: ${reason}`,
        nationalNote ? `국가 건물 데이터 미사용: ${nationalNote}` : '',
        zoningNote,
        parcelNote,
        `좌표: ${at.lat}, ${at.lng}`,
        buildingCount === null ? '' : `건물: ${buildingCount}동 · 이름: ${labelCount || 0}개 (반경 ${buildingRadius}m)`,
        '드래그로 회전, 두 손가락(또는 Ctrl+드래그)으로 기울입니다. 지도를 옮기면 그 자리 기준으로 다시 받습니다.',
      ]);
    }

    if (layerEl) {
      layerEl.addEventListener('change', () => {
        tileErrors = 0;
        map.setStyle(styleFor(layerEl.value));
        map.once('styledata', () => {
          if (parcelGeoJson && parcelsEl && parcelsEl.checked) addParcelLayer(parcelGeoJson);
          if (zoningGeoJson && zoningEl && zoningEl.checked) addZoningLayer(zoningGeoJson);
          if (lastGeoJson && buildingsEl && buildingsEl.checked) addBuildingLayer(lastGeoJson);
        });
      });
    }
    if (buildingsEl) {
      buildingsEl.addEventListener('change', () => loadBuildings(true));
    }
    if (labelsEl) {
      labelsEl.addEventListener('change', () => loadBuildings(true));
    }
    if (sourceEl) {
      sourceEl.addEventListener('change', () => loadBuildings(true));
    }
    if (zoningEl) {
      zoningEl.addEventListener('change', () => loadZoning(true));
    }
    if (parcelsEl) {
      parcelsEl.addEventListener('change', () => loadParcels(true));
    }
    if (priceModeEl) {
      priceModeEl.addEventListener('change', () => {
        if (!parcelGeoJson) return;
        const styled = applyPriceColors(parcelGeoJson, priceModeEl.value);
        parcelKinds = styled.kinds;
        parcelScaleMode = styled.mode;
        const source = map.getSource('parcel');
        if (source) source.setData(parcelGeoJson);
        renderAllLegends();
      });
    }

    /** 2D로 넘어갈 때 지금 보고 있는 자리를 그대로 이어 간다. */
    function syncTo2dLink() {
      if (!to2dEl) return;
      const center = viewCenter();
      to2dEl.href = `./?at=${center.lat},${center.lng}&name=${encodeURIComponent(placeEl.value)}`;
    }

    // 지도를 옮기면 그 자리 기준으로 다시 받는다. 조금 움직인 정도는
    // areaGuard 가 걸러 내므로 실제 요청은 화면이 꽤 바뀌었을 때만 나간다.
    map.on(
      'moveend',
      debounce(() => {
        syncTo2dLink();
        loadBuildings(false);
        loadZoning(false);
        loadParcels(false);
      }, 400)
    );

    engine = {
      kind: 'maplibre',
      moveTo(next, nextTilt) {
        marker.setLngLat([next.lng, next.lat]);
        map.easeTo({ center: [next.lng, next.lat], pitch: pitchFrom(nextTilt), zoom: 16.5, duration: 800 });
        // 이동이 끝나면 moveend 가 새 자리 기준으로 다시 받는다.
        return true;
      },
    };

    describe(point);
    syncTo2dLink();
    map.once('load', () => {
      loadParcels(true);
      loadZoning(true);
      loadBuildings(true);
    });
  }

  /** VWorld 3D의 tilt(-90~0)를 MapLibre의 pitch(0~85)로 옮긴다. */
  function pitchFrom(tilt) {
    const value = Math.abs(Number(tilt));
    return Math.max(0, Math.min(85, 90 - value));
  }

  /* --------------------------------------------------------------- 동작 */

  async function go() {
    const text = placeEl.value.trim();
    if (!text || !engine) return;
    goEl.disabled = true;
    try {
      setStatus('위치를 찾는 중…');
      const point = await geocode(text);
      if (!engine.moveTo(point, tiltEl.value)) {
        setStatus(`좌표는 찾았지만 시점을 옮기지 못했습니다.\n${point.lat}, ${point.lng}`, 'error');
        return;
      }
      setStatus(`${point.label}\n${point.lat}, ${point.lng}`, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      goEl.disabled = false;
    }
  }

  async function start() {
    const data = window.__SEJONG_DATA__ || {};
    vworldKey = (data.map && data.map.vworldKey) || '';

    const params = new URLSearchParams(location.search);
    const given = parseLatLng(params.get('at') || '');
    placeEl.value = params.get('name') || (given ? given.label : DEFAULT_ADDRESS);

    let point = given;
    if (!point) {
      // 좌표가 안 넘어왔으면 기본 주소를 찾아본다. 실패하면 세종시 중심에서 시작한다.
      setStatus('기본 위치를 찾는 중…');
      try {
        point = await geocode(DEFAULT_ADDRESS);
      } catch (_) {
        point = SEJONG_CENTER;
      }
    }

    if (!vworldKey) {
      setStatus('VWorld 인증키가 없어 지도를 띄울 수 없습니다.', 'error');
      return;
    }

    const tilt = tiltEl.value;
    const result = await tryVworld(point, tilt);

    if (result.ok) {
      engine = {
        kind: 'vworld',
        moveTo(next, nextTilt) {
          const position = vworldCamera(next, nextTilt, 800);
          if (typeof result.engine.map.moveTo === 'function') {
            result.engine.map.moveTo(position);
            return true;
          }
          return false;
        },
      };
      setStatus(`VWorld 3D 준비 완료\n${placeEl.value}`, 'ok');
      diag([
        `방식: VWorld 3D (${result.label})`,
        `초기화: ${result.engine.mode}`,
        `엔진 준비: ${Math.round(result.waitedMs / 1000)}초`,
        `좌표: ${point.lat}, ${point.lng}`,
      ]);
      return;
    }

    // VWorld 3D가 응답은 하는데 엔진을 만들지 않는 경우. 2D 타일로 대신한다.
    const reason = result.added.length
      ? `VWorld 3D 엔진 없음 (스크립트가 만든 전역: ${result.added.slice(0, 5).join(', ')})`
      : 'VWorld 3D 스크립트가 아무것도 만들지 않음 — 3D 서비스 미승인으로 보임';

    setStatus('VWorld 3D를 쓸 수 없어 대체 방식으로 띄웁니다…');
    try {
      await startFallback(point, tilt, reason);
    } catch (error) {
      setStatus(`3D 지도를 띄우지 못했습니다.\n${error.message}`, 'error');
      diag([reason, ...result.tried]);
    }
  }

  goEl.addEventListener('click', go);
  placeEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  tiltEl.addEventListener('change', () => {
    if (engine) go();
  });

  start();
})();
