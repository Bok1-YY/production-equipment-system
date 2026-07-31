@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Equipment System

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Run the desktop dependency installer first.
  pause
  exit /b 1
)

for /f %%V in ('node.exe -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22.5 or newer is required.
  echo Run the desktop dependency installer first.
  pause
  exit /b 1
)

if not exist "node_modules\qrcode\package.json" (
  echo Installing Equipment System dependencies...
  call npm.cmd ci --replace-registry-host=always
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

set "HOST=127.0.0.1"
set "PORT=8787"
set "PUBLIC_BASE_URL=http://127.0.0.1:8787"

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
echo Equipment System is starting at http://127.0.0.1:8787
echo Keep this window open. Press Ctrl+C to stop the service.
node.exe src\server.js

if errorlevel 1 (
  echo.
  echo Equipment System stopped with an error.
  pause
)
