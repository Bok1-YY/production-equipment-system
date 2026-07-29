#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^https:// ]]; then
  echo "用法：./scripts/build-production.sh https://正式域名" >&2
  exit 2
fi

required=(
  YSM_ANDROID_KEYSTORE
  YSM_ANDROID_KEYSTORE_PASSWORD
  YSM_ANDROID_KEY_ALIAS
  YSM_ANDROID_KEY_PASSWORD
  YSM_ANDROID_VERSION_CODE
  YSM_ANDROID_VERSION_NAME
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "缺少环境变量：${name}" >&2
    exit 2
  fi
done
if [[ ! -f "${YSM_ANDROID_KEYSTORE}" ]]; then
  echo "签名文件不存在" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_root="$(cd "${script_dir}/.." && pwd)"
cd "${mobile_root}"
node scripts/configure-production.js "$1"
npx cap sync android
cd android
./gradlew clean testReleaseUnitTest lintRelease assembleRelease bundleRelease

echo "APK：${mobile_root}/android/app/build/outputs/apk/release/"
echo "AAB：${mobile_root}/android/app/build/outputs/bundle/release/"
