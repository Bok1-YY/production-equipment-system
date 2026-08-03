@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Stop Equipment System

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-full-windows.ps1"
if errorlevel 1 (
  echo.
  echo Stop failed. See the message above.
  pause
)
