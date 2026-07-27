#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$ROOT_DIR/equipment-system"
MOBILE_DIR="$PROJECT_DIR/mobile"
OUTPUT_DIR="$ROOT_DIR/安装包"
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/ysm-android-build"
JDK_DIR="$CACHE_BASE/jdk-21"
SDK_ROOT="$CACHE_BASE/android-sdk"
GRADLE_CACHE="$CACHE_BASE/gradle"
CMDLINE_VERSION="15859902"
CMDLINE_SHA256="4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583"
PORT=8788

notify_error() {
  local message="$1"
  printf '打包失败：%b\n' "$message" >&2
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --error --title="打包安卓手机测试版" \
      --text="$(printf '%b' "$message")" 2>/dev/null || true
  fi
  exit 1
}

notify_success() {
  local message="$1"
  printf '%b\n' "$message"
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --info --title="打包安卓手机测试版" \
      --text="$(printf '%b' "$message")" 2>/dev/null || true
  fi
}

detect_lan_ip() {
  local candidate=""
  if command -v ip >/dev/null 2>&1; then
    candidate="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
      { for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }
    ')"
  fi
  if [[ -z "$candidate" ]] && command -v hostname >/dev/null 2>&1; then
    candidate="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '
      /^10\./ || /^192\.168\./ || /^172\.(1[6-9]|2[0-9]|3[01])\./ { print; exit }
    ')"
  fi
  printf '%s' "$candidate"
}

confirm_sdk_license() {
  if [[ -f "$CACHE_BASE/license-confirmed" ]]; then
    return 0
  fi
  local message="首次打包需要下载并使用 Google Android SDK。继续表示你同意 Android SDK 许可协议。"
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --question --title="Android SDK 许可" --text="$message" ||
      notify_error "未接受 Android SDK 许可，已取消。"
  elif [[ "${YSM_ACCEPT_ANDROID_LICENSES:-0}" != "1" ]]; then
    printf '%s [y/N] ' "$message"
    read -r answer
    [[ "$answer" =~ ^[Yy]$ ]] || notify_error "未接受 Android SDK 许可，已取消。"
  fi
}

download_jdk() {
  [[ -x "$JDK_DIR/bin/java" ]] && return 0
  echo "首次准备：下载便携式 JDK 21……"
  local temp_dir metadata jdk_url jdk_sha
  temp_dir="$(mktemp -d)"
  metadata="$temp_dir/adoptium.json"
  curl -L --fail --retry 3 \
    "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse" \
    -o "$metadata" || notify_error "JDK 元数据下载失败。"
  jdk_url="$(node -e "const a=require('$metadata'); process.stdout.write(a[0].binary.package.link)")"
  jdk_sha="$(node -e "const a=require('$metadata'); process.stdout.write(a[0].binary.package.checksum)")"
  curl -L --fail --retry 3 "$jdk_url" -o "$temp_dir/jdk.tar.gz" ||
    notify_error "JDK 下载失败。"
  printf '%s  %s\n' "$jdk_sha" "$temp_dir/jdk.tar.gz" | sha256sum -c - >/dev/null ||
    notify_error "JDK 校验失败。"
  mkdir -p "$JDK_DIR"
  tar -xzf "$temp_dir/jdk.tar.gz" --strip-components=1 -C "$JDK_DIR"
  rm -rf "$temp_dir"
}

download_android_tools() {
  [[ -x "$SDK_ROOT/cmdline-tools/latest/bin/android" ]] && return 0
  echo "首次准备：下载 Android 命令行工具……"
  local temp_dir archive
  temp_dir="$(mktemp -d)"
  archive="$temp_dir/commandlinetools.zip"
  curl -L --fail --retry 3 \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VERSION}_latest.zip" \
    -o "$archive" || notify_error "Android 命令行工具下载失败。"
  printf '%s  %s\n' "$CMDLINE_SHA256" "$archive" | sha256sum -c - >/dev/null ||
    notify_error "Android 命令行工具校验失败。"
  unzip -q "$archive" -d "$temp_dir/unpacked"
  mkdir -p "$SDK_ROOT/cmdline-tools/latest"
  cp -a "$temp_dir/unpacked/cmdline-tools/." "$SDK_ROOT/cmdline-tools/latest/"
  rm -rf "$temp_dir"
}

