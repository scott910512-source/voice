(function () {
  'use strict';

  const CATEGORY_LABELS = {
    parking_allowed: '주차 가능',
    no_park: '주차 금지',
    no_stop_no_park: '정차·주차 금지',
    other: '주차 무관 표지',
  };

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

  let mapAdapter = null;
  let allSigns = [];
  // 위치 기반 조회 중이면 여기에 결과가 들어가고, 목록/지도는 이 결과만 보여준다.
  let nearbyResult = null;

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
      meta.textContent = [sign.parking.label, sign.address].filter(Boolean).join(' · ');

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
      setStatus(`반경 ${radiusText} 안 ${signs.length.toLocaleString('ko-KR')}건 (전체 ${allSigns.length.toLocaleString('ko-KR')}건 중)`);
      return;
    }
    setStatus(`${signs.length.toLocaleString('ko-KR')}건 표시 중 (전체 ${allSigns.length.toLocaleString('ko-KR')}건)`);
  }

  function summarizeNearby(result) {
    const labels = [
      ['parking_allowed', '주차 가능'],
      ['no_park', '주차 금지'],
      ['no_stop_no_park', '정차·주차 금지'],
    ];
    const parts = labels
      .filter(([key]) => result.counts[key] > 0)
      .map(([key, label]) => `${label} ${result.counts[key]}건`);
    return parts.length ? parts.join(' · ') : '주차 관련 표지 없음';
  }

  async function locate() {
    const address = addressEl.value.trim();
    if (!address) return;

    locateResultEl.textContent = '위치를 찾는 중…';
    delete locateResultEl.dataset.tone;
    locateEl.disabled = true;

    try {
      const params = new URLSearchParams({ address, radius: radiusEl.value });
      const response = await fetch(`/api/near?${params}`);
      const payload = await response.json();

      if (!payload.ok) throw new Error(payload.error || '조회에 실패했습니다.');

      nearbyResult = payload;
      clearLocateEl.hidden = false;
      if (mapAdapter) mapAdapter.setFocusArea(payload.center, payload.radius);

      const matched = payload.center.matched || address;
      locateResultEl.textContent = payload.warning
        ? payload.warning
        : `${matched} 기준 · ${summarizeNearby(payload)}`;
      if (payload.warning) locateResultEl.dataset.tone = 'error';

      refreshView();
    } catch (error) {
      locateResultEl.textContent = error.message;
      locateResultEl.dataset.tone = 'error';
    } finally {
      locateEl.disabled = false;
    }
  }

  function clearLocate() {
    nearbyResult = null;
    clearLocateEl.hidden = true;
    locateResultEl.textContent = '';
    delete locateResultEl.dataset.tone;
    if (mapAdapter) mapAdapter.setFocusArea(null);
    refreshView();
  }

  async function loadSigns({ force = false } = {}) {
    setStatus(force ? '공공데이터를 다시 불러오는 중…' : '데이터를 불러오는 중…');
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

  async function init() {
    let serverConfig = { map: { naverClientId: '', kakaoJsKey: '', vworldKey: '' } };
    try {
      const response = await fetch('/api/config');
      serverConfig = await response.json();
    } catch (_) {
      /* 설정 조회 실패 시 기본 타일로 진행한다. */
    }
    const mapConfig = serverConfig.map;

    try {
      mapAdapter = await window.SejongMap.create(document.getElementById('map'), mapConfig);
      mapAdapter.onMarkerClick(showDetail);
    } catch (error) {
      setStatus(`지도를 초기화하지 못했습니다: ${error.message}`, 'error');
    }

    if (serverConfig.defaultAddress) addressEl.value = serverConfig.defaultAddress;
    if (serverConfig.defaultRadius) radiusEl.value = String(serverConfig.defaultRadius);

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
