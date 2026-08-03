param(
  [switch]$CheckOnly,
  [switch]$NoBrowser,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDir = Join-Path $projectDir 'data'
$port = 8787
$localUrl = "http://127.0.0.1:$port"
$serverEntry = Join-Path $projectDir 'src\server.js'
$pidFile = Join-Path $dataDir 'equipment-server.pid'

function Get-PrivateLanAddress {
  $addresses = foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($adapter.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
    if ($adapter.NetworkInterfaceType -in @(
      [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback,
      [System.Net.NetworkInformation.NetworkInterfaceType]::Tunnel
    )) { continue }
    foreach ($entry in $adapter.GetIPProperties().UnicastAddresses) {
      if ($entry.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
      $ip = $entry.Address.ToString()
      $private = $ip -match '^10\.' -or $ip -match '^192\.168\.' -or
        $ip -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
      if (-not $private) { continue }
      [pscustomobject]@{
        Address = $ip
        Priority = if ($adapter.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211) { 0 } else { 1 }
      }
    }
  }
  return $addresses | Sort-Object Priority, Address | Select-Object -First 1 -ExpandProperty Address
}

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/api/health" -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-PortInUse {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1', $port)
    return $task.Wait(350) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Ensure-PrivateFirewallRule([string]$nodePath) {
  $marker = Join-Path $dataDir '.firewall-8787-ready'
  if (Test-Path -LiteralPath $marker) { return }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Warning 'The server will start normally, but phone access may require Windows Firewall permission later.'
    return
  }

  $arguments = @(
    'advfirewall', 'firewall', 'add', 'rule',
    'name=YSM Equipment System Full', 'dir=in', 'action=allow',
    'protocol=TCP', "localport=$port", 'profile=private',
    "program=$nodePath", 'enable=yes'
  )
  try {
    & "$env:SystemRoot\System32\netsh.exe" @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "netsh exited with $LASTEXITCODE" }
    Set-Content -LiteralPath $marker -Value (Get-Date -Format o) -Encoding ascii
  } catch {
    Write-Warning 'The private-network firewall rule was not created. The PC page will work, but phone access may be blocked.'
  }
}

function Open-LocalPage {
  if ($NoBrowser) { return }
  try {
    $browserInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $browserInfo.FileName = $localUrl
    $browserInfo.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($browserInfo) | Out-Null
  } catch {
    Write-Warning "The browser could not be opened automatically. Open $localUrl manually."
  }
}

function Show-LogTail([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $lines = Get-Content -LiteralPath $path -Tail 20 -ErrorAction SilentlyContinue
  if (-not $lines) { return }
  Write-Host ''
  Write-Host "${label}:" -ForegroundColor Yellow
  $lines | ForEach-Object { Write-Host $_ }
}

try {
  Set-Location -LiteralPath $projectDir
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

  $node = Get-Command node.exe -ErrorAction Stop
  $nodeMajor = [int](& $node.Source -p "Number(process.versions.node.split('.')[0])")
  if ($nodeMajor -lt 22) { throw 'Node.js 22.5 or newer is required.' }
  $npm = Get-Command npm.cmd -ErrorAction Stop
  if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\qrcode\package.json'))) {
    Write-Host 'Installing dependencies for the first run...'
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }

  $lanAddress = Get-PrivateLanAddress
  if (-not $lanAddress) { throw 'No private LAN IPv4 was found. Connect this PC to the factory Wi-Fi and try again.' }
  $phoneUrl = "http://${lanAddress}:$port"

  if ($CheckOnly) {
    Write-Host "Full launcher check passed. PC: $localUrl  Phone: $phoneUrl" -ForegroundColor Green
    exit 0
  }

  if (Test-PortInUse) {
    if (Test-Health) {
      Write-Host "The equipment system is already running: $localUrl" -ForegroundColor Green
      Write-Host "Phone address: $phoneUrl"
      Open-LocalPage
      exit 0
    }
    throw "Port $port is occupied by another program. Close it and try again."
  }

  Ensure-PrivateFirewallRule $node.Source
  $env:HOST = '0.0.0.0'
  $env:PORT = [string]$port
  $env:PUBLIC_BASE_URL = $phoneUrl
  $env:YSM_DB_PATH = Join-Path $dataDir 'equipment.db'

  Write-Host ''
  Write-Host 'YSM Equipment System - Full Features' -ForegroundColor Green
  Write-Host "PC:             $localUrl"
  Write-Host "Phone:          $phoneUrl"
  Write-Host "Phone install:  $phoneUrl/%E6%89%8B%E6%9C%BA%E5%AE%89%E8%A3%85.html"
  Write-Host ''

  if ($Foreground) {
    Write-Host 'Foreground mode: keep this window open and press Ctrl+C to stop.'
    & $node.Source $serverEntry
    exit $LASTEXITCODE
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $dataDir "server-$timestamp.stdout.log"
  $stderrLog = Join-Path $dataDir "server-$timestamp.stderr.log"
  $serverCommand = '"{0}" "{1}" 1>"{2}" 2>"{3}"' -f $node.Source, $serverEntry, $stdoutLog, $stderrLog
  $serverInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $serverInfo.FileName = "$env:SystemRoot\System32\cmd.exe"
  $serverInfo.Arguments = "/d /s /c `"$serverCommand`""
  $serverInfo.WorkingDirectory = $projectDir
  $serverInfo.UseShellExecute = $true
  $serverInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $serverProcess = [System.Diagnostics.Process]::Start($serverInfo)
  if (-not $serverProcess) { throw 'Windows did not create the server process.' }

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($serverProcess.HasExited) { break }
    if (Test-Health) {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $ready) {
    Show-LogTail $stdoutLog 'Server output'
    Show-LogTail $stderrLog 'Server error'
    if ($serverProcess.HasExited) {
      throw "The server exited during startup with code $($serverProcess.ExitCode). Logs: $stderrLog"
    }
    throw "The server did not become ready within 10 seconds. Logs: $stderrLog"
  }

  $listenerPid = $null
  foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p TCP)) {
    if ($line -match "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      $listenerPid = [int]$Matches[1]
      break
    }
  }
  if (-not $listenerPid) { throw 'The server is healthy, but its listener process could not be identified.' }
  $listenerProcess = Get-Process -Id $listenerPid -ErrorAction Stop
  if ($listenerProcess.ProcessName -ne 'node') { throw "Port $port is not owned by Node.js." }
  $pidRecord = @(
    [string]$listenerPid,
    [string]$listenerProcess.StartTime.ToUniversalTime().Ticks
  )
  Set-Content -LiteralPath $pidFile -Value $pidRecord -Encoding ascii

  Write-Host "Started successfully in the background (PID $listenerPid)." -ForegroundColor Green
  Write-Host "Logs: $stdoutLog"
  Open-LocalPage
  exit 0
} catch {
  Write-Host ''
  Write-Host "Full launcher failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
