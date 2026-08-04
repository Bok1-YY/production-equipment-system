param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^http://\d{1,3}(\.\d{1,3}){3}:\d{1,5}$')]
  [string]$ServerUrl
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mobileDir = Join-Path $projectDir 'mobile'
$cacheDir = Join-Path $env:LOCALAPPDATA 'YSMEquipmentSystem\android-build'
$javaHome = Join-Path $cacheDir 'jdk-21'
$sdkRoot = Join-Path $cacheDir 'android-sdk'
$downloadsDir = Join-Path $projectDir 'web\downloads'
$apkTarget = Join-Path $downloadsDir 'ysm-equipment-mobile-test.apk'
$apkMetadata = Join-Path $downloadsDir 'ysm-equipment-mobile-test.json'
$apkSource = Join-Path $mobileDir 'android\app\build\outputs\apk\debug\app-debug.apk'
$script:gradleInitScript = $null

function Invoke-Download([string]$url, [string]$destination) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination -TimeoutSec 900
      return
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

function Test-Java21([string]$javaDirectory) {
  $java = Join-Path $javaDirectory 'bin\java.exe'
  if (-not (Test-Path -LiteralPath $java)) { return $false }
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $java
  $info.Arguments = '-version'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $version = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  return $version -match 'version "(21|2[2-9]|[3-9]\d)'
}

function Install-Java21 {
  if (Test-Java21 $javaHome) { return }
  Write-Host 'First Android build: downloading portable JDK 21...' -ForegroundColor Cyan
  $asset = (Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse' -TimeoutSec 60)[0]
  if (-not $asset.binary.package.link -or -not $asset.binary.package.checksum) {
    throw 'The JDK download metadata is incomplete.'
  }
  $temporary = Join-Path $env:TEMP ('ysm-jdk-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    $archive = Join-Path $temporary 'jdk.zip'
    Invoke-Download $asset.binary.package.link $archive
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$asset.binary.package.checksum).ToLowerInvariant()) {
      throw 'The downloaded JDK checksum does not match.'
    }
    $unpacked = Join-Path $temporary 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
    $root = Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1
    if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root.FullName 'bin\java.exe'))) {
      throw 'The downloaded JDK archive has an unexpected layout.'
    }
    if (Test-Path -LiteralPath $javaHome) { Remove-Item -LiteralPath $javaHome -Recurse -Force }
    Move-Item -LiteralPath $root.FullName -Destination $javaHome
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}

function Install-AndroidCommandLineTools {
  $sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
  if (Test-Path -LiteralPath $sdkManager) { return $sdkManager }
  Write-Host 'First Android build: downloading Android command-line tools...' -ForegroundColor Cyan
  $repository = [xml](Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/android/repository/repository2-1.xml' -TimeoutSec 60).Content
  $package = $repository.SelectSingleNode("//*[local-name()='remotePackage' and @path='cmdline-tools;latest']")
  $archiveNode = $package.SelectSingleNode("*[local-name()='archives']/*[local-name()='archive'][*[local-name()='host-os']='windows']/*[local-name()='complete']")
  $relativeUrl = $archiveNode.SelectSingleNode("*[local-name()='url']").InnerText
  $checksum = $archiveNode.SelectSingleNode("*[local-name()='checksum']").InnerText
  if (-not $relativeUrl -or -not $checksum) { throw 'Android command-line tools metadata is incomplete.' }

  # Windows PowerShell 5 Expand-Archive still has legacy path-length limits.
  # Keep this extraction root short because the SDK archive contains deep Maven paths.
  $temporary = Join-Path $env:TEMP ('ysm-sdk-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $temporary -Force | Out-Null
  try {
    $archive = Join-Path $temporary 'command-line-tools.zip'
    Invoke-Download "https://dl.google.com/android/repository/$relativeUrl" $archive
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA1).Hash.ToLowerInvariant()
    if ($actual -ne $checksum.ToLowerInvariant()) {
      throw 'The downloaded Android command-line tools checksum does not match.'
    }
    $unpacked = Join-Path $temporary 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
    $source = Join-Path $unpacked 'cmdline-tools'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'bin\sdkmanager.bat'))) {
      throw 'The Android command-line tools archive has an unexpected layout.'
    }
    $destination = Join-Path $sdkRoot 'cmdline-tools\latest'
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $destination
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
  return $sdkManager
}

