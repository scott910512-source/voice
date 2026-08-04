(function () {
  'use strict';

  /**
   * VWorld 3D(WebGL) 지도.
   *
   * 이 API는 2D와 다른 점이 두 가지 있다.
   *  1) 스크립트 URL에 apiKey 말고 domain 파라미터가 더 필요하다. VWorld 콘솔에
   *     등록한 인증도메인과 정확히 같아야 한다. 여기서는 현재 호스트를 쓴다.
   *  2) 전역 vw 객체에 붙는 진입점이 버전에 따라 다르다(MapController / Map).
   *     그래서 하나로 단정하지 않고 있는 것을 찾아 순서대로 시도하고, 다 실패하면
   *     vw에 실제로 무엇이 들어 있는지 화면에 보여준다. 원인을 모른 채 검은
   *     화면만 남는 상황을 피하기 위해서다.
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

  let controller = null;
  let mode = null;

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
      el.onerror = () => reject(new Error(`스크립트를 불러오지 못했습니다: ${src}`));
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

  /** 주소 검색. 키가 필요 없는 오픈소스 지오코더를 쓴다. */
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

  function cameraPosition(point, tilt, height) {
    return new window.vw.CameraPosition(
      new window.vw.CoordZ(point.lng, point.lat, height),
      new window.vw.Direction(0, Number(tilt), 0)
    );
  }

  /**
   * 버전에 따라 진입점이 달라서 순서대로 시도한다.
   * 성공한 방식을 mode에 남겨 이후 카메라 이동에 같은 방식을 쓴다.
   */
  function initMap(point, tilt) {
    const vw = window.vw;
    const attempts = [];

    // 3.0 방식. options 객체 하나에 컨테이너 id와 초기 위치를 담는다.
    for (const Ctor of ['Map', 'MapController']) {
      if (typeof vw[Ctor] !== 'function') continue;
      try {
        const map = new vw[Ctor]({
          mapId: 'vmap',
          initPosition: cameraPosition(point, tilt, 800),
          logo: true,
          navigation: true,
        });
        // 인자를 무시하고 빈 지도를 만드는 구현도 있어, 실제로 살아 있는지 본다.
        if (map && (typeof map.moveTo === 'function' || typeof map.getCurrentPosition === 'function')) {
          return { map, mode: `${Ctor}(options 3.0)` };
        }
        attempts.push(`${Ctor}(options 3.0): 객체는 만들어졌으나 조작 메서드가 없음`);
      } catch (error) {
        attempts.push(`${Ctor}(options 3.0): ${error.message}`);
      }
    }

    if (typeof vw.MapController === 'function') {
      try {
        const position = cameraPosition(point, tilt, 800);
        vw.MapControllerOption = {
          container: 'vmap',
          mapMode: '3d-with-terrain',
          basemapType: vw.BasemapType ? vw.BasemapType.PHOTO : undefined,
          controlDensity: vw.DensityType ? vw.DensityType.EMPTY : undefined,
          interactionDensity: vw.DensityType ? vw.DensityType.BASIC : undefined,
          controlsAutoArrange: true,
          homePosition: position,
          initPosition: position,
        };
        const map = new vw.MapController(vw.MapControllerOption);
        return { map, mode: 'MapController' };
      } catch (error) {
        attempts.push(`MapController: ${error.message}`);
      }
    }

    if (typeof vw.Map === 'function') {
      try {
        const map = new vw.Map();
        if (typeof map.setOption === 'function' && vw.MapOptions) {
          map.setOption(
            new vw.MapOptions(
              vw.BasemapType ? vw.BasemapType.PHOTO : undefined,
              '',
              vw.DensityType ? vw.DensityType.EMPTY : undefined,
              vw.DensityType ? vw.DensityType.BASIC : undefined,
              true,
              cameraPosition(point, tilt, 800)
            )
          );
        }
        if (typeof map.start === 'function') map.start();
        return { map, mode: 'Map' };
      } catch (error) {
        attempts.push(`Map: ${error.message}`);
      }
    }

    const available = Object.keys(vw || {}).slice(0, 40).join(', ') || '(비어 있음)';
    throw new Error(
      `VWorld 3D 초기화에 실패했습니다.\n시도: ${attempts.join(' | ') || '진입점 없음'}\nvw에 있는 것: ${available}`
    );
  }

  function moveTo(point, tilt) {
    const vw = window.vw;
    const position = cameraPosition(point, tilt, 800);
    if (controller && typeof controller.moveTo === 'function') {
      controller.moveTo(position);
      return true;
    }
    if (vw.Camera && typeof vw.Camera.moveTo === 'function') {
      vw.Camera.moveTo(position);
      return true;
    }
    return false;
  }

  async function go() {
    const text = placeEl.value.trim();
    if (!text) return;
    goEl.disabled = true;
    try {
      setStatus('위치를 찾는 중…');
      const point = await geocode(text);
      if (!moveTo(point, tiltEl.value)) {
        setStatus(`좌표는 찾았지만 카메라를 옮기지 못했습니다.\n${point.lat}, ${point.lng}`, 'error');
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
    const key = (data.map && data.map.vworldKey) || '';
    // 3D API는 인증도메인을 함께 보내야 한다. 로컬에서는 호스트만, 배포에서는
    // 콘솔에 등록한 도메인과 같은 값이 되도록 현재 호스트를 그대로 쓴다.
    const domain = location.hostname || 'localhost';

    const params = new URLSearchParams(location.search);
    const start = parseLatLng(params.get('at') || '') || DEFAULT;
    placeEl.value = params.get('name') || (start === DEFAULT ? DEFAULT.label : start.label);

    if (!key) {
      setStatus(
        'VWorld 인증키가 없어 3D 지도를 띄울 수 없습니다.\n' +
          '워크플로를 한 번 실행해 키가 포함된 데이터로 다시 빌드하세요.',
        'error'
      );
      return;
    }

    setStatus('VWorld 3D 지도를 불러오는 중…');
    diag([`인증키: ${key.slice(0, 8)}…`, `인증도메인: ${domain}`, `초기 좌표: ${start.lat}, ${start.lng}`]);

    // 버전과 domain 파라미터 유무가 콘솔 안내마다 달라서 후보를 순서대로 시도한다.
    // 3.0(도메인 없음)이 VWorld가 현재 안내하는 형태다.
    const base = 'https://map.vworld.kr/js/webglMapInit.js.do';
    const candidates = [
      { label: '3.0', src: `${base}?version=3.0&apiKey=${encodeURIComponent(key)}` },
      {
        label: '3.0 + domain',
        src: `${base}?version=3.0&apiKey=${encodeURIComponent(key)}&domain=${encodeURIComponent(domain)}`,
      },
      {
        label: '2.0 + domain',
        src: `${base}?version=2.0&apiKey=${encodeURIComponent(key)}&domain=${encodeURIComponent(domain)}`,
      },
    ];

    const tried = [];
    let loaded = null;
    for (const candidate of candidates) {
      try {
        await loadScript(candidate.src);
        // 스크립트가 200이어도 인증 실패면 vw가 만들어지지 않는다.
        if (window.vw) {
          loaded = candidate;
          break;
        }
        tried.push(`${candidate.label}: 받았지만 vw 객체 없음`);
      } catch (error) {
        tried.push(`${candidate.label}: 불러오기 실패`);
      }
    }

    if (!loaded) {
      setStatus(
        'VWorld 3D 스크립트를 불러오지 못했습니다.\n' +
          `${tried.join('\n')}\n\n` +
          `VWorld 콘솔 → 인증키 관리 → 서비스 URL에 "${domain}" 을 등록했는지 확인하세요.`,
        'error'
      );
      diag([`인증키: ${key.slice(0, 8)}…`, `인증도메인: ${domain}`, ...tried]);
      return;
    }

    try {
      const result = initMap(start, tiltEl.value);
      controller = result.map;
      mode = result.mode;
      setStatus(`3D 지도 준비 완료\n${placeEl.value}`, 'ok');
      diag([
        `인증키: ${key.slice(0, 8)}…`,
        `스크립트: ${loaded.label}`,
        `초기화 방식: ${mode}`,
        `좌표: ${start.lat}, ${start.lng}`,
        tried.length ? `건너뛴 후보: ${tried.join(' / ')}` : '',
      ]);
    } catch (error) {
      setStatus(error.message, 'error');
      diag([`인증키: ${key.slice(0, 8)}…`, `스크립트: ${loaded.label}`, `인증도메인: ${domain}`]);
    }
  }

  goEl.addEventListener('click', go);
  placeEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  tiltEl.addEventListener('change', () => {
    if (controller) go();
  });

  start();
})();
