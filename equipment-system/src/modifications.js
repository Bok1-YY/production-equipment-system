'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DomainError, optionalText, positiveId, requireText } = require('./domain');
const { transaction } = require('./db');
const { LEVELS } = require('./auth');

const TASK_STATUSES = Object.freeze([
  'DRAFT', 'PUBLISHED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS',
  'REVISION_REQUESTED', 'REVISING', 'PENDING_REVIEW', 'RETURNED',
  'APPROVED', 'CANCELLED',
]);
const PRIORITIES = new Set(['NORMAL', 'URGENT', 'CRITICAL']);
const STRUCTURE_TYPES = new Set(['WORKSHOP', 'LINE', 'PROCESS', 'POSITION']);
const STRUCTURE_ACTIONS = new Set(['CREATE', 'UPDATE', 'REPARENT', 'STATUS', 'DELETE']);
const EQUIPMENT_ACTIONS = new Set(['INSTALL', 'MOVE', 'REMOVE', 'REPLACE', 'RETROFIT']);
const EDITABLE_STATUSES = new Set(['DRAFT', 'REVISING']);
const EXECUTION_STATUSES = new Set(['IN_PROGRESS', 'RETURNED']);
const MODIFYING_STATUSES = Object.freeze([
  'IN_PROGRESS', 'REVISION_REQUESTED', 'PENDING_REVIEW', 'RETURNED', 'REVISING',
]);
const CLOSED_STATUSES = new Set(['APPROVED', 'CANCELLED']);
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_TOTAL_BYTES = 500 * 1024 * 1024;

const STRUCTURES = Object.freeze({
  WORKSHOP: { table: 'workshops', entity: 'workshop', parentType: 'FACTORY', parentColumn: 'factory_id' },
  LINE: { table: 'production_lines', entity: 'production_line', parentType: 'WORKSHOP', parentColumn: 'workshop_id' },
  PROCESS: { table: 'processes', entity: 'process', parentType: 'LINE', parentColumn: 'line_id' },
  POSITION: { table: 'positions', entity: 'position', parentType: 'PROCESS', parentColumn: 'process_id' },
});

const DOCUMENT_TYPES = Object.freeze({
  jpg: { mime: 'image/jpeg', inline: true, test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { alias: 'jpg' },
  png: { mime: 'image/png', inline: true, test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp', inline: true, test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  pdf: { mime: 'application/pdf', inline: true, test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  doc: { mime: 'application/msword', test: oleFile },
  xls: { mime: 'application/vnd.ms-excel', test: oleFile },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: zipFile },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: zipFile },
  zip: { mime: 'application/zip', test: zipFile },
  dwg: { mime: 'image/vnd.dwg', test: (b) => /^AC10\d\d/.test(b.subarray(0, 6).toString('ascii')) },
  dxf: { mime: 'image/vnd.dxf', test: (b) => /(?:SECTION|HEADER)/i.test(b.subarray(0, 512).toString('utf8')) },
});

function oleFile(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function zipFile(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
    && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([a, b]) => buffer[2] === a && buffer[3] === b);
}

function nowIso() { return new Date().toISOString(); }
function asObject(row) { return row ? { ...row } : null; }
function asObjects(rows) { return rows.map(asObject); }
function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function json(value) { return JSON.stringify(value ?? null); }
function upper(value) { return String(value || '').trim().toUpperCase(); }
function bool(value) { return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true'; }

function validIso(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new DomainError(`${field}格式不正确`, 400, 'VALIDATION_ERROR');
  }
  return date.toISOString();
}

function requireAdmin(context) {
  if (!context || Number(context.level) !== LEVELS.MANAGER) {
    throw new DomainError('只有管理员可以管理技改任务', 403, 'FORBIDDEN');
  }
}

function sequenceInside(db, key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
  const next = Number(row?.value || 0) + 1;
  db.prepare('INSERT OR REPLACE INTO app_meta(key,value) VALUES (?,?)').run(key, String(next));
  return next;
}

function taskRow(service, id) {
  const row = service.db.prepare(`
    SELECT t.*, creator.display_name AS created_by,
           primary_user.display_name AS primary_assignee,
           publisher.display_name AS published_by,
           reviewer.display_name AS reviewed_by
    FROM modification_tasks t
    JOIN users creator ON creator.id=t.created_by_user_id
    JOIN users primary_user ON primary_user.id=t.primary_assignee_user_id
    LEFT JOIN users publisher ON publisher.id=t.published_by_user_id
    LEFT JOIN users reviewer ON reviewer.id=t.reviewed_by_user_id
    WHERE t.id=?
  `).get(positiveId(id, '技改任务'));
  if (!row) throw new DomainError('技改任务不存在', 404, 'NOT_FOUND');
  return asObject(row);
}

function assertVisible(service, task, context) {
  if (Number(context?.level) === LEVELS.MANAGER) return;
  if (Number(context?.level) !== LEVELS.TECHNICIAN) {
    throw new DomainError('当前级别无权查看技改任务', 403, 'FORBIDDEN');
  }
  const member = service.db.prepare(
    'SELECT 1 FROM modification_task_members WHERE task_id=? AND user_id=?'
  ).get(task.id, context.user_id);
  if (!member) throw new DomainError('只能查看分派给自己的技改任务', 403, 'FORBIDDEN');
}

function assertPrimary(task, context) {
  if (Number(context?.level) !== LEVELS.TECHNICIAN
      || Number(task.primary_assignee_user_id) !== Number(context.user_id)) {
    throw new DomainError('只有主负责人可以推进这张技改任务', 403, 'FORBIDDEN');
  }
}

function assertMember(service, task, context) {
  assertVisible(service, task, context);
  if (Number(context.level) !== LEVELS.TECHNICIAN) {
    throw new DomainError('该操作必须由任务中的技术员完成', 403, 'FORBIDDEN');
  }
}

function activeItems(service, taskId) {
  return asObjects(service.db.prepare(`
    SELECT * FROM modification_task_items
    WHERE task_id=? AND active=1 ORDER BY sequence_no,id
  `).all(taskId)).map((item) => ({
    ...item,
    payload: parseJson(item.payload_json),
    before: parseJson(item.before_json, null),
    affects_operation: Boolean(item.affects_operation),
    photo_required: Boolean(item.photo_required),
  }));
}

function taskMembers(service, taskId) {
  return asObjects(service.db.prepare(`
    SELECT m.*,u.username,u.display_name,u.level,u.status
    FROM modification_task_members m JOIN users u ON u.id=m.user_id
    WHERE m.task_id=? ORDER BY CASE m.member_role WHEN 'PRIMARY' THEN 0 ELSE 1 END,u.display_name
  `).all(taskId)).map((member) => ({ ...member, acknowledged: member.acknowledged_revision > 0 }));
}

function itemFiles(service, item) {
  return service.listAttachments('MODIFICATION_ITEM', item.id);
}

