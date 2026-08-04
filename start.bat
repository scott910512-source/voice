@echo off
chcp 65001 > nul
title 세종시 주차 구간 지도

echo.
echo   세종시 주차 허용/금지 구간 지도
echo   ================================
echo.

where node > nul 2>&1
if errorlevel 1 (
  echo   [오류] Node.js가 설치되어 있지 않습니다.
  echo.
  echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤
  echo   이 파일을 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo   서버를 시작합니다. 잠시 뒤 브라우저가 열립니다.
echo   종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo.

start "" http://localhost:3000
node server.js

echo.
echo   서버가 종료되었습니다.
pause
