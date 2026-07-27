'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  CLOSED_WORK_ORDER_STATUSES,
  DomainError,
  MANUAL_EQUIPMENT_STATUSES,
  POST_ARRIVAL_STATUSES,
  REVIEW_DIMENSIONS,
  UNDER_REPAIR_WORK_ORDER_STATUSES,
  WITHDRAWABLE_STATUSES,
  assertChangeAction,
  assertReviewScore,
  assertRole,
  assertWorkOrderTransition,
  formatEquipmentCode,
  normalizeEquipmentTypeCode,
  normalizeKeySpec,
  optionalText,
  positiveId,
  requireText,
} = require('./domain');
const { nextSequence, transaction } = require('./db');
const { LEVELS, destroyUserSessions, hashPassword, normalizeLevel, verifyPassword } = require('./auth');
const { FALLBACK_FAULT_CODE } = require('./fault-codes');

const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

// 附件：现场照片。默认落在数据库旁边的 attachments/，测试可通过构造参数改到临时目录。
const DEFAULT_DATA_DIR = process.env.YSM_DB_PATH && process.env.YSM_DB_PATH !== ':memory:'
  ? path.dirname(process.env.YSM_DB_PATH)
  : path.join(__dirname, '..', 'data');
const DEFAULT_ATTACHMENT_ROOT = path.join(DEFAULT_DATA_DIR, 'attachments');
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TARGET = 6;
const ATTACHMENT_TARGETS = new Set(['WORK_ORDER', 'PATROL']);

// 只认魔数，不信前端声明的 mime —— 否则改个扩展名就能往服务器上传任意文件。
const IMAGE_SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function detectImage(buffer) {
  return IMAGE_SIGNATURES.find((item) => item.test(buffer)) || null;
}

// 三个维度的平均分，保留一位小数。
function reviewOverall(row) {
  const total = REVIEW_DIMENSIONS.reduce((sum, item) => sum + Number(row[`${item.key}_score`] || 0), 0);
  return Math.round((total / REVIEW_DIMENSIONS.length) * 10) / 10;
}

function round1(value) {
  return value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;
}

// 把聚合查询的一行整理成技术员评分摘要。没有评价时全部返回 null 而不是 0，
// 免得"还没人评过"在界面上显示成"0 分"。
function summarizeReviewRow(row) {
  const count = Number(row.review_count) || 0;
  const dimensions = Object.fromEntries(REVIEW_DIMENSIONS.map((item) => [item.key, count ? round1(row[item.key]) : null]));
  const overall = count
    ? round1(REVIEW_DIMENSIONS.reduce((sum, item) => sum + Number(row[item.key] || 0), 0) / REVIEW_DIMENSIONS.length)
    : null;
  return {
    technician_user_id: row.technician_user_id || null,
    technician: row.technician || null,
    technician_status: row.technician_status || null,
    review_count: count,
    ...dimensions,
    overall,
  };
}

function generatePassword() {
  const bytes = crypto.randomBytes(10);
  return `ysm${[...bytes].map((byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('')}`;
}

function assertPasswordStrength(value) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(`密码至少需要${MIN_PASSWORD_LENGTH}位`, 400, 'WEAK_PASSWORD');
  }
  if (password.length > 100) throw new DomainError('密码不能超过100位', 400, 'VALIDATION_ERROR');
  if (/\s/.test(password)) throw new DomainError('密码不能包含空格', 400, 'VALIDATION_ERROR');
  return password;
}

const ROLES = Object.freeze({
  EMPLOYEE: 'EMPLOYEE',
  TECHNICIAN: 'TECHNICIAN',
  PRODUCTION_SUPERVISOR: 'PRODUCTION_SUPERVISOR',
  EQUIPMENT_ADMIN: 'EQUIPMENT_ADMIN',
  ADMIN: 'ADMIN',
});

function nowIso() {
  return new Date().toISOString();
}

function asObject(row) {
  return row ? { ...row } : null;
}

function asObjects(rows) {
  return rows.map(asObject);
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function qrToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function effectiveDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new DomainError('生效时间格式不正确', 400);
  if (date.getTime() > Date.now() + 5 * 60 * 1000) throw new DomainError('设备变动不能提前超过5分钟生效', 400);
  return date.toISOString();
}

function yes(value) {
  return ['1', '是', 'TRUE', 'true', 'YES', 'yes'].includes(String(value || '').trim());
}

