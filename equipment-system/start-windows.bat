@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title YSM Equipment System - Full Features

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-full-windows.ps1"
if errorlevel 1 (
  echo.
  echo Full launcher stopped with an error. See the message above.
  pause
)
