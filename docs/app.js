(function () {
  'use strict';

  /**
   * 두 가지 모드로 동작한다.
   *  - 서버 모드: node server.js 가 떠 있으면 /api/* 를 쓴다. 항상 최신 데이터.
   *  - 정적 모드: GitHub Pages나 로컬 파일로 열었을 때. data/signs.js 에 미리 받아둔
   *    데이터를 쓰고, 주소 검색은 브라우저에서 직접 한다. 서버가 필요 없다.
   */

  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const metaEl = document.getElementById('meta');
  const queryEl = document.getElementById('query');
  const refreshEl = document.getElementById('refresh');
  const detailEl = document.getElementById('detail');
  const detailTitleEl = document.getElementById('detail-title');
  const detailBadgeEl = document.getElementById('detail-badge');
  const detailFieldsEl = document.getElementById('detail-fields');
  const addressEl = document.getElementById('address');
  const radiusEl = document.getElementById('radius');
  const locateEl = document.getElementById('locate');
  const clearLocateEl = document.getElementById('clear-locate');
  const locateResultEl = document.getElementById('locate-result');
  const verdictEl = document.getElementById('verdict');
  const mapNoticeEl = document.getElementById('map-notice');

  let mapAdapter = null;
  let allSigns = [];
  let nearbyResult = null;
  let serverMode = false;
  let staticData = null;

  /* ------------------------------------------------------------ 거리 계산 */

  function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function parseLatLng(input) {
    const match = String(input).trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    let lat = Number(match[1]);
    let lng = Number(match[2]);
    if (lat > 100 && lng < 100) [lat, lng] = [lng, lat];
    return { lat, lng, matched: `${lat}, ${lng}`, provider: 'input' };
  }

  /** 정적 모드용 주소 검색. 키가 필요 없는 오픈소스 지오코더를 쓴다. */
  async function geocodeInBrowser(address) {
    const direct = parseLatLng(address);
    if (direct) return direct;

    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=' +
      encodeURIComponent(address);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`주소 검색에 실패했습니다 (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) {
      throw new Error('주소를 찾지 못했습니다. 도로명주소를 줄여서 넣거나 "36.48, 127.28" 처럼 좌표를 입력해 보세요.');
    }
    return { lat: Number(data[0].lat), lng: Number(data[0].lon), matched: data[0].display_name, provider: 'nominatim' };
  }

  /* --------------------------------------------------------------- 판정 */

  /**
   * 주변 표지로 주차 가능 여부를 한 문장으로 정리한다.
   * 규제 표지는 표지가 선 지점부터 효력이 있으므로, 가까운 규제일수록 강하게 본다.
   */
  function buildVerdict(signs, radius) {
    const restrictive = signs.filter(
      (s) => s.parking.category === 'no_park' || s.parking.category === 'no_stop_no_park'
    );
    const allowed = signs.filter((s) => s.parking.category === 'parking_allowed');
    const nearRestrictive = restrictive.filter((s) => s.distance <= 100);
    const nearAllowed = allowed.filter((s) => s.distance <= 300);
    const radiusText = radius >= 1000 ? `${radius / 1000}km` : `${radius}m`;

    if (nearRestrictive.length) {
      const nearest = nearRestrictive[0];
      return {
        level: 'no',
        headline: `주차 불가 가능성 높음`,
        detail: `${nearest.distance}m 거리에 「${nearest.parking.label}」 표지가 있습니다. 반경 ${radiusText} 안 규제 표지 ${restrictive.length}건.`,
      };
    }
    if (nearAllowed.length) {
      const nearest = nearAllowed[0];
      return {
        level: 'yes',
        headline: '주차 가능 구역이 가까움',
        detail: `${nearest.distance}m 거리에 「${nearest.parking.label}」 표지가 있습니다.`,
      };
    }
    if (restrictive.length || allowed.length) {
      return {
        level: 'caution',
        headline: '바로 옆에는 표지가 없음',
        detail: `반경 ${radiusText} 안에 규제 ${restrictive.length}건, 주차장 ${allowed.length}건이 있지만 100m 안에는 없습니다.`,
      };
    }
    return {
      level: 'unknown',
      headline: '주차 관련 표지 없음',
      detail:
        `반경 ${radiusText} 안에 주차 관련 도로안전표지가 등록되어 있지 않습니다. ` +
        `표지가 없다고 주차가 허용된다는 뜻은 아니므로 현장 표지를 확인하세요.` +
        (outOfCoverage() ? ` ${coverageNotice()}` : ''),
    };
  }

  /** 검색 지점이 데이터가 담고 있는 영역 밖인지 본다. */
  function outOfCoverage() {
    const bounds = staticData?.coverage?.bounds;
    if (!bounds || !nearbyResult) return false;
    const { lat, lng } = nearbyResult.center;
    const margin = 0.02; // 약 2km 여유
    return (
      lat < bounds.minLat - margin ||
      lat > bounds.maxLat + margin ||
      lng < bounds.minLng - margin ||
      lng > bounds.maxLng + margin
    );
  }

  function coverageNotice() {
    const coverage = staticData?.coverage;
    if (!coverage) return '';
    const where = [coverage.routes.join('·'), coverage.areas.join('·')].filter(Boolean).join(' / ');
    return where
      ? `이 공공데이터는 현재 ${where} 구간만 담고 있어, 검색하신 위치는 아예 포함되어 있지 않습니다.`
      : '';
  }

  function renderVerdict(result) {
    if (!result) {
      verdictEl.hidden = true;
      return;
    }
    const verdict = buildVerdict(result.signs, result.radius);
    verdictEl.hidden = false;
    verdictEl.dataset.level = verdict.level;
    verdictEl.querySelector('.verdict__headline').textContent = verdict.headline;
    verdictEl.querySelector('.verdict__detail').textContent = verdict.detail;
  }

  /* --------------------------------------------------------------- 화면 */

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.dataset.tone = tone;
    else delete statusEl.dataset.tone;
  }

  function activeCategories() {
    return [...document.querySelectorAll('.filters input:checked')].map((el) => el.dataset.category);
  }

  function signTitle(sign) {
    return sign.name || sign.address || sign.parking.label || '표지';
  }

  function visibleSigns() {
    const categories = activeCategories();
    const query = queryEl.value.trim().toLowerCase();
    const source = nearbyResult ? nearbyResult.signs : allSigns;
    return source.filter((sign) => {
      if (!categories.includes(sign.parking.category)) return false;
      if (!query) return true;
      return JSON.stringify(sign.raw).toLowerCase().includes(query);
    });
  }

  function renderCounts() {
    const counts = {};
    allSigns.forEach((sign) => {
      counts[sign.parking.category] = (counts[sign.parking.category] || 0) + 1;
    });
    document.querySelectorAll('[data-count]').forEach((el) => {
      el.textContent = counts[el.dataset.count] || 0;
    });
  }

  function renderList(signs) {
    resultsEl.textContent = '';
    const shown = signs.slice(0, 300);
    const fragment = document.createDocumentFragment();

    shown.forEach((sign) => {
      const li = document.createElement('li');
      li.className = `result result--${sign.parking.category}`;
      li.tabIndex = 0;

      const title = document.createElement('p');
      title.className = 'result__title';
      const titleText = document.createElement('span');
      titleText.textContent = signTitle(sign);
      title.appendChild(titleText);
      if (typeof sign.distance === 'number') {
        const distance = document.createElement('span');
        distance.className = 'result__distance';
        distance.textContent = sign.distance >= 1000 ? `${(sign.distance / 1000).toFixed(1)}km` : `${sign.distance}m`;
        title.appendChild(distance);
      }

      const meta = document.createElement('p');
      meta.className = 'result__meta';
      meta.textContent = [sign.parking.label, sign.route, sign.address].filter(Boolean).join(' · ');

      li.append(title, meta);
      li.addEventListener('click', () => {
        showDetail(sign);
        if (mapAdapter) mapAdapter.focus(sign);
      });
      fragment.appendChild(li);
    });

    resultsEl.appendChild(fragment);
    if (signs.length > shown.length) {
      const li = document.createElement('li');
      li.className = 'result__meta';
      li.style.padding = '8px 12px';
      li.textContent = `외 ${signs.length - shown.length}건은 지도에만 표시됩니다.`;
      resultsEl.appendChild(li);
    }
  }

  function showDetail(sign) {
    detailTitleEl.textContent = signTitle(sign);
    detailBadgeEl.textContent = sign.parking.label;
    detailBadgeEl.dataset.category = sign.parking.category;

    detailFieldsEl.textContent = '';
    const rows = Object.entries(sign.raw).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === 'object') return false;
      return String(value).trim() !== '';
    });

    if (typeof sign.distance === 'number') rows.unshift(['검색 지점에서', `${sign.distance}m`]);
    if (sign.parking.evidence) rows.unshift(['분류 근거', sign.parking.evidence]);
    rows.push(['좌표', `${sign.lat}, ${sign.lng}`]);

    rows.forEach(([key, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      detailFieldsEl.append(dt, dd);
    });

    detailEl.hidden = false;
  }

  function refreshView() {
    const signs = visibleSigns();
    renderList(signs);
    if (mapAdapter) mapAdapter.setMarkers(signs);

    if (nearbyResult) {
      const radiusText = nearbyResult.radius >= 1000 ? `${nearbyResult.radius / 1000}km` : `${nearbyResult.radius}m`;
      setStatus(
        `반경 ${radiusText} 안 ${signs.length.toLocaleString('ko-KR')}건 (전체 ${allSigns.length.toLocaleString('ko-KR')}건 중)`
      );
      return;
    }
    setStatus(`${signs.length.toLocaleString('ko-KR')}건 표시 중 (전체 ${allSigns.length.toLocaleString('ko-KR')}건)`);
  }

  /* --------------------------------------------------------- 위치 기반 조회 */

  function summarizeNearby(counts) {
    const labels = [
      ['parking_allowed', '주차 가능'],
      ['no_park', '주차 금지'],
      ['no_stop_no_park', '정차·주차 금지'],
    ];
    const parts = labels.filter(([key]) => counts[key] > 0).map(([key, label]) => `${label} ${counts[key]}건`);
    return parts.length ? parts.join(' · ') : '주차 관련 표지 없음';
  }

  /** 정적 모드에서 브라우저가 직접 반경 계산까지 한다. */
  function nearbyInBrowser(center, radius) {
    const signs = allSigns
      .filter((s) => s.mappable)
      .map((sign) => ({ ...sign, distance: Math.round(distanceMeters(center, sign)) }))
      .filter((sign) => sign.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    const counts = { no_stop_no_park: 0, no_park: 0, parking_allowed: 0, other: 0 };
    signs.forEach((s) => (counts[s.parking.category] += 1));

    const bounds = staticData?.bounds || { minLat: 36.35, maxLat: 36.78, minLng: 127.06, maxLng: 127.42 };
    const inSejong =
      center.lat >= bounds.minLat &&
      center.lat <= bounds.maxLat &&
      center.lng >= bounds.minLng &&
      center.lng <= bounds.maxLng;

    return {
      ok: true,
      center,
      radius,
      counts,
      total: signs.length,
      signs,
      warning: inSejong ? null : '검색된 좌표가 세종특별자치시 범위 밖입니다. 주소를 다시 확인하세요.',
    };
  }

  async function locate() {
    const address = addressEl.value.trim();
    if (!address) return;

    locateResultEl.textContent = '위치를 찾는 중…';
    delete locateResultEl.dataset.tone;
    locateEl.disabled = true;

    try {
      const radius = Number(radiusEl.value);
      let payload;

      if (serverMode) {
        const params = new URLSearchParams({ address, radius: String(radius) });
        const response = await fetch(`/api/near?${params}`);
        payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || '조회에 실패했습니다.');
      } else {
        const center = await geocodeInBrowser(address);
        payload = nearbyInBrowser(center, radius);
      }

      nearbyResult = payload;
      clearLocateEl.hidden = false;
      if (mapAdapter) mapAdapter.setFocusArea(payload.center, payload.radius);

      const matched = payload.center.matched || address;
      locateResultEl.textContent = payload.warning || `${matched} 기준 · ${summarizeNearby(payload.counts)}`;
      if (payload.warning) locateResultEl.dataset.tone = 'error';

      renderVerdict(payload);
      refreshView();
    } catch (error) {
      locateResultEl.textContent = error.message;
      locateResultEl.dataset.tone = 'error';
      renderVerdict(null);
    } finally {
      locateEl.disabled = false;
    }
  }

  function clearLocate() {
    nearbyResult = null;
    clearLocateEl.hidden = true;
    locateResultEl.textContent = '';
    delete locateResultEl.dataset.tone;
    renderVerdict(null);
    if (mapAdapter) mapAdapter.setFocusArea(null);
    refreshView();
  }

  /* --------------------------------------------------------------- 데이터 */

  async function loadSigns({ force = false } = {}) {
    setStatus(force ? '공공데이터를 다시 불러오는 중…' : '데이터를 불러오는 중…');

    if (!serverMode) {
      if (!staticData || !Array.isArray(staticData.signs)) {
        setStatus('데이터 파일이 없습니다. GitHub Actions가 데이터를 갱신하면 표시됩니다.', 'error');
        return;
      }
      allSigns = staticData.signs;
      renderCounts();
      refreshView();
      const generated = staticData.generatedAt ? new Date(staticData.generatedAt).toLocaleString('ko-KR') : '알 수 없음';
      const where = staticData.coverage?.routes?.length ? ` · 수록 구간: ${staticData.coverage.routes.join('·')}` : '';
      metaEl.textContent = `${generated} 기준 · 표지 ${allSigns.length.toLocaleString('ko-KR')}건${where} · 오프라인 사용 가능`;
      return;
    }

    const params = new URLSearchParams({ category: 'parking_allowed,no_park,no_stop_no_park,other' });
    if (force) params.set('refresh', '1');
    const response = await fetch(`/api/signs?${params}`);
    const payload = await response.json();

    if (!payload.ok) {
      setStatus(`데이터를 불러오지 못했습니다: ${payload.error}`, 'error');
      metaEl.textContent = payload.hint || '';
      return;
    }

    allSigns = payload.signs;
    renderCounts();
    refreshView();

    const parts = [
      `수신 ${payload.meta.fetchedCount.toLocaleString('ko-KR')} / 전체 ${payload.meta.totalCount.toLocaleString('ko-KR')}건`,
      `좌표 있는 표지 ${payload.meta.mappable.toLocaleString('ko-KR')}건`,
      payload.cached ? '캐시 사용' : '실시간 조회',
    ];
    if (payload.meta.truncated) parts.push('일일 트래픽 보호를 위해 일부만 조회');
    metaEl.textContent = parts.join(' · ');

    if (payload.meta.mappable === 0 && allSigns.length > 0) {
      setStatus('좌표 필드를 찾지 못했습니다. /api/schema 에서 실제 응답 필드를 확인하세요.', 'error');
    }
  }

  /* ----------------------------------------------------------------- 시작 */

  async function init() {
    staticData = window.__SEJONG_DATA__ || null;

    let serverConfig = null;
    try {
      const response = await fetch('api/config', { cache: 'no-store' });
      if (response.ok) {
        serverConfig = await response.json();
        serverMode = true;
      }
    } catch (_) {
      /* 서버가 없으면 정적 모드로 간다. */
    }

    const mapConfig = (serverConfig && serverConfig.map) || (staticData && staticData.map) || {
      naverClientId: '',
      kakaoJsKey: '',
      vworldKey: '',
    };

    try {
      mapAdapter = await window.SejongMap.create(document.getElementById('map'), mapConfig);
      mapAdapter.onMarkerClick(showDetail);
      if (mapAdapter.onNotice) {
        mapAdapter.onNotice((message) => {
          mapNoticeEl.textContent = message;
          mapNoticeEl.hidden = false;
        });
      }
    } catch (error) {
      setStatus(`지도를 초기화하지 못했습니다: ${error.message}`, 'error');
    }

    const defaultAddress = (serverConfig && serverConfig.defaultAddress) || (staticData && staticData.defaultAddress);
    const defaultRadius = (serverConfig && serverConfig.defaultRadius) || (staticData && staticData.defaultRadius);
    if (defaultAddress) addressEl.value = defaultAddress;
    if (defaultRadius) radiusEl.value = String(defaultRadius);

    if (!serverMode) refreshEl.hidden = true;

    document.querySelectorAll('.filters input').forEach((el) => el.addEventListener('change', refreshView));
    queryEl.addEventListener('input', debounce(refreshView, 200));
    refreshEl.addEventListener('click', () => loadSigns({ force: true }));
    locateEl.addEventListener('click', locate);
    clearLocateEl.addEventListener('click', clearLocate);
    addressEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') locate();
    });
    radiusEl.addEventListener('change', () => {
      if (nearbyResult) locate();
    });
    detailEl.querySelector('.detail__close').addEventListener('click', () => {
      detailEl.hidden = true;
    });

    await loadSigns();
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  init();
})();