function integerOr(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

class EquipmentService {
  constructor(db, options = {}) {
    this.db = db;
    this.attachmentRoot = options.attachmentRoot || DEFAULT_ATTACHMENT_ROOT;
  }

  dashboard() {
    const scalar = (sql, ...params) => Number(this.db.prepare(sql).get(...params).count);
    // 近30天已完成工单的两段平均时长（分钟）。只统计时间戳齐全的单：
    // assigned_at/arrived_at 是后加的列，改造前的老工单为空，算进去会把均值拖低。
    const minutesBetween = (from, to) => {
      const row = this.db.prepare(`
        SELECT AVG((julianday(${to}) - julianday(${from})) * 1440) AS value
        FROM work_orders
        WHERE status = 'COMPLETED' AND ${from} IS NOT NULL AND ${to} IS NOT NULL
          AND completed_at >= datetime('now', '-30 days')
      `).get();
      return row?.value == null ? null : Math.round(Number(row.value));
    };
    return {
      equipment: scalar('SELECT COUNT(*) AS count FROM equipment WHERE status != ?', 'RETIRED'),
      installedEquipment: scalar('SELECT COUNT(*) AS count FROM equipment_installations WHERE removed_at IS NULL'),
      pendingChanges: scalar('SELECT COUNT(*) AS count FROM composition_changes WHERE status = ?', 'PENDING'),
      repairingEquipment: scalar(`SELECT COUNT(*) AS count FROM equipment WHERE status IN ('REPORTED', 'REPAIRING')`),
      openWorkOrders: scalar(`SELECT COUNT(*) AS count FROM work_orders WHERE status NOT IN ('COMPLETED', 'CANCELLED')`),
      downtimeWorkOrders: scalar(`SELECT COUNT(*) AS count FROM work_orders WHERE is_downtime = 1 AND status NOT IN ('COMPLETED', 'CANCELLED')`),
      avgResponseMinutes: minutesBetween('reported_at', 'arrived_at'),
      avgRepairMinutes: minutesBetween('arrived_at', 'completed_at'),
    };
  }

  organization() {
    return {
      factories: asObjects(this.db.prepare('SELECT * FROM factories ORDER BY code').all()),
      workshops: asObjects(this.db.prepare('SELECT * FROM workshops ORDER BY code').all()),
      lines: asObjects(this.db.prepare(`
        SELECT l.*, w.name AS workshop_name
        FROM production_lines l JOIN workshops w ON w.id = l.workshop_id
        ORDER BY l.code
      `).all()),
      processes: asObjects(this.db.prepare(`
        SELECT p.*, l.name AS line_name
        FROM processes p JOIN production_lines l ON l.id = p.line_id
        ORDER BY l.code, p.sequence_no, p.code
      `).all()),
      positions: asObjects(this.db.prepare(`
        SELECT pos.*, p.name AS process_name, l.name AS line_name
        FROM positions pos
        JOIN processes p ON p.id = pos.process_id
        JOIN production_lines l ON l.id = p.line_id
        ORDER BY l.code, p.sequence_no, pos.sequence_no, pos.code
      `).all()),
    };
  }

  organizationTree() {
    const organization = this.organization();
    const installed = asObjects(this.db.prepare(`
      SELECT i.position_id, i.installed_at, e.id, e.code, e.standard_name, e.alias,
             e.category, e.status, e.critical, q.token AS qr_token
      FROM equipment_installations i
      JOIN equipment e ON e.id = i.equipment_id
      LEFT JOIN qr_mappings q ON q.target_type='EQUIPMENT' AND q.target_id=e.id AND q.status='ACTIVE'
      WHERE i.removed_at IS NULL
    `).all());
    const installedByPosition = new Map(installed.map((item) => [item.position_id, item]));
    return organization.factories.map((factory) => ({
      ...factory,
      workshops: organization.workshops.filter((workshop) => workshop.factory_id === factory.id).map((workshop) => ({
        ...workshop,
        lines: organization.lines.filter((line) => line.workshop_id === workshop.id).map((line) => ({
          ...line,
          processes: organization.processes.filter((process) => process.line_id === line.id).map((process) => ({
            ...process,
            positions: organization.positions.filter((position) => position.process_id === process.id).map((position) => ({
              ...position,
              equipment: installedByPosition.get(position.id) || null,
            })),
          })),
        })),
      })),
    }));
  }

  compositionExportRows() {
    return asObjects(this.db.prepare(`
      SELECT w.code AS workshop_code, w.name AS workshop_name,
             l.code AS line_code, l.name AS line_name, l.supervisor,
             p.code AS process_code, p.name AS process_name, p.sequence_no AS process_sequence,
             pos.code AS position_code, pos.name AS position_name, pos.sequence_no AS position_sequence,
             pos.critical AS position_critical, e.code AS equipment_code, e.legacy_code,
             et.code AS equipment_type_code, e.key_spec,
             e.standard_name AS equipment_name, e.alias AS equipment_alias, e.category AS equipment_category,
             e.brand, e.model, e.serial_number, e.responsible_person, e.commissioned_on, e.critical AS equipment_critical,
             i.installed_at AS effective_at, e.notes
      FROM workshops w
      JOIN production_lines l ON l.workshop_id=w.id
      JOIN processes p ON p.line_id=l.id
      JOIN positions pos ON pos.process_id=p.id
      LEFT JOIN equipment_installations i ON i.position_id=pos.id AND i.removed_at IS NULL
      LEFT JOIN equipment e ON e.id=i.equipment_id
      LEFT JOIN equipment_types et ON et.id=e.equipment_type_id
      ORDER BY w.code, l.code, p.sequence_no, p.code, pos.sequence_no, pos.code
    `).all()).map((row) => ({
      ...row,
      position_critical: row.position_critical ? '是' : '否',
      equipment_critical: row.equipment_code ? (row.equipment_critical ? '是' : '否') : '',
    }));
  }

  previewCompositionImport(rows) {
    return this.analyzeCompositionImport(rows);
  }

  analyzeCompositionImport(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new DomainError('组合导入数据不能为空', 400);
    const workshops = new Map(asObjects(this.db.prepare('SELECT * FROM workshops').all()).map((x) => [x.code.toUpperCase(), x]));
    const lines = new Map(asObjects(this.db.prepare(`
      SELECT l.*, w.code AS workshop_code FROM production_lines l JOIN workshops w ON w.id=l.workshop_id
    `).all()).map((x) => [x.code.toUpperCase(), x]));
    const processes = new Map(asObjects(this.db.prepare(`
      SELECT p.*, l.code AS line_code FROM processes p JOIN production_lines l ON l.id=p.line_id
    `).all()).map((x) => [x.code.toUpperCase(), x]));
    const positions = new Map(asObjects(this.db.prepare(`
      SELECT pos.*, p.code AS process_code FROM positions pos JOIN processes p ON p.id=pos.process_id
    `).all()).map((x) => [x.code.toUpperCase(), x]));
    const equipment = asObjects(this.db.prepare('SELECT * FROM equipment').all());
    const equipmentTypes = new Map(asObjects(this.db.prepare(`SELECT * FROM equipment_types WHERE status='ACTIVE'`).all()).map((x) => [x.code, x]));
    const byCode = new Map(equipment.map((x) => [x.code.toUpperCase(), x]));
    const byLegacy = new Map();
    const bySerial = new Map();
    for (const item of equipment) {
      if (item.legacy_code) {
        const key = item.legacy_code.toUpperCase();
        byLegacy.set(key, [...(byLegacy.get(key) || []), item]);
      }
      if (item.brand && item.serial_number) {
        const key = `${item.brand.toUpperCase()}|${item.serial_number.toUpperCase()}`;
        bySerial.set(key, [...(bySerial.get(key) || []), item]);
      }
    }
    const installations = asObjects(this.db.prepare(`SELECT * FROM equipment_installations WHERE removed_at IS NULL`).all());
    const installedByEquipment = new Map(installations.map((x) => [x.equipment_id, x]));
    const installedByPosition = new Map(installations.map((x) => [x.position_id, x]));
    const seenPositions = new Set();
    const plannedEquipmentKeys = new Set();
    const plannedEquipmentUse = new Set();
    const plannedPositionUse = new Set();
    const newWorkshops = new Set(), newLines = new Set(), newProcesses = new Set(), newPositions = new Set();
    const claimedWorkshops = new Map(), claimedLines = new Map(), claimedProcesses = new Map();
    const analyzedRows = [];
    let equipmentCreated = 0, equipmentReused = 0, installationsPlanned = 0;

    for (const source of rows) {
      const row = {
        ...source,
        workshop_code: upper(source.workshop_code), line_code: upper(source.line_code),
        process_code: upper(source.process_code), position_code: upper(source.position_code),
        equipment_code: upper(source.equipment_code), legacy_code: upper(source.legacy_code),
        equipment_type_code: upper(source.equipment_type_code || source.type_code),
        key_spec: upper(source.key_spec),
        workshop_name: String(source.workshop_name || '').trim(), line_name: String(source.line_name || '').trim(),
        process_name: String(source.process_name || '').trim(), position_name: String(source.position_name || '').trim(),
        equipment_name: String(source.equipment_name || '').trim(), equipment_category: String(source.equipment_category || '').trim(),
        brand: String(source.brand || '').trim(), serial_number: String(source.serial_number || '').trim(),
        process_sequence: integerOr(source.process_sequence), position_sequence: integerOr(source.position_sequence),
        position_critical: yes(source.position_critical), equipment_critical: yes(source.equipment_critical),
      };
      const errors = [], warnings = [], actions = [];
      for (const [key, label] of [['workshop_code', '车间编码'], ['workshop_name', '车间名称'], ['line_code', '产线编码'], ['line_name', '产线名称'], ['process_code', '工序编码'], ['process_name', '工序名称'], ['position_code', '机位编码'], ['position_name', '机位名称']]) {
        if (!row[key]) errors.push(`${label}不能为空`);
      }
      const workshopClaim = claimedWorkshops.get(row.workshop_code);
      if (workshopClaim && workshopClaim !== row.workshop_name) errors.push(`文件内车间编码${row.workshop_code}对应了不同名称`);
      else if (row.workshop_code) claimedWorkshops.set(row.workshop_code, row.workshop_name);
      const lineClaim = claimedLines.get(row.line_code);
      const lineSignature = `${row.workshop_code}|${row.line_name}`;
      if (lineClaim && lineClaim !== lineSignature) errors.push(`文件内产线编码${row.line_code}的名称或所属车间不一致`);
      else if (row.line_code) claimedLines.set(row.line_code, lineSignature);
      const processClaim = claimedProcesses.get(row.process_code);
      const processSignature = `${row.line_code}|${row.process_name}`;
      if (processClaim && processClaim !== processSignature) errors.push(`文件内工序编码${row.process_code}的名称或所属产线不一致`);
      else if (row.process_code) claimedProcesses.set(row.process_code, processSignature);
      if (seenPositions.has(row.position_code)) errors.push(`机位编码${row.position_code}在文件中重复`);
      seenPositions.add(row.position_code);

      const workshop = workshops.get(row.workshop_code);
      if (workshop && workshop.name !== row.workshop_name) errors.push(`车间编码${row.workshop_code}已存在，但名称不一致`);
      else if (!workshop && !newWorkshops.has(row.workshop_code)) { newWorkshops.add(row.workshop_code); actions.push('新建车间'); }
      const line = lines.get(row.line_code);
      if (line && (line.name !== row.line_name || upper(line.workshop_code) !== row.workshop_code)) errors.push(`产线编码${row.line_code}的名称或所属车间冲突`);
      else if (!line && !newLines.has(row.line_code)) { newLines.add(row.line_code); actions.push('新建产线'); }
      const process = processes.get(row.process_code);
      if (process && (process.name !== row.process_name || upper(process.line_code) !== row.line_code)) errors.push(`工序编码${row.process_code}的名称或所属产线冲突`);
      else if (!process && !newProcesses.has(row.process_code)) { newProcesses.add(row.process_code); actions.push('新建工序'); }
      const position = positions.get(row.position_code);
      if (position && (position.name !== row.position_name || upper(position.process_code) !== row.process_code)) errors.push(`机位编码${row.position_code}的名称或所属工序冲突`);
      else if (!position && !newPositions.has(row.position_code)) { newPositions.add(row.position_code); actions.push('新建机位'); }

      const hasEquipment = [row.equipment_code, row.legacy_code, row.equipment_name, row.equipment_category, row.brand, row.model, row.serial_number, row.equipment_type_code, row.key_spec].some(Boolean);
      let matched = null;
      let equipmentKey = null;
      if (hasEquipment) {
        if (row.equipment_code) {
          matched = byCode.get(row.equipment_code) || null;
          if (!matched) errors.push(`永久设备编码${row.equipment_code}不存在，不能自行指定永久码`);
        } else if (row.legacy_code) {
          const candidates = byLegacy.get(row.legacy_code) || [];
          if (candidates.length > 1) errors.push(`原资产编号${row.legacy_code}匹配到多台设备`);
          else matched = candidates[0] || null;
          equipmentKey = `LEGACY:${row.legacy_code}`;
        } else if (row.brand && row.serial_number) {
          const key = `${row.brand.toUpperCase()}|${row.serial_number.toUpperCase()}`;
          const candidates = bySerial.get(key) || [];
          if (candidates.length > 1) errors.push(`品牌和出厂编号匹配到多台设备`);
          else matched = candidates[0] || null;
          equipmentKey = `SERIAL:${key}`;
        } else {
          equipmentKey = `ROW:${row.row_number}`;
        }

        if (!matched && !row.equipment_code) {
          try { row.key_spec = normalizeKeySpec(row.key_spec); } catch (error) { errors.push(error.message); }
          if (!row.equipment_name || !row.equipment_category || !row.equipment_type_code) {
            errors.push('自动创建设备必须填写设备名称、设备类别和类型代码');
          } else if (!equipmentTypes.has(row.equipment_type_code)) {
            errors.push(`设备类型代码${row.equipment_type_code}不存在`);
          }
          else {
            if (!plannedEquipmentKeys.has(equipmentKey)) { plannedEquipmentKeys.add(equipmentKey); equipmentCreated += 1; actions.push('新建设备'); }
            else warnings.push('复用本文件中计划新建的同一设备');
          }
        } else if (matched) {
          equipmentKey = `ID:${matched.id}`;
          equipmentReused += 1;
          actions.push('复用设备');
          if (row.equipment_name && row.equipment_name !== matched.standard_name) warnings.push(`表内设备名称与台账名称“${matched.standard_name}”不同，以台账为准`);
        }

        if (equipmentKey) {
          if (plannedEquipmentUse.has(equipmentKey)) errors.push('同一设备不能在组合表中安装到多个机位');
          plannedEquipmentUse.add(equipmentKey);
          if (matched && installedByEquipment.has(matched.id)) {
            const active = installedByEquipment.get(matched.id);
            if (!position || active.position_id !== position.id) errors.push('设备当前已经安装在其他机位');
          }
          if (plannedPositionUse.has(row.position_code)) errors.push('同一机位不能安装多台设备');
          plannedPositionUse.add(row.position_code);
          if (position && installedByPosition.has(position.id)) {
            const active = installedByPosition.get(position.id);
            if (!matched || active.equipment_id !== matched.id) errors.push('目标机位当前已经被其他设备占用');
            else warnings.push('设备已在该机位，导入时不会重复安装');
          } else {
            installationsPlanned += 1;
            actions.push('安装设备');
          }
        }
      }
      if (row.effective_at) {
        try { effectiveDate(row.effective_at); } catch (error) { errors.push(error.message); }
      }
      analyzedRows.push({ row_number: row.row_number, row, equipment_id: matched?.id || null, equipment_key: equipmentKey, actions, warnings, errors });
    }
    const errorCount = analyzedRows.reduce((sum, row) => sum + row.errors.length, 0);
    const warningCount = analyzedRows.reduce((sum, row) => sum + row.warnings.length, 0);
    return {
      summary: {
        rows: analyzedRows.length, errors: errorCount, warnings: warningCount,
        workshops_created: newWorkshops.size, lines_created: newLines.size,
        processes_created: newProcesses.size, positions_created: newPositions.size,
        equipment_created: equipmentCreated, equipment_reused: equipmentReused,
        installations: installationsPlanned,
      },
      rows: analyzedRows,
    };
  }

  commitCompositionImport(rows, meta, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const analysis = this.analyzeCompositionImport(rows);
    if (analysis.summary.errors) throw new DomainError(`组合表仍有${analysis.summary.errors}个错误，不能导入`, 409, 'IMPORT_HAS_ERRORS');
    const filename = requireText(meta.filename || '产线组合.xlsx', '文件名', 255);
    const fileHash = requireText(meta.file_hash, '文件哈希', 128);
    if (this.db.prepare(`SELECT id FROM import_batches WHERE import_type='LINE_COMPOSITION' AND file_hash=? AND status='COMPLETED'`).get(fileHash)) {
      throw new DomainError('该Excel文件已经成功导入过，不能重复提交', 409, 'DUPLICATE_IMPORT');
    }
    return transaction(this.db, () => {
      const factory = this.db.prepare('SELECT id FROM factories ORDER BY id LIMIT 1').get();
      const workshopIds = new Map(asObjects(this.db.prepare('SELECT id, code FROM workshops').all()).map((x) => [upper(x.code), x.id]));
      const lineIds = new Map(asObjects(this.db.prepare('SELECT id, code FROM production_lines').all()).map((x) => [upper(x.code), x.id]));
      const processIds = new Map(asObjects(this.db.prepare('SELECT id, code FROM processes').all()).map((x) => [upper(x.code), x.id]));
      const positionIds = new Map(asObjects(this.db.prepare('SELECT id, code FROM positions').all()).map((x) => [upper(x.code), x.id]));
      const equipmentIds = new Map();
      const actual = { ...analysis.summary, equipment_codes: [] };

      for (const item of analysis.rows) {
        const row = item.row;
        if (!workshopIds.has(row.workshop_code)) {
          const result = this.db.prepare(`INSERT INTO workshops(factory_id, code, name, created_at) VALUES (?, ?, ?, ?)`)
            .run(factory.id, row.workshop_code, row.workshop_name, nowIso());
          workshopIds.set(row.workshop_code, Number(result.lastInsertRowid));
          this.audit('workshop', result.lastInsertRowid, 'IMPORT_CREATE', context.actor, null, row);
        }
        if (!lineIds.has(row.line_code)) {
          const result = this.db.prepare(`INSERT INTO production_lines(workshop_id, code, name, supervisor, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(workshopIds.get(row.workshop_code), row.line_code, row.line_name, optionalText(row.supervisor, 80), nowIso());
          lineIds.set(row.line_code, Number(result.lastInsertRowid));
          this.audit('production_line', result.lastInsertRowid, 'IMPORT_CREATE', context.actor, null, row);
        }
        if (!processIds.has(row.process_code)) {
          const result = this.db.prepare(`INSERT INTO processes(line_id, code, name, sequence_no, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(lineIds.get(row.line_code), row.process_code, row.process_name, row.process_sequence, nowIso());
          processIds.set(row.process_code, Number(result.lastInsertRowid));
          this.createQrMapping('PROCESS', result.lastInsertRowid);
          this.audit('process', result.lastInsertRowid, 'IMPORT_CREATE', context.actor, null, row);
        }
        if (!positionIds.has(row.position_code)) {
          const result = this.db.prepare(`INSERT INTO positions(process_id, code, name, sequence_no, critical, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(processIds.get(row.process_code), row.position_code, row.position_name, row.position_sequence, row.position_critical ? 1 : 0, nowIso());
          positionIds.set(row.position_code, Number(result.lastInsertRowid));
          this.audit('position', result.lastInsertRowid, 'IMPORT_CREATE', context.actor, null, row);
        }

        if (!item.equipment_key) continue;
        let equipmentId = item.equipment_id;
        if (!equipmentId && equipmentIds.has(item.equipment_key)) equipmentId = equipmentIds.get(item.equipment_key);
        if (!equipmentId) {
          const created = this.createEquipmentInsideTransaction({
            standard_name: row.equipment_name,
            alias: row.equipment_alias,
            category: row.equipment_category,
            type_code: row.equipment_type_code,
            key_spec: row.key_spec,
            brand: row.brand,
            model: row.model,
            serial_number: row.serial_number,
            critical: row.equipment_critical,
            responsible_person: row.responsible_person,
            commissioned_on: row.commissioned_on,
            legacy_code: row.legacy_code,
            data_source: '产线组合导入',
            verified: true,
            notes: row.notes,
          }, context);
          equipmentId = created.id;
          equipmentIds.set(item.equipment_key, equipmentId);
          actual.equipment_codes.push(created.code);
        }
        const positionId = positionIds.get(row.position_code);
        const current = this.activeInstallation(equipmentId);
        if (!current) {
          const sequence = this.nextSequenceInsideTransaction('change_sequence');
          const changeNo = `CHG-${String(sequence).padStart(6, '0')}`;
          const installedAt = row.effective_at ? effectiveDate(row.effective_at) : nowIso();
          const changeResult = this.db.prepare(`
            INSERT INTO composition_changes(change_no, action, equipment_id, to_position_id, effective_at, reason,
              submitted_by, status, reviewed_by, reviewed_at, review_note, created_at)
            VALUES (?, 'INSTALL', ?, ?, ?, '产线组合初始化导入', ?, 'APPROVED', ?, ?, ?, ?)
          `).run(changeNo, equipmentId, positionId, installedAt, context.actor, context.actor, nowIso(), filename, nowIso());
          this.db.prepare(`INSERT INTO equipment_installations(equipment_id, position_id, installed_at, change_request_id, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(equipmentId, positionId, installedAt, changeResult.lastInsertRowid, nowIso());
          this.audit('composition_change', changeResult.lastInsertRowid, 'IMPORT_APPROVE', context.actor, null, { change_no: changeNo, equipment_id: equipmentId, position_id: positionId });
        }
      }
      const batch = this.db.prepare(`
        INSERT INTO import_batches(import_type, filename, file_hash, row_count, result_json, actor, created_at)
        VALUES ('LINE_COMPOSITION', ?, ?, ?, ?, ?, ?)
      `).run(filename, fileHash, rows.length, JSON.stringify(actual), context.actor, nowIso());
      this.audit('import_batch', batch.lastInsertRowid, 'COMMIT', context.actor, null, actual);
      return { batch_id: Number(batch.lastInsertRowid), ...actual };
    });
  }

  nextSequenceInsideTransaction(key) {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
    const next = Number(row.value) + 1;
    this.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(String(next), key);
    return next;
  }

  createWorkshop(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const factoryId = positiveId(input.factory_id, '工厂');
    const code = requireText(input.code, '车间编码', 40).toUpperCase();
    const name = requireText(input.name, '车间名称', 80);
    this.ensure('factories', factoryId, '工厂不存在');
    try {
      const result = this.db.prepare(`
        INSERT INTO workshops(factory_id, code, name, created_at)
        VALUES (?, ?, ?, ?)
      `).run(factoryId, code, name, nowIso());
      const created = this.rowById('workshops', result.lastInsertRowid);
      this.audit('workshop', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '车间编码已存在');
    }
  }

  updateWorkshop(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('workshops', positiveId(id, '车间'));
    if (!current) throw new DomainError('车间不存在', 404);
    this.db.prepare(`UPDATE workshops SET name=? WHERE id=?`)
      .run(requireText(input.name, '车间名称', 80), current.id);
    const updated = this.rowById('workshops', current.id);
    this.audit('workshop', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  createLine(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const workshopId = positiveId(input.workshop_id, '车间');
    const code = requireText(input.code, '产线编码', 40).toUpperCase();
    const name = requireText(input.name, '产线名称', 80);
    const now = nowIso();
    this.ensure('workshops', workshopId, '车间不存在');
    try {
      const result = this.db.prepare(`
        INSERT INTO production_lines(workshop_id, code, name, supervisor, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workshopId, code, name, optionalText(input.supervisor, 80), now);
      const created = this.rowById('production_lines', result.lastInsertRowid);
      this.audit('production_line', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '产线编码已存在');
    }
  }

  updateLine(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('production_lines', positiveId(id, '产线'));
    if (!current) throw new DomainError('产线不存在', 404);
    this.db.prepare(`UPDATE production_lines SET name=?, supervisor=? WHERE id=?`)
      .run(requireText(input.name, '产线名称', 80), optionalText(input.supervisor, 80), current.id);
    const updated = this.rowById('production_lines', current.id);
    this.audit('production_line', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  createProcess(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const lineId = positiveId(input.line_id, '产线');
    this.ensure('production_lines', lineId, '产线不存在');
    const code = requireText(input.code, '工序编码', 50).toUpperCase();
    const name = requireText(input.name, '工序名称', 80);
    try {
      const result = this.db.prepare(`
        INSERT INTO processes(line_id, code, name, sequence_no, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(lineId, code, name, Number(input.sequence_no) || 1, nowIso());
      const created = this.rowById('processes', result.lastInsertRowid);
      this.createQrMapping('PROCESS', created.id);
      this.audit('process', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '工序编码已存在');
    }
  }

  updateProcess(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('processes', positiveId(id, '工序'));
    if (!current) throw new DomainError('工序不存在', 404);
    this.db.prepare(`UPDATE processes SET name=?, sequence_no=? WHERE id=?`)
      .run(requireText(input.name, '工序名称', 80), integerOr(input.sequence_no), current.id);
    const updated = this.rowById('processes', current.id);
    this.audit('process', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  createPosition(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const processId = positiveId(input.process_id, '工序');
    this.ensure('processes', processId, '工序不存在');
    const code = requireText(input.code, '机位编码', 60).toUpperCase();
    const name = requireText(input.name, '机位名称', 80);
    try {
      const result = this.db.prepare(`
        INSERT INTO positions(process_id, code, name, sequence_no, critical, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(processId, code, name, Number(input.sequence_no) || 1, input.critical ? 1 : 0, nowIso());
      const created = this.rowById('positions', result.lastInsertRowid);
      this.audit('position', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '机位编码已存在');
    }
  }

  updatePosition(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('positions', positiveId(id, '机位'));
    if (!current) throw new DomainError('机位不存在', 404);
    this.db.prepare(`UPDATE positions SET name=?, sequence_no=?, critical=? WHERE id=?`)
      .run(requireText(input.name, '机位名称', 80), integerOr(input.sequence_no), input.critical ? 1 : 0, current.id);
    const updated = this.rowById('positions', current.id);
    this.audit('position', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  structureDeletionPreview(type, id) {
    const normalizedType = String(type || '').toLowerCase();
    const config = {
      workshop: { table: 'workshops', label: '车间' },
      line: { table: 'production_lines', label: '产线' },
      process: { table: 'processes', label: '工序' },
      position: { table: 'positions', label: '机位' },
    }[normalizedType];
    if (!config) throw new DomainError('不支持删除该结构类型', 400);
    const targetId = positiveId(id, config.label);
    const organization = this.organization();
    const collections = {
      workshop: organization.workshops,
      line: organization.lines,
      process: organization.processes,
      position: organization.positions,
    };
    const target = collections[normalizedType].find((item) => item.id === targetId);
    if (!target) throw new DomainError(`${config.label}不存在`, 404);

    const workshopIds = normalizedType === 'workshop' ? [targetId] : [];
    const lineIds = normalizedType === 'line'
      ? [targetId]
      : organization.lines.filter((item) => workshopIds.includes(item.workshop_id)).map((item) => item.id);
    const processIds = normalizedType === 'process'
      ? [targetId]
      : organization.processes.filter((item) => lineIds.includes(item.line_id)).map((item) => item.id);
    const positionIds = normalizedType === 'position'
      ? [targetId]
      : organization.positions.filter((item) => processIds.includes(item.process_id)).map((item) => item.id);

    const installationCount = this.countWhereIn('equipment_installations', 'position_id', positionIds);
    const workOrders = processIds.length
      ? asObjects(this.db.prepare(`
        SELECT id, work_order_no, process_id, status, fault_symptom, reported_at
        FROM work_orders
        WHERE process_id IN (${processIds.map(() => '?').join(',')})
        ORDER BY id
      `).all(...processIds))
      : [];
    let compositionCount = 0;
    if (positionIds.length) {
      const placeholders = positionIds.map(() => '?').join(',');
      compositionCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM composition_changes
        WHERE from_position_id IN (${placeholders}) OR to_position_id IN (${placeholders})
      `).get(...positionIds, ...positionIds).count);
    }
    const blockers = [];
    if (installationCount) blockers.push(`包含${installationCount}条设备安装历史`);
    if (compositionCount) blockers.push(`包含${compositionCount}条设备变动记录`);
    return {
      deletable: blockers.length === 0,
      target: { type: normalizedType, id: target.id, code: target.code, name: target.name, label: config.label },
      counts: {
        workshops: workshopIds.length,
        lines: lineIds.length,
        processes: processIds.length,
        positions: positionIds.length,
        work_orders_to_delete: workOrders.length,
      },
      blockers,
      snapshot: {
        workshops: organization.workshops.filter((item) => workshopIds.includes(item.id)),
        lines: organization.lines.filter((item) => lineIds.includes(item.id)),
        processes: organization.processes.filter((item) => processIds.includes(item.id)),
        positions: organization.positions.filter((item) => positionIds.includes(item.id)),
        work_orders: workOrders,
      },
      ids: { workshopIds, lineIds, processIds, positionIds, workOrderIds: workOrders.map((item) => item.id) },
    };
  }

  deleteStructureBranch(type, id, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const preview = this.structureDeletionPreview(type, id);
    if (!preview.deletable) throw new DomainError(`不能删除：${preview.blockers.join('；')}`, 409, 'STRUCTURE_IN_USE');
    return transaction(this.db, () => {
      this.deleteWhereIn('work_order_parts', 'work_order_id', preview.ids.workOrderIds);
      this.deleteWhereIn('work_order_history', 'work_order_id', preview.ids.workOrderIds);
      this.deleteWhereIn('work_orders', 'id', preview.ids.workOrderIds);
      this.deleteWhereIn('qr_mappings', 'target_id', preview.ids.processIds, `target_type='PROCESS'`);
      this.deleteWhereIn('positions', 'id', preview.ids.positionIds);
      this.deleteWhereIn('processes', 'id', preview.ids.processIds);
      this.deleteWhereIn('production_lines', 'id', preview.ids.lineIds);
      this.deleteWhereIn('workshops', 'id', preview.ids.workshopIds);
      this.audit('structure_branch', preview.target.id, 'DELETE', context.actor, preview, null);
      return { target: preview.target, deleted: preview.counts };
    });
  }

  countWhereIn(table, column, ids) {
    const allowedTables = new Set(['equipment_installations', 'work_orders']);
    const allowedColumns = new Set(['position_id', 'process_id']);
    if (!allowedTables.has(table) || !allowedColumns.has(column) || !ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders})`).get(...ids).count);
  }

  deleteWhereIn(table, column, ids, extraWhere = '') {
    const allowedTables = new Set([
      'qr_mappings', 'positions', 'processes', 'production_lines', 'workshops',
      'work_order_parts', 'work_order_history', 'work_orders',
    ]);
    const allowedColumns = new Set(['id', 'target_id', 'work_order_id']);
    if (!allowedTables.has(table) || !allowedColumns.has(column) || !ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const where = extraWhere ? `${extraWhere} AND ` : '';
    this.db.prepare(`DELETE FROM ${table} WHERE ${where}${column} IN (${placeholders})`).run(...ids);
  }

  listEquipmentTypes() {
    return asObjects(this.db.prepare(`
      SELECT t.*, COUNT(e.id) AS equipment_count
      FROM equipment_types t
      LEFT JOIN equipment e ON e.equipment_type_id=t.id
      GROUP BY t.id
      ORDER BY t.code
    `).all());
  }

  createEquipmentType(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const code = normalizeEquipmentTypeCode(input.code);
    const name = requireText(input.name, '类型名称', 80);
    const time = nowIso();
    try {
      const result = this.db.prepare(`
        INSERT INTO equipment_types(code, name, created_at, updated_at) VALUES (?, ?, ?, ?)
      `).run(code, name, time, time);
      const created = this.rowById('equipment_types', result.lastInsertRowid);
      this.audit('equipment_type', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '设备类型代码已存在');
    }
  }

  updateEquipmentType(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('equipment_types', positiveId(id, '设备类型'));
    if (!current) throw new DomainError('设备类型不存在', 404);
    this.db.prepare(`UPDATE equipment_types SET name=?, updated_at=? WHERE id=?`)
      .run(requireText(input.name, '类型名称', 80), nowIso(), current.id);
    const updated = this.rowById('equipment_types', current.id);
    this.audit('equipment_type', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  deleteEquipmentType(id, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.rowById('equipment_types', positiveId(id, '设备类型'));
    if (!current) throw new DomainError('设备类型不存在', 404);
    const used = Number(this.db.prepare('SELECT COUNT(*) AS count FROM equipment WHERE equipment_type_id=?').get(current.id).count);
    if (used) throw new DomainError(`该类型已被${used}台设备使用，不能删除`, 409, 'TYPE_IN_USE');
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM equipment_code_sequences WHERE equipment_type_id=?').run(current.id);
      this.db.prepare('DELETE FROM equipment_types WHERE id=?').run(current.id);
      this.audit('equipment_type', current.id, 'DELETE', context.actor, current, null);
      return current;
    });
  }

  createEquipment(input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    return transaction(this.db, () => this.createEquipmentInsideTransaction(input, context));
  }

  createEquipmentInsideTransaction(input, context) {
    const standardName = requireText(input.standard_name, '设备标准名称', 100);
    const category = requireText(input.category, '设备类别', 100);
    const typeCode = normalizeEquipmentTypeCode(input.type_code);
    const keySpec = normalizeKeySpec(input.key_spec);
    const equipmentType = this.db.prepare(`SELECT * FROM equipment_types WHERE code=? AND status='ACTIVE'`).get(typeCode);
    if (!equipmentType) throw new DomainError(`设备类型代码${typeCode}不存在或已停用`, 400, 'INVALID_EQUIPMENT_TYPE');
    const sequence = this.nextEquipmentSequenceInsideTransaction(equipmentType.id, keySpec);
    const code = formatEquipmentCode(typeCode, keySpec, sequence);
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO equipment(
        code, equipment_type_id, key_spec, standard_name, alias, category, brand, model, serial_number, critical,
        responsible_person, commissioned_on, legacy_code, data_source, verified, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code, equipmentType.id, keySpec, standardName, optionalText(input.alias, 100), category,
      optionalText(input.brand, 100), optionalText(input.model, 100), optionalText(input.serial_number, 100),
      input.critical ? 1 : 0, optionalText(input.responsible_person, 80), input.commissioned_on || null,
      optionalText(input.legacy_code, 100), optionalText(input.data_source, 100) || '现场盘点',
      input.verified ? 1 : 0, optionalText(input.notes, 1000), now, now
    );
    const created = this.rowById('equipment', result.lastInsertRowid);
    this.createQrMapping('EQUIPMENT', created.id);
    this.audit('equipment', created.id, 'CREATE', context.actor, null, created);
    return this.getEquipment(created.id);
  }

  nextEquipmentSequenceInsideTransaction(equipmentTypeId, keySpec) {
    this.db.prepare(`
      INSERT OR IGNORE INTO equipment_code_sequences(equipment_type_id, key_spec, value) VALUES (?, ?, 0)
    `).run(equipmentTypeId, keySpec);
    const row = this.db.prepare(`
      SELECT value FROM equipment_code_sequences WHERE equipment_type_id=? AND key_spec=?
    `).get(equipmentTypeId, keySpec);
    const next = Number(row.value) + 1;
    if (next > 9999) throw new DomainError('该设备类型和规格的流水号已经用完', 500, 'SEQUENCE_EXHAUSTED');
    this.db.prepare(`
      UPDATE equipment_code_sequences SET value=? WHERE equipment_type_id=? AND key_spec=?
    `).run(next, equipmentTypeId, keySpec);
    return next;
  }

  importEquipment(rows, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    throw new DomainError('旧版逐行导入已停用，请使用“预览后整批导入”', 410, 'IMPORT_API_RETIRED');
  }

  previewEquipmentImport(rows) {
    return this.analyzeEquipmentImport(rows);
  }

  analyzeEquipmentImport(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new DomainError('导入数据不能为空', 400);
    if (rows.length > 500) throw new DomainError('单次最多导入500台设备', 400);
    const types = new Map(asObjects(this.db.prepare(`SELECT * FROM equipment_types WHERE status='ACTIVE'`).all()).map((item) => [item.code, item]));
    const existing = asObjects(this.db.prepare('SELECT * FROM equipment').all());
    const existingLegacy = new Map();
    const existingSerial = new Map();
    for (const item of existing) {
      if (item.legacy_code) existingLegacy.set(upper(item.legacy_code), item);
      if (item.brand && item.serial_number) existingSerial.set(`${upper(item.brand)}|${upper(item.serial_number)}`, item);
    }
    const sequenceValues = new Map(asObjects(this.db.prepare(`
      SELECT s.equipment_type_id, s.key_spec, s.value FROM equipment_code_sequences s
    `).all()).map((item) => [`${item.equipment_type_id}|${item.key_spec}`, Number(item.value)]));
    const seenLegacy = new Map();
    const seenSerial = new Map();
    const analyzed = [];

    for (const source of rows) {
      const row = {
        ...source,
        standard_name: String(source.standard_name || '').trim(),
        category: String(source.category || '').trim(),
        type_code: upper(source.type_code || source.equipment_type_code),
        key_spec: upper(source.key_spec),
        legacy_code: upper(source.legacy_code),
        brand: String(source.brand || '').trim(),
        serial_number: String(source.serial_number || '').trim(),
        review_status: String(source.review_status || '').trim(),
        suggested_code: upper(source.suggested_code),
      };
      const errors = [];
      const warnings = [];
      let type = null;
      if (!row.standard_name) errors.push('标准设备名称不能为空');
      if (!row.category) errors.push('设备类别不能为空');
      try { row.type_code = normalizeEquipmentTypeCode(row.type_code); } catch (error) { errors.push(error.message); }
      try { row.key_spec = normalizeKeySpec(row.key_spec); } catch (error) { errors.push(error.message); }
      if (row.type_code) {
        type = types.get(row.type_code) || null;
        if (!type) errors.push(`设备类型代码${row.type_code}不存在或已停用`);
      }
      if (row.review_status === '待核实') errors.push('该行核查状态为“待核实”，必须核实后才能整批导入');

      if (row.legacy_code) {
        if (existingLegacy.has(row.legacy_code)) errors.push(`原资产编号${row.legacy_code}已存在于系统`);
        const firstRow = seenLegacy.get(row.legacy_code);
        if (firstRow) errors.push(`原资产编号与文件第${firstRow}行重复`);
        else seenLegacy.set(row.legacy_code, row.row_number);
      }
      if (row.brand && row.serial_number) {
        const serialKey = `${upper(row.brand)}|${upper(row.serial_number)}`;
        if (existingSerial.has(serialKey)) errors.push('相同品牌和出厂编号的设备已存在于系统');
        const firstRow = seenSerial.get(serialKey);
        if (firstRow) errors.push(`品牌和出厂编号与文件第${firstRow}行重复`);
        else seenSerial.set(serialKey, row.row_number);
      }

      let plannedCode = '';
      if (type && !errors.some((message) => message.includes('类型代码') || message.includes('关键规格'))) {
        const sequenceKey = `${type.id}|${row.key_spec}`;
        const next = (sequenceValues.get(sequenceKey) || 0) + 1;
        sequenceValues.set(sequenceKey, next);
        plannedCode = formatEquipmentCode(type.code, row.key_spec, next);
        if (row.suggested_code && row.suggested_code !== plannedCode) {
          warnings.push(`表内建议码为${row.suggested_code}，系统当前计划码为${plannedCode}，以系统发码为准`);
        }
      }
      analyzed.push({ row_number: row.row_number, row, planned_code: plannedCode, errors, warnings });
    }
    const errorCount = analyzed.reduce((sum, item) => sum + item.errors.length, 0);
    const warningCount = analyzed.reduce((sum, item) => sum + item.warnings.length, 0);
    return {
      summary: { rows: analyzed.length, equipment_created: analyzed.length, errors: errorCount, warnings: warningCount },
      rows: analyzed,
    };
  }

  commitEquipmentImport(rows, meta, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const filename = requireText(meta.filename || '设备台账.xlsx', '文件名', 255);
    const fileHash = requireText(meta.file_hash, '文件哈希', 128);
    try {
      if (this.db.prepare(`SELECT id FROM import_batches WHERE import_type='EQUIPMENT' AND file_hash=? AND status='COMPLETED'`).get(fileHash)) {
        throw new DomainError('该设备台账已经成功导入过，不能重复提交', 409, 'DUPLICATE_IMPORT');
      }
      const analysis = this.analyzeEquipmentImport(rows);
      if (analysis.summary.errors) throw new DomainError(`设备台账仍有${analysis.summary.errors}个错误，不能导入`, 409, 'IMPORT_HAS_ERRORS');
      return transaction(this.db, () => {
        const created = analysis.rows.map((item) => this.createEquipmentInsideTransaction(item.row, context));
        const result = {
          rows: created.length,
          equipment_codes: created.map((item) => item.code),
          warnings: analysis.summary.warnings,
        };
        const batch = this.db.prepare(`
          INSERT INTO import_batches(import_type, filename, file_hash, row_count, result_json, actor, status, created_at)
          VALUES ('EQUIPMENT', ?, ?, ?, ?, ?, 'COMPLETED', ?)
        `).run(filename, fileHash, created.length, JSON.stringify(result), context.actor, nowIso());
        this.audit('import_batch', batch.lastInsertRowid, 'COMMIT', context.actor, null, result);
        return { batch_id: Number(batch.lastInsertRowid), ...result };
      });
    } catch (error) {
      if (error.code !== 'DUPLICATE_IMPORT') {
        this.db.prepare(`
          INSERT OR REPLACE INTO import_batches(import_type, filename, file_hash, row_count, result_json, actor, status, created_at)
          VALUES ('EQUIPMENT', ?, ?, ?, ?, ?, 'FAILED', ?)
        `).run(filename, fileHash, Array.isArray(rows) ? rows.length : 0, JSON.stringify({ error: error.message }), context.actor, nowIso());
      }
      throw error;
    }
  }

  listEquipment(search = '') {
    const query = `%${String(search).trim()}%`;
    return asObjects(this.db.prepare(`
      SELECT e.*, et.code AS type_code, et.name AS type_name,
             pos.id AS position_id, pos.code AS position_code, pos.name AS position_name,
             pos.sequence_no AS position_sequence,
             p.id AS process_id, p.name AS process_name, l.id AS line_id, l.name AS line_name,
             w.id AS workshop_id, w.name AS workshop_name,
             q.token AS qr_token
      FROM equipment e
      LEFT JOIN equipment_types et ON et.id=e.equipment_type_id
      LEFT JOIN equipment_installations i ON i.equipment_id = e.id AND i.removed_at IS NULL
      LEFT JOIN positions pos ON pos.id = i.position_id
      LEFT JOIN processes p ON p.id = pos.process_id
      LEFT JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN workshops w ON w.id = l.workshop_id
      LEFT JOIN qr_mappings q ON q.target_type = 'EQUIPMENT' AND q.target_id = e.id AND q.status = 'ACTIVE'
      WHERE e.code LIKE ? OR e.standard_name LIKE ? OR COALESCE(e.alias, '') LIKE ?
         OR COALESCE(et.code, '') LIKE ? OR COALESCE(e.key_spec, '') LIKE ?
      -- 按"车间 / 产线 / 工位顺序"排：工人是按"这条线第几位"认机器的，
      -- 分级选择器直接吃这个顺序，不用在前端再排一遍。未安装的（l.code 为 NULL）排最后。
      ORDER BY l.code IS NULL, l.code, pos.sequence_no, e.code
    `).all(query, query, query, query, query));
  }

  updateEquipment(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const current = this.getEquipment(id);
    // 手工只能选在用/闲置/停用/报废，改的是baseline；"已报修""维修中"由工单派生，不接受手工写入。
    const fallback = MANUAL_EQUIPMENT_STATUSES.includes(current.baseline_status)
      ? current.baseline_status
      : (MANUAL_EQUIPMENT_STATUSES.includes(current.status) ? current.status : 'ACTIVE');
    const baseline = String(input.status || fallback).toUpperCase();
    if (!MANUAL_EQUIPMENT_STATUSES.includes(baseline)) {
      throw new DomainError('设备状态无效，“已报修”和“维修中”由维修工单自动维护', 400);
    }
    this.db.prepare(`
      UPDATE equipment SET standard_name=?, alias=?, category=?, brand=?, model=?, serial_number=?,
        critical=?, baseline_status=?, responsible_person=?, commissioned_on=?, legacy_code=?, data_source=?,
        verified=?, notes=?, updated_at=? WHERE id=?
    `).run(requireText(input.standard_name, '设备标准名称', 100), optionalText(input.alias, 100),
      requireText(input.category, '设备类别', 100), optionalText(input.brand, 100),
      optionalText(input.model, 100), optionalText(input.serial_number, 100), input.critical ? 1 : 0,
      baseline, optionalText(input.responsible_person, 80), input.commissioned_on || null,
      optionalText(input.legacy_code, 100), optionalText(input.data_source, 100) || '现场盘点',
      input.verified ? 1 : 0, optionalText(input.notes, 1000), nowIso(), current.id);
    // 没有未结工单时立刻落到手工选的状态；正在维修则保持维修态，结单后自然回到这里。
    this.syncEquipmentStatus(current.id, context);
    const updated = this.getEquipment(current.id);
    this.audit('equipment', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  getEquipment(id) {
    const equipmentId = positiveId(id, '设备');
    const row = this.db.prepare(`
      SELECT e.*, et.code AS type_code, et.name AS type_name,
             pos.id AS position_id, pos.code AS position_code, pos.name AS position_name,
             p.id AS process_id, p.name AS process_name, l.id AS line_id, l.name AS line_name,
             q.token AS qr_token
      FROM equipment e
      LEFT JOIN equipment_types et ON et.id=e.equipment_type_id
      LEFT JOIN equipment_installations i ON i.equipment_id = e.id AND i.removed_at IS NULL
      LEFT JOIN positions pos ON pos.id = i.position_id
      LEFT JOIN processes p ON p.id = pos.process_id
      LEFT JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN qr_mappings q ON q.target_type = 'EQUIPMENT' AND q.target_id = e.id AND q.status = 'ACTIVE'
      WHERE e.id = ?
    `).get(equipmentId);
    if (!row) throw new DomainError('设备不存在', 404, 'NOT_FOUND');
    return asObject(row);
  }

  // 把散在四张表里的设备历史聚合成一份履历：位置变动、维修工单、档案修改、统计摘要。
  equipmentHistory(id) {
    const equipment = this.getEquipment(id);
    const equipmentId = equipment.id;

    const installations = asObjects(this.db.prepare(`
      SELECT i.id, i.installed_at, i.removed_at,
             pos.code AS position_code, pos.name AS position_name,
             p.name AS process_name, l.name AS line_name, w.name AS workshop_name,
             c.change_no, c.action, c.reason, c.submitted_by, c.reviewed_by, c.reviewed_at
      FROM equipment_installations i
      JOIN positions pos ON pos.id = i.position_id
      JOIN processes p ON p.id = pos.process_id
      JOIN production_lines l ON l.id = p.line_id
      JOIN workshops w ON w.id = l.workshop_id
      LEFT JOIN composition_changes c ON c.id = i.change_request_id
      WHERE i.equipment_id = ?
      ORDER BY i.installed_at DESC, i.id DESC
    `).all(equipmentId));

    // 作为"被替换下来的旧设备"那次变动也要出现，所以两个外键都要匹配。
    const changes = asObjects(this.db.prepare(`
      SELECT c.*, e.code AS equipment_code, re.code AS replacement_equipment_code,
             fp.name AS from_position_name, tp.name AS to_position_name,
             CASE WHEN c.replacement_equipment_id = ? THEN 1 ELSE 0 END AS as_replacement
      FROM composition_changes c
      JOIN equipment e ON e.id = c.equipment_id
      LEFT JOIN equipment re ON re.id = c.replacement_equipment_id
      LEFT JOIN positions fp ON fp.id = c.from_position_id
      LEFT JOIN positions tp ON tp.id = c.to_position_id
      WHERE c.equipment_id = ? OR c.replacement_equipment_id = ?
      ORDER BY c.id DESC
    `).all(equipmentId, equipmentId, equipmentId));

    const workOrders = asObjects(this.db.prepare(`
      SELECT w.*, p.name AS process_name, l.name AS line_name,
             re.code AS reported_equipment_code, fe.code AS final_equipment_code,
             CASE WHEN w.final_equipment_id = ? THEN 0 ELSE 1 END AS reported_only
      FROM work_orders w
      JOIN processes p ON p.id = w.process_id
      JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN equipment re ON re.id = w.reported_equipment_id
      LEFT JOIN equipment fe ON fe.id = w.final_equipment_id
      WHERE w.final_equipment_id = ? OR w.reported_equipment_id = ?
      ORDER BY w.id DESC
    `).all(equipmentId, equipmentId, equipmentId));
    const partsByOrder = new Map();
    for (const part of asObjects(this.db.prepare(`
      SELECT * FROM work_order_parts WHERE work_order_id IN (
        SELECT id FROM work_orders WHERE final_equipment_id = ? OR reported_equipment_id = ?
      ) ORDER BY id
    `).all(equipmentId, equipmentId))) {
      partsByOrder.set(part.work_order_id, [...(partsByOrder.get(part.work_order_id) || []), part]);
    }
    const orderPhotos = this.attachmentsByTarget('WORK_ORDER', workOrders.map((item) => item.id));
    for (const order of workOrders) {
      order.parts = partsByOrder.get(order.id) || [];
      order.attachments = orderPhotos.get(order.id) || [];
      // 履历里带上评分：翻维修记录时能直接看出这次修得好不好。
      const review = this.workOrderReview(order.id);
      order.review_overall = review?.overall_score ?? null;
    }

    const patrols = asObjects(this.db.prepare(this.patrolQuery('WHERE r.equipment_id = ?')).all(equipmentId));
    const patrolPhotos = this.attachmentsByTarget('PATROL', patrols.map((item) => item.id));
    for (const patrol of patrols) patrol.attachments = patrolPhotos.get(patrol.id) || [];

    const audits = asObjects(this.db.prepare(`
      SELECT * FROM audit_logs WHERE entity_type='equipment' AND entity_id=? ORDER BY id DESC
    `).all(equipmentId));

    const owned = workOrders.filter((item) => !item.reported_only);
    const completed = owned.filter((item) => item.status === 'COMPLETED');
    const open = owned.filter((item) => !CLOSED_WORK_ORDER_STATUSES.includes(item.status));
    const currentInstallation = installations.find((item) => !item.removed_at) || null;
    const days = (from) => Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 86400000));

    return {
      equipment,
      summary: {
        work_orders: owned.length,
        completed_work_orders: completed.length,
        open_work_orders: open.length,
        downtime_work_orders: owned.filter((item) => item.is_downtime).length,
        total_downtime_minutes: owned.reduce((sum, item) => sum + (Number(item.downtime_minutes) || 0), 0),
        last_repair_at: completed[0]?.completed_at || null,
        parts_replaced: owned.reduce((sum, item) => sum + item.parts.length, 0),
        photos: owned.reduce((sum, item) => sum + item.attachments.length, 0)
          + patrols.reduce((sum, item) => sum + item.attachments.length, 0),
        patrols: patrols.length,
        last_patrol_at: patrols[0]?.patrolled_at || null,
        position_changes: changes.length,
        installed_days: currentInstallation ? days(currentInstallation.installed_at) : null,
        current_position: currentInstallation
          ? `${currentInstallation.line_name} / ${currentInstallation.process_name} / ${currentInstallation.position_name}`
          : null,
      },
      installations,
      changes,
      work_orders: workOrders,
      patrols,
      audits,
    };
  }

  resolveQr(token) {
    const mapping = this.db.prepare(`SELECT * FROM qr_mappings WHERE token = ? AND status = 'ACTIVE'`).get(token);
    if (!mapping) throw new DomainError('二维码不存在或已停用', 404, 'QR_NOT_FOUND');
    if (mapping.target_type === 'EQUIPMENT') {
      return { target_type: 'EQUIPMENT', target: this.getEquipment(mapping.target_id) };
    }
    const process = this.db.prepare(`
      SELECT p.*, l.name AS line_name FROM processes p
      JOIN production_lines l ON l.id = p.line_id WHERE p.id = ?
    `).get(mapping.target_id);
    return {
      target_type: 'PROCESS',
      target: asObject(process),
      equipment: this.db.prepare(`
        SELECT e.id, e.code, e.standard_name, e.alias, e.status, pos.name AS position_name
        FROM positions pos
        LEFT JOIN equipment_installations i ON i.position_id = pos.id AND i.removed_at IS NULL
        LEFT JOIN equipment e ON e.id = i.equipment_id
        WHERE pos.process_id = ? ORDER BY pos.sequence_no
      `).all(mapping.target_id).map(asObject),
    };
  }

  lineComposition(lineId, at) {
    const id = positiveId(lineId, '产线');
    this.ensure('production_lines', id, '产线不存在');
    const effectiveAt = at ? effectiveDate(at) : nowIso();
    return asObjects(this.db.prepare(`
      SELECT l.id AS line_id, l.code AS line_code, l.name AS line_name,
             p.id AS process_id, p.code AS process_code, p.name AS process_name,
             pos.id AS position_id, pos.code AS position_code, pos.name AS position_name,
             pos.critical AS position_critical,
             e.id AS equipment_id, e.code AS equipment_code, e.standard_name, e.alias,
             i.installed_at, i.removed_at
      FROM production_lines l
      JOIN processes p ON p.line_id = l.id
      JOIN positions pos ON pos.process_id = p.id
      LEFT JOIN equipment_installations i ON i.position_id = pos.id
        AND i.installed_at <= ? AND (i.removed_at IS NULL OR i.removed_at > ?)
      LEFT JOIN equipment e ON e.id = i.equipment_id
      WHERE l.id = ?
      ORDER BY p.sequence_no, p.code, pos.sequence_no, pos.code
    `).all(effectiveAt, effectiveAt, id));
  }

  createCompositionChange(input, context) {
    assertRole(context.role, [ROLES.PRODUCTION_SUPERVISOR, ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const action = assertChangeAction(requireText(input.action, '变动类型', 20).toUpperCase());
    const equipmentId = positiveId(input.equipment_id, '设备');
    this.ensure('equipment', equipmentId, '设备不存在');
    const current = this.activeInstallation(equipmentId);
    let fromPositionId = current ? current.position_id : null;
    let toPositionId = input.to_position_id ? positiveId(input.to_position_id, '目标机位') : null;
    let replacementId = input.replacement_equipment_id
      ? positiveId(input.replacement_equipment_id, '替换设备') : null;

    if (action === 'INSTALL' && current) throw new DomainError('设备当前已安装，应该提交移动申请', 409);
    if (action === 'INSTALL' && !toPositionId) throw new DomainError('安装必须选择目标机位', 400);
    if (action === 'MOVE' && !current) throw new DomainError('未安装设备不能提交移动申请', 409);
    if (action === 'MOVE' && !toPositionId) throw new DomainError('移动必须选择目标机位', 400);
    if (action === 'REMOVE' && !current) throw new DomainError('设备当前未安装', 409);
    if (action === 'REPLACE') {
      if (!current) throw new DomainError('被替换设备当前未安装', 409);
      if (!replacementId) throw new DomainError('必须选择替换后的设备', 400);
      if (replacementId === equipmentId) throw new DomainError('新旧设备不能相同', 400);
      this.ensure('equipment', replacementId, '替换设备不存在');
      if (this.activeInstallation(replacementId)) throw new DomainError('替换设备当前已安装', 409);
      toPositionId = current.position_id;
    }
    if (toPositionId) this.ensure('positions', toPositionId, '目标机位不存在');

    const effectiveAt = effectiveDate(input.effective_at);
    const reason = requireText(input.reason, '变动原因', 500);
    const sequence = nextSequence(this.db, 'change_sequence');
    const changeNo = `CHG-${String(sequence).padStart(6, '0')}`;
    const result = this.db.prepare(`
      INSERT INTO composition_changes(
        change_no, action, equipment_id, replacement_equipment_id, from_position_id,
        to_position_id, effective_at, reason, submitted_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(changeNo, action, equipmentId, replacementId, fromPositionId, toPositionId,
      effectiveAt, reason, context.actor, nowIso());
    const created = this.getCompositionChange(result.lastInsertRowid);
    this.audit('composition_change', created.id, 'SUBMIT', context.actor, null, created);
    return created;
  }

  listCompositionChanges() {
    return asObjects(this.db.prepare(`
      SELECT c.*, e.code AS equipment_code, e.standard_name AS equipment_name,
             re.code AS replacement_equipment_code, re.standard_name AS replacement_equipment_name,
             fp.name AS from_position_name, tp.name AS to_position_name
      FROM composition_changes c
      JOIN equipment e ON e.id = c.equipment_id
      LEFT JOIN equipment re ON re.id = c.replacement_equipment_id
      LEFT JOIN positions fp ON fp.id = c.from_position_id
      LEFT JOIN positions tp ON tp.id = c.to_position_id
      ORDER BY c.id DESC
    `).all());
  }

  reviewCompositionChange(id, input, context) {
    assertRole(context.role, [ROLES.EQUIPMENT_ADMIN, ROLES.ADMIN]);
    const change = this.getCompositionChange(id);
    if (change.status !== 'PENDING') throw new DomainError('该变动申请已经处理', 409);
    const decision = requireText(input.decision, '审核结果', 20).toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw new DomainError('审核结果无效', 400);
    if (decision === 'REJECTED') {
      const note = requireText(input.note, '驳回原因', 500);
      this.db.prepare(`
        UPDATE composition_changes SET status='REJECTED', reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?
      `).run(context.actor, nowIso(), note, change.id);
      const updated = this.getCompositionChange(change.id);
      this.audit('composition_change', change.id, 'REJECT', context.actor, change, updated);
      return updated;
    }

    return transaction(this.db, () => {
      this.applyCompositionChange(change);
      this.db.prepare(`
        UPDATE composition_changes SET status='APPROVED', reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?
      `).run(context.actor, nowIso(), optionalText(input.note, 500), change.id);
      const updated = this.getCompositionChange(change.id);
      this.audit('composition_change', change.id, 'APPROVE', context.actor, change, updated);
      return updated;
    });
  }

  applyCompositionChange(change) {
    const current = this.activeInstallation(change.equipment_id);
    const target = change.to_position_id ? this.activeEquipmentAtPosition(change.to_position_id) : null;
    if (change.action === 'INSTALL') {
      if (current) throw new DomainError('审核时发现设备已经安装，请驳回后重新提交', 409);
      if (target) throw new DomainError('审核时发现目标机位已被占用', 409);
      this.insertInstallation(change.equipment_id, change.to_position_id, change);
    } else if (change.action === 'MOVE') {
      if (!current || current.position_id !== change.from_position_id) {
        throw new DomainError('设备当前位置已经变化，请驳回后重新提交', 409);
      }
      if (target) throw new DomainError('目标机位已被占用', 409);
      this.closeInstallation(current.id, change.effective_at);
      this.insertInstallation(change.equipment_id, change.to_position_id, change);
    } else if (change.action === 'REMOVE') {
      if (!current || current.position_id !== change.from_position_id) {
        throw new DomainError('设备当前位置已经变化，请驳回后重新提交', 409);
      }
      this.closeInstallation(current.id, change.effective_at);
    } else if (change.action === 'REPLACE') {
      if (!current || current.position_id !== change.from_position_id) {
        throw new DomainError('被替换设备的位置已经变化', 409);
      }
      if (this.activeInstallation(change.replacement_equipment_id)) {
        throw new DomainError('替换设备已经安装在其他位置', 409);
      }
      this.closeInstallation(current.id, change.effective_at);
      this.insertInstallation(change.replacement_equipment_id, current.position_id, change);
    }
  }

  // 照片与工单在同一个事务里落地，避免"工单建好了照片没传上"。
  // 故障代码选填（见 resolveReportedFault），工序能从设备推出来时也不必让普工选。
  createWorkOrder(input, context) {
    assertRole(context.role, [ROLES.EMPLOYEE, ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const equipmentId = input.equipment_id ? positiveId(input.equipment_id, '设备') : null;
    if (equipmentId) this.ensure('equipment', equipmentId, '设备不存在');
    let processId = input.process_id ? positiveId(input.process_id, '工序') : null;
    if (processId) this.ensure('processes', processId, '工序不存在');
    // 扫码报修的常规路径：只有设备，工序按当前安装关系带出。设备还没装到机位上时推不出来，
    // 那就只能回头让人选——work_orders.process_id 是 NOT NULL，没有工序这单落不了地。
    if (!processId) processId = this.processIdForEquipment(equipmentId);
    if (!processId) {
      throw new DomainError(equipmentId
        ? '这台设备还没安装到任何机位上，请手动选择所属工序'
        : '请选择所属工序，或者直接扫设备上的二维码', 400, 'PROCESS_REQUIRED');
    }

    const fault = this.resolveReportedFault(input);
    const photos = Array.isArray(input.attachments) ? input.attachments : [];
    if (fault.code?.requires_photo && !photos.length) {
      throw new DomainError(`“${fault.code.symptom}”必须上传现场照片`, 400, 'PHOTO_REQUIRED');
    }

    const written = [];
    try {
      return transaction(this.db, () => {
        const sequence = this.nextSequenceInsideTransaction('work_order_sequence');
        const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
        const workOrderNo = `WO-${date}-${String(sequence).padStart(5, '0')}`;
        const now = nowIso();
        const result = this.db.prepare(`
          INSERT INTO work_orders(
            work_order_no, process_id, reported_equipment_id, final_equipment_id, reporter, reporter_user_id,
            reported_at, fault_location, fault_symptom, fault_code_id, urgency, is_downtime, description,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(workOrderNo, processId, equipmentId, equipmentId, context.actor, context.user_id || null, now,
          optionalText(input.fault_location, 200), fault.symptom, fault.code?.id || null,
          fault.urgency, fault.isDowntime, fault.description, now, now);
        const id = Number(result.lastInsertRowid);
        written.push(...this.storeAttachments('WORK_ORDER', id, photos, context));
        this.history(id, 'CREATED', null, 'SUBMITTED', context.actor, '提交报修', {
          fault_code: fault.code?.code || null, photos: photos.length,
        });
        this.syncEquipmentStatus(equipmentId, context);
        const created = this.getWorkOrder(id);
        this.audit('work_order', id, 'CREATE', context.actor, null, created.work_order);
        return created;
      });
    } catch (error) {
      for (const item of written) { try { fs.unlinkSync(item.absolute); } catch { /* 已经不在就算了 */ } }
      throw error;
    }
  }

  // 报修时的故障代码是**选填**的。2026-07-26 把录入点从报修挪到了结单：普工不必在
  // 三级分类里翻，到场看过的技术员分类本来就更准。这不是重新打开"只填自由文本"的旁路
  // ——旁路的危害是统计落空，所以 transitionWorkOrder 在结单前会强制要求补上故障码。
  resolveReportedFault(input) {
    const description = optionalText(input.description, 2000);
    if (!input.fault_code_id) {
      // 不选码就必须留一句话，否则这张工单对技术员没有任何信息量。
      if (!description) throw new DomainError('请用一句话说明哪里不对劲，或者直接选择故障代码', 400, 'DESCRIPTION_REQUIRED');
      return {
        code: null,
        symptom: description.slice(0, 500),
        description,
        urgency: String(input.urgency || 'NORMAL').toUpperCase(),
        isDowntime: input.is_downtime ? 1 : 0,
      };
    }
    const code = this.getFaultCode(input.fault_code_id);
    if (code.status !== 'ACTIVE') throw new DomainError('该故障代码已停用，请重新选择', 400, 'FAULT_CODE_DISABLED');
    // 故障码带默认值，但报修人显式选择的优先。
    const urgency = String(input.urgency || code.default_urgency || 'NORMAL').toUpperCase();
    return {
      code, description, urgency,
      symptom: this.faultSymptomText(code, description),
      isDowntime: (input.is_downtime || code.requires_downtime) ? 1 : 0,
    };
  }

  // fault_symptom 是给人看的那一行，工单列表、设备履历、审计日志全都直接显示它。
  // 兜底码「其他」用补充说明代替，免得列表里排出一整列"其他"。
  faultSymptomText(code, description) {
    if (code.code !== FALLBACK_FAULT_CODE) return `${code.category} / ${code.part} / ${code.symptom}`;
    if (!description) throw new DomainError('选择“其他”时必须描述具体故障', 400, 'DESCRIPTION_REQUIRED');
    return description.slice(0, 500);
  }

  // 设备装在哪个机位、机位属于哪个工序，安装关系里就有——不必再让人选一遍。
  processIdForEquipment(equipmentId) {
    if (!equipmentId) return null;
    const installed = this.db.prepare(`
      SELECT pos.process_id FROM equipment_installations i
      JOIN positions pos ON pos.id = i.position_id
      WHERE i.equipment_id = ? AND i.removed_at IS NULL
    `).get(Number(equipmentId));
    return installed?.process_id || null;
  }

  // 普工只看得到自己报修的工单；技术员和管理员看全部。
  listWorkOrders(context = null) {
    const ownOnly = context && Number(context.level) === LEVELS.WORKER;
    return asObjects(this.db.prepare(`
      SELECT w.*, p.name AS process_name, l.name AS line_name,
             re.code AS reported_equipment_code, re.standard_name AS reported_equipment_name,
             fe.code AS final_equipment_code, fe.standard_name AS final_equipment_name,
             CASE WHEN rv.id IS NULL THEN 0 ELSE 1 END AS has_review,
             ow.work_order_no AS reopened_from_work_order_no
      FROM work_orders w
      LEFT JOIN work_order_reviews rv ON rv.work_order_id = w.id
      LEFT JOIN work_orders ow ON ow.id = w.reopened_from_work_order_id
      JOIN processes p ON p.id = w.process_id
      JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN equipment re ON re.id = w.reported_equipment_id
      LEFT JOIN equipment fe ON fe.id = w.final_equipment_id
      ${ownOnly ? 'WHERE w.reporter_user_id = ?' : ''}
      ORDER BY w.id DESC
    `).all(...(ownOnly ? [Number(context.user_id) || 0] : [])));
  }

  // 安卓通知栏只需要待接单摘要，不把整张工单、照片和维修历史反复传到手机。
  // 这个队列只给二级技术员；管理员仍在系统内派单，不跟技术员抢通知。
  pendingRepairNotifications(context) {
    assertRole(context.role, [ROLES.TECHNICIAN]);
    return asObjects(this.db.prepare(`
      SELECT w.id, w.work_order_no, w.reported_at, w.urgency, w.is_downtime,
             w.fault_symptom, w.description, p.name AS process_name, l.name AS line_name,
             e.code AS equipment_code, e.standard_name AS equipment_name, e.alias AS equipment_alias
      FROM work_orders w
      JOIN processes p ON p.id = w.process_id
      JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN equipment e ON e.id = w.reported_equipment_id
      WHERE w.status = 'SUBMITTED'
      ORDER BY w.id
    `).all());
  }

  // context为null表示服务内部调用，不做可见性过滤；HTTP路由一律传入调用者上下文。
  getWorkOrder(id, context = null) {
    const workOrderId = positiveId(id, '工单');
    const workOrder = this.db.prepare(`
      SELECT w.*, p.name AS process_name, l.name AS line_name,
             re.code AS reported_equipment_code, re.standard_name AS reported_equipment_name,
             fe.code AS final_equipment_code, fe.standard_name AS final_equipment_name
      FROM work_orders w
      JOIN processes p ON p.id = w.process_id
      JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN equipment re ON re.id = w.reported_equipment_id
      LEFT JOIN equipment fe ON fe.id = w.final_equipment_id
      WHERE w.id = ?
    `).get(workOrderId);
    if (!workOrder) throw new DomainError('维修工单不存在', 404, 'NOT_FOUND');
    if (context && Number(context.level) === LEVELS.WORKER && workOrder.reporter_user_id !== context.user_id) {
      throw new DomainError('只能查看自己报修的工单', 403, 'FORBIDDEN');
    }
    // 评价对技术员一律不可见——他只能在自己的汇总里看到综合分。
    const review = this.workOrderReview(workOrderId);
    const canSeeReview = !context || context.role === ROLES.ADMIN
      || (review && review.reviewer_user_id === context.user_id);
    return {
      work_order: asObject(workOrder),
      parts: asObjects(this.db.prepare('SELECT * FROM work_order_parts WHERE work_order_id = ? ORDER BY id').all(workOrderId)),
      history: asObjects(this.db.prepare('SELECT * FROM work_order_history WHERE work_order_id = ? ORDER BY id').all(workOrderId)),
      attachments: this.listAttachments('WORK_ORDER', workOrderId),
      review: canSeeReview ? review : null,
      has_review: Boolean(review),
    };
  }

  // 技术员只能给自己接单（抢单），管理员可以指派给任意技术员，也可以中途转派。
  // 接单一律走这里，不走 transitionWorkOrder——状态机里 SUBMITTED 只能到 CANCELLED。
  assignWorkOrder(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const current = this.getWorkOrder(id).work_order;
    if (CLOSED_WORK_ORDER_STATUSES.includes(current.status)) {
      throw new DomainError('已结束的工单不能再接单或转派', 409);
    }
    const selfClaim = context.role === ROLES.TECHNICIAN;
    // 技术员只能从待接单池里抢。已经有人在处理的单要换人，必须由管理员转派——
    // 否则"这次到底是谁修的"和报修人的评价归属就串了。
    if (selfClaim && current.status !== 'SUBMITTED') {
      throw new DomainError(current.assignee
        ? `该工单已由${current.assignee}负责，需要接手请让管理员转派`
        : '该工单已经在处理中', 409, 'ALREADY_ASSIGNED');
    }
    let assigneeUserId = input.assignee_user_id ? positiveId(input.assignee_user_id, '技术员') : null;
    let assignee;
    if (selfClaim) {
      if (assigneeUserId && assigneeUserId !== context.user_id) {
        throw new DomainError('技术员只能自己接单，指派他人请联系管理员', 403, 'FORBIDDEN');
      }
      if (input.assignee && input.assignee !== context.actor) {
        throw new DomainError('技术员只能自己接单，指派他人请联系管理员', 403, 'FORBIDDEN');
      }
      assigneeUserId = context.user_id || null;
      assignee = requireText(context.actor, '技术员', 80);
    } else if (assigneeUserId) {
      const target = this.publicUser(assigneeUserId);
      if (target.status !== 'ACTIVE') throw new DomainError('该成员已停用，不能接单', 409, 'ACCOUNT_DISABLED');
      if (Number(target.level) < LEVELS.TECHNICIAN) throw new DomainError('只能指派给技术员或管理员', 400, 'VALIDATION_ERROR');
      assignee = target.display_name;
    } else {
      assignee = requireText(input.assignee, '技术员', 80);
    }
    // 从待接单池接走 → 已接单。转派一张已经在修的单时保持它当前的阶段不动，
    // 换个人不该把工单退回到"还没到场"。
    const nextStatus = current.status === 'SUBMITTED' ? 'ACCEPTED' : current.status;
    const time = nowIso();
    // 首次接单的时刻。转派不覆盖——"报修到有人接"这段时长要按第一个接手的人算。
    this.db.prepare('UPDATE work_orders SET assignee=?, assignee_user_id=?, status=?, updated_at=?, assigned_at=COALESCE(assigned_at, ?) WHERE id=?')
      .run(assignee, assigneeUserId, nextStatus, time, time, current.id);
    this.history(current.id, current.status === 'SUBMITTED' ? (selfClaim ? 'CLAIMED' : 'ASSIGNED') : 'REASSIGNED',
      current.status, nextStatus, context.actor, optionalText(input.note, 500), { assignee });
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'ASSIGN', context.actor, current, updated.work_order);
    return updated;
  }

  // 推进工单的人必须是接单人本人，管理员不受限。别人想接手要先让管理员转派（会留痕）。
  assertOwnWorkOrder(current, context, action) {
    if (context.role === ROLES.ADMIN) return;
    if (!current.assignee_user_id) {
      // assignee 是纯文本的情况：账号体系之前留下的老数据，或管理员用接口按姓名指派。
      // 界面上的指派下拉必选真实账号，所以正常路径不会走到这儿。
      throw new DomainError(current.assignee
        ? `${current.assignee}没有关联系统账号，请让管理员重新指派后再${action}`
        : `这张工单还没有人接单，不能${action}`, 409, 'NOT_ASSIGNED');
    }
    if (current.assignee_user_id !== context.user_id) {
      throw new DomainError(`这张工单由${current.assignee}负责，需要接手请让管理员转派`, 403, 'NOT_ASSIGNEE');
    }
  }

  // 到场之前判断不了是哪台设备、什么故障，更不会用掉零件。管理员不受限——
  // 把明显的误报在派单前改掉是合理的。
  assertArrived(current, context, action) {
    if (CLOSED_WORK_ORDER_STATUSES.includes(current.status)) {
      throw new DomainError(`已结束工单不能${action}`, 409);
    }
    if (context.role === ROLES.ADMIN) return;
    if (!POST_ARRIVAL_STATUSES.includes(current.status)) {
      throw new DomainError(`要先到现场（把工单推进到「已到场」）才能${action}`, 409, 'NOT_ARRIVED');
    }
    this.assertOwnWorkOrder(current, context, action);
  }

  transitionWorkOrder(id, input, context) {
    const current = this.getWorkOrder(id).work_order;
    const to = requireText(input.to_status, '目标状态', 30).toUpperCase();
    assertWorkOrderTransition(current.status, to);
    // 结单权限 2026-07-26 从管理员下放给技术员：验收改由报修人的评价承担。
    // 取消仍然只有管理员能做——普工要撤销自己的报修走 withdrawWorkOrder。
    if (to === 'CANCELLED') assertRole(context.role, [ROLES.ADMIN]);
    else {
      assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
      // 谁接的单谁推进。否则张三接的单李四能一路点到结单，工单上的负责人和
      // 报修人的评价却都算在张三头上。
      this.assertOwnWorkOrder(current, context, '推进这张工单');
    }
    const note = optionalText(input.note, 1000);
    if (current.status === 'PENDING_REVIEW' && to === 'IN_PROGRESS' && !note) {
      throw new DomainError('审核退回必须填写原因', 400);
    }
    if (to === 'COMPLETED' && !current.trial_result) {
      throw new DomainError('完成工单前必须填写试运行结果', 409);
    }
    // 工单不挂设备就结掉，设备状态联动、维修履历和 MTBF 之类的统计全都落空。
    // 报修时允许"无法判断具体设备"，但修完了技术员一定知道自己修的是哪台。
    if (to === 'COMPLETED' && !current.final_equipment_id) {
      throw new DomainError(
        '完成工单前必须先用「修正故障设备」指明这次实际维修的是哪台设备，否则这次维修记不到任何设备账上',
        409, 'EQUIPMENT_REQUIRED');
    }
    // 报修时不再强制选故障代码（普工不必在三级分类里翻），代价必须在这里收回来：
    // 结单前一定要有码，否则故障统计等于没做。
    if (to === 'COMPLETED' && !current.fault_code_id) {
      throw new DomainError(
        '完成工单前必须用「确认故障分类」选出这次的故障代码，否则这次故障进不了任何统计',
        409, 'FAULT_CODE_REQUIRED');
    }
    const time = nowIso();
    let extraSql = '';
    const params = [to, time];
    if (to === 'IN_PROGRESS' && !current.started_at) {
      extraSql += ', started_at=?';
      params.push(time);
    }
    if (to === 'ARRIVED' && !current.arrived_at) {
      extraSql += ', arrived_at=?';
      params.push(time);
    }
    if (to === 'COMPLETED') {
      extraSql += ', completed_at=?';
      params.push(time);
    }
    params.push(current.id);
    this.db.prepare(`UPDATE work_orders SET status=?, updated_at=? ${extraSql} WHERE id=?`).run(...params);
    this.history(current.id, 'STATUS_CHANGED', current.status, to, context.actor, note, null);
    this.syncEquipmentStatus(current.final_equipment_id, context);
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'STATUS_CHANGE', context.actor, current, updated.work_order);
    return updated;
  }

  updateRepairDetail(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.ADMIN]);
    const current = this.getWorkOrder(id).work_order;
    this.assertArrived(current, context, '填写维修记录');
    this.db.prepare(`
      UPDATE work_orders SET diagnosis=?, root_cause=?, repair_action=?, trial_result=?,
        downtime_minutes=?, updated_at=? WHERE id=?
    `).run(optionalText(input.diagnosis, 2000), optionalText(input.root_cause, 2000),
      optionalText(input.repair_action, 3000), optionalText(input.trial_result, 2000),
      input.downtime_minutes === '' || input.downtime_minutes === undefined ? null : Number(input.downtime_minutes),
      nowIso(), current.id);
    this.history(current.id, 'REPAIR_DETAIL_UPDATED', current.status, current.status,
      context.actor, optionalText(input.note, 500), input);
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'UPDATE_REPAIR_DETAIL', context.actor, current, updated.work_order);
    return updated;
  }

  correctWorkOrderEquipment(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const current = this.getWorkOrder(id).work_order;
    this.assertArrived(current, context, '修正故障设备');
    const equipmentId = positiveId(input.equipment_id, '正确设备');
    this.ensure('equipment', equipmentId, '设备不存在');
    const reason = requireText(input.reason, '修正原因', 500);
    this.db.prepare('UPDATE work_orders SET final_equipment_id=?, updated_at=? WHERE id=?')
      .run(equipmentId, nowIso(), current.id);
    this.history(current.id, 'EQUIPMENT_CORRECTED', current.status, current.status, context.actor, reason,
      { from_equipment_id: current.final_equipment_id, to_equipment_id: equipmentId });
    // 新旧两台都要重算：否则被改错的那台会永远卡在维修中。
    this.syncEquipmentStatus(current.final_equipment_id, context);
    this.syncEquipmentStatus(equipmentId, context);
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'CORRECT_EQUIPMENT', context.actor, current, updated.work_order);
    return updated;
  }

  // 技术员到场后确认故障分类。普工报修时可以不选码，结单前必须由看过现场的人补上。
  classifyWorkOrder(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const current = this.getWorkOrder(id).work_order;
    this.assertArrived(current, context, '确认故障分类');
    if (!input.fault_code_id) throw new DomainError('请选择故障代码', 400, 'FAULT_CODE_REQUIRED');
    const code = this.getFaultCode(input.fault_code_id);
    if (code.status !== 'ACTIVE') throw new DomainError('该故障代码已停用，请重新选择', 400, 'FAULT_CODE_DISABLED');
    // 兜底码「其他」要有文字才知道是什么故障，工单上原有的补充说明可以直接用。
    const symptom = this.faultSymptomText(code, optionalText(input.description, 2000) || current.description);
    this.db.prepare('UPDATE work_orders SET fault_code_id=?, fault_symptom=?, updated_at=? WHERE id=?')
      .run(code.id, symptom, nowIso(), current.id);
    this.history(current.id, 'FAULT_CLASSIFIED', current.status, current.status, context.actor,
      optionalText(input.note, 500) || `确认为 ${symptom}`,
      { from_fault_code_id: current.fault_code_id, to_fault_code_id: code.id, fault_code: code.code });
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'CLASSIFY_FAULT', context.actor, current, updated.work_order);
    return updated;
  }

  // 报修界面上的"常用故障"快捷按钮：先按这台设备所属类型的历史频次排。
  // 刚上线时一张工单都没有，频次表是空的，所以回退到管理员标了 is_common 的那几条
  // ——否则第一天打开报修页会是一排空按钮。兜底码「其他」不进快捷按钮：点了它还要
  // 再填一段文字，和"不选码直接写一句话"这条默认路径完全重复。
  frequentFaultCodes(equipmentId, limit = 6) {
    const equipment = equipmentId ? this.rowById('equipment', positiveId(equipmentId, '设备')) : null;
    const typeId = equipment?.equipment_type_id || null;
    const ranked = asObjects(this.db.prepare(`
      SELECT f.*, COUNT(w.id) AS use_count
      FROM fault_codes f
      JOIN work_orders w ON w.fault_code_id = f.id
      ${typeId ? 'JOIN equipment e ON e.id = COALESCE(w.final_equipment_id, w.reported_equipment_id) AND e.equipment_type_id = ?' : ''}
      WHERE f.status = 'ACTIVE' AND f.code != ?
      GROUP BY f.id ORDER BY use_count DESC, f.sort_order LIMIT ?
    `).all(...(typeId ? [typeId] : []), FALLBACK_FAULT_CODE, limit));

    if (ranked.length >= limit) return ranked;
    const seen = new Set(ranked.map((item) => item.id));
    const fallback = asObjects(this.db.prepare(`
      SELECT f.*, 0 AS use_count FROM fault_codes f
      WHERE f.status = 'ACTIVE' AND f.code != ?
        AND (f.equipment_type_id IS NULL OR f.equipment_type_id = ?)
      ORDER BY f.is_common DESC,
               CASE WHEN f.equipment_type_id IS NULL THEN 1 ELSE 0 END,
               f.sort_order
      LIMIT ?
    `).all(FALLBACK_FAULT_CODE, typeId, limit));
    return [...ranked, ...fallback.filter((item) => !seen.has(item.id))].slice(0, limit);
  }

  addWorkOrderPart(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.ADMIN]);
    const current = this.getWorkOrder(id).work_order;
    this.assertArrived(current, context, '记录使用零件');
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new DomainError('零件数量必须大于0', 400);
    const result = this.db.prepare(`
      INSERT INTO work_order_parts(
        work_order_id, part_name, specification, quantity, unit, part_condition, source,
        old_part_disposition, part_code, unit_cost, recorded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(current.id, requireText(input.part_name, '零件名称', 120), optionalText(input.specification, 200),
      quantity, requireText(input.unit || '个', '单位', 20), input.part_condition || 'NEW',
      optionalText(input.source, 100), optionalText(input.old_part_disposition, 200),
      optionalText(input.part_code, 80), input.unit_cost === '' || input.unit_cost === undefined ? null : Number(input.unit_cost),
      context.actor, nowIso());
    const part = asObject(this.db.prepare('SELECT * FROM work_order_parts WHERE id=?').get(result.lastInsertRowid));
    this.history(current.id, 'PART_ADDED', current.status, current.status, context.actor, null, part);
    this.audit('work_order_part', part.id, 'CREATE', context.actor, null, part);
    return part;
  }

  // ---- 撤回 / 评价 / 重新报修 ----

  // 报修人自己撤销误报。权限按"是不是本人"判，不按级别——技术员也会报修。
  withdrawWorkOrder(id, input, context) {
    const current = this.getWorkOrder(id).work_order;
    const isReporter = current.reporter_user_id && current.reporter_user_id === context.user_id;
    if (!isReporter && context.role !== ROLES.ADMIN) {
      throw new DomainError('只能撤回自己提交的报修', 403, 'FORBIDDEN');
    }
    if (!WITHDRAWABLE_STATUSES.includes(current.status)) {
      throw new DomainError(
        CLOSED_WORK_ORDER_STATUSES.includes(current.status)
          ? '该工单已经结束，不能撤回'
          : '技术员已经到场，不能再撤回，请直接和技术员说明',
        409, 'NOT_WITHDRAWABLE');
    }
    const reason = requireText(input.reason, '撤回原因', 500);
    const time = nowIso();
    this.db.prepare('UPDATE work_orders SET status=?, updated_at=? WHERE id=?').run('CANCELLED', time, current.id);
    // 事件类型用 WITHDRAWN 而不是普通流转，事后要能分清"普工自己撤的"和"管理员取消的"。
    this.history(current.id, 'WITHDRAWN', current.status, 'CANCELLED', context.actor, reason, null);
    this.syncEquipmentStatus(current.final_equipment_id, context);
    const updated = this.getWorkOrder(current.id);
    this.audit('work_order', current.id, 'WITHDRAW', context.actor, current, updated.work_order);
    return updated;
  }

  // 报修人对已完成的工单打分。一单一评，可以改。
  reviewWorkOrder(id, input, context) {
    const current = this.getWorkOrder(id).work_order;
    const isReporter = current.reporter_user_id && current.reporter_user_id === context.user_id;
    if (!isReporter) throw new DomainError('只有报修人本人可以评价这次维修', 403, 'FORBIDDEN');
    if (current.status !== 'COMPLETED') throw new DomainError('工单完成之后才能评价', 409, 'NOT_COMPLETED');

    const scores = {};
    for (const dimension of REVIEW_DIMENSIONS) {
      scores[dimension.key] = assertReviewScore(input[`${dimension.key}_score`], dimension.name);
    }
    const comment = optionalText(input.comment, 1000);
    const existing = asObject(this.db.prepare('SELECT * FROM work_order_reviews WHERE work_order_id=?').get(current.id));
    const now = nowIso();
    if (existing) {
      this.db.prepare(`
        UPDATE work_order_reviews SET quality_score=?, attitude_score=?, speed_score=?, comment=?, updated_at=?
        WHERE work_order_id=?
      `).run(scores.quality, scores.attitude, scores.speed, comment, now, current.id);
    } else {
      this.db.prepare(`
        INSERT INTO work_order_reviews(work_order_id, reviewer, reviewer_user_id, technician, technician_user_id,
          quality_score, attitude_score, speed_score, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(current.id, context.actor, context.user_id || null,
        // 技术员姓名做快照：他离职停用之后，历史评价和综合分仍然要算得出来。
        current.assignee || null, current.assignee_user_id || null,
        scores.quality, scores.attitude, scores.speed, comment, now, now);
    }
    const review = this.workOrderReview(current.id);
    // 工单历史对技术员可见，所以这里**绝对不能**写入评分和评论——
    // 否则接口层把 review 剥成 null 也没用，内容会从时间线里漏出去。
    this.history(current.id, existing ? 'REVIEW_UPDATED' : 'REVIEWED', current.status, current.status,
      context.actor, '报修人已提交评价', null);
    this.audit('work_order_review', review.id, existing ? 'UPDATE' : 'CREATE', context.actor, existing, review);
    return review;
  }

  workOrderReview(workOrderId) {
    const row = asObject(this.db.prepare(`
      SELECT * FROM work_order_reviews WHERE work_order_id=?
    `).get(Number(workOrderId)));
    return row ? { ...row, overall_score: reviewOverall(row) } : null;
  }

  // 技术员只能看自己的综合分。只认会话里的 user_id，不接受任何入参指定别人。
  myReviewSummary(context) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS review_count, AVG(quality_score) AS quality,
             AVG(attitude_score) AS attitude, AVG(speed_score) AS speed
      FROM work_order_reviews WHERE technician_user_id = ?
    `).get(Number(context.user_id) || 0);
    return summarizeReviewRow({ ...row, technician_user_id: context.user_id, technician: context.actor });
  }

  listReviews(context) {
    assertRole(context.role, [ROLES.ADMIN]);
    return asObjects(this.db.prepare(`
      SELECT r.*, w.work_order_no, w.fault_symptom, w.completed_at,
             e.code AS equipment_code, e.standard_name AS equipment_name,
             p.name AS process_name, l.name AS line_name
      FROM work_order_reviews r
      JOIN work_orders w ON w.id = r.work_order_id
      LEFT JOIN equipment e ON e.id = w.final_equipment_id
      LEFT JOIN processes p ON p.id = w.process_id
      LEFT JOIN production_lines l ON l.id = p.line_id
      ORDER BY r.id DESC
    `).all()).map((row) => ({ ...row, overall_score: reviewOverall(row) }));
  }

  technicianRanking(context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const rows = this.db.prepare(`
      SELECT r.technician_user_id, COUNT(*) AS review_count,
             AVG(r.quality_score) AS quality, AVG(r.attitude_score) AS attitude, AVG(r.speed_score) AS speed,
             MAX(COALESCE(u.display_name, r.technician)) AS technician,
             MAX(u.status) AS technician_status
      FROM work_order_reviews r
      LEFT JOIN users u ON u.id = r.technician_user_id
      GROUP BY r.technician_user_id
    `).all().map((row) => summarizeReviewRow(row));
    return rows.sort((a, b) => b.overall - a.overall || b.review_count - a.review_count);
  }

  // 没修好可以从已完成的工单直接重新报修，新单继承原单的设备和故障码。
  reopenWorkOrder(id, input, context) {
    const original = this.getWorkOrder(id).work_order;
    const isReporter = original.reporter_user_id && original.reporter_user_id === context.user_id;
    if (!isReporter && context.role !== ROLES.ADMIN) {
      throw new DomainError('只能对自己报修的工单发起重新报修', 403, 'FORBIDDEN');
    }
    if (original.status !== 'COMPLETED') {
      throw new DomainError('只有已完成的工单才能重新报修；未完成的工单请直接联系技术员', 409, 'NOT_COMPLETED');
    }
    const created = this.createWorkOrder({
      process_id: original.process_id,
      equipment_id: original.final_equipment_id || original.reported_equipment_id,
      fault_code_id: input.fault_code_id || original.fault_code_id,
      fault_location: input.fault_location ?? original.fault_location,
      urgency: input.urgency,
      is_downtime: input.is_downtime,
      description: optionalText(input.description, 2000)
        || `${original.work_order_no} 修复后问题再次出现`,
      attachments: input.attachments,
    }, context);
    this.db.prepare('UPDATE work_orders SET reopened_from_work_order_id=? WHERE id=?')
      .run(original.id, created.work_order.id);
    this.history(original.id, 'REOPENED', original.status, original.status, context.actor,
      `已重新报修：${created.work_order.work_order_no}`,
      { new_work_order_id: created.work_order.id, new_work_order_no: created.work_order.work_order_no });
    this.audit('work_order', created.work_order.id, 'REOPEN', context.actor, null,
      { from_work_order_id: original.id, from_work_order_no: original.work_order_no });
    return { original: this.getWorkOrder(original.id).work_order, work_order: this.getWorkOrder(created.work_order.id).work_order };
  }

  // ---- 巡检 ----
  // 技术员每天到现场转：扫码选设备 → 拍照 → 写清发现了什么问题、怎么解决的。
  // 不是旧系统那种逐项打勾的巡检表，刻意做得很轻，否则没人愿意每天填。

  createPatrolRecord(input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const equipmentId = input.equipment_id ? positiveId(input.equipment_id, '设备') : null;
    if (equipmentId) this.ensure('equipment', equipmentId, '设备不存在');
    let processId = input.process_id ? positiveId(input.process_id, '工序') : null;
    if (processId) this.ensure('processes', processId, '工序不存在');
    if (!equipmentId && !processId) throw new DomainError('请先扫码或选择巡检的设备', 400, 'VALIDATION_ERROR');
    // 只给了设备时，把它当前所在的工序一并记下来，方便按产线统计。
    if (!processId) processId = this.processIdForEquipment(equipmentId);
    const findings = requireText(input.findings, '巡检发现', 2000);
    const photos = Array.isArray(input.attachments) ? input.attachments : [];

    const written = [];
    try {
      return transaction(this.db, () => {
        const sequence = this.nextSequenceInsideTransaction('patrol_sequence');
        const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
        const patrolNo = `PT-${date}-${String(sequence).padStart(5, '0')}`;
        const now = nowIso();
        const result = this.db.prepare(`
          INSERT INTO patrol_records(patrol_no, equipment_id, process_id, patroller, patroller_user_id,
            findings, has_issue, patrolled_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(patrolNo, equipmentId, processId, context.actor, context.user_id || null,
          findings, input.has_issue ? 1 : 0, now, now);
        const id = Number(result.lastInsertRowid);
        written.push(...this.storeAttachments('PATROL', id, photos, context));
        const created = this.getPatrolRecord(id);
        this.audit('patrol_record', id, 'CREATE', context.actor, null, created);
        return created;
      });
    } catch (error) {
      for (const item of written) { try { fs.unlinkSync(item.absolute); } catch { /* 已经不在就算了 */ } }
      throw error;
    }
  }

  patrolQuery(where = '') {
    return `
      SELECT r.*, e.code AS equipment_code, e.standard_name AS equipment_name,
             p.name AS process_name, l.name AS line_name, w.work_order_no
      FROM patrol_records r
      LEFT JOIN equipment e ON e.id = r.equipment_id
      LEFT JOIN processes p ON p.id = r.process_id
      LEFT JOIN production_lines l ON l.id = p.line_id
      LEFT JOIN work_orders w ON w.id = r.work_order_id
      ${where}
      ORDER BY r.id DESC
    `;
  }

  listPatrolRecords(context = null) {
    if (context && Number(context.level) === LEVELS.WORKER) {
      throw new DomainError('当前级别无权查看巡检记录', 403, 'FORBIDDEN');
    }
    const rows = asObjects(this.db.prepare(this.patrolQuery()).all());
    const photos = this.attachmentsByTarget('PATROL', rows.map((item) => item.id));
    for (const row of rows) row.attachments = photos.get(row.id) || [];
    return rows;
  }

  getPatrolRecord(id) {
    const row = asObject(this.db.prepare(this.patrolQuery('WHERE r.id = ?')).get(positiveId(id, '巡检记录')));
    if (!row) throw new DomainError('巡检记录不存在', 404, 'NOT_FOUND');
    row.attachments = this.listAttachments('PATROL', row.id);
    return row;
  }

  // 现场没能当场解决的，直接从巡检记录开一张工单，双向关联。
  convertPatrolToWorkOrder(id, input, context) {
    assertRole(context.role, [ROLES.TECHNICIAN, ROLES.PRODUCTION_SUPERVISOR, ROLES.ADMIN]);
    const patrol = this.getPatrolRecord(id);
    if (patrol.work_order_id) throw new DomainError('该巡检记录已经转过维修工单', 409, 'ALREADY_CONVERTED');
    if (!patrol.process_id) throw new DomainError('该巡检记录没有关联工序，无法转维修', 409, 'VALIDATION_ERROR');
    const created = this.createWorkOrder({
      process_id: patrol.process_id,
      equipment_id: patrol.equipment_id,
      fault_code_id: input.fault_code_id,
      fault_location: input.fault_location,
      urgency: input.urgency,
      is_downtime: input.is_downtime,
      description: input.description || `由巡检 ${patrol.patrol_no} 转入：${patrol.findings}`,
    }, context);
    this.db.prepare('UPDATE patrol_records SET work_order_id=?, has_issue=1 WHERE id=?')
      .run(created.work_order.id, patrol.id);
    this.history(created.work_order.id, 'FROM_PATROL', null, 'SUBMITTED', context.actor,
      `来自巡检 ${patrol.patrol_no}`, { patrol_id: patrol.id, patrol_no: patrol.patrol_no });
    this.audit('patrol_record', patrol.id, 'CONVERT_TO_WORK_ORDER', context.actor, patrol,
      { work_order_id: created.work_order.id, work_order_no: created.work_order.work_order_no });
    return { patrol: this.getPatrolRecord(patrol.id), work_order: created.work_order };
  }

  // ---- 故障代码（故障类别 → 故障部位 → 故障现象）----

  listFaultCodes({ includeDisabled = false } = {}) {
    const rows = asObjects(this.db.prepare(`
      SELECT f.*, et.code AS equipment_type_code, et.name AS equipment_type_name,
             (SELECT COUNT(*) FROM work_orders w WHERE w.fault_code_id = f.id) AS work_order_count
      FROM fault_codes f
      LEFT JOIN equipment_types et ON et.id = f.equipment_type_id
      ${includeDisabled ? '' : `WHERE f.status='ACTIVE'`}
      ORDER BY f.sort_order, f.id
    `).all());
    // 同时返回分组结构，前端的三级级联下拉直接用，不必在浏览器里再分一遍组。
    const categories = [];
    for (const row of rows) {
      if (row.status !== 'ACTIVE' && !includeDisabled) continue;
      let category = categories.find((item) => item.category === row.category);
      if (!category) categories.push(category = { category: row.category, parts: [] });
      let part = category.parts.find((item) => item.part === row.part);
      if (!part) category.parts.push(part = { part: row.part, symptoms: [] });
      part.symptoms.push(row);
    }
    return { codes: rows, categories };
  }

  getFaultCode(id) {
    const row = this.db.prepare('SELECT * FROM fault_codes WHERE id=?').get(positiveId(id, '故障代码'));
    if (!row) throw new DomainError('故障代码不存在', 404, 'NOT_FOUND');
    return asObject(row);
  }

  createFaultCode(input, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const payload = this.normalizeFaultCodeInput(input);
    const now = nowIso();
    try {
      const result = this.db.prepare(`
        INSERT INTO fault_codes(code, category, part, symptom, suggested_action, default_urgency,
          requires_downtime, requires_photo, is_common, equipment_type_id, status, is_seeded, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?)
      `).run(payload.code, payload.category, payload.part, payload.symptom, payload.suggested_action,
        payload.default_urgency, payload.requires_downtime, payload.requires_photo, payload.is_common,
        payload.equipment_type_id,
        Number(this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM fault_codes').get().next),
        now, now);
      const created = this.getFaultCode(result.lastInsertRowid);
      this.audit('fault_code', created.id, 'CREATE', context.actor, null, created);
      return created;
    } catch (error) {
      this.rethrowConstraint(error, '相同的故障代码或“类别+部位+现象”组合已存在');
    }
  }

  updateFaultCode(id, input, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const current = this.getFaultCode(id);
    const payload = this.normalizeFaultCodeInput({ ...current, ...input }, current.code);
    const status = String(input.status || current.status).toUpperCase();
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new DomainError('故障代码状态无效', 400, 'VALIDATION_ERROR');
    try {
      this.db.prepare(`
        UPDATE fault_codes SET category=?, part=?, symptom=?, suggested_action=?, default_urgency=?,
          requires_downtime=?, requires_photo=?, is_common=?, equipment_type_id=?, status=?, is_seeded=0, updated_at=? WHERE id=?
      `).run(payload.category, payload.part, payload.symptom, payload.suggested_action, payload.default_urgency,
        payload.requires_downtime, payload.requires_photo, payload.is_common, payload.equipment_type_id, status, nowIso(), current.id);
      const updated = this.getFaultCode(current.id);
      this.audit('fault_code', current.id, 'UPDATE', context.actor, current, updated);
      return updated;
    } catch (error) {
      this.rethrowConstraint(error, '相同的“类别+部位+现象”组合已存在');
    }
  }

  deleteFaultCode(id, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const current = this.getFaultCode(id);
    // 已经被工单引用的不能删，否则历史工单的故障归类就断了；改成停用即可。
    const used = Number(this.db.prepare('SELECT COUNT(*) AS count FROM work_orders WHERE fault_code_id=?').get(current.id).count);
    if (used) throw new DomainError(`该故障代码已被${used}张工单使用，只能停用不能删除`, 409, 'FAULT_CODE_IN_USE');
    this.db.prepare('DELETE FROM fault_codes WHERE id=?').run(current.id);
    this.audit('fault_code', current.id, 'DELETE', context.actor, current, null);
    return current;
  }

  normalizeFaultCodeInput(input, existingCode = null) {
    const code = existingCode || requireText(input.code, '故障代码', 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code)) {
      throw new DomainError('故障代码只能使用大写字母、数字和连字符', 400, 'VALIDATION_ERROR');
    }
    const urgency = String(input.default_urgency || 'NORMAL').toUpperCase();
    if (!['NORMAL', 'URGENT', 'CRITICAL'].includes(urgency)) throw new DomainError('默认紧急程度无效', 400, 'VALIDATION_ERROR');
    let equipmentTypeId = null;
    if (input.equipment_type_id) {
      equipmentTypeId = positiveId(input.equipment_type_id, '适用设备类型');
      if (!this.db.prepare('SELECT id FROM equipment_types WHERE id=?').get(equipmentTypeId)) {
        throw new DomainError('适用设备类型不存在', 400, 'VALIDATION_ERROR');
      }
    }
    return {
      code,
      category: requireText(input.category, '故障类别', 40),
      part: requireText(input.part, '故障部位', 40),
      symptom: requireText(input.symptom, '故障现象', 80),
      suggested_action: optionalText(input.suggested_action, 500),
      default_urgency: urgency,
      requires_downtime: input.requires_downtime ? 1 : 0,
      requires_photo: input.requires_photo ? 1 : 0,
      is_common: input.is_common ? 1 : 0,
      equipment_type_id: equipmentTypeId,
    };
  }

  // ---- 现场照片 ----

  listAttachments(targetType, targetId) {
    if (!ATTACHMENT_TARGETS.has(targetType)) throw new DomainError('不支持的附件对象类型', 400, 'VALIDATION_ERROR');
    return asObjects(this.db.prepare(`
      SELECT id, target_type, target_id, original_name, mime, size, uploaded_by, created_at
      FROM attachments WHERE target_type=? AND target_id=? ORDER BY id
    `).all(targetType, Number(targetId)));
  }

  attachmentsByTarget(targetType, targetIds) {
    if (!targetIds.length) return new Map();
    const placeholders = targetIds.map(() => '?').join(',');
    const rows = asObjects(this.db.prepare(`
      SELECT id, target_id, original_name, mime, size, uploaded_by, created_at
      FROM attachments WHERE target_type=? AND target_id IN (${placeholders}) ORDER BY id
    `).all(targetType, ...targetIds));
    const grouped = new Map();
    for (const row of rows) grouped.set(row.target_id, [...(grouped.get(row.target_id) || []), row]);
    return grouped;
  }

  // 落盘 + 写表。调用方负责事务；失败时用返回的路径清理已经写下的文件。
  storeAttachment(targetType, targetId, input, context) {
    if (!ATTACHMENT_TARGETS.has(targetType)) throw new DomainError('不支持的附件对象类型', 400, 'VALIDATION_ERROR');
    if (typeof input?.content_base64 !== 'string' || !input.content_base64) {
      throw new DomainError('照片内容为空', 400, 'VALIDATION_ERROR');
    }
    let buffer;
    try { buffer = Buffer.from(input.content_base64, 'base64'); }
    catch { throw new DomainError('照片编码无效', 400, 'VALIDATION_ERROR'); }
    if (!buffer.length) throw new DomainError('照片内容为空', 400, 'VALIDATION_ERROR');
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new DomainError(`单张照片不能超过${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB，请重新拍摄`, 400, 'ATTACHMENT_TOO_LARGE');
    }
    const detected = detectImage(buffer);
    if (!detected) throw new DomainError('只能上传 JPG、PNG 或 WEBP 格式的照片', 400, 'UNSUPPORTED_MEDIA_TYPE');

    const existing = Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM attachments WHERE target_type=? AND target_id=?'
    ).get(targetType, Number(targetId)).count);
    if (existing >= MAX_ATTACHMENTS_PER_TARGET) {
      throw new DomainError(`最多只能上传${MAX_ATTACHMENTS_PER_TARGET}张照片`, 409, 'TOO_MANY_ATTACHMENTS');
    }

    const month = nowIso().slice(0, 7).replace('-', '');
    const relative = path.join(month, `${crypto.randomBytes(16).toString('hex')}.${detected.ext}`);
    const absolute = path.join(this.attachmentRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buffer);

    const result = this.db.prepare(`
      INSERT INTO attachments(target_type, target_id, file_path, original_name, mime, size,
        uploaded_by, uploader_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(targetType, Number(targetId), relative, optionalText(input.name, 200), detected.mime,
      buffer.length, context.actor, context.user_id || null, nowIso());
    return { id: Number(result.lastInsertRowid), absolute, relative };
  }

  // 一次提交多张。任何一张失败都把已写下的文件删掉，不留孤儿文件。
  storeAttachments(targetType, targetId, items, context) {
    if (!Array.isArray(items) || !items.length) return [];
    if (items.length > MAX_ATTACHMENTS_PER_TARGET) {
      throw new DomainError(`最多只能上传${MAX_ATTACHMENTS_PER_TARGET}张照片`, 400, 'TOO_MANY_ATTACHMENTS');
    }
    const written = [];
    try {
      for (const item of items) written.push(this.storeAttachment(targetType, targetId, item, context));
      return written;
    } catch (error) {
      for (const item of written) { try { fs.unlinkSync(item.absolute); } catch { /* 已经不在就算了 */ } }
      throw error;
    }
  }

  // 给已有工单补照片：报修人补现场情况，技术员补维修后的照片。
  addWorkOrderAttachments(id, input, context) {
    const order = this.getWorkOrder(id, context).work_order;
    if (CLOSED_WORK_ORDER_STATUSES.includes(order.status)) {
      throw new DomainError('已结束工单不能再上传照片', 409, 'WORK_ORDER_CLOSED');
    }
    const isReporter = order.reporter_user_id && order.reporter_user_id === context.user_id;
    if (Number(context.level) === LEVELS.WORKER && !isReporter) {
      throw new DomainError('只能给自己报修的工单上传照片', 403, 'FORBIDDEN');
    }
    const photos = Array.isArray(input.attachments) ? input.attachments : [];
    if (!photos.length) throw new DomainError('没有收到照片', 400, 'VALIDATION_ERROR');
    const written = [];
    try {
      return transaction(this.db, () => {
        written.push(...this.storeAttachments('WORK_ORDER', order.id, photos, context));
        this.history(order.id, 'PHOTO_ADDED', order.status, order.status, context.actor,
          `上传${photos.length}张照片`, null);
        return this.listAttachments('WORK_ORDER', order.id);
      });
    } catch (error) {
      for (const item of written) { try { fs.unlinkSync(item.absolute); } catch { /* 已经不在就算了 */ } }
      throw error;
    }
  }

  attachmentFile(id, context) {
    const row = asObject(this.db.prepare('SELECT * FROM attachments WHERE id=?').get(positiveId(id, '照片')));
    if (!row) throw new DomainError('照片不存在', 404, 'NOT_FOUND');
    // 普工只能看自己报修的工单的照片，和工单本身的可见性保持一致。
    if (row.target_type === 'WORK_ORDER') this.getWorkOrder(row.target_id, context);
    else if (context && Number(context.level) === LEVELS.WORKER) {
      throw new DomainError('当前级别无权查看巡检照片', 403, 'FORBIDDEN');
    }
    const absolute = path.join(this.attachmentRoot, row.file_path);
    // 防路径穿越：file_path 是系统自己生成的，但仍然按静态服务的同一套规则再守一次。
    if (!absolute.startsWith(this.attachmentRoot) || !fs.existsSync(absolute)) {
      throw new DomainError('照片文件已丢失', 404, 'NOT_FOUND');
    }
    return { ...row, absolute };
  }

  deleteAttachment(id, context) {
    const row = asObject(this.db.prepare('SELECT * FROM attachments WHERE id=?').get(positiveId(id, '照片')));
    if (!row) throw new DomainError('照片不存在', 404, 'NOT_FOUND');
    const isOwner = row.uploader_user_id && row.uploader_user_id === context.user_id;
    if (!isOwner && context.role !== ROLES.ADMIN) throw new DomainError('只能删除自己上传的照片', 403, 'FORBIDDEN');
    if (row.target_type === 'WORK_ORDER') {
      const order = this.getWorkOrder(row.target_id).work_order;
      if (CLOSED_WORK_ORDER_STATUSES.includes(order.status)) {
        throw new DomainError('已结束工单的照片不能删除', 409, 'WORK_ORDER_CLOSED');
      }
    }
    this.db.prepare('DELETE FROM attachments WHERE id=?').run(row.id);
    try { fs.unlinkSync(path.join(this.attachmentRoot, row.file_path)); } catch { /* 文件已丢失也要清掉记录 */ }
    this.audit('attachment', row.id, 'DELETE', context.actor, row, null);
    return { id: row.id };
  }

  // ---- 三级成员管理 ----

  listUsers() {
    return asObjects(this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.level, u.status, u.must_change_password,
             u.phone, u.created_at, u.updated_at,
             (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
      FROM users u
      ORDER BY u.level DESC, u.username
    `).all());
  }

  publicUser(id) {
    const row = this.db.prepare(`
      SELECT id, username, display_name, level, status, must_change_password, phone, created_at, updated_at
      FROM users WHERE id = ?
    `).get(Number(id));
    if (!row) throw new DomainError('成员不存在', 404, 'NOT_FOUND');
    return asObject(row);
  }

  createUser(input, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const username = requireText(input.username, '工号/登录名', 40).toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
      throw new DomainError('工号只能使用字母、数字、点、下划线或连字符，长度2至40位', 400, 'VALIDATION_ERROR');
    }
    const displayName = requireText(input.display_name, '姓名', 40);
    const level = normalizeLevel(input.level);
    if (!level) throw new DomainError('成员级别必须是1普工、2技术员或3管理员', 400, 'VALIDATION_ERROR');
    const password = assertPasswordStrength(input.password || generatePassword());
    const { hash, salt } = hashPassword(password);
    const now = nowIso();
    try {
      const result = this.db.prepare(`
        INSERT INTO users(username, display_name, level, password_hash, password_salt,
          status, must_change_password, phone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)
      `).run(username, displayName, level, hash, salt, optionalText(input.phone, 30), now, now);
      const created = this.publicUser(result.lastInsertRowid);
      this.audit('user', created.id, 'CREATE', context.actor, null, created);
      // 初始密码只在创建响应里返回这一次，之后系统不再保存明文。
      return { ...created, initial_password: password };
    } catch (error) {
      this.rethrowConstraint(error, '该工号已经存在');
    }
  }

  updateUser(id, input, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const current = this.publicUser(positiveId(id, '成员'));
    const level = input.level === undefined ? current.level : normalizeLevel(input.level);
    if (!level) throw new DomainError('成员级别必须是1普工、2技术员或3管理员', 400, 'VALIDATION_ERROR');
    const status = String(input.status || current.status).toUpperCase();
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new DomainError('成员状态无效', 400, 'VALIDATION_ERROR');
    const losesAdmin = current.level === 3 && current.status === 'ACTIVE' && (level !== 3 || status !== 'ACTIVE');
    if (losesAdmin) this.assertNotLastAdmin(current.id);
    this.db.prepare(`
      UPDATE users SET display_name=?, level=?, status=?, phone=?, updated_at=? WHERE id=?
    `).run(requireText(input.display_name || current.display_name, '姓名', 40), level, status,
      optionalText(input.phone === undefined ? current.phone : input.phone, 30), nowIso(), current.id);
    // 降级或停用后立即失效已有会话，避免旧权限继续生效。
    if (level !== current.level || status !== current.status) destroyUserSessions(this.db, current.id);
    const updated = this.publicUser(current.id);
    this.audit('user', current.id, 'UPDATE', context.actor, current, updated);
    return updated;
  }

  resetUserPassword(id, context) {
    assertRole(context.role, [ROLES.ADMIN]);
    const current = this.publicUser(positiveId(id, '成员'));
    const password = generatePassword();
    const { hash, salt } = hashPassword(password);
    this.db.prepare(`
      UPDATE users SET password_hash=?, password_salt=?, must_change_password=1, updated_at=? WHERE id=?
    `).run(hash, salt, nowIso(), current.id);
    destroyUserSessions(this.db, current.id);
    this.audit('user', current.id, 'RESET_PASSWORD', context.actor, null, { username: current.username });
    return { ...this.publicUser(current.id), initial_password: password };
  }

  changeOwnPassword(userId, oldPassword, newPassword) {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(Number(userId));
    if (!row) throw new DomainError('成员不存在', 404, 'NOT_FOUND');
    if (!verifyPassword(oldPassword, row.password_hash, row.password_salt)) {
      throw new DomainError('原密码不正确', 400, 'INVALID_PASSWORD');
    }
    const password = assertPasswordStrength(newPassword);
    if (verifyPassword(password, row.password_hash, row.password_salt)) {
      throw new DomainError('新密码不能与原密码相同', 400, 'VALIDATION_ERROR');
    }
    const { hash, salt } = hashPassword(password);
    this.db.prepare(`
      UPDATE users SET password_hash=?, password_salt=?, must_change_password=0, updated_at=? WHERE id=?
    `).run(hash, salt, nowIso(), row.id);
    this.audit('user', row.id, 'CHANGE_PASSWORD', row.display_name, null, { username: row.username });
    return this.publicUser(row.id);
  }

  login(username, password) {
    const name = String(username || '').trim().toLowerCase();
    const row = name ? this.db.prepare('SELECT * FROM users WHERE username=?').get(name) : null;
    // 用户不存在时也做一次哈希运算，避免用响应时间区分"账号不存在"和"密码错误"。
    const valid = row
      ? verifyPassword(password, row.password_hash, row.password_salt)
      : (hashPassword(String(password ?? '')), false);
    if (!row || !valid) throw new DomainError('工号或密码不正确', 401, 'INVALID_CREDENTIALS');
    if (row.status !== 'ACTIVE') throw new DomainError('该账号已停用，请联系管理员', 403, 'ACCOUNT_DISABLED');
    this.audit('user', row.id, 'LOGIN', row.display_name, null, { username: row.username });
    return this.publicUser(row.id);
  }

  assertNotLastAdmin(excludedUserId) {
    const remaining = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE level = 3 AND status = 'ACTIVE' AND id != ?
    `).get(Number(excludedUserId)).count);
    if (!remaining) throw new DomainError('系统必须保留至少一个启用的管理员账号', 409, 'LAST_ADMIN');
  }

  auditLogs(limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return asObjects(this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(safeLimit));
  }

  // 设备状态由未结工单派生，而不是在报修/结单时命令式地设来设去。
  // 这样同一台设备挂多张工单也不会算错，任何时候重算结果都一致。
  syncEquipmentStatus(equipmentId, context = null) {
    if (!equipmentId) return null;
    const equipment = this.rowById('equipment', equipmentId);
    if (!equipment) return null;
    const closed = CLOSED_WORK_ORDER_STATUSES.map(() => '?').join(',');
    const openOrders = this.db.prepare(`
      SELECT status FROM work_orders
      WHERE final_equipment_id = ? AND status NOT IN (${closed})
    `).all(Number(equipmentId), ...CLOSED_WORK_ORDER_STATUSES);

    const baseline = MANUAL_EQUIPMENT_STATUSES.includes(equipment.baseline_status)
      ? equipment.baseline_status
      : (MANUAL_EQUIPMENT_STATUSES.includes(equipment.status) ? equipment.status : 'ACTIVE');
    let next = baseline;
    if (openOrders.some((item) => UNDER_REPAIR_WORK_ORDER_STATUSES.includes(item.status))) next = 'REPAIRING';
    else if (openOrders.length) next = 'REPORTED';

    // baseline_status 是历史遗留的NULL时补写一次，之后维修期间的手工修改才有地方落。
    if (equipment.baseline_status !== baseline) {
      this.db.prepare('UPDATE equipment SET baseline_status=? WHERE id=?').run(baseline, equipment.id);
    }
    if (next === equipment.status) return null;
    this.db.prepare('UPDATE equipment SET status=?, updated_at=? WHERE id=?').run(next, nowIso(), equipment.id);
    this.audit('equipment', equipment.id, 'STATUS_SYNC', context?.actor || '系统',
      { status: equipment.status }, { status: next, baseline_status: baseline, open_work_orders: openOrders.length });
    return next;
  }

  createQrMapping(targetType, targetId) {
    this.db.prepare(`INSERT OR IGNORE INTO qr_mappings(token, target_type, target_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(qrToken(), targetType, Number(targetId), nowIso());
  }

  activeInstallation(equipmentId) {
    return asObject(this.db.prepare(`SELECT * FROM equipment_installations WHERE equipment_id=? AND removed_at IS NULL`).get(equipmentId));
  }

  activeEquipmentAtPosition(positionId) {
    return asObject(this.db.prepare(`SELECT * FROM equipment_installations WHERE position_id=? AND removed_at IS NULL`).get(positionId));
  }

  insertInstallation(equipmentId, positionId, change) {
    this.db.prepare(`
      INSERT INTO equipment_installations(equipment_id, position_id, installed_at, change_request_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(equipmentId, positionId, change.effective_at, change.id, nowIso());
  }

  closeInstallation(installationId, effectiveAt) {
    const installation = this.db.prepare('SELECT * FROM equipment_installations WHERE id=?').get(installationId);
    if (!installation) throw new DomainError('设备安装记录不存在', 404);
    if (new Date(effectiveAt) < new Date(installation.installed_at)) {
      throw new DomainError('变动生效时间不能早于当前安装时间', 409);
    }
    this.db.prepare('UPDATE equipment_installations SET removed_at=? WHERE id=?').run(effectiveAt, installationId);
  }

  getCompositionChange(id) {
    const row = this.db.prepare('SELECT * FROM composition_changes WHERE id=?').get(positiveId(id, '变动申请'));
    if (!row) throw new DomainError('设备变动申请不存在', 404, 'NOT_FOUND');
    return asObject(row);
  }

  history(workOrderId, eventType, fromStatus, toStatus, actor, note, details) {
    this.db.prepare(`
      INSERT INTO work_order_history(work_order_id, event_type, from_status, to_status, actor, note, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workOrderId, eventType, fromStatus, toStatus, actor, note || null, json(details), nowIso());
  }

  audit(entityType, entityId, action, actor, before, after) {
    this.db.prepare(`
      INSERT INTO audit_logs(entity_type, entity_id, action, actor, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entityType, Number(entityId), action, actor, json(before), json(after), nowIso());
  }

  ensure(table, id, message) {
    const allowed = new Set(['factories', 'workshops', 'production_lines', 'processes', 'positions', 'equipment']);
    if (!allowed.has(table)) throw new Error('Invalid table');
    if (!this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) {
      throw new DomainError(message, 404, 'NOT_FOUND');
    }
  }

  rowById(table, id) {
    return asObject(this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(id)));
  }

  rethrowConstraint(error, message) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      throw new DomainError(message, 409, 'DUPLICATE');
    }
    throw error;
  }
}

module.exports = { EquipmentService, ROLES };
