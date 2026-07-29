#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$ROOT_DIR/equipment-system"
DATA_DIR="$PROJECT_DIR/data"
PID_FILE="$DATA_DIR/mobile-test.pid"
LOG_FILE="$DATA_DIR/mobile-test.log"
PORT=8788
SYSTEMD_UNIT="ysm-equipment-mobile-test.service"

notify_error() {
  local message="$1"
  printf '启动失败：%b\n' "$message" >&2
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --error --title="优胜美设备管理（手机测试版）" \
      --text="$(printf '%b' "$message\n\n日志：$LOG_FILE")" 2>/dev/null || true
  fi
  exit 1
}

notify_success() {
  local message="$1"
  printf '%b\n' "$message"
  if [[ "${YSM_NO_DIALOG:-0}" != "1" ]] && command -v zenity >/dev/null 2>&1; then
    zenity --info --title="优胜美设备管理（手机测试版）" \
      --text="$(printf '%b' "$message")" 2>/dev/null || true
  fi
}

detect_lan_ip() {
  local candidate=""
  # 先从真实私网地址里选，不能使用 Mihomo/Clash TUN 常见的 198.18.0.0/15。
  if command -v hostname >/dev/null 2>&1; then
    candidate="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '
      /^10\./ || /^192\.168\./ || /^172\.(1[6-9]|2[0-9]|3[01])\./ { print; exit }
    ')"
  fi
  if [[ -z "$candidate" ]] && command -v ip >/dev/null 2>&1; then
    candidate="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
      { for (i = 1; i <= NF; i++) if ($i == "src") {
          value=$(i + 1)
          if (value ~ /^10\./ || value ~ /^192\.168\./ ||
              value ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) print value
          exit
        } }
    ')"
  fi
  printf '%s' "$candidate"
}

LAN_IP="${YSM_MOBILE_HOST:-$(detect_lan_ip)}"
[[ "$LAN_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
  notify_error "没有找到可用的局域网 IPv4。请先连接 Wi-Fi，或用 YSM_MOBILE_HOST=电脑IP 运行。"

SYSTEM_URL="http://$LAN_IP:$PORT"
LOCAL_HEALTH="http://127.0.0.1:$PORT/api/health"

mkdir -p "$DATA_DIR"
cd "$PROJECT_DIR"

command -v node >/dev/null 2>&1 || notify_error "没有找到 Node.js 22 或更高版本。"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
[[ -n "$NODE_MAJOR" && "$NODE_MAJOR" -ge 22 ]] ||
  notify_error "Node.js 版本过低，需要 Node.js 22 或更高版本。"

if [[ ! -d "$PROJECT_DIR/node_modules/qrcode" ]]; then
  command -v npm >/dev/null 2>&1 || notify_error "没有找到 npm。"
  npm ci >>"$LOG_FILE" 2>&1 || notify_error "后端依赖安装失败，请检查网络和日志。"
fi

is_healthy() {
  curl -fsS --max-time 2 "$LOCAL_HEALTH" >/dev/null 2>&1
}

is_our_process() {
  local pid="$1"
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq "$PROJECT_DIR/src/server.js"
}

if is_healthy; then
  if command -v systemctl >/dev/null 2>&1 &&
      systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
    notify_success "手机测试服务已经运行。\n\n手机访问：$SYSTEM_URL\n安装包下载：$SYSTEM_URL/手机安装.html"
    exit 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    RUNNING_PID="$(tr -cd '0-9' <"$PID_FILE")"
    if [[ -n "$RUNNING_PID" ]] && is_our_process "$RUNNING_PID"; then
      notify_success "手机测试服务已经运行。\n\n手机访问：$SYSTEM_URL\n安装包下载：$SYSTEM_URL/手机安装.html"
      exit 0
    fi
  fi
  notify_error "端口 $PORT 已被其他程序占用。测试版没有接管该端口。"
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(tr -cd '0-9' <"$PID_FILE")"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null && is_our_process "$OLD_PID"; then
    notify_error "测试版进程仍在运行，但健康检查失败。请先使用停止脚本，再检查日志。"
  fi
  rm -f "$PID_FILE"
fi

: >"$LOG_FILE"
SERVER_PID=""
if command -v systemd-run >/dev/null 2>&1 &&
    systemctl --user show-environment >/dev/null 2>&1; then
  # 交给用户级 systemd 托管后，关闭终端或打包脚本退出都不会把后端一起杀掉。
  # --collect 会在停止后自动清理瞬态单元，下一次可继续使用同一个固定名称。
  systemctl --user stop "$SYSTEMD_UNIT" >/dev/null 2>&1 || true
  systemd-run --user --collect --quiet \
    --unit="$SYSTEMD_UNIT" \
    --property="WorkingDirectory=$PROJECT_DIR" \
    --property="StandardOutput=append:$LOG_FILE" \
    --property="StandardError=append:$LOG_FILE" \
    --setenv="HOST=0.0.0.0" \
    --setenv="PORT=$PORT" \
    --setenv="PUBLIC_BASE_URL=$SYSTEM_URL" \
    --setenv="YSM_DB_PATH=$DATA_DIR/equipment.db" \
    "$(command -v node)" "$PROJECT_DIR/src/server.js" ||
    notify_error "无法创建手机测试后台服务。"
else
  env HOST=0.0.0.0 PORT="$PORT" PUBLIC_BASE_URL="$SYSTEM_URL" \
    YSM_DB_PATH="$DATA_DIR/equipment.db" \
    nohup setsid node "$PROJECT_DIR/src/server.js" >>"$LOG_FILE" 2>&1 </dev/null &
  SERVER_PID=$!
  printf '%s\n' "$SERVER_PID" >"$PID_FILE"
fi

for _ in $(seq 1 40); do
  if is_healthy; then
    if [[ -z "$SERVER_PID" ]]; then
      SERVER_PID="$(systemctl --user show "$SYSTEMD_UNIT" --property=MainPID --value 2>/dev/null || true)"
      [[ "$SERVER_PID" =~ ^[1-9][0-9]*$ ]] && printf '%s\n' "$SERVER_PID" >"$PID_FILE"
    fi
    notify_success "手机测试服务已启动。\n\n手机访问：$SYSTEM_URL\n安装包下载：$SYSTEM_URL/手机安装.html\n\n电脑和手机必须连接同一个 Wi-Fi。"
    exit 0
  fi
  sleep 0.25
done

if command -v systemctl >/dev/null 2>&1 &&
    systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
  systemctl --user stop "$SYSTEMD_UNIT" >/dev/null 2>&1 || true
elif [[ -n "$SERVER_PID" ]] && is_our_process "$SERVER_PID"; then
  kill "$SERVER_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
notify_error "服务没有正常启动。"
