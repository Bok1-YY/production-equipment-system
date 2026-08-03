$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pidFile = Join-Path $projectDir 'data\equipment-server.pid'
$port = 8787

function Get-ListenerPid {
  foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p TCP)) {
    if ($line -match "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      return [int]$Matches[1]
    }
  }
  return $null
}

try {
  $targetPid = $null
  if (Test-Path -LiteralPath $pidFile) {
    $record = @(Get-Content -LiteralPath $pidFile -ErrorAction Stop)
    if ($record.Count -ge 2 -and $record[0] -match '^\d+$' -and $record[1] -match '^\d+$') {
      $candidate = Get-Process -Id ([int]$record[0]) -ErrorAction SilentlyContinue
      if ($candidate -and
          $candidate.ProcessName -eq 'node' -and
          $candidate.StartTime.ToUniversalTime().Ticks -eq [long]$record[1]) {
        $targetPid = $candidate.Id
      }
    }
  }

  if (-not $targetPid) {
    $listenerPid = Get-ListenerPid
    if ($listenerPid) {
      $listener = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
      if ($listener -and $listener.ProcessName -eq 'node') {
        $targetPid = $listener.Id
      }
    }
  }

  if (-not $targetPid) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Equipment System is not running.'
    exit 0
  }

  Stop-Process -Id $targetPid -Force -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Equipment System stopped.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host "Stop failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
