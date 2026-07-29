'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const backupDir = path.resolve(process.argv[2] || '');
const dbPath = path.resolve(process.env.YSM_DB_PATH || '/data/equipment.db');
if (!process.argv[2]) {
  throw new Error('用法：先停止 App，再运行 node scripts/restore-production.js <备份目录>');
}
if (process.env.YSM_CONFIRM_RESTORE !== 'YES') {
  throw new Error('恢复会替换当前数据库和附件；确认停机后设置 YSM_CONFIRM_RESTORE=YES');
}
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
for (const expected of manifest.files || []) {
  const filename = path.join(backupDir, expected.name);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  if (hash !== expected.sha256) throw new Error(`备份校验失败：${expected.name}`);
}
const sourceDb = path.join(backupDir, 'equipment.db');
const check = new DatabaseSync(sourceDb, { readOnly: true });
const integrity = check.prepare('PRAGMA integrity_check').all();
const foreignKeys = check.prepare('PRAGMA foreign_key_check').all();
check.close();
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || foreignKeys.length) {
  throw new Error('备份数据库完整性或外键检查失败');
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '');
const safetyDir = path.join(path.dirname(dbPath), `pre-restore-${stamp}`);
fs.mkdirSync(safetyDir);
if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(safetyDir, 'equipment.db'));
const attachments = path.join(path.dirname(dbPath), 'attachments');
if (fs.existsSync(attachments)) {
  const tar = spawnSync('tar', ['-czf', path.join(safetyDir, 'attachments.tar.gz'), '-C',
    path.dirname(attachments), 'attachments'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`恢复前附件备份失败：${tar.stderr || tar.stdout}`);
}

const tempDb = `${dbPath}.restore`;
fs.copyFileSync(sourceDb, tempDb);
fs.renameSync(tempDb, dbPath);
const archive = path.join(backupDir, 'attachments.tar.gz');
if (fs.existsSync(archive)) {
  fs.rmSync(attachments, { recursive: true, force: true });
  const tar = spawnSync('tar', ['-xzf', archive, '-C', path.dirname(dbPath)], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`附件恢复失败：${tar.stderr || tar.stdout}`);
}
process.stdout.write(`恢复完成；恢复前副本保存在 ${safetyDir}\n`);
