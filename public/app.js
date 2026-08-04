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

  let mapAdapter = null;
  let allSigns = [];

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
    return allSigns.filter((sign) => {
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
      title.textContent = signTitle(sign);

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
    setStatus(`${signs.length.toLocaleString('ko-KR')}건 표시 중 (전체 ${allSigns.length.toLocaleString('ko-KR')}건)`);
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
    let mapConfig = { naverClientId: '', kakaoJsKey: '', vworldKey: '' };
    try {
      const response = await fetch('/api/config');
      const payload = await response.json();
      mapConfig = payload.map;
    } catch (_) {
      /* 지도 키 조회 실패 시 기본 타일로 진행한다. */
    }

    try {
      mapAdapter = await window.SejongMap.create(document.getElementById('map'), mapConfig);
      mapAdapter.onMarkerClick(showDetail);
    } catch (error) {
      setStatus(`지도를 초기화하지 못했습니다: ${error.message}`, 'error');
    }

    document.querySelectorAll('.filters input').forEach((el) => el.addEventListener('change', refreshView));
    queryEl.addEventListener('input', debounce(refreshView, 200));
    refreshEl.addEventListener('click', () => loadSigns({ force: true }));
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
