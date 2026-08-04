'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.YSM_DB_PATH || path.join(__dirname, '..', 'data', 'equipment.db'));
if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const hasTable = (name) => Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(name));
  const count = (table) => hasTable(table)
    ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    : null;
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  const report = {
    ok: integrity.length === 1 && integrity[0].integrity_check === 'ok' && foreignKeys.length === 0,
    database: dbPath,
    bytes: fs.statSync(dbPath).size,
    counts: {
      equipment: count('equipment'),
      production_lines: count('production_lines'),
      equipment_installations: count('equipment_installations'),
      users: count('users'),
      work_orders: count('work_orders'),
      attachments: count('attachments'),
    },
    latest_schema_migration: hasTable('schema_migrations')
      ? db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version
      : null,
    integrity_check: integrity,
    foreign_key_errors: foreignKeys.length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  db.close();
}
