/**
 * 지도 어댑터.
 *
 * 국내 지도 품질(도로명·건물·1방향 표기)을 우선하기 위해
 *   1) 네이버 지도  (NAVER_MAP_CLIENT_ID)
 *   2) 카카오맵     (KAKAO_MAP_JS_KEY)
 *   3) VWorld 국내 배경지도 (VWORLD_KEY, Leaflet)
 *   4) OSM 기본 타일 (키가 하나도 없을 때, Leaflet)
 * 순으로 자동 선택한다. 어느 쪽이든 아래의 동일한 인터페이스를 돌려준다.
 *
 *   setMarkers(signs)  · focus(sign)  · onMarkerClick(fn)  · onIdle(fn)  · getBounds()
 */
(function () {
  'use strict';

  const SEJONG_CENTER = { lat: 36.48, lng: 127.289 };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`스크립트 로드 실패: ${src}`));
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

  function markerHtml(sign) {
    return `<div class="marker marker--${sign.parking.category}"></div>`;
  }

  /* ---------------------------------------------------------------- 네이버 */

  async function createNaver(container, clientId) {
    // 신규 발급 키는 ncpKeyId, 구 키는 ncpClientId 를 쓴다. 순서대로 시도한다.
    try {
      await loadScript(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`);
    } catch (_) {
      await loadScript(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpClientId=${encodeURIComponent(clientId)}`);
    }
    if (!window.naver || !window.naver.maps) throw new Error('네이버 지도 SDK 초기화 실패');

    const maps = window.naver.maps;
    const map = new maps.Map(container, {
      center: new maps.LatLng(SEJONG_CENTER.lat, SEJONG_CENTER.lng),
      zoom: 12,
      zoomControl: true,
      zoomControlOptions: { position: maps.Position.TOP_RIGHT },
    });

    let markers = [];
    let clickHandler = null;

    return {
      provider: 'naver',
      setMarkers(signs) {
        markers.forEach((m) => m.setMap(null));
        markers = signs.map((sign) => {
          const marker = new maps.Marker({
            position: new maps.LatLng(sign.lat, sign.lng),
            map,
            icon: { content: markerHtml(sign), anchor: new maps.Point(7, 7) },
          });
          maps.Event.addListener(marker, 'click', () => clickHandler && clickHandler(sign));
          marker.__sign = sign;
          return marker;
        });
      },
      focus(sign) {
        map.setCenter(new maps.LatLng(sign.lat, sign.lng));
        map.setZoom(Math.max(map.getZoom(), 16));
      },
      onMarkerClick(fn) {
        clickHandler = fn;
      },
      onIdle(fn) {
        maps.Event.addListener(map, 'idle', fn);
      },
      setFocusArea(center, radius) {
        if (this.__focus) this.__focus.forEach((o) => o.setMap(null));
        if (!center) {
          this.__focus = null;
          return;
        }
        const position = new maps.LatLng(center.lat, center.lng);
        const pin = new maps.Marker({
          position,
          map,
          icon: { content: '<div class="center-pin"></div>', anchor: new maps.Point(8, 8) },
          zIndex: 1000,
        });
        const circle = new maps.Circle({
          map,
          center: position,
          radius,
          strokeColor: '#2563eb',
          strokeOpacity: 0.7,
          strokeWeight: 1,
          fillColor: '#2563eb',
          fillOpacity: 0.07,
        });
        this.__focus = [pin, circle];
        map.setCenter(position);
        map.setZoom(radius <= 300 ? 17 : radius <= 700 ? 16 : radius <= 1200 ? 15 : 14);
      },
      getBounds() {
        const b = map.getBounds();
        return [b.minX(), b.minY(), b.maxX(), b.maxY()];
      },
    };
  }

  /* ---------------------------------------------------------------- 카카오 */

  async function createKakao(container, appKey) {
    await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`);
    if (!window.kakao || !window.kakao.maps) throw new Error('카카오맵 SDK 초기화 실패');
    await new Promise((resolve) => window.kakao.maps.load(resolve));

    const maps = window.kakao.maps;
    const map = new maps.Map(container, {
      center: new maps.LatLng(SEJONG_CENTER.lat, SEJONG_CENTER.lng),
      level: 7,
    });

    let overlays = [];
    let clickHandler = null;

    return {
      provider: 'kakao',
      setMarkers(signs) {
        overlays.forEach((o) => o.setMap(null));
        overlays = signs.map((sign) => {
          const el = document.createElement('div');
          el.innerHTML = markerHtml(sign);
          el.firstChild.addEventListener('click', () => clickHandler && clickHandler(sign));
          const overlay = new maps.CustomOverlay({
            position: new maps.LatLng(sign.lat, sign.lng),
            content: el,
            yAnchor: 0.5,
            xAnchor: 0.5,
            clickable: true,
          });
          overlay.setMap(map);
          return overlay;
        });
      },
      focus(sign) {
        map.setCenter(new maps.LatLng(sign.lat, sign.lng));
        map.setLevel(Math.min(map.getLevel(), 3));
      },
      onMarkerClick(fn) {
        clickHandler = fn;
      },
      onIdle(fn) {
        maps.event.addListener(map, 'idle', fn);
      },
      setFocusArea(center, radius) {
        if (this.__focus) this.__focus.forEach((o) => o.setMap(null));
        if (!center) {
          this.__focus = null;
          return;
        }
        const position = new maps.LatLng(center.lat, center.lng);
        const el = document.createElement('div');
        el.innerHTML = '<div class="center-pin"></div>';
        const pin = new maps.CustomOverlay({ position, content: el, yAnchor: 0.5, xAnchor: 0.5, zIndex: 10 });
        pin.setMap(map);
        const circle = new maps.Circle({
          center: position,
          radius,
          strokeWeight: 1,
          strokeColor: '#2563eb',
          strokeOpacity: 0.7,
          fillColor: '#2563eb',
          fillOpacity: 0.07,
        });
        circle.setMap(map);
        this.__focus = [pin, circle];
        map.setCenter(position);
        map.setLevel(radius <= 300 ? 2 : radius <= 700 ? 3 : radius <= 1200 ? 4 : 5);
      },
      getBounds() {
        const b = map.getBounds();
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        return [sw.getLng(), sw.getLat(), ne.getLng(), ne.getLat()];
      },
    };
  }

  /* --------------------------------------------------- Leaflet (VWorld/OSM) */

  async function createLeaflet(container, vworldKey) {
    // Leaflet은 저장소에 포함해 둔다. 폐쇄망/사내망에서도 지도 틀은 뜨고,
    // 외부로 나가는 요청은 배경지도 타일 하나로 줄어든다.
    await loadStyle('/vendor/leaflet/leaflet.css');
    await loadScript('/vendor/leaflet/leaflet.js');
    if (!window.L) throw new Error('Leaflet 로드 실패');

    const L = window.L;
    const map = L.map(container).setView([SEJONG_CENTER.lat, SEJONG_CENTER.lng], 12);

    let noticeHandler = null;
    const notify = (message) => noticeHandler && noticeHandler(message);

    const openStreetMap = () =>
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      });

    if (vworldKey) {
      // 국토교통부 VWorld 국내 배경지도. 국내 도로·지번 표기가 들어간다.
      // WMTS 경로는 /{z}/{TileRow}/{TileCol} 이라 Leaflet의 {y}/{x} 순서다.
      const vworld = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Base/{z}/{y}/{x}.png`, {
        maxZoom: 19,
        attribution: '© VWorld (국토교통부)',
      });

      // VWorld는 콘솔에 등록되지 않은 도메인에서 오는 요청을 거절한다.
      // 그 경우 지도가 통째로 회색이 되는데, 원인을 알 수 없으면 앱이
      // 고장난 것처럼 보인다. 몇 장 연속 실패하면 OSM으로 내리고 알린다.
      let failures = 0;
      let switched = false;
      vworld.on('tileerror', () => {
        failures += 1;
        if (switched || failures < 3) return;
        switched = true;
        map.removeLayer(vworld);
        openStreetMap().addTo(map);
        notify(
          'VWorld 지도를 불러오지 못해 OpenStreetMap으로 전환했습니다. ' +
            'VWorld 콘솔의 인증키 설정에 이 사이트 주소가 등록되어 있는지 확인하세요.'
        );
      });
      vworld.addTo(map);
    } else {
      openStreetMap().addTo(map);
    }

    const layer = L.layerGroup().addTo(map);
    let clickHandler = null;

    return {
      provider: vworldKey ? 'vworld' : 'osm',
      setMarkers(signs) {
        layer.clearLayers();
        signs.forEach((sign) => {
          const marker = L.marker([sign.lat, sign.lng], {
            icon: L.divIcon({
              html: markerHtml(sign),
              className: '',
              iconSize: [14, 14],
              iconAnchor: [7, 7],
            }),
          });
          marker.on('click', () => clickHandler && clickHandler(sign));
          layer.addLayer(marker);
        });
      },
      focus(sign) {
        map.setView([sign.lat, sign.lng], Math.max(map.getZoom(), 17));
      },
      onMarkerClick(fn) {
        clickHandler = fn;
      },
      onIdle(fn) {
        map.on('moveend zoomend', fn);
      },
      onNotice(fn) {
        noticeHandler = fn;
      },
      setFocusArea(center, radius) {
        if (this.__focus) this.__focus.forEach((o) => map.removeLayer(o));
        if (!center) {
          this.__focus = null;
          return;
        }
        const pin = L.marker([center.lat, center.lng], {
          icon: L.divIcon({ html: '<div class="center-pin"></div>', className: '', iconSize: [16, 16], iconAnchor: [8, 8] }),
          zIndexOffset: 1000,
        }).addTo(map);
        const circle = L.circle([center.lat, center.lng], {
          radius,
          color: '#2563eb',
          weight: 1,
          opacity: 0.7,
          fillColor: '#2563eb',
          fillOpacity: 0.07,
        }).addTo(map);
        this.__focus = [pin, circle];
        map.fitBounds(circle.getBounds(), { padding: [30, 30] });
      },
      getBounds() {
        const b = map.getBounds();
        return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      },
    };
  }

  /* ------------------------------------------------------------------ 진입 */

  async function create(container, mapConfig) {
    const attempts = [];

    if (mapConfig.naverClientId) {
      try {
        return await createNaver(container, mapConfig.naverClientId);
      } catch (error) {
        attempts.push(`네이버: ${error.message}`);
      }
    }
    if (mapConfig.kakaoJsKey) {
      try {
        return await createKakao(container, mapConfig.kakaoJsKey);
      } catch (error) {
        attempts.push(`카카오: ${error.message}`);
      }
    }
    const adapter = await createLeaflet(container, mapConfig.vworldKey);
    adapter.fallbackNotes = attempts;
    return adapter;
  }

  window.SejongMap = { create, SEJONG_CENTER };
})();
