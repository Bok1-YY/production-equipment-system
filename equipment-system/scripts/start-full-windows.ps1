param(
  [switch]$CheckOnly,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDir = Join-Path $projectDir 'data'
$port = 8787
$localUrl = "http://127.0.0.1:$port"

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
  $arguments = @(
    'advfirewall', 'firewall', 'add', 'rule',
    'name=YSM Equipment System Full', 'dir=in', 'action=allow',
    'protocol=TCP', "localport=$port", 'profile=private',
    "program=$nodePath", 'enable=yes'
  )
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
      & "$env:SystemRoot\System32\netsh.exe" @arguments | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "netsh exited with $LASTEXITCODE" }
    } else {
      Write-Host 'Windows will ask once for permission to allow phones on the private Wi-Fi.' -ForegroundColor Yellow
      $process = Start-Process -FilePath "$env:SystemRoot\System32\netsh.exe" -ArgumentList $arguments -Verb RunAs -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "netsh exited with $($process.ExitCode)" }
    }
    Set-Content -LiteralPath $marker -Value (Get-Date -Format o) -Encoding ascii
  } catch {
    Write-Warning 'The private-network firewall rule was not created. The PC page will work, but phone access may be blocked.'
  }
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
      if (-not $NoBrowser) { Start-Process $localUrl }
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
  Write-Host "Phone install:  $phoneUrl/手机安装.html"
  Write-Host 'Keep this window open. Press Ctrl+C to stop all features.'
  Write-Host ''

  if (-not $NoBrowser) {
    $openCommand = @"
for (`$i = 0; `$i -lt 40; `$i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri '$localUrl/api/health' -TimeoutSec 1 | Out-Null; Start-Process '$localUrl'; break } catch { Start-Sleep -Milliseconds 250 }
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($openCommand))
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden | Out-Null
  }

  & $node.Source (Join-Path $projectDir 'src\server.js')
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "Full launcher failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