command -v node >/dev/null 2>&1 || notify_error "没有找到 Node.js。"
command -v npm >/dev/null 2>&1 || notify_error "没有找到 npm。"
command -v curl >/dev/null 2>&1 || notify_error "没有找到 curl。"
command -v unzip >/dev/null 2>&1 || notify_error "没有找到 unzip。"
command -v sha256sum >/dev/null 2>&1 || notify_error "没有找到 sha256sum。"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
[[ -n "$NODE_MAJOR" && "$NODE_MAJOR" -ge 22 ]] ||
  notify_error "需要 Node.js 22 或更高版本。"

LAN_IP="${YSM_MOBILE_HOST:-$(detect_lan_ip)}"
[[ "$LAN_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
  notify_error "没有找到局域网 IPv4。请先连接 Wi-Fi，或设置 YSM_MOBILE_HOST。"
SERVER_URL="http://$LAN_IP:$PORT"

mkdir -p "$CACHE_BASE" "$OUTPUT_DIR" "$GRADLE_CACHE"
confirm_sdk_license
download_jdk
download_android_tools

export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export GRADLE_USER_HOME="$GRADLE_CACHE"
export PATH="$JAVA_HOME/bin:$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$PATH"

echo "检查 Android SDK 组件……"
android sdk install "platform-tools" "platforms;android-36" "build-tools;35.0.0" ||
  notify_error "Android SDK 组件安装失败。"
touch "$CACHE_BASE/license-confirmed"

if [[ ! -d "$PROJECT_DIR/node_modules/qrcode" ]]; then
  (cd "$PROJECT_DIR" && npm ci) || notify_error "后端依赖安装失败。"
fi
if [[ ! -d "$MOBILE_DIR/node_modules/@capacitor/android" ]]; then
  (cd "$MOBILE_DIR" && npm ci) || notify_error "安卓壳依赖安装失败。"
fi

cd "$MOBILE_DIR"
node scripts/configure-mobile.js "$SERVER_URL" "$SDK_ROOT"

if [[ ! -x "$MOBILE_DIR/android/gradlew" ]]; then
  npx cap add android || notify_error "创建 Android 工程失败。"
fi
npx cap sync android || notify_error "同步 Android 工程失败。"
node scripts/patch-android.js

BUILD_EPOCH="$(date +%s)"
BUILD_LABEL="$(date +%Y%m%d-%H%M)"
./android/gradlew --no-daemon -p android :app:assembleDebug \
  "-PysmVersionCode=$BUILD_EPOCH" "-PysmVersionName=0.1-test.$BUILD_LABEL" ||
  notify_error "Gradle 构建失败。"

APK_SOURCE="$MOBILE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
[[ -s "$APK_SOURCE" ]] || notify_error "构建完成但没有找到 APK。"
"$SDK_ROOT/build-tools/35.0.0/apksigner" verify --verbose "$APK_SOURCE" >/dev/null ||
  notify_error "APK 签名校验失败。"

APK_NAME="优胜美设备管理-安卓测试版-$BUILD_LABEL.apk"
APK_OUTPUT="$OUTPUT_DIR/$APK_NAME"
cp "$APK_SOURCE" "$APK_OUTPUT"
mkdir -p "$PROJECT_DIR/web/downloads"
cp "$APK_SOURCE" "$PROJECT_DIR/web/downloads/ysm-equipment-mobile-test.apk"

node -e "require('qrcode').toFile(process.argv[1], process.argv[2], {width:720, margin:2})" \
  "$OUTPUT_DIR/手机下载安装二维码.png" "$SERVER_URL/手机安装.html"

YSM_NO_DIALOG=1 YSM_MOBILE_HOST="$LAN_IP" "$ROOT_DIR/一键启动手机测试服务.sh" ||
  notify_error "APK 已生成，但测试服务启动失败。"

notify_success "安卓测试包已生成并启动测试服务。\n\n安装包：$APK_OUTPUT\n手机扫码：$OUTPUT_DIR/手机下载安装二维码.png\n服务地址：$SERVER_URL\n\n手机和电脑必须连接同一个 Wi-Fi。"
