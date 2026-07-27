#!/usr/bin/env bash
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$PROJECT_DIR/data"
LOG_FILE="$DATA_DIR/server.log"
PID_FILE="$DATA_DIR/server.pid"
SERVICE_NAME="ysm-equipment-system.service"
SYSTEM_URL="http://127.0.0.1:8787"

mkdir -p "$DATA_DIR"
cd "$PROJECT_DIR" || exit 1

notify_error() {
  local message="$1"
  echo "启动失败：$message" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="优胜美设备管理系统" --text="$message\n\n运行日志：$LOG_FILE" 2>/dev/null || true
  fi
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  notify_error "没有找到 Node.js，请先安装 Node.js 22 或更高版本。"
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null)"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 22 ]]; then
  notify_error "当前 Node.js 版本过低，需要 Node.js 22 或更高版本。"
fi

if [[ ! -d "$PROJECT_DIR/node_modules/qrcode" ]]; then
  if ! npm install >> "$LOG_FILE" 2>&1; then
    notify_error "首次运行依赖安装失败，请检查网络连接。"
  fi
fi

is_healthy() {
  curl -fsS --max-time 2 "$SYSTEM_URL/api/health" >/dev/null 2>&1
}

if ! is_healthy; then
  rm -f "$PID_FILE"
  : > "$LOG_FILE"

  # Cinnamon关闭启动终端时会清理普通后台子进程，因此优先交给systemd用户服务托管。
  if systemctl --user daemon-reload >> "$LOG_FILE" 2>&1 && \
     systemctl --user start "$SERVICE_NAME" >> "$LOG_FILE" 2>&1; then
    echo "设备系统已交给systemd用户服务运行。" >> "$LOG_FILE"
  else
    # 极少数未启用systemd用户会话的环境使用独立会话作为后备。
    echo "systemd用户服务不可用，使用独立后台会话。" >> "$LOG_FILE"
    HOST=127.0.0.1 PORT=8787 PUBLIC_BASE_URL="$SYSTEM_URL" \
      nohup setsid node "$PROJECT_DIR/src/server.js" >> "$LOG_FILE" 2>&1 < /dev/null &
    echo "$!" > "$PID_FILE"
  fi

  STARTED=0
  for _ in $(seq 1 40); do
    if is_healthy; then
      STARTED=1
      break
    fi
    sleep 0.25
  done

  if [[ "$STARTED" -ne 1 ]]; then
    rm -f "$PID_FILE"
    notify_error "服务没有正常启动，请把server.log发给开发人员检查。"
  fi
fi

if [[ "${YSM_NO_BROWSER:-0}" != "1" ]]; then
  if ! xdg-open "$SYSTEM_URL" >/dev/null 2>&1; then
    zenity --info --title="优胜美设备管理系统" --text="系统已启动，请在浏览器打开：\n$SYSTEM_URL" 2>/dev/null || true
  fi
fi

exit 0
