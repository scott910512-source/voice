(function () {
  'use strict';

  /**
   * 서비스워커 등록 및 자동 갱신.
   *
   * 앱 셸을 캐시 우선으로 쓰기 때문에, 새 버전이 올라와도 사용자가 강력
   * 새로고침을 하지 않으면 옛 화면이 계속 보인다. 비개발자에게 그걸
   * 요구할 수는 없다. 새 서비스워커가 제어권을 넘겨받으면 한 번만
   * 새로고침해서 스스로 최신 화면이 되게 한다.
   */

  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  // 첫 방문에는 제어자가 없다. 이때의 controllerchange는 갱신이 아니라
  // 최초 설치이므로 새로고침하면 안 된다.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(
      (registration) => {
        // 탭을 계속 열어 두는 경우를 위해 주기적으로도 확인한다.
        setInterval(() => registration.update(), 60 * 60 * 1000);
      },
      () => {
        /* 서버 모드에는 sw.js가 없다. 무시한다. */
      }
    );
  });
})();
