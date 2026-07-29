'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.YSM_DB_PATH || path.join(__dirname, '..', 'data', 'equipment.db'));
const failures = [];
const warnings = [];
const checks = {};

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

if (!fs.existsSync(dbPath)) {
  failures.push(`数据库不存在：${dbPath}`);
} else {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    checks.database_integrity = integrity;
    checks.foreign_key_errors = foreignKeys.length;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') failures.push('数据库完整性检查失败');
    if (foreignKeys.length) failures.push(`数据库存在${foreignKeys.length}条外键错误`);

    const admins = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE level=3 AND status='ACTIVE'
    `).get().count);
    checks.active_admins = admins;
    if (admins < 2) failures.push('正式上线前必须建立至少两个启用的三级管理员');
    const defaultAdmin = db.prepare(`
      SELECT status, must_change_password FROM users WHERE username='admin'
    `).get();
    checks.default_admin = defaultAdmin || null;
    if (defaultAdmin?.status === 'ACTIVE') {
      warnings.push('默认 admin 账号仍启用；双管理员验收后应停用或改为受控应急账号');
    }
    if (defaultAdmin?.must_change_password) failures.push('默认管理员仍未完成首次改密');

    const pendingCodes = hasColumn(db, 'fault_codes', 'is_seeded')
      ? Number(db.prepare(`
        SELECT COUNT(*) AS count FROM fault_codes
        WHERE is_seeded=1 AND status='ACTIVE'
      `).get().count) : 0;
    checks.seeded_fault_codes_pending_business_review = pendingCodes;
    if (pendingCodes) warnings.push(`仍有${pendingCodes}条预置故障代码需要设备科业务确认`);

    const completedMissing = hasColumn(db, 'work_orders', 'diagnosis')
      ? Number(db.prepare(`
        SELECT COUNT(*) AS count FROM work_orders
        WHERE status='COMPLETED' AND (
          diagnosis IS NULL OR trim(diagnosis)='' OR
          repair_action IS NULL OR trim(repair_action)='' OR
          trial_result IS NULL OR trim(trial_result)='' OR
          final_equipment_id IS NULL OR fault_code_id IS NULL
        )
      `).get().count) : 0;
    checks.legacy_completed_orders_missing_required_fields = completedMissing;
    if (completedMissing) {
      warnings.push(`${completedMissing}张历史已完成工单缺少现行结单字段；系统不会伪造历史内容`);
    }

    const terminalOpen = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM work_orders
      WHERE status IN ('TRIAL_RUN','PENDING_REVIEW')
        AND (diagnosis IS NULL OR repair_action IS NULL OR trial_result IS NULL
             OR final_equipment_id IS NULL OR fault_code_id IS NULL)
    `).get().count);
    checks.open_orders_blocked_from_completion = terminalOpen;
    if (terminalOpen) failures.push(`${terminalOpen}张待结工单缺少必填字段，需要业务人员补录`);

    const dataRoot = path.dirname(dbPath);
    const attachmentRows = db.prepare('SELECT id, file_path FROM attachments').all();
    const missingFiles = attachmentRows.filter((item) =>
      !fs.existsSync(path.join(dataRoot, 'attachments', item.file_path)));
    checks.attachment_rows = attachmentRows.length;
    checks.missing_attachment_files = missingFiles.length;
    if (missingFiles.length) failures.push(`${missingFiles.length}条附件记录找不到文件`);
  } finally {
    db.close();
  }
}

if (process.env.NODE_ENV === 'production') {
  const publicBase = process.env.PUBLIC_BASE_URL || '';
  const origin = process.env.YSM_TRUSTED_ORIGIN || '';
  if (!publicBase.startsWith('https://')) failures.push('PUBLIC_BASE_URL 必须是正式 HTTPS 地址');
  if (origin !== publicBase.replace(/\/+$/, '')) failures.push('YSM_TRUSTED_ORIGIN 必须与 PUBLIC_BASE_URL 一致');
  if (process.env.YSM_SECURE_COOKIE !== '1') failures.push('生产环境必须设置 YSM_SECURE_COOKIE=1');
  if (process.env.YSM_TRUST_PROXY !== '1') failures.push('Caddy 单入口部署必须设置 YSM_TRUST_PROXY=1');
  for (const [name, value] of [
    ['YSM_PRIVACY_URL', process.env.YSM_PRIVACY_URL],
    ['YSM_ICP_RECORD', process.env.YSM_ICP_RECORD],
    ['YSM_PUBLIC_SECURITY_RECORD', process.env.YSM_PUBLIC_SECURITY_RECORD],
    ['YSM_APP_RECORD', process.env.YSM_APP_RECORD],
    ['YSM_COMPANY_CONTACT', process.env.YSM_COMPANY_CONTACT],
  ]) {
    if (!value) warnings.push(`生产环境尚未填写 ${name}`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: failures.length === 0,
  database: dbPath,
  checks,
  failures,
  warnings,
}, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
