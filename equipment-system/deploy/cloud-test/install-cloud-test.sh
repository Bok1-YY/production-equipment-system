#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/home/ecs-user/ysm-app"
DATA_DIR="/home/ecs-user/ysm-data"
SERVICE_SOURCE="/home/ecs-user/ysm-cloud-migration/ysm-equipment-cloud-test.service"
SERVICE_TARGET="/etc/systemd/system/ysm-equipment-cloud-test.service"
APK_SOURCE="/home/ecs-user/ysm-cloud-migration/ysm-equipment-cloud-test.apk"
BACKUP_DIR="${1:-}"
SERVER_URL="${2:-}"

if [[ -z "$BACKUP_DIR" || ! -f "$BACKUP_DIR/manifest.json"
      || ! "$SERVER_URL" =~ ^https?://[^/[:space:]]+$ ]]; then
  echo "用法：bash install-cloud-test.sh 备份目录 http://云服务器IP:端口" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/src/server.js" || ! -d "$APP_DIR/node_modules" ]]; then
  echo "没有找到已安装依赖的云端程序：$APP_DIR" >&2
  exit 1
fi
if [[ ! -f "$SERVICE_SOURCE" ]]; then
  echo "没有找到服务配置：$SERVICE_SOURCE" >&2
  exit 1
fi

echo "校验迁移备份……"
node "$APP_DIR/scripts/verify-backup.js" "$BACKUP_DIR"

echo "停止临时进程后，恢复当前测试数据库和附件……"
sudo systemctl stop ysm-equipment-cloud-test.service 2>/dev/null || true
mkdir -p "$DATA_DIR"
YSM_CONFIRM_RESTORE=YES YSM_DB_PATH="$DATA_DIR/equipment.db" \
  node "$APP_DIR/scripts/restore-production.js" "$BACKUP_DIR"

if [[ -s "$APK_SOURCE" ]]; then
  echo "发布云端验证 APK 下载文件……"
  mkdir -p "$APP_DIR/web/downloads"
  install -m 0644 "$APK_SOURCE" "$APP_DIR/web/downloads/ysm-equipment-mobile-test.apk"
fi

echo "安装并启动系统服务……"
printf 'PUBLIC_BASE_URL=%s\nYSM_TRUSTED_ORIGIN=%s\n' "$SERVER_URL" |
  sudo tee /etc/ysm-equipment-cloud-test.env >/dev/null
sudo chown root:root /etc/ysm-equipment-cloud-test.env
sudo chmod 0600 /etc/ysm-equipment-cloud-test.env
sudo install -m 0644 -o root -g root "$SERVICE_SOURCE" "$SERVICE_TARGET"
sudo systemctl daemon-reload
sudo systemctl enable --now ysm-equipment-cloud-test.service

sleep 2
sudo systemctl --no-pager --full status ysm-equipment-cloud-test.service
curl -fsS http://127.0.0.1:8788/api/health/ready
echo
echo "云端验证服务已启动：$SERVER_URL"
