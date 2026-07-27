#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$ROOT_DIR/equipment-system"
PID_FILE="$PROJECT_DIR/data/mobile-test.pid"

notify_result() {
  local message="$1"
  printf '%b\n' "$message"
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --info --title="优胜美设备管理（手机测试版）" \
      --text="$(printf '%b' "$message")" 2>/dev/null || true
  fi
}

if [[ ! -f "$PID_FILE" ]]; then
  notify_result "手机测试服务当前没有运行。"
  exit 0
fi

SERVER_PID="$(tr -cd '0-9' <"$PID_FILE")"
if [[ -z "$SERVER_PID" || ! -r "/proc/$SERVER_PID/cmdline" ]]; then
  rm -f "$PID_FILE"
  notify_result "手机测试服务当前没有运行。"
  exit 0
fi

if ! tr '\0' ' ' <"/proc/$SERVER_PID/cmdline" | grep -Fq "$PROJECT_DIR/src/server.js"; then
  echo "拒绝停止：PID 文件指向的不是手机测试版服务。" >&2
  exit 1
fi

kill "$SERVER_PID"
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    notify_result "手机测试服务已停止。"
    exit 0
  fi
  sleep 0.1
done

echo "服务没有在预期时间内停止，请检查进程 $SERVER_PID。" >&2
exit 1
