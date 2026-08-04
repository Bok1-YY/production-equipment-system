'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_EQUIPMENT_TYPES } = require('./equipment-types');
const { DEFAULT_FAULT_CODES } = require('./fault-codes');
const { hashPassword } = require('./auth');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'equipment.db');

function openDatabase(filename = process.env.YSM_DB_PATH || DEFAULT_DB_PATH) {
  if (filename !== ':memory:') {
    if (process.env.YSM_REQUIRE_EXISTING_DB === '1' && !fs.existsSync(filename)) {
      throw new Error(`数据库不存在，已拒绝创建空库：${path.resolve(filename)}`);
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedOrganization(db);
  seedAdmin(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS factories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workshops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factory_id INTEGER NOT NULL REFERENCES factories(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS production_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workshop_id INTEGER NOT NULL REFERENCES workshops(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      supervisor TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL REFERENCES production_lines(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sequence_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_id INTEGER NOT NULL REFERENCES processes(id),
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sequence_no INTEGER NOT NULL DEFAULT 1,
      critical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      standard_name TEXT NOT NULL,
      alias TEXT,
      category TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      critical INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      responsible_person TEXT,
      commissioned_on TEXT,
      legacy_code TEXT,
      data_source TEXT NOT NULL DEFAULT '现场盘点',
      verified INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_code_sequences (
      equipment_type_id INTEGER NOT NULL REFERENCES equipment_types(id),
      key_spec TEXT NOT NULL DEFAULT '',
      value INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(equipment_type_id, key_spec)
    );

    CREATE TABLE IF NOT EXISTS equipment_installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id),
      position_id INTEGER NOT NULL REFERENCES positions(id),
      installed_at TEXT NOT NULL,
      removed_at TEXT,
      change_request_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_installation_per_equipment
      ON equipment_installations(equipment_id) WHERE removed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_equipment_per_position
      ON equipment_installations(position_id) WHERE removed_at IS NULL;

    CREATE TABLE IF NOT EXISTS qr_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      UNIQUE(target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS composition_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_no TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id),
      replacement_equipment_id INTEGER REFERENCES equipment(id),
      from_position_id INTEGER REFERENCES positions(id),
      to_position_id INTEGER REFERENCES positions(id),
      effective_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_no TEXT NOT NULL UNIQUE,
      process_id INTEGER NOT NULL REFERENCES processes(id),
      reported_equipment_id INTEGER REFERENCES equipment(id),
      final_equipment_id INTEGER REFERENCES equipment(id),
      reporter TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      fault_location TEXT,
      fault_symptom TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'NORMAL',
      is_downtime INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'SUBMITTED',
      assignee TEXT,
      diagnosis TEXT,
      root_cause TEXT,
      repair_action TEXT,
      trial_result TEXT,
      downtime_minutes INTEGER,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_order_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
      part_name TEXT NOT NULL,
      specification TEXT,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      part_condition TEXT NOT NULL DEFAULT 'NEW',
      source TEXT,
      old_part_disposition TEXT,
      part_code TEXT,
      unit_cost REAL,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_order_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT NOT NULL,
      note TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_order_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL UNIQUE REFERENCES work_orders(id),
      reviewer TEXT NOT NULL,
      reviewer_user_id INTEGER REFERENCES users(id),
      technician TEXT,
      technician_user_id INTEGER REFERENCES users(id),
      quality_score INTEGER NOT NULL,
      attitude_score INTEGER NOT NULL,
      speed_score INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_by_technician ON work_order_reviews(technician_user_id);

    CREATE TABLE IF NOT EXISTS fault_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      part TEXT NOT NULL,
      symptom TEXT NOT NULL,
      suggested_action TEXT,
      default_urgency TEXT NOT NULL DEFAULT 'NORMAL',
      requires_downtime INTEGER NOT NULL DEFAULT 0,
      requires_photo INTEGER NOT NULL DEFAULT 0,
      equipment_type_id INTEGER REFERENCES equipment_types(id),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      is_seeded INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(category, part, symptom)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploader_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachments_by_target ON attachments(target_type, target_id);

    CREATE TABLE IF NOT EXISTS patrol_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patrol_no TEXT NOT NULL UNIQUE,
      equipment_id INTEGER REFERENCES equipment(id),
      process_id INTEGER REFERENCES processes(id),
      patroller TEXT NOT NULL,
      patroller_user_id INTEGER REFERENCES users(id),
      findings TEXT NOT NULL,
      has_issue INTEGER NOT NULL DEFAULT 0,
      work_order_id INTEGER REFERENCES work_orders(id),
      patrolled_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patrols_by_equipment ON patrol_records(equipment_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      level INTEGER NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      must_change_password INTEGER NOT NULL DEFAULT 1,
      phone TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      absolute_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      source_ip TEXT NOT NULL,
      succeeded INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_attempts_by_username_time
      ON login_attempts(username, attempted_at);
    CREATE INDEX IF NOT EXISTS login_attempts_by_ip_time
      ON login_attempts(source_ip, attempted_at);

    CREATE TABLE IF NOT EXISTS notification_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      device_label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS notification_devices_by_user
      ON notification_devices(user_id);

    CREATE TABLE IF NOT EXISTS idempotency_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE(user_id, operation, request_key)
    );
    CREATE INDEX IF NOT EXISTS idempotency_by_expiry
      ON idempotency_requests(expires_at);

    CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_kind TEXT NOT NULL CHECK(task_kind IN ('INSPECTION', 'MAINTENANCE')),
      name TEXT NOT NULL,
      maintenance_level INTEGER CHECK(maintenance_level IN (1, 2, 3)),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_template_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'CHECK'
        CHECK(item_type IN ('CHECK', 'NUMBER', 'TEXT')),
      standard_text TEXT,
      unit TEXT,
      min_value REAL,
      max_value REAL,
      requires_photo_on_fail INTEGER NOT NULL DEFAULT 0,
      sequence_no INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS task_items_by_template
      ON task_template_items(template_id, sequence_no, id);

    CREATE TABLE IF NOT EXISTS task_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_kind TEXT NOT NULL CHECK(task_kind IN ('INSPECTION', 'MAINTENANCE')),
      template_id INTEGER NOT NULL REFERENCES task_templates(id),
      name TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('PROCESS', 'EQUIPMENT')),
      target_id INTEGER NOT NULL,
      schedule_type TEXT NOT NULL
        CHECK(schedule_type IN ('DAILY', 'WEEKLY', 'INTERVAL', 'FIXED', 'MANUAL')),
      interval_days INTEGER,
      next_due_at TEXT,
      assignee_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_plans_due
      ON task_plans(status, next_due_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_kind TEXT NOT NULL CHECK(task_kind IN ('INSPECTION', 'MAINTENANCE')),
      plan_id INTEGER REFERENCES task_plans(id),
      template_id INTEGER NOT NULL REFERENCES task_templates(id),
      target_type TEXT NOT NULL CHECK(target_type IN ('PROCESS', 'EQUIPMENT')),
      target_id INTEGER NOT NULL,
      assignee_user_id INTEGER REFERENCES users(id),
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN ('PENDING', 'COMPLETED', 'ABNORMAL', 'CONVERTED', 'CANCELLED')),
      executor TEXT,
      executor_user_id INTEGER REFERENCES users(id),
      started_at TEXT,
      completed_at TEXT,
      summary TEXT,
      work_order_id INTEGER REFERENCES work_orders(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_id, due_at)
    );
    CREATE INDEX IF NOT EXISTS scheduled_tasks_by_kind_status
      ON scheduled_tasks(task_kind, status, due_at);
    CREATE INDEX IF NOT EXISTS scheduled_tasks_by_assignee
      ON scheduled_tasks(assignee_user_id, status, due_at);

    CREATE TABLE IF NOT EXISTS task_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      template_item_id INTEGER NOT NULL REFERENCES task_template_items(id),
      result_status TEXT NOT NULL CHECK(result_status IN ('PASS', 'FAIL', 'NA')),
      measured_value REAL,
      text_value TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, template_item_id)
    );
    CREATE INDEX IF NOT EXISTS task_results_by_task ON task_results(task_id);

    CREATE TABLE IF NOT EXISTS abnormal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL UNIQUE REFERENCES scheduled_tasks(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CONVERTED', 'CLOSED')),
      work_order_id INTEGER REFERENCES work_orders(id),
      closed_by_user_id INTEGER REFERENCES users(id),
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS abnormal_events_by_status
      ON abnormal_events(status, created_at);

    CREATE TABLE IF NOT EXISTS qr_scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mapping_id INTEGER NOT NULL REFERENCES qr_mappings(id),
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      source_ip TEXT,
      user_agent TEXT,
      scanned_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS qr_scan_logs_by_mapping
      ON qr_scan_logs(mapping_id, scanned_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id),
      actor_username TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      created_at TEXT NOT NULL,
      UNIQUE(import_type, file_hash, status)
    );

    INSERT OR IGNORE INTO app_meta(key, value) VALUES ('equipment_sequence', '0');
    INSERT OR IGNORE INTO app_meta(key, value) VALUES ('change_sequence', '0');
    INSERT OR IGNORE INTO app_meta(key, value) VALUES ('work_order_sequence', '0');
    INSERT OR IGNORE INTO app_meta(key, value) VALUES ('patrol_sequence', '0');
  `);
  ensureColumn(db, 'equipment', 'equipment_type_id', 'INTEGER REFERENCES equipment_types(id)');
  ensureColumn(db, 'equipment', 'key_spec', "TEXT NOT NULL DEFAULT ''");
  // 旧工单没有账号归属，留空即可：普工只能看到自己报修的工单，旧数据对普工不可见。
  ensureColumn(db, 'work_orders', 'reporter_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'work_orders', 'assignee_user_id', 'INTEGER REFERENCES users(id)');
  // 没有未结工单时设备应有的状态。维修期间手工改档案改的是它，结单后自然生效。旧数据为NULL，按ACTIVE兜底。
  ensureColumn(db, 'equipment', 'baseline_status', 'TEXT');
  // 报修时选的故障代码。改造前建的旧工单为NULL，所有读取路径都要容忍这一点。
  ensureColumn(db, 'work_orders', 'fault_code_id', 'INTEGER REFERENCES fault_codes(id)');
  // 「重新报修」时指向原工单。几天内就重新报修，本身就是"上次没修好"的信号。
  ensureColumn(db, 'work_orders', 'reopened_from_work_order_id', 'INTEGER REFERENCES work_orders(id)');
  // 接单和到场的时刻。原先只有 started_at（维修中）和 completed_at，"路上花了多久"
  // 只能去 work_order_history 里翻文本，聚合不了。补成列之后四段时长可以直接算。
  ensureColumn(db, 'work_orders', 'assigned_at', 'TEXT');
  ensureColumn(db, 'work_orders', 'arrived_at', 'TEXT');
  ensureColumn(db, 'work_orders', 'downtime_is_override', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'work_orders', 'downtime_override_reason', 'TEXT');
  ensureColumn(db, 'work_orders', 'trial_issue_description', 'TEXT');
  ensureColumn(db, 'sessions', 'absolute_expires_at', 'TEXT');
  ensureColumn(db, 'audit_logs', 'actor_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'audit_logs', 'actor_username', 'TEXT');
  ensureColumn(db, 'composition_changes', 'submitted_by_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'composition_changes', 'reviewed_by_user_id', 'INTEGER REFERENCES users(id)');
  backfillWorkOrderTimestamps(db);
  normalizeMergedWorkOrderStatus(db);
  mergeDiagnosisAndRootCause(db);
  // 普工报修页"常用故障"快捷按钮上出现哪几条。
  ensureColumn(db, 'fault_codes', 'is_common', 'INTEGER NOT NULL DEFAULT 0');
  backfillCommonFaultCodes(db);
  const now = new Date().toISOString();
  const insertType = db.prepare(`
    INSERT OR IGNORE INTO equipment_types(code, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const [code, name] of Object.entries(DEFAULT_EQUIPMENT_TYPES)) insertType.run(code, name, now, now);
  seedFaultCodes(db, now);
  db.exec(`
    CREATE INDEX IF NOT EXISTS work_orders_by_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS work_orders_by_reporter ON work_orders(reporter_user_id, id);
    CREATE INDEX IF NOT EXISTS work_orders_by_assignee ON work_orders(assignee_user_id, status);
    CREATE INDEX IF NOT EXISTS work_orders_by_equipment ON work_orders(final_equipment_id, status);
    CREATE INDEX IF NOT EXISTS work_orders_by_completed ON work_orders(completed_at);
    CREATE INDEX IF NOT EXISTS work_order_history_by_order ON work_order_history(work_order_id, id);
    CREATE INDEX IF NOT EXISTS work_order_parts_by_order ON work_order_parts(work_order_id, id);
    CREATE INDEX IF NOT EXISTS composition_changes_by_status ON composition_changes(status, id);
    CREATE INDEX IF NOT EXISTS patrols_by_process ON patrol_records(process_id, id);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (1, 'baseline-and-production-hardening', ?)
  `).run(now);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (2, 'structured-inspection-maintenance-and-scan-audit', ?)
  `).run(now);
}

// 维修界面只保留一个「诊断原因」。旧库里两个字段都可能有值，迁移时完整合并一次；
// root_cause 列暂时保留，避免旧版本程序或备份恢复因列缺失而失败。
function mergeDiagnosisAndRootCause(db) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) return;
  transaction(db, () => {
    const rows = db.prepare(`
      SELECT id, diagnosis, root_cause FROM work_orders
      WHERE root_cause IS NOT NULL AND TRIM(root_cause) <> ''
    `).all();
    const update = db.prepare('UPDATE work_orders SET diagnosis=?, root_cause=NULL WHERE id=?');
    for (const row of rows) {
      const diagnosis = String(row.diagnosis || '').trim();
      const rootCause = String(row.root_cause || '').trim();
      const merged = !diagnosis ? rootCause
        : diagnosis.includes(rootCause) ? diagnosis : `${diagnosis}\n根本原因：${rootCause}`;
      update.run(merged, row.id);
    }
    db.prepare(`
      INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (3, 'merge-diagnosis-and-structure-trial-result', ?)
    `).run(new Date().toISOString());
  });
}

// assigned_at / arrived_at 是后加的列，历史工单为 NULL。流转历史里其实记着这两个时刻，
// 补一次就能让旧单也进时长统计。线上库当前 0 张工单，这段是给别处的副本准备的。
function backfillWorkOrderTimestamps(db) {
  // assigned_at 认两种 to_status：ASSIGNED 是 2026-07-26 合并接单步骤之前写的。
  db.prepare(`
    UPDATE work_orders SET assigned_at = (
      SELECT MIN(h.created_at) FROM work_order_history h
      WHERE h.work_order_id = work_orders.id AND h.to_status IN ('ASSIGNED', 'ACCEPTED')
    ) WHERE assigned_at IS NULL
  `).run();
  db.prepare(`
    UPDATE work_orders SET arrived_at = (
      SELECT MIN(h.created_at) FROM work_order_history h
      WHERE h.work_order_id = work_orders.id AND h.to_status = 'ARRIVED'
    ) WHERE arrived_at IS NULL
  `).run();
}

// 2026-07-26 合并接单步骤：ASSIGNED（已分派）和 ACCEPTED（已接单）表达的是同一件事，
// 只留 ACCEPTED。状态机里已经没有 ASSIGNED，停在该状态的旧工单必须归一，否则
// assertWorkOrderTransition 查不到它的出边，那张单就永远推不动了。
// 线上库当前 0 张工单，这段是给别处的副本准备的。
function normalizeMergedWorkOrderStatus(db) {
  db.prepare(`UPDATE work_orders SET status='ACCEPTED' WHERE status='ASSIGNED'`).run();
}

// is_common 是后加的列，上一轮已经种过故障码的库里全是 0，快捷按钮会一条都没有。
// 按预置清单补一次，只动 is_seeded=1 的行——管理员自建的码不替他做主。
// 已经有人标过（任意一条为 1）就不再补，否则管理员取消掉的标记会在重启后复活。
function backfillCommonFaultCodes(db) {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM fault_codes WHERE is_common = 1').get().count)) return;
  const codes = DEFAULT_FAULT_CODES.filter((item) => item.is_common).map((item) => item.code);
  if (!codes.length) return;
  db.prepare(`UPDATE fault_codes SET is_common = 1
    WHERE is_seeded = 1 AND code IN (${codes.map(() => '?').join(',')})`).run(...codes);
}

// 只在故障码表为空时种入建议值。人工维护过（哪怕只删了一条）之后就不再补种，
// 否则管理员删掉的预置项会在下次重启时复活。
function seedFaultCodes(db, now) {
  const existing = Number(db.prepare('SELECT COUNT(*) AS count FROM fault_codes').get().count);
  if (existing) return;
  const insert = db.prepare(`
    INSERT INTO fault_codes(code, category, part, symptom, suggested_action, default_urgency,
      requires_downtime, requires_photo, is_common, status, is_seeded, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)
  `);
  DEFAULT_FAULT_CODES.forEach((item, index) => {
    insert.run(item.code, item.category, item.part, item.symptom, item.suggested_action || null,
      item.default_urgency || 'NORMAL', item.requires_downtime ? 1 : 0, item.requires_photo ? 1 : 0,
      item.is_common ? 1 : 0, index, now, now);
  });
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedOrganization(db) {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO factories(code, name, created_at) VALUES (?, ?, ?)`)
    .run('YSM', '优胜美工厂', now);
  const factory = db.prepare('SELECT id FROM factories WHERE code = ?').get('YSM');
  db.prepare(`INSERT OR IGNORE INTO workshops(factory_id, code, name, created_at) VALUES (?, ?, ?, ?)`)
    .run(factory.id, 'YSM-WS01', '生产车间', now);
}

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'ysm-admin-2026';

// 系统里一个管理员都没有时建默认管理员。must_change_password=1，
// 首次登录后系统只放行改密接口，初始密码用完即废。
function seedAdmin(db) {
  const existing = db.prepare(`SELECT id FROM users WHERE level = 3 AND status = 'ACTIVE' LIMIT 1`).get();
  if (existing) return;
  const now = new Date().toISOString();
  const { hash, salt } = hashPassword(DEFAULT_ADMIN_PASSWORD);
  db.prepare(`
    INSERT OR IGNORE INTO users(username, display_name, level, password_hash, password_salt,
      status, must_change_password, created_at, updated_at)
    VALUES (?, ?, 3, ?, ?, 'ACTIVE', 1, ?, ?)
  `).run(DEFAULT_ADMIN_USERNAME, '系统管理员', hash, salt, now, now);
}

function nextSequence(db, key) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
    const next = Number(row.value) + 1;
    db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run(String(next), key);
    db.exec('COMMIT');
    return next;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  openDatabase,
  nextSequence,
  transaction,
};
