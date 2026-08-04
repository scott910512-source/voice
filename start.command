#!/bin/bash
# macOS / Linux 용 실행 스크립트. Finder에서 더블클릭하면 됩니다.

cd "$(dirname "$0")" || exit 1

echo
echo "  세종시 주차 허용/금지 구간 지도"
echo "  ================================"
echo

if ! command -v node > /dev/null 2>&1; then
  echo "  [오류] Node.js가 설치되어 있지 않습니다."
  echo
  echo "  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  echo "  (Homebrew 사용 시: brew install node)"
  echo
  read -r -p "  엔터를 누르면 닫힙니다."
  exit 1
fi

PORT="${PORT:-3000}"
echo "  서버를 시작합니다. 잠시 뒤 브라우저가 열립니다."
echo "  종료하려면 Ctrl+C 를 누르세요."
echo

# 서버가 뜰 시간을 준 뒤 브라우저를 연다.
(
  sleep 1.5
  if command -v open > /dev/null 2>&1; then
    open "http://localhost:${PORT}"
  elif command -v xdg-open > /dev/null 2>&1; then
    xdg-open "http://localhost:${PORT}"
  fi
) &

node server.js
