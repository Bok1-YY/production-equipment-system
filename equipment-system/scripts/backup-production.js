'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.YSM_DB_PATH || path.join(__dirname, '..', 'data', 'equipment.db'));
const backupRoot = path.resolve(process.argv[2] || '/backups');
const retentionDays = Math.max(7, Number(process.env.YSM_BACKUP_RETENTION_DAYS) || 30);

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!fs.existsSync(dbPath)) {
  fail(`数据库不存在：${dbPath}`);
} else {
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
  const finalDir = path.join(backupRoot, `ysm-backup-${stamp}`);
  const workDir = `${finalDir}.partial`;
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: false });
  try {
    const databaseFile = path.join(workDir, 'equipment.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=30000');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`数据库完整性检查失败：${JSON.stringify(integrity)}`);
    }
    db.exec(`VACUUM INTO ${sqlString(databaseFile)}`);
    db.close();

    const attachments = path.join(path.dirname(dbPath), 'attachments');
    let attachmentArchive = null;
    if (fs.existsSync(attachments)) {
      attachmentArchive = path.join(workDir, 'attachments.tar.gz');
      const tar = spawnSync('tar', ['-czf', attachmentArchive, '-C', path.dirname(attachments), 'attachments'], {
        encoding: 'utf8',
      });
      if (tar.status !== 0) throw new Error(`附件归档失败：${tar.stderr || tar.stdout}`);
    }

    const files = [databaseFile, attachmentArchive].filter(Boolean).map((filename) => ({
      name: path.basename(filename),
      bytes: fs.statSync(filename).size,
      sha256: sha256(filename),
    }));
    fs.writeFileSync(path.join(workDir, 'manifest.json'), `${JSON.stringify({
      format: 1,
      created_at: new Date().toISOString(),
      source_database: dbPath,
      files,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(workDir, finalDir);

    const cutoff = Date.now() - retentionDays * 86400000;
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^ysm-backup-\d{8}T\d{6}Z$/.test(entry.name)) continue;
      const full = path.join(backupRoot, entry.name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true });
    }
    process.stdout.write(`${finalDir}\n`);
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fail(`备份失败：${error.message}`);
  }
}
