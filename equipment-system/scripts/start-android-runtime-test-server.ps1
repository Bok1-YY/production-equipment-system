param(
    [int]$Port = 8787,
    [string]$DatabasePath = (Join-Path $env:TEMP 'ysm-android-runtime-test\equipment.db')
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    throw 'Node.js was not found.'
}

$allowedRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $env:TEMP 'ysm-android-runtime-test')
)
$resolvedDatabase = [System.IO.Path]::GetFullPath($DatabasePath)
$allowedPrefix = $allowedRoot.TrimEnd('\') + '\'
if (-not $resolvedDatabase.StartsWith(
    $allowedPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "The Android runtime test database must stay under $allowedRoot"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedDatabase) |
    Out-Null

$env:HOST = '127.0.0.1'
$env:PORT = [string]$Port
$env:PUBLIC_BASE_URL = "http://127.0.0.1:$Port"
$env:YSM_DB_PATH = $resolvedDatabase

Set-Location -LiteralPath $projectRoot
& $node '.\src\server.js'
exit $LASTEXITCODE