function taskDetail(service, id, context) {
  const task = taskRow(service, id);
  assertVisible(service, task, context);
  const items = activeItems(service, task.id);
  for (const item of items) item.attachments = itemFiles(service, item);
  const documents = service.listAttachments('MODIFICATION_DOCUMENT', task.id);
  const history = asObjects(service.db.prepare(`
    SELECT h.*,u.username FROM modification_task_history h
    LEFT JOIN users u ON u.id=h.actor_user_id WHERE h.task_id=? ORDER BY h.id
  `).all(task.id)).map((row) => ({ ...row, details: parseJson(row.details_json, null) }));
  const revisions = asObjects(service.db.prepare(`
    SELECT r.*,u.display_name AS published_by FROM modification_task_revisions r
    JOIN users u ON u.id=r.published_by_user_id WHERE r.task_id=? ORDER BY r.revision_no DESC
  `).all(task.id)).map((row) => ({ ...row, snapshot: parseJson(row.snapshot_json) }));
  return {
    task: { ...task, overdue: !CLOSED_STATUSES.has(task.status) && new Date(task.due_at) < new Date() },
    members: taskMembers(service, task.id), items, documents, history, revisions,
  };
}

function history(service, task, eventType, context, from, to, note, details) {
  service.db.prepare(`
    INSERT INTO modification_task_history(
      task_id,event_type,from_status,to_status,actor_user_id,actor,note,details_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(task.id, eventType, from || null, to || null, context.user_id || null,
    context.actor, note || null, details === undefined ? null : json(details), nowIso());
}

function notification(service, userId, eventKey, task, title, body) {
  service.db.prepare(`
    INSERT OR IGNORE INTO user_notifications(
      user_id,notification_type,entity_type,entity_id,event_key,title,body,deep_link,created_at
    ) VALUES (?,'MODIFICATION_TASK','MODIFICATION_TASK',?,?,?,?,?,?)
  `).run(userId, task.id, eventKey, title, body, `/modifications/${task.id}`, nowIso());
}

function notifyMembers(service, task, event, title, body) {
  for (const member of taskMembers(service, task.id)) {
    notification(service, member.user_id, `mod:${task.id}:${task.revision_no}:${event}:${member.user_id}`,
      task, title, body);
  }
}

function notifyAdmins(service, task, event, title, body) {
  for (const user of service.db.prepare("SELECT id FROM users WHERE level=3 AND status='ACTIVE'").all()) {
    notification(service, user.id, `mod:${task.id}:${task.revision_no}:${event}:${user.id}`,
      task, title, body);
  }
}

function validateAssignees(service, primaryId, collaboratorIds = []) {
  const ids = [...new Set([positiveId(primaryId, '主负责人'), ...(collaboratorIds || []).map((id) => positiveId(id, '协作人'))])];
  for (const id of ids) {
    const user = service.publicUser(id);
    if (user.status !== 'ACTIVE' || Number(user.level) !== LEVELS.TECHNICIAN) {
      throw new DomainError('任务执行人必须是启用的技术员账号', 400, 'INVALID_ASSIGNEE');
    }
  }
  return ids;
}

function replaceMembers(service, taskId, primaryId, collaboratorIds) {
  const ids = validateAssignees(service, primaryId, collaboratorIds);
  service.db.prepare('DELETE FROM modification_task_members WHERE task_id=?').run(taskId);
  const insert = service.db.prepare(`
    INSERT INTO modification_task_members(task_id,user_id,member_role,created_at) VALUES (?,?,?,?)
  `);
  for (const id of ids) insert.run(taskId, id, id === Number(primaryId) ? 'PRIMARY' : 'COLLABORATOR', nowIso());
}

function normalizePayload(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('变更参数格式不正确', 400, 'VALIDATION_ERROR');
  }
  return value;
}

function normalizedItem(input, sequence) {
  const targetType = upper(input.target_type);
  const action = upper(input.action);
  if (targetType === 'EQUIPMENT') {
    if (!EQUIPMENT_ACTIONS.has(action)) throw new DomainError('设备变更类型无效', 400, 'VALIDATION_ERROR');
  } else if (!STRUCTURE_TYPES.has(targetType) || !STRUCTURE_ACTIONS.has(action)) {
    throw new DomainError('产线结构变更类型无效', 400, 'VALIDATION_ERROR');
  }
  if (action === 'CREATE' && !String(input.client_ref || '').trim()) {
    throw new DomainError('新建结构必须提供任务内引用编号', 400, 'VALIDATION_ERROR');
  }
  if (action !== 'CREATE' && !input.target_id) positiveId(input.target_id, '变更对象');
  const photoRequired = input.photo_required === undefined ? true : bool(input.photo_required);
  const exemption = optionalText(input.photo_exemption_reason, 500);
  if (!photoRequired && !exemption) throw new DomainError('免拍照项目必须填写原因', 400, 'PHOTO_EXEMPTION_REASON_REQUIRED');
  return {
    id: input.id ? positiveId(input.id, '变更项目') : null,
    sequence_no: Number.isInteger(Number(input.sequence_no)) && Number(input.sequence_no) > 0
      ? Number(input.sequence_no) : sequence,
    target_type: targetType,
    action,
    target_id: input.target_id ? positiveId(input.target_id, '变更对象') : null,
    client_ref: optionalText(input.client_ref, 80),
    title: requireText(input.title, '项目标题', 120),
    instructions: requireText(input.instructions, '施工要求', 2000),
    payload: normalizePayload(input.payload),
    affects_operation: bool(input.affects_operation) ? 1 : 0,
    photo_required: photoRequired ? 1 : 0,
    photo_exemption_reason: exemption,
  };
}

function samePlanItem(current, next) {
  return current.target_type === next.target_type && current.action === next.action
    && Number(current.target_id || 0) === Number(next.target_id || 0)
    && String(current.client_ref || '') === String(next.client_ref || '')
    && current.title === next.title && current.instructions === next.instructions
    && current.payload_json === json(next.payload)
    && Number(current.affects_operation) === next.affects_operation
    && Number(current.photo_required) === next.photo_required
    && String(current.photo_exemption_reason || '') === String(next.photo_exemption_reason || '');
}

function replaceItems(service, task, inputs) {
  if (!Array.isArray(inputs)) return;
  const normalized = inputs.map((item, index) => normalizedItem(item, index + 1));
  const sequenceSet = new Set();
  const refSet = new Set();
  for (const item of normalized) {
    if (sequenceSet.has(item.sequence_no)) throw new DomainError('变更项目顺序不能重复', 409, 'DUPLICATE_SEQUENCE');
    sequenceSet.add(item.sequence_no);
    if (item.client_ref) {
      if (refSet.has(item.client_ref)) throw new DomainError('任务内引用编号不能重复', 409, 'DUPLICATE_REFERENCE');
      refSet.add(item.client_ref);
    }
  }
  const existing = new Map(service.db.prepare(
    'SELECT * FROM modification_task_items WHERE task_id=? AND active=1'
  ).all(task.id).map((row) => [Number(row.id), row]));
  const kept = new Set();
  const insert = service.db.prepare(`
    INSERT INTO modification_task_items(
      task_id,sequence_no,target_type,action,target_id,client_ref,title,instructions,payload_json,
      affects_operation,photo_required,photo_exemption_reason,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const item of normalized) {
    const old = item.id ? existing.get(item.id) : null;
    if (item.id && !old) throw new DomainError('变更项目不属于该任务', 404, 'NOT_FOUND');
    if (!old) {
      insert.run(task.id, item.sequence_no, item.target_type, item.action, item.target_id,
        item.client_ref, item.title, item.instructions, json(item.payload), item.affects_operation,
        item.photo_required, item.photo_exemption_reason, nowIso(), nowIso());
      continue;
    }
    kept.add(old.id);
    const unchanged = samePlanItem(old, item);
    service.db.prepare(`
      UPDATE modification_task_items SET sequence_no=?,target_type=?,action=?,target_id=?,client_ref=?,
        title=?,instructions=?,payload_json=?,affects_operation=?,photo_required=?,photo_exemption_reason=?,
        execution_result=CASE WHEN ? THEN execution_result ELSE NULL END,
        result_revision=CASE WHEN ? THEN result_revision ELSE NULL END,updated_at=? WHERE id=?
    `).run(item.sequence_no, item.target_type, item.action, item.target_id, item.client_ref,
      item.title, item.instructions, json(item.payload), item.affects_operation, item.photo_required,
      item.photo_exemption_reason, unchanged ? 1 : 0, unchanged ? 1 : 0, nowIso(), old.id);
  }
  for (const old of existing.values()) {
    if (!kept.has(old.id)) service.db.prepare('UPDATE modification_task_items SET active=0,updated_at=? WHERE id=?').run(nowIso(), old.id);
  }
}

function validateItemReference(service, taskId, value, expectedType, field) {
  if (value === undefined || value === null || value === '') return null;
  if (Number.isInteger(Number(value)) && Number(value) > 0) {
    const id = Number(value);
    const config = STRUCTURES[expectedType];
    if (!config || !service.rowById(config.table, id)) {
      throw new DomainError(`${field}不存在`, 404, 'NOT_FOUND');
    }
    return { id, ref: null };
  }
  const ref = String(value).trim();
  const item = service.db.prepare(`
    SELECT * FROM modification_task_items WHERE task_id=? AND client_ref=? AND active=1
  `).get(taskId, ref);
  if (!item || item.action !== 'CREATE' || item.target_type !== expectedType) {
    throw new DomainError(`${field}引用的新增结构不存在或类型不匹配`, 409, 'INVALID_ITEM_REFERENCE');
  }
  return { id: null, ref };
}

function captureSnapshot(service, item) {
  if (item.action === 'CREATE') return null;
  if (item.target_type === 'EQUIPMENT') {
    const equipment = service.getEquipment(item.target_id);
    // status/updated_at 会被本任务自己的“改造中”派生状态改变，不属于方案冲突。
    equipment.baseline_status = equipment.baseline_status
      || (['ACTIVE', 'IDLE', 'DISABLED', 'RETIRED'].includes(equipment.status) ? equipment.status : 'ACTIVE');
    delete equipment.status;
    delete equipment.updated_at;
    const installation = service.activeInstallation(item.target_id);
    return { equipment, installation };
  }
  const config = STRUCTURES[item.target_type];
  const row = service.rowById(config.table, item.target_id);
  if (!row) throw new DomainError(`${item.title}引用的结构不存在`, 404, 'NOT_FOUND');
  return row;
}

function validateItem(service, task, item) {
  const payload = item.payload;
  if (item.target_type === 'EQUIPMENT') {
    service.ensure('equipment', item.target_id, '设备不存在');
    if (item.action === 'INSTALL' || item.action === 'MOVE') {
      validateItemReference(service, task.id, payload.to_position_id ?? payload.to_position_ref, 'POSITION', '目标机位');
    }
    if (item.action === 'REPLACE') {
      const replacement = positiveId(payload.replacement_equipment_id, '替换后的设备');
      if (replacement === item.target_id) throw new DomainError('新旧设备不能相同', 400, 'VALIDATION_ERROR');
      service.ensure('equipment', replacement, '替换后的设备不存在');
    }
    if (item.action === 'RETROFIT') {
      const profile = normalizePayload(payload.profile);
      const allowed = new Set(['standard_name', 'alias', 'category', 'brand', 'model', 'serial_number',
        'critical', 'status', 'responsible_person', 'commissioned_on', 'legacy_code', 'data_source', 'verified', 'notes']);
      if (!Object.keys(profile).length || Object.keys(profile).some((key) => !allowed.has(key))) {
        throw new DomainError('设备改造档案字段为空或包含不可修改的设备身份字段', 400, 'IMMUTABLE_EQUIPMENT_IDENTITY');
      }
    }
    return;
  }
  const config = STRUCTURES[item.target_type];
  if (item.action === 'CREATE') {
    requireText(payload.code, '结构编码', 60);
    requireText(payload.name, '结构名称', 80);
    const parentValue = payload.parent_id ?? payload.parent_ref;
    if (config.parentType === 'FACTORY') positiveId(parentValue, '工厂');
    else validateItemReference(service, task.id, parentValue, config.parentType, '上级结构');
  } else {
    service.ensure(config.table, item.target_id, `${item.target_type}不存在`);
  }
  if (item.action === 'UPDATE' && !Object.keys(payload).length) {
    throw new DomainError('结构更新内容不能为空', 400, 'VALIDATION_ERROR');
  }
  if (item.action === 'REPARENT') {
    const parentValue = payload.parent_id ?? payload.parent_ref;
    if (config.parentType === 'FACTORY') positiveId(parentValue, '工厂');
    else validateItemReference(service, task.id, parentValue, config.parentType, '新上级结构');
  }
  if (item.action === 'STATUS' && !['ACTIVE', 'DISABLED'].includes(upper(payload.status))) {
    throw new DomainError('结构状态只能是在用或停用', 400, 'VALIDATION_ERROR');
  }
}

function publishValidation(service, task) {
  if (new Date(task.planned_start_at) > new Date(task.due_at)) {
    throw new DomainError('计划开始时间不能晚于截止时间', 400, 'INVALID_SCHEDULE');
  }
  const members = taskMembers(service, task.id);
  if (!members.length || !members.some((member) => member.member_role === 'PRIMARY')) {
    throw new DomainError('必须指定主负责人', 409, 'PRIMARY_ASSIGNEE_REQUIRED');
  }
  validateAssignees(service, task.primary_assignee_user_id,
    members.filter((member) => member.member_role === 'COLLABORATOR').map((member) => member.user_id));
  const items = activeItems(service, task.id);
  if (!items.length) throw new DomainError('至少需要一条变更项目', 409, 'MODIFICATION_ITEM_REQUIRED');
  for (const item of items) validateItem(service, task, item);
  const documents = Number(service.db.prepare(`
    SELECT COUNT(*) AS count FROM attachments
    WHERE target_type='MODIFICATION_DOCUMENT' AND target_id=?
  `).get(task.id).count);
  if (!documents) throw new DomainError('发布前至少上传一份技术文件或图纸', 409, 'TECHNICAL_DOCUMENT_REQUIRED');
  return items;
}

function snapshotForRevision(service, task, items) {
  const members = taskMembers(service, task.id);
  const documents = service.listAttachments('MODIFICATION_DOCUMENT', task.id);
  return {
    task: {
      title: task.title, objective: task.objective, acceptance_criteria: task.acceptance_criteria,
      priority: task.priority, planned_start_at: task.planned_start_at, due_at: task.due_at,
      primary_assignee_user_id: task.primary_assignee_user_id,
    },
    members: members.map(({ user_id, member_role, display_name }) => ({ user_id, member_role, display_name })),
    items: items.map((item) => ({
      id: item.id, sequence_no: item.sequence_no, target_type: item.target_type, action: item.action,
      target_id: item.target_id, client_ref: item.client_ref, title: item.title,
      instructions: item.instructions, payload: item.payload, before: item.before,
      affects_operation: item.affects_operation, photo_required: item.photo_required,
      photo_exemption_reason: item.photo_exemption_reason,
    })),
    documents: documents.map(({ id, original_name, mime, size, sha256, revision_no }) =>
      ({ id, original_name, mime, size, sha256, revision_no })),
  };
}

function resolveTarget(service, taskId, value, expectedType, appliedRefs) {
  if (Number.isInteger(Number(value)) && Number(value) > 0) return Number(value);
  const ref = String(value || '').trim();
  const resolved = appliedRefs.get(ref) || service.db.prepare(`
    SELECT applied_target_id FROM modification_task_items
    WHERE task_id=? AND client_ref=? AND target_type=? AND active=1
  `).get(taskId, ref)?.applied_target_id;
  if (!resolved) throw new DomainError(`任务内结构“${ref}”尚未创建`, 409, 'UNRESOLVED_ITEM_REFERENCE');
  return Number(resolved);
}

function validateExpectedSnapshots(service, items) {
  for (const item of items) {
    if (item.action === 'CREATE') continue;
    const current = captureSnapshot(service, item);
    if (json(current) !== json(item.before)) {
      throw new DomainError(`“${item.title}”的现场台账已被其他操作修改，请修订方案后重试`,
        409, 'MODIFICATION_SNAPSHOT_CONFLICT');
    }
  }
}

function createApprovedCompositionChange(service, item, task, context, payload, appliedRefs) {
  const action = item.action;
  const equipmentId = item.target_id;
  const current = service.activeInstallation(equipmentId);
  let toPositionId = null;
  let replacementId = null;
  if (action === 'INSTALL' || action === 'MOVE') {
    toPositionId = resolveTarget(service, task.id,
      payload.to_position_id ?? payload.to_position_ref, 'POSITION', appliedRefs);
  }
  if (action === 'REPLACE') {
    replacementId = positiveId(payload.replacement_equipment_id, '替换后的设备');
    toPositionId = current?.position_id || null;
  }
  const changeNo = `CHG-${String(sequenceInside(service.db, 'change_sequence')).padStart(6, '0')}`;
  const effectiveAt = nowIso();
  const result = service.db.prepare(`
    INSERT INTO composition_changes(
      change_no,action,equipment_id,replacement_equipment_id,from_position_id,to_position_id,
      effective_at,reason,submitted_by,submitted_by_user_id,status,reviewed_by,reviewed_by_user_id,
      reviewed_at,review_note,created_at,modification_task_id,modification_item_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,?,?,?,?,?)
  `).run(changeNo, action, equipmentId, replacementId, current?.position_id || null, toPositionId,
    effectiveAt, item.instructions, task.created_by, task.created_by_user_id, context.actor,
    context.user_id, effectiveAt, '由技改任务审核通过', task.created_at, task.id, item.id);
  const change = service.getCompositionChange(result.lastInsertRowid);
  service.applyCompositionChange(change);
  service.db.prepare("UPDATE composition_changes SET status='APPROVED' WHERE id=?").run(change.id);
  service.audit('composition_change', change.id, 'APPROVE_FROM_MODIFICATION_TASK', context, null,
    { ...change, status: 'APPROVED', modification_task_id: task.id });
}

function applyEquipmentRetrofit(service, item, context) {
  const current = service.getEquipment(item.target_id);
  const profile = item.payload.profile || {};
  service.updateEquipment(item.target_id, {
    standard_name: profile.standard_name ?? current.standard_name,
    alias: profile.alias === undefined ? current.alias : profile.alias,
    category: profile.category ?? current.category,
    brand: profile.brand === undefined ? current.brand : profile.brand,
    model: profile.model === undefined ? current.model : profile.model,
    serial_number: profile.serial_number === undefined ? current.serial_number : profile.serial_number,
    critical: profile.critical === undefined ? Boolean(current.critical) : bool(profile.critical),
    status: profile.status ?? current.baseline_status ?? current.status,
    responsible_person: profile.responsible_person === undefined ? current.responsible_person : profile.responsible_person,
    commissioned_on: profile.commissioned_on === undefined ? current.commissioned_on : profile.commissioned_on,
    legacy_code: profile.legacy_code === undefined ? current.legacy_code : profile.legacy_code,
    data_source: profile.data_source === undefined ? current.data_source : profile.data_source,
    verified: profile.verified === undefined ? Boolean(current.verified) : bool(profile.verified),
    notes: profile.notes === undefined ? current.notes : profile.notes,
  }, context);
}

function structureParent(service, task, item, appliedRefs) {
  const config = STRUCTURES[item.target_type];
  const payload = item.payload;
  const value = payload.parent_id ?? payload.parent_ref;
  if (config.parentType === 'FACTORY') {
    const id = positiveId(value, '工厂');
    service.assertActiveStructure('factory', id);
    return id;
  }
  const id = resolveTarget(service, task.id, value, config.parentType, appliedRefs);
  service.assertActiveStructure(config.parentType.toLowerCase(), id);
  return id;
}

function applyStructureItem(service, task, item, context, appliedRefs) {
  const config = STRUCTURES[item.target_type];
  const payload = item.payload;
  if (item.action === 'CREATE') {
    const parentId = structureParent(service, task, item, appliedRefs);
    const code = requireText(payload.code, '结构编码', 60).toUpperCase();
    const name = requireText(payload.name, '结构名称', 80);
    let result;
    if (item.target_type === 'WORKSHOP') {
      result = service.db.prepare(`INSERT INTO workshops(factory_id,code,name,status,created_at) VALUES (?,?,?,'ACTIVE',?)`)
        .run(parentId, code, name, nowIso());
    } else if (item.target_type === 'LINE') {
      result = service.db.prepare(`INSERT INTO production_lines(workshop_id,code,name,supervisor,status,created_at) VALUES (?,?,?,?, 'ACTIVE',?)`)
        .run(parentId, code, name, optionalText(payload.supervisor, 80), nowIso());
    } else if (item.target_type === 'PROCESS') {
      result = service.db.prepare(`INSERT INTO processes(line_id,code,name,sequence_no,status,created_at) VALUES (?,?,?,?, 'ACTIVE',?)`)
        .run(parentId, code, name, Number(payload.sequence_no) || 1, nowIso());
    } else {
      result = service.db.prepare(`INSERT INTO positions(process_id,code,name,sequence_no,critical,status,created_at) VALUES (?,?,?,?,?,'ACTIVE',?)`)
        .run(parentId, code, name, Number(payload.sequence_no) || 1, bool(payload.critical) ? 1 : 0, nowIso());
    }
    const id = Number(result.lastInsertRowid);
    if (item.target_type === 'PROCESS') service.createQrMapping('PROCESS', id);
    appliedRefs.set(item.client_ref, id);
    service.db.prepare('UPDATE modification_task_items SET applied_target_id=?,updated_at=? WHERE id=?')
      .run(id, nowIso(), item.id);
    service.audit(config.entity, id, 'CREATE_FROM_MODIFICATION_TASK', context, null,
      { ...service.rowById(config.table, id), modification_task_id: task.id });
    return;
  }
  const current = service.rowById(config.table, item.target_id);
  if (item.action === 'UPDATE') {
    if (item.target_type === 'WORKSHOP') {
      service.db.prepare('UPDATE workshops SET name=? WHERE id=?').run(requireText(payload.name ?? current.name, '车间名称', 80), current.id);
    } else if (item.target_type === 'LINE') {
      service.db.prepare('UPDATE production_lines SET name=?,supervisor=? WHERE id=?')
        .run(requireText(payload.name ?? current.name, '产线名称', 80),
          payload.supervisor === undefined ? current.supervisor : optionalText(payload.supervisor, 80), current.id);
    } else if (item.target_type === 'PROCESS') {
      service.db.prepare('UPDATE processes SET name=?,sequence_no=? WHERE id=?')
        .run(requireText(payload.name ?? current.name, '工序名称', 80), Number(payload.sequence_no ?? current.sequence_no) || 1, current.id);
    } else {
      service.db.prepare('UPDATE positions SET name=?,sequence_no=?,critical=? WHERE id=?')
        .run(requireText(payload.name ?? current.name, '机位名称', 80), Number(payload.sequence_no ?? current.sequence_no) || 1,
          payload.critical === undefined ? current.critical : (bool(payload.critical) ? 1 : 0), current.id);
    }
    service.audit(config.entity, current.id, 'UPDATE_FROM_MODIFICATION_TASK', context, current,
      { ...service.rowById(config.table, current.id), modification_task_id: task.id });
  } else if (item.action === 'REPARENT') {
    const parentId = structureParent(service, task, item, appliedRefs);
    service.db.prepare(`UPDATE ${config.table} SET ${config.parentColumn}=? WHERE id=?`).run(parentId, current.id);
    service.audit(config.entity, current.id, 'REPARENT_FROM_MODIFICATION_TASK', context, current,
      { ...service.rowById(config.table, current.id), modification_task_id: task.id });
  } else if (item.action === 'STATUS') {
    const status = upper(payload.status);
    if (status === 'DISABLED' && item.target_type === 'POSITION' && service.activeEquipmentAtPosition(current.id)) {
      throw new DomainError('该机位仍安装着设备，不能停用', 409, 'STRUCTURE_IN_USE');
    }
    service.db.prepare(`UPDATE ${config.table} SET status=? WHERE id=?`).run(status, current.id);
    service.audit(config.entity, current.id, 'STATUS_FROM_MODIFICATION_TASK', context, current,
      { ...service.rowById(config.table, current.id), modification_task_id: task.id });
  } else if (item.action === 'DELETE') {
    const preview = service.structureDeletionPreview(item.target_type.toLowerCase(), current.id);
    if (!preview.deletable) throw new DomainError(`不能删除：${preview.blockers.join('；')}`, 409, 'STRUCTURE_IN_USE');
    service.deleteWhereIn('qr_mappings', 'target_id', preview.ids.processIds, "target_type='PROCESS'");
    service.deleteWhereIn('positions', 'id', preview.ids.positionIds);
    service.deleteWhereIn('processes', 'id', preview.ids.processIds);
    service.deleteWhereIn('production_lines', 'id', preview.ids.lineIds);
    service.deleteWhereIn('workshops', 'id', preview.ids.workshopIds);
    service.audit('structure_branch', current.id, 'DELETE_FROM_MODIFICATION_TASK', context,
      { ...preview, modification_task_id: task.id }, null);
  }
}

function applyTask(service, task, context, items) {
  validateExpectedSnapshots(service, items);
  const appliedRefs = new Map();
  for (const item of items) {
    if (item.target_type === 'EQUIPMENT') {
      if (item.action === 'RETROFIT') applyEquipmentRetrofit(service, item, context);
      else createApprovedCompositionChange(service, item, task, context, item.payload, appliedRefs);
    } else applyStructureItem(service, task, item, context, appliedRefs);
  }
}

function documentType(filename, header) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  let config = DOCUMENT_TYPES[ext];
  if (config?.alias) config = DOCUMENT_TYPES[config.alias];
  if (!config || !config.test(header)) {
    throw new DomainError('文件类型无效，只支持图片、PDF、Word、Excel、DWG/DXF和ZIP',
      400, 'UNSUPPORTED_MEDIA_TYPE');
  }
  return { ext: config === DOCUMENT_TYPES.jpg ? 'jpg' : ext, mime: config.mime, inline: Boolean(config.inline) };
}

