'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const backupDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：node scripts/verify-backup.js <备份目录>');
const manifestPath = path.join(backupDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error('备份缺少 manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const expected of manifest.files || []) {
  const filename = path.join(backupDir, expected.name);
  if (!fs.existsSync(filename)) throw new Error(`备份文件缺失：${expected.name}`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  if (hash !== expected.sha256) throw new Error(`备份校验失败：${expected.name}`);
}
const db = new DatabaseSync(path.join(backupDir, 'equipment.db'), { readOnly: true });
const integrity = db.prepare('PRAGMA integrity_check').all();
const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
db.close();
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || foreignKeys.length) {
  throw new Error('备份数据库完整性或外键检查失败');
}
process.stdout.write(`备份有效：${backupDir}\n`);
