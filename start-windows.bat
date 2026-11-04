@echo off
rem Auto SMS for ERPNext - run it on this Windows computer (for testing).
rem Double-click this file. Keep the window open while you test; close it to stop.
title Auto SMS for ERPNext
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org , install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing for the first time - this takes 2 to 3 minutes...
  call npm ci
  if errorlevel 1 (
    echo.
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node scripts\setup-env.mjs
set OPEN_BROWSER=1
set AUTO_PORT=1
call npm run dev
pause
