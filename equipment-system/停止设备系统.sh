#!/usr/bin/env bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/data/server.pid"
SERVICE_NAME="ysm-equipment-system.service"
STOPPED=0

if systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1; then
  STOPPED=1
fi

if [[ -f "$PID_FILE" ]]; then
  SERVER_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

if command -v zenity >/dev/null 2>&1; then
  if [[ "$STOPPED" -eq 1 ]]; then
    zenity --info --title="优胜美设备管理系统" --text="设备系统已停止。" 2>/dev/null || true
  else
    zenity --info --title="优胜美设备管理系统" --text="设备系统当前没有运行。" 2>/dev/null || true
  fi
fi

exit 0
