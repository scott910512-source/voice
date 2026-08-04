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

  const DEFAULT = {
    lat: 36.543499,
    lng: 127.3321156,
    label: '세종특별자치시 연동면 명학산단로 110-5',
  };

  const statusEl = document.getElementById('status3d');
  const diagEl = document.getElementById('diag');
  const placeEl = document.getElementById('place');
  const tiltEl = document.getElementById('tilt');
  const goEl = document.getElementById('go');
  const layerEl = document.getElementById('layer');

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

  function vworldTiles(kind) {
    const layer = kind === 'satellite' ? 'Satellite' : 'Base';
    const ext = kind === 'satellite' ? 'jpeg' : 'png';
    // WMTS 경로는 /{z}/{TileRow}/{TileCol} 이라 {y}/{x} 순서다.
    return `https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/${layer}/{z}/{y}/{x}.${ext}`;
  }

  function styleFor(kind) {
    return {
      version: 8,
      sources: {
        base: {
          type: 'raster',
          tiles: [vworldTiles(kind)],
          tileSize: 256,
          attribution: '© VWorld (국토교통부)',
        },
      },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
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

    const marker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([point.lng, point.lat]).addTo(map);

    if (layerEl) {
      layerEl.addEventListener('change', () => map.setStyle(styleFor(layerEl.value)));
    }

    engine = {
      kind: 'maplibre',
      moveTo(next, nextTilt) {
        marker.setLngLat([next.lng, next.lat]);
        map.easeTo({ center: [next.lng, next.lat], pitch: pitchFrom(nextTilt), zoom: 16.5, duration: 800 });
        return true;
      },
    };

    setStatus(`VWorld 지도를 기울여 보는 중입니다.\n${placeEl.value}`, 'ok');
    diag([
      `방식: MapLibre + VWorld 타일`,
      `이유: ${reason}`,
      `좌표: ${point.lat}, ${point.lng}`,
      '드래그로 회전, 두 손가락(또는 Ctrl+드래그)으로 기울입니다.',
    ]);
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
    const point = parseLatLng(params.get('at') || '') || DEFAULT;
    placeEl.value = params.get('name') || (point === DEFAULT ? DEFAULT.label : point.label);

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