function Get-EmbeddedServerUrl([string]$apk) {
  if (-not (Test-Path -LiteralPath $apk)) { return $null }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($apk)
  try {
    $entry = $zip.GetEntry('assets/capacitor.config.json')
    if (-not $entry) { return $null }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
      return (($reader.ReadToEnd() | ConvertFrom-Json).server.url)
    } finally {
      $reader.Dispose()
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-MobileSourceFingerprint {
  $inputs = @(
    @('package.json', 'package-lock.json', 'capacitor.config.json') | ForEach-Object {
      Get-Item -LiteralPath (Join-Path $mobileDir $_) -ErrorAction SilentlyContinue
    }
    @('scripts', 'www', 'android\app\src') | ForEach-Object {
      Get-ChildItem -LiteralPath (Join-Path $mobileDir $_) -Recurse -File -ErrorAction SilentlyContinue
    }
    Get-ChildItem -LiteralPath (Join-Path $mobileDir 'android') -File -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $mobileDir 'android\app') -File -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $mobileDir 'android\gradle\wrapper') -File -ErrorAction SilentlyContinue
  ) | Where-Object {
    $_.FullName -notmatch '\\android\\app\\src\\main\\assets\\' -and $_.Name -ne 'local.properties'
  } | Sort-Object FullName -Unique
  $lines = foreach ($inputFile in $inputs) {
    $relative = $inputFile.FullName.Substring($mobileDir.Length).TrimStart('\').Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $inputFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative|$hash"
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-ApkCurrent([string]$sourceFingerprint) {
  if (-not (Test-Path -LiteralPath $apkTarget) -or -not (Test-Path -LiteralPath $apkMetadata)) { return $false }
  try {
    $metadata = Get-Content -LiteralPath $apkMetadata -Raw | ConvertFrom-Json
    if ($metadata.server_url -ne $ServerUrl -or $metadata.source_fingerprint -ne $sourceFingerprint) { return $false }
    if ((Get-EmbeddedServerUrl $apkTarget) -ne $ServerUrl) { return $false }
    $actualHash = (Get-FileHash -LiteralPath $apkTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    return $actualHash -eq $metadata.apk_sha256
  } catch {
    return $false
  }
}

function Save-FileStates([string[]]$paths) {
  return @($paths | ForEach-Object {
    $exists = Test-Path -LiteralPath $_
    [pscustomobject]@{
      Path = $_
      Existed = $exists
      Bytes = if ($exists) { [System.IO.File]::ReadAllBytes($_) } else { $null }
      LastWriteTimeUtc = if ($exists) { (Get-Item -LiteralPath $_).LastWriteTimeUtc } else { $null }
    }
  })
}

function Restore-FileStates($states) {
  foreach ($state in $states) {
    if ($state.Existed) {
      [System.IO.File]::WriteAllBytes($state.Path, $state.Bytes)
      (Get-Item -LiteralPath $state.Path).LastWriteTimeUtc = $state.LastWriteTimeUtc
    } elseif (Test-Path -LiteralPath $state.Path) {
      Remove-Item -LiteralPath $state.Path -Force
    }
  }
}

function Invoke-Checked([string]$label, [scriptblock]$command) {
  Write-Host $label -ForegroundColor Cyan
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$label failed with exit code $LASTEXITCODE." }
}

function Enable-WindowsProxyForJava {
  try {
    $settings = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if (-not $settings.ProxyEnable -or -not $settings.ProxyServer) { return }
    $proxyValue = [string]$settings.ProxyServer
    if ($proxyValue -match '(?:^|;)https=([^;]+)') {
      $proxyValue = $Matches[1]
    } elseif ($proxyValue -match '(?:^|;)http=([^;]+)') {
      $proxyValue = $Matches[1]
    }
    $proxyValue = $proxyValue -replace '^https?://', ''
    if ($proxyValue -notmatch '^([^:]+):(\d+)$') { return }
    $proxyAddress = $Matches[1]
    $proxyPort = $Matches[2]
    $proxyOptions = "-Dhttp.proxyHost=$proxyAddress -Dhttp.proxyPort=$proxyPort -Dhttps.proxyHost=$proxyAddress -Dhttps.proxyPort=$proxyPort -Djdk.tls.client.protocols=TLSv1.2 -Dhttps.protocols=TLSv1.2"
    $env:GRADLE_OPTS = (($env:GRADLE_OPTS, $proxyOptions) | Where-Object { $_ }) -join ' '
    $javaProxyOptions = "$proxyOptions -Dhttp.nonProxyHosts=localhost|127.*|*.aliyun.com"
    $env:JAVA_TOOL_OPTIONS = (($env:JAVA_TOOL_OPTIONS, $javaProxyOptions) | Where-Object { $_ }) -join ' '
    $script:gradleInitScript = Join-Path $cacheDir 'windows-network.init.gradle'
    @'
gradle.beforeProject { project ->
    project.buildscript.repositories {
        maven { url = project.uri('https://maven.aliyun.com/repository/google') }
        maven { url = project.uri('https://maven.aliyun.com/repository/central') }
        maven { url = project.uri('https://maven.aliyun.com/repository/gradle-plugin') }
    }
    project.repositories.clear()
    project.repositories {
        maven { url = project.uri('https://maven.aliyun.com/repository/google') }
        maven { url = project.uri('https://maven.aliyun.com/repository/central') }
        maven { url = project.uri('https://maven.aliyun.com/repository/gradle-plugin') }
        google()
        mavenCentral()
    }
}
gradle.settingsEvaluated { settings ->
    settings.pluginManagement.repositories {
        maven { url = settings.uri('https://maven.aliyun.com/repository/gradle-plugin') }
        maven { url = settings.uri('https://maven.aliyun.com/repository/google') }
        maven { url = settings.uri('https://maven.aliyun.com/repository/central') }
    }
}
'@ | Set-Content -LiteralPath $script:gradleInitScript -Encoding ascii
    Write-Host "Android downloads will use the Windows proxy $proxyAddress`:$proxyPort" -ForegroundColor Cyan
    Write-Host 'Gradle will prefer the directly reachable Aliyun Maven mirrors.' -ForegroundColor Cyan
  } catch {
    Write-Warning 'The Windows proxy settings could not be applied to the Android build.'
  }
}

New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null
$sourceFingerprint = Get-MobileSourceFingerprint

if (Test-ApkCurrent $sourceFingerprint) {
  Write-Host "Android APK is ready for $ServerUrl" -ForegroundColor Green
  exit 0
}

Install-Java21
$sdkManager = Install-AndroidCommandLineTools
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:GRADLE_USER_HOME = Join-Path $cacheDir 'gradle'
$env:Path = "$javaHome\bin;$sdkRoot\platform-tools;$env:Path"
Enable-WindowsProxyForJava

$licenseMarker = Join-Path $cacheDir 'android-license-confirmed'
if (-not (Test-Path -LiteralPath $licenseMarker)) {
  if ($env:YSM_ACCEPT_ANDROID_LICENSES -ne '1') {
    Write-Host 'The first APK build downloads Google Android SDK components.' -ForegroundColor Yellow
    $answer = Read-Host 'Type Y to accept the Android SDK licenses and continue'
    if ($answer -notmatch '^[Yy]$') { throw 'Android SDK licenses were not accepted.' }
  }
  1..30 | ForEach-Object { 'y' } | & $sdkManager --licenses | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Android SDK license acceptance failed.' }
  Set-Content -LiteralPath $licenseMarker -Value (Get-Date -Format o) -Encoding ascii
}

$requiredSdkFiles = @(
  (Join-Path $sdkRoot 'platform-tools\adb.exe'),
  (Join-Path $sdkRoot 'platforms\android-36\android.jar'),
  (Join-Path $sdkRoot 'build-tools\35.0.0\apksigner.bat')
)
if ($requiredSdkFiles | Where-Object { -not (Test-Path -LiteralPath $_) } | Select-Object -First 1) {
  Invoke-Checked 'Installing required Android SDK components...' {
    & $sdkManager 'platform-tools' 'platforms;android-36' 'build-tools;35.0.0'
  }
} else {
  Write-Host 'Required Android SDK components are ready.' -ForegroundColor Green
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $mobileDir 'node_modules\@capacitor\android'))) {
  Push-Location $mobileDir
  try { Invoke-Checked 'Installing Android JavaScript dependencies...' { & $npm ci } }
  finally { Pop-Location }
}

$mutableMobileFiles = @(
  (Join-Path $mobileDir 'capacitor.config.json'),
  (Join-Path $mobileDir 'android\local.properties'),
  (Join-Path $mobileDir 'android\app\build.gradle'),
  (Join-Path $mobileDir 'android\variables.gradle'),
  (Join-Path $mobileDir 'android\app\src\main\AndroidManifest.xml'),
  (Join-Path $mobileDir 'android\app\capacitor.build.gradle'),
  (Join-Path $mobileDir 'android\capacitor.settings.gradle')
)
$mobileFileStates = Save-FileStates $mutableMobileFiles
try {
  Push-Location $mobileDir
  try {
    Invoke-Checked 'Configuring the Android app for the current Wi-Fi address...' {
      & node.exe 'scripts\configure-mobile.js' $ServerUrl $sdkRoot
    }
    Invoke-Checked 'Synchronizing the Android project...' { & $npx cap sync android }
    Invoke-Checked 'Applying Android project settings...' { & node.exe 'scripts\patch-android.js' }
    $versionCode = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $versionName = '0.1-local.' + (Get-Date -Format 'yyyyMMdd-HHmm')
    Write-Host 'Building the Android APK (first build can take several minutes)...' -ForegroundColor Cyan
    $gradleArguments = @('--no-daemon', '-p', 'android', ':app:assembleDebug', "-PysmVersionCode=$versionCode", "-PysmVersionName=$versionName")
    if ($script:gradleInitScript) { $gradleArguments += @('--init-script', $script:gradleInitScript) }
    if ($env:YSM_GRADLE_REFRESH -eq '1') { $gradleArguments += '--refresh-dependencies' }
    for ($buildAttempt = 1; $buildAttempt -le 3; $buildAttempt++) {
      & '.\android\gradlew.bat' @gradleArguments
      if ($LASTEXITCODE -eq 0) { break }
      if ($buildAttempt -eq 3) { throw "Android APK build failed after $buildAttempt attempts." }
      Write-Warning "Gradle download/build attempt $buildAttempt failed. Retrying with the existing cache..."
      Start-Sleep -Seconds 3
    }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $apkSource) -or (Get-Item -LiteralPath $apkSource).Length -eq 0) {
    throw 'Gradle finished, but the APK was not created.'
  }
  $apksigner = Join-Path $sdkRoot 'build-tools\35.0.0\apksigner.bat'
  Invoke-Checked 'Verifying the APK signature...' { & $apksigner verify --verbose $apkSource }
  Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
  if ((Get-EmbeddedServerUrl $apkTarget) -ne $ServerUrl) {
    throw 'The APK does not contain the current Wi-Fi server address.'
  }
  $metadata = [ordered]@{
    server_url = $ServerUrl
    source_fingerprint = $sourceFingerprint
    apk_sha256 = (Get-FileHash -LiteralPath $apkTarget -Algorithm SHA256).Hash.ToLowerInvariant()
    apk_bytes = (Get-Item -LiteralPath $apkTarget).Length
    built_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $metadata | ConvertTo-Json | Set-Content -LiteralPath $apkMetadata -Encoding utf8
} finally {
  Restore-FileStates $mobileFileStates
}
Write-Host "Android APK is ready: $apkTarget" -ForegroundColor Green