function safeFilename(raw) {
  let decoded = String(raw || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* 原样校验 */ }
  const name = path.basename(decoded).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return requireText(name, '文件名', 200);
}

function installModificationMethods(EquipmentService) {
  const proto = EquipmentService.prototype;

  proto.listModificationTasks = function listModificationTasks(context, filters = {}) {
    if (Number(context?.level) < LEVELS.TECHNICIAN) {
      throw new DomainError('当前级别无权查看技改任务', 403, 'FORBIDDEN');
    }
    const where = [];
    const args = [];
    if (Number(context.level) === LEVELS.TECHNICIAN) {
      where.push('EXISTS (SELECT 1 FROM modification_task_members mm WHERE mm.task_id=t.id AND mm.user_id=?)');
      args.push(context.user_id);
    }
    const status = upper(filters.status);
    if (status) {
      if (!TASK_STATUSES.includes(status)) throw new DomainError('任务状态无效', 400, 'VALIDATION_ERROR');
      where.push('t.status=?'); args.push(status);
    }
    return asObjects(this.db.prepare(`
      SELECT t.*,p.display_name AS primary_assignee,c.display_name AS created_by,
             (SELECT COUNT(*) FROM modification_task_items i WHERE i.task_id=t.id AND i.active=1) AS item_count,
             (SELECT COUNT(*) FROM modification_task_members m WHERE m.task_id=t.id) AS member_count
      FROM modification_tasks t JOIN users p ON p.id=t.primary_assignee_user_id
      JOIN users c ON c.id=t.created_by_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE WHEN t.status NOT IN ('APPROVED','CANCELLED') AND t.due_at<? THEN 0 ELSE 1 END,
               t.id DESC
    `).all(...args, nowIso())).map((task) => ({
      ...task, overdue: !CLOSED_STATUSES.has(task.status) && new Date(task.due_at) < new Date(),
    }));
  };

  proto.getModificationTask = function getModificationTask(id, context) {
    return taskDetail(this, id, context);
  };

  proto.createModificationTask = function createModificationTask(input, context) {
    requireAdmin(context);
    const plannedStart = validIso(input.planned_start_at, '计划开始时间');
    const dueAt = validIso(input.due_at, '截止时间');
    if (new Date(plannedStart) > new Date(dueAt)) throw new DomainError('计划开始时间不能晚于截止时间', 400, 'INVALID_SCHEDULE');
    const priority = upper(input.priority || 'NORMAL');
    if (!PRIORITIES.has(priority)) throw new DomainError('优先级无效', 400, 'VALIDATION_ERROR');
    const primaryId = positiveId(input.primary_assignee_user_id, '主负责人');
    validateAssignees(this, primaryId, input.collaborator_user_ids || []);
    return transaction(this.db, () => {
      const taskNo = `MOD-${String(sequenceInside(this.db, 'modification_task_sequence')).padStart(6, '0')}`;
      const now = nowIso();
      const result = this.db.prepare(`
        INSERT INTO modification_tasks(
          task_no,title,objective,acceptance_criteria,priority,planned_start_at,due_at,status,
          primary_assignee_user_id,created_by_user_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,'DRAFT',?,?,?,?)
      `).run(taskNo, requireText(input.title, '任务标题', 120), requireText(input.objective, '改造目的', 2000),
        requireText(input.acceptance_criteria, '验收标准', 2000), priority, plannedStart, dueAt,
        primaryId, context.user_id, now, now);
      const task = taskRow(this, result.lastInsertRowid);
      replaceMembers(this, task.id, primaryId, input.collaborator_user_ids || []);
      replaceItems(this, task, input.items || []);
      history(this, task, 'CREATED', context, null, 'DRAFT', '创建技改任务草稿');
      this.audit('modification_task', task.id, 'CREATE', context, null, task);
      return taskDetail(this, task.id, context);
    });
  };

  proto.updateModificationTask = function updateModificationTask(id, input, context) {
    requireAdmin(context);
    const current = taskRow(this, id);
    if (!EDITABLE_STATUSES.has(current.status)) throw new DomainError('当前状态不能编辑方案', 409, 'TASK_NOT_EDITABLE');
    return transaction(this.db, () => {
      const primaryId = input.primary_assignee_user_id
        ? positiveId(input.primary_assignee_user_id, '主负责人') : current.primary_assignee_user_id;
      const collaborators = input.collaborator_user_ids === undefined
        ? taskMembers(this, current.id).filter((m) => m.member_role === 'COLLABORATOR').map((m) => m.user_id)
        : input.collaborator_user_ids;
      validateAssignees(this, primaryId, collaborators);
      const plannedStart = input.planned_start_at ? validIso(input.planned_start_at, '计划开始时间') : current.planned_start_at;
      const dueAt = input.due_at ? validIso(input.due_at, '截止时间') : current.due_at;
      if (new Date(plannedStart) > new Date(dueAt)) throw new DomainError('计划开始时间不能晚于截止时间', 400, 'INVALID_SCHEDULE');
      const priority = upper(input.priority || current.priority);
      if (!PRIORITIES.has(priority)) throw new DomainError('优先级无效', 400, 'VALIDATION_ERROR');
      this.db.prepare(`
        UPDATE modification_tasks SET title=?,objective=?,acceptance_criteria=?,priority=?,
          planned_start_at=?,due_at=?,primary_assignee_user_id=?,updated_at=? WHERE id=?
      `).run(requireText(input.title ?? current.title, '任务标题', 120),
        requireText(input.objective ?? current.objective, '改造目的', 2000),
        requireText(input.acceptance_criteria ?? current.acceptance_criteria, '验收标准', 2000),
        priority, plannedStart, dueAt, primaryId, nowIso(), current.id);
      replaceMembers(this, current.id, primaryId, collaborators);
      replaceItems(this, current, input.items);
      const updated = taskRow(this, current.id);
      history(this, updated, 'PLAN_UPDATED', context, current.status, current.status,
        optionalText(input.reason, 500) || '更新任务方案');
      this.audit('modification_task', current.id, 'UPDATE_PLAN', context, current, updated);
      return taskDetail(this, current.id, context);
    });
  };

  proto.reviseModificationTask = function reviseModificationTask(id, input, context) {
    requireAdmin(context);
    const current = taskRow(this, id);
    if (CLOSED_STATUSES.has(current.status) || current.status === 'DRAFT' || current.status === 'REVISING') {
      throw new DomainError('当前状态不能发起方案修订', 409, 'INVALID_TRANSITION');
    }
    const reason = requireText(input.reason, '修订原因', 500);
    this.db.prepare("UPDATE modification_tasks SET status='REVISING',updated_at=? WHERE id=?").run(nowIso(), current.id);
    const revising = taskRow(this, current.id);
    history(this, revising, 'REVISION_STARTED', context, current.status, 'REVISING', reason);
    if (Object.keys(input).some((key) => key !== 'reason')) return this.updateModificationTask(current.id, input, context);
    return taskDetail(this, current.id, context);
  };

  proto.publishModificationTask = function publishModificationTask(id, input, context) {
    requireAdmin(context);
    const current = taskRow(this, id);
    if (!EDITABLE_STATUSES.has(current.status)) throw new DomainError('当前状态不能发布', 409, 'INVALID_TRANSITION');
    return transaction(this.db, () => {
      const items = publishValidation(this, current);
      for (const item of items) {
        const before = captureSnapshot(this, item);
        this.db.prepare('UPDATE modification_task_items SET before_json=?,updated_at=? WHERE id=?')
          .run(before === null ? null : json(before), nowIso(), item.id);
        item.before = before;
      }
      const revision = Number(current.revision_no) + 1;
      const reason = optionalText(input.reason, 500) || (revision === 1 ? '首次发布' : '发布修订方案');
      const now = nowIso();
      this.db.prepare(`
        UPDATE modification_tasks SET status='PUBLISHED',revision_no=?,published_by_user_id=?,
          published_at=?,accepted_at=NULL,updated_at=? WHERE id=?
      `).run(revision, context.user_id, now, now, current.id);
      this.db.prepare(`UPDATE modification_task_members SET acknowledged_revision=0,acknowledged_at=NULL WHERE task_id=?`)
        .run(current.id);
      const published = taskRow(this, current.id);
      this.db.prepare(`
        INSERT INTO modification_task_revisions(task_id,revision_no,reason,snapshot_json,published_by_user_id,published_at)
        VALUES (?,?,?,?,?,?)
      `).run(current.id, revision, reason, json(snapshotForRevision(this, published, activeItems(this, current.id))),
        context.user_id, now);
      history(this, published, 'PUBLISHED', context, current.status, 'PUBLISHED', reason, { revision });
      notifyMembers(this, published, 'published', `${published.task_no} 待确认`, published.title);
      this.audit('modification_task', current.id, 'PUBLISH', context, current, published);
      return taskDetail(this, current.id, context);
    });
  };

  proto.acknowledgeModificationTask = function acknowledgeModificationTask(id, input, context) {
    const current = taskRow(this, id);
    assertMember(this, current, context);
    if (current.status !== 'PUBLISHED') throw new DomainError('当前任务不在待确认状态', 409, 'INVALID_TRANSITION');
    return transaction(this.db, () => {
      const result = this.db.prepare(`
        UPDATE modification_task_members SET acknowledged_revision=?,acknowledged_at=?
        WHERE task_id=? AND user_id=?
      `).run(current.revision_no, nowIso(), current.id, context.user_id);
      if (!Number(result.changes)) throw new DomainError('你不是该任务的执行人员', 403, 'FORBIDDEN');
      const pending = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM modification_task_members
        WHERE task_id=? AND acknowledged_revision<>?
      `).get(current.id, current.revision_no).count);
      let to = 'PUBLISHED';
      if (!pending) {
        to = 'ACCEPTED';
        this.db.prepare("UPDATE modification_tasks SET status='ACCEPTED',accepted_at=?,updated_at=? WHERE id=?")
          .run(nowIso(), nowIso(), current.id);
      }
      history(this, current, 'ACKNOWLEDGED', context, current.status, to,
        optionalText(input.note, 500), { revision: current.revision_no, remaining: pending });
      return taskDetail(this, current.id, context);
    });
  };

  proto.arriveModificationTask = function arriveModificationTask(id, input, context) {
    const current = taskRow(this, id); assertPrimary(current, context);
    if (current.status !== 'ACCEPTED') throw new DomainError('任务尚未由所有执行人确认', 409, 'INVALID_TRANSITION');
    this.db.prepare("UPDATE modification_tasks SET status='ARRIVED',arrived_at=?,updated_at=? WHERE id=?")
      .run(nowIso(), nowIso(), current.id);
    history(this, current, 'ARRIVED', context, 'ACCEPTED', 'ARRIVED', optionalText(input.note, 500));
    return taskDetail(this, current.id, context);
  };

  proto.startModificationTask = function startModificationTask(id, input, context) {
    const current = taskRow(this, id); assertPrimary(current, context);
    if (current.status !== 'ARRIVED') throw new DomainError('请先确认到场', 409, 'INVALID_TRANSITION');
    this.db.prepare("UPDATE modification_tasks SET status='IN_PROGRESS',started_at=?,updated_at=? WHERE id=?")
      .run(nowIso(), nowIso(), current.id);
    history(this, current, 'STARTED', context, 'ARRIVED', 'IN_PROGRESS', optionalText(input.note, 500));
    for (const item of activeItems(this, current.id).filter((x) => x.target_type === 'EQUIPMENT' && x.affects_operation)) {
      this.syncEquipmentStatus(item.target_id, context);
    }
    return taskDetail(this, current.id, context);
  };

  proto.reportModificationDeviation = function reportModificationDeviation(id, input, context) {
    const current = taskRow(this, id); assertMember(this, current, context);
    if (!['ARRIVED', 'IN_PROGRESS', 'RETURNED'].includes(current.status)) {
      throw new DomainError('当前阶段不能上报方案偏差', 409, 'INVALID_TRANSITION');
    }
    const note = requireText(input.note, '现场偏差和建议', 2000);
    this.db.prepare("UPDATE modification_tasks SET status='REVISION_REQUESTED',updated_at=? WHERE id=?")
      .run(nowIso(), current.id);
    history(this, current, 'DEVIATION_REPORTED', context, current.status, 'REVISION_REQUESTED', note);
    const updated = taskRow(this, current.id);
    notifyAdmins(this, updated, 'deviation', `${updated.task_no} 现场方案有偏差`, note);
    return taskDetail(this, current.id, context);
  };

  proto.updateModificationItemResult = function updateModificationItemResult(taskId, itemId, input, context) {
    const task = taskRow(this, taskId); assertMember(this, task, context);
    if (!EXECUTION_STATUSES.has(task.status)) throw new DomainError('当前阶段不能填写施工结果', 409, 'INVALID_TRANSITION');
    const item = this.db.prepare('SELECT * FROM modification_task_items WHERE id=? AND task_id=? AND active=1')
      .get(positiveId(itemId, '变更项目'), task.id);
    if (!item) throw new DomainError('变更项目不存在', 404, 'NOT_FOUND');
    const result = requireText(input.execution_result, '实际执行结果', 2000);
    this.db.prepare('UPDATE modification_task_items SET execution_result=?,result_revision=?,updated_at=? WHERE id=?')
      .run(result, task.revision_no, nowIso(), item.id);
    history(this, task, 'ITEM_RESULT_UPDATED', context, task.status, task.status,
      `填写项目“${item.title}”执行结果`, { item_id: item.id });
    return taskDetail(this, task.id, context);
  };

  proto.addModificationItemPhotos = function addModificationItemPhotos(taskId, itemId, input, context) {
    const task = taskRow(this, taskId); assertMember(this, task, context);
    if (!EXECUTION_STATUSES.has(task.status)) throw new DomainError('当前阶段不能上传完工照片', 409, 'INVALID_TRANSITION');
    const item = this.db.prepare('SELECT * FROM modification_task_items WHERE id=? AND task_id=? AND active=1')
      .get(positiveId(itemId, '变更项目'), task.id);
    if (!item) throw new DomainError('变更项目不存在', 404, 'NOT_FOUND');
    const photos = Array.isArray(input.attachments) ? input.attachments : [];
    if (!photos.length) throw new DomainError('没有收到完工照片', 400, 'VALIDATION_ERROR');
    const written = this.storeAttachments('MODIFICATION_ITEM', item.id, photos, context);
    for (const file of written) {
      this.db.prepare('UPDATE attachments SET revision_no=? WHERE id=?').run(task.revision_no, file.id);
    }
    history(this, task, 'ITEM_PHOTO_ADDED', context, task.status, task.status,
      `为“${item.title}”上传${photos.length}张完工照片`, { item_id: item.id });
    return itemFiles(this, item);
  };

  proto.submitModificationTask = function submitModificationTask(id, input, context) {
    const current = taskRow(this, id); assertPrimary(current, context);
    if (!EXECUTION_STATUSES.has(current.status)) throw new DomainError('当前阶段不能提交审核', 409, 'INVALID_TRANSITION');
    const items = activeItems(this, current.id);
    for (const item of items) {
      if (!item.execution_result || !item.result_revision) {
        throw new DomainError(`“${item.title}”尚未填写实际执行结果`, 409, 'ITEM_RESULT_REQUIRED');
      }
      if (item.photo_required) {
        const photo = this.db.prepare(`
          SELECT 1 FROM attachments WHERE target_type='MODIFICATION_ITEM' AND target_id=? AND revision_no=? LIMIT 1
        `).get(item.id, item.result_revision);
        if (!photo) throw new DomainError(`“${item.title}”尚未上传本次结果对应的完工照片`, 409, 'ITEM_PHOTO_REQUIRED');
      }
    }
    const summary = requireText(input.completion_summary, '施工总结', 3000);
    const issues = optionalText(input.outstanding_issues, 2000);
    this.db.prepare(`
      UPDATE modification_tasks SET status='PENDING_REVIEW',completion_summary=?,outstanding_issues=?,
        submitted_at=?,updated_at=? WHERE id=?
    `).run(summary, issues, nowIso(), nowIso(), current.id);
    history(this, current, 'SUBMITTED_FOR_REVIEW', context, current.status, 'PENDING_REVIEW', summary,
      { outstanding_issues: issues });
    const updated = taskRow(this, current.id);
    notifyAdmins(this, updated, 'review', `${updated.task_no} 待审核`, updated.title);
    return taskDetail(this, current.id, context);
  };

  proto.reviewModificationTask = function reviewModificationTask(id, input, context) {
    requireAdmin(context);
    const current = taskRow(this, id);
    if (current.status !== 'PENDING_REVIEW') throw new DomainError('任务不在待审核状态', 409, 'INVALID_TRANSITION');
    const decision = upper(input.decision);
    if (!['APPROVED', 'RETURNED'].includes(decision)) throw new DomainError('审核结果无效', 400, 'VALIDATION_ERROR');
    if (decision === 'RETURNED') {
      const note = requireText(input.note, '退回原因', 1000);
      this.db.prepare("UPDATE modification_tasks SET status='RETURNED',review_note=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE id=?")
        .run(note, context.user_id, nowIso(), nowIso(), current.id);
      history(this, current, 'RETURNED', context, 'PENDING_REVIEW', 'RETURNED', note);
      const returned = taskRow(this, current.id);
      notifyMembers(this, returned, 'returned', `${returned.task_no} 已退回整改`, note);
      return taskDetail(this, current.id, context);
    }
    const note = optionalText(input.note, 1000);
    return transaction(this.db, () => {
      const items = activeItems(this, current.id);
      applyTask(this, current, context, items);
      const approvedAt = nowIso();
      this.db.prepare(`
        UPDATE modification_tasks SET status='APPROVED',review_note=?,reviewed_by_user_id=?,
          reviewed_at=?,updated_at=? WHERE id=?
      `).run(note, context.user_id, approvedAt, approvedAt, current.id);
      history(this, current, 'APPROVED', context, 'PENDING_REVIEW', 'APPROVED', note,
        { applied_items: items.length });
      const approved = taskRow(this, current.id);
      this.audit('modification_task', current.id, 'APPROVE_AND_APPLY', context, current, approved);
      for (const equipmentId of new Set(items.filter((x) => x.target_type === 'EQUIPMENT').flatMap((x) =>
        [x.target_id, x.payload.replacement_equipment_id].filter(Boolean)))) {
        this.syncEquipmentStatus(equipmentId, context);
      }
      notifyMembers(this, approved, 'approved', `${approved.task_no} 已审核通过`, approved.title);
      return taskDetail(this, current.id, context);
    });
  };

  proto.cancelModificationTask = function cancelModificationTask(id, input, context) {
    requireAdmin(context);
    const current = taskRow(this, id);
    if (CLOSED_STATUSES.has(current.status)) throw new DomainError('任务已经结束', 409, 'TASK_CLOSED');
    const reason = requireText(input.reason, '取消原因', 1000);
    this.db.prepare("UPDATE modification_tasks SET status='CANCELLED',cancellation_reason=?,cancelled_at=?,updated_at=? WHERE id=?")
      .run(reason, nowIso(), nowIso(), current.id);
    history(this, current, 'CANCELLED', context, current.status, 'CANCELLED', reason);
    const cancelled = taskRow(this, current.id);
    for (const item of activeItems(this, current.id).filter((x) => x.target_type === 'EQUIPMENT')) this.syncEquipmentStatus(item.target_id, context);
    notifyMembers(this, cancelled, 'cancelled', `${cancelled.task_no} 已取消`, reason);
    return taskDetail(this, current.id, context);
  };

  proto.storeModificationDocument = async function storeModificationDocument(taskId, request, metadata, context) {
    requireAdmin(context);
    const task = taskRow(this, taskId);
    if (!EDITABLE_STATUSES.has(task.status)) throw new DomainError('只有草稿或修订中的任务可以上传技术文件', 409, 'TASK_NOT_EDITABLE');
    const count = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM attachments
      WHERE target_type='MODIFICATION_DOCUMENT' AND target_id=?`).get(task.id);
    if (Number(count.count) >= MAX_DOCUMENTS) throw new DomainError(`每张任务最多上传${MAX_DOCUMENTS}份技术文件`, 409, 'TOO_MANY_ATTACHMENTS');
    const filename = safeFilename(metadata.filename);
    fs.mkdirSync(this.attachmentRoot, { recursive: true });
    const temporary = path.join(this.attachmentRoot, `.upload-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let size = 0;
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(temporary, { flags: 'wx' });
    try {
      await new Promise((resolve, reject) => {
        request.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES || Number(count.bytes) + size > MAX_DOCUMENT_TOTAL_BYTES) {
            reject(new DomainError('技术文件超过单文件50MB或任务合计500MB限制', 413, 'PAYLOAD_TOO_LARGE'));
            request.destroy();
            return;
          }
          hash.update(chunk);
          if (!output.write(chunk)) request.pause(), output.once('drain', () => request.resume());
        });
        request.on('end', () => output.end(resolve));
        request.on('error', reject);
        output.on('error', reject);
      });
      if (!size) throw new DomainError('文件内容为空', 400, 'VALIDATION_ERROR');
      const descriptor = fs.openSync(temporary, 'r');
      const header = Buffer.alloc(Math.min(size, 512));
      fs.readSync(descriptor, header, 0, header.length, 0); fs.closeSync(descriptor);
      const detected = documentType(filename, header);
      const month = nowIso().slice(0, 7).replace('-', '');
      const relative = path.join(month, `${crypto.randomBytes(16).toString('hex')}.${detected.ext}`);
      const absolute = path.join(this.attachmentRoot, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.renameSync(temporary, absolute);
      const revision = Number(task.revision_no) + 1;
      const result = this.db.prepare(`
        INSERT INTO attachments(target_type,target_id,file_path,original_name,mime,size,uploaded_by,
          uploader_user_id,created_at,revision_no,sha256,disposition)
        VALUES ('MODIFICATION_DOCUMENT',?,?,?,?,?,?,?,?,?,? ,?)
      `).run(task.id, relative, filename, detected.mime, size, context.actor, context.user_id,
        nowIso(), revision, hash.digest('hex'), detected.inline ? 'inline' : 'attachment');
      history(this, task, 'DOCUMENT_ADDED', context, task.status, task.status, `上传技术文件：${filename}`,
        { attachment_id: Number(result.lastInsertRowid), revision });
      return this.listAttachments('MODIFICATION_DOCUMENT', task.id);
    } catch (error) {
      try { output.destroy(); } catch { /* noop */ }
      try { fs.unlinkSync(temporary); } catch { /* incomplete upload */ }
      throw error;
    }
  };

  proto.listUserNotifications = function listUserNotifications(context, options = {}) {
    if (!context?.user_id) throw new DomainError('请先登录', 401, 'UNAUTHORIZED');
    const unreadOnly = options.unread !== false;
    return asObjects(this.db.prepare(`
      SELECT * FROM user_notifications WHERE user_id=? ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY id DESC LIMIT 100
    `).all(context.user_id));
  };

  proto.readUserNotification = function readUserNotification(id, context) {
    const notificationId = positiveId(id, '通知');
    const result = this.db.prepare('UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?')
      .run(nowIso(), notificationId, context.user_id);
    if (!Number(result.changes)) throw new DomainError('通知不存在', 404, 'NOT_FOUND');
    return { id: notificationId, read: true };
  };
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MODIFYING_STATUSES,
  TASK_STATUSES,
  installModificationMethods,
};
