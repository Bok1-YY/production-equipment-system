@echo off
setlocal EnableExtensions
title Stop Equipment System

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$owners = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; $stopped = 0; foreach ($ownerPid in $owners) { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerPid) -ErrorAction SilentlyContinue; if ($proc -and $proc.CommandLine -match 'src[\\/]+server[.]js') { Stop-Process -Id $ownerPid -Force; $stopped++ } }; if ($stopped -eq 0) { Write-Host 'Equipment System is not running.' } else { Write-Host 'Equipment System stopped.' }"

timeout /t 2 /nobreak >nul
