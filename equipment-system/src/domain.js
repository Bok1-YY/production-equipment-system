'use strict';

const LEGACY_EQUIPMENT_CODE_PATTERN = /^YSM-EQ-\d{6}$/;
const EQUIPMENT_CODE_PATTERN = /^YSM-[A-Z]{2,4}-(?:[A-Z0-9]+-)*\d{4}$/;

const CHANGE_ACTIONS = new Set(['INSTALL', 'MOVE', 'REMOVE', 'REPLACE']);
const CHANGE_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

// 2026-07-26：删掉 ASSIGNED。它和 ACCEPTED 表达的是同一件事（有人负责了、还没到场），
// 现场分不清两个名字的差别，技术员到场前要多点一下。管理员指派和技术员抢单现在都落到
// ACCEPTED，谁做的靠历史事件 CLAIMED / ASSIGNED / REASSIGNED 区分。
//
// SUBMITTED 只能走到 CANCELLED：接单一律走 assignWorkOrder，不走 transitionWorkOrder。
// 原先 SUBMITTED → ASSIGNED 是可以流转的，界面上就出现了一个"已分派"选项，点了会把状态
// 改成已分派而 assignee 是空的——等于请人制造"分派给谁都不知道"的脏工单。
const WORK_ORDER_TRANSITIONS = Object.freeze({
  SUBMITTED: new Set(['CANCELLED']),
  ACCEPTED: new Set(['ARRIVED', 'CANCELLED']),
  ARRIVED: new Set(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set(['WAITING_PARTS', 'OUTSOURCED', 'TRIAL_RUN', 'CANCELLED']),
  WAITING_PARTS: new Set(['IN_PROGRESS', 'CANCELLED']),
  OUTSOURCED: new Set(['IN_PROGRESS', 'CANCELLED']),
  // 试运行完由技术员直接结单。原来这里要先进 PENDING_REVIEW 等管理员验收，
  // 2026-07-26 改为「技术员结单 + 报修人评价」，验收由评价承担。
  TRIAL_RUN: new Set(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  // PENDING_REVIEW 不再是正向路径上的一环，但保留可达 COMPLETED：
  // 改造前可能有工单正停在这个状态，删掉它们就永远结不了单。
  PENDING_REVIEW: new Set(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
});

// 报修人可以自己撤回的状态：技术员还没到现场。到场之后再撤就是白跑一趟。
const WITHDRAWABLE_STATUSES = Object.freeze(['SUBMITTED', 'ACCEPTED']);

// 技术员已经到现场的状态。到场之前判断不了是哪台设备、什么故障，更不会用掉零件，
// 所以「修正故障设备」「确认故障分类」「诊断与维修记录」「使用零件」四个操作都要求到场。
const POST_ARRIVAL_STATUSES = Object.freeze(['ARRIVED', 'IN_PROGRESS', 'WAITING_PARTS', 'OUTSOURCED', 'TRIAL_RUN', 'PENDING_REVIEW']);

// 工单的有序阶段，供界面画步骤条用（"我在第几步、还剩几步"）。
// 由服务端 /api/meta 下发，前端不许再抄一份——抄了就会和状态机走散。
// 等零件/外协/待审核是维修中的分支，不占独立步骤，界面上并到所属阶段显示。
const WORK_ORDER_STAGES = Object.freeze([
  { status: 'SUBMITTED', name: '待接单' },
  { status: 'ACCEPTED', name: '已接单', includes: [] },
  { status: 'ARRIVED', name: '已到场' },
  { status: 'IN_PROGRESS', name: '维修中', includes: ['WAITING_PARTS', 'OUTSOURCED'] },
  { status: 'TRIAL_RUN', name: '待试运行', includes: ['PENDING_REVIEW'] },
  { status: 'COMPLETED', name: '已完成' },
]);

// 评价维度，三项五星制。字段名对应 work_order_reviews 的 <key>_score 列。
const REVIEW_DIMENSIONS = Object.freeze([
  { key: 'quality', name: '维修质量' },
  { key: 'attitude', name: '服务态度' },
  { key: 'speed', name: '响应速度' },
]);
const MIN_REVIEW_SCORE = 1;
const MAX_REVIEW_SCORE = 5;

// 人能在档案里手工选的状态。系统维护的两个状态不在其中，避免手工写进去后被工单重算冲掉。
const MANUAL_EQUIPMENT_STATUSES = Object.freeze(['ACTIVE', 'IDLE', 'DISABLED', 'RETIRED']);
const REPAIR_EQUIPMENT_STATUSES = Object.freeze(['REPORTED', 'REPAIRING']);

// 工单已经结束的状态；其余都算"未结"，会把设备保持在维修态。
const CLOSED_WORK_ORDER_STATUSES = Object.freeze(['COMPLETED', 'CANCELLED']);
// 技术员已经动手的阶段 —— 设备记为"维修中"；未结但不在此列的算"已报修"。
const UNDER_REPAIR_WORK_ORDER_STATUSES = Object.freeze(
  Object.keys(WORK_ORDER_TRANSITIONS).filter((status) =>
    !CLOSED_WORK_ORDER_STATUSES.includes(status)
    && !['SUBMITTED', 'ACCEPTED', 'ARRIVED'].includes(status))
);

function requireText(value, field, maxLength = 200) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(`${field}不能为空`, 400, 'VALIDATION_ERROR');
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new DomainError(`${field}不能超过${maxLength}个字符`, 400, 'VALIDATION_ERROR');
  }
  return result;
}

function optionalText(value, maxLength = 1000) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new DomainError('文本字段格式不正确', 400, 'VALIDATION_ERROR');
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new DomainError(`文本不能超过${maxLength}个字符`, 400, 'VALIDATION_ERROR');
  }
  return result || null;
}

function positiveId(value, field) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) {
    throw new DomainError(`${field}必须是有效编号`, 400, 'VALIDATION_ERROR');
  }
  return result;
}

function normalizeEquipmentTypeCode(value) {
  const code = requireText(value, '设备类型代码', 4).toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(code)) throw new DomainError('设备类型代码必须是2至4位大写英文字母', 400, 'VALIDATION_ERROR');
  return code;
}

function normalizeKeySpec(value) {
  const spec = String(value || '').trim().toUpperCase();
  if (spec.length > 40 || (spec && !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(spec))) {
    throw new DomainError('关键规格只能使用大写字母、数字和连字符', 400, 'VALIDATION_ERROR');
  }
  return spec;
}

function formatEquipmentCode(typeCode, keySpec, sequence) {
  const type = normalizeEquipmentTypeCode(typeCode);
  const spec = normalizeKeySpec(keySpec);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new DomainError('设备流水号超出范围', 500, 'SEQUENCE_EXHAUSTED');
  }
  return `YSM-${type}-${spec ? `${spec}-` : ''}${String(sequence).padStart(4, '0')}`;
}

function isValidEquipmentCode(code) {
  return EQUIPMENT_CODE_PATTERN.test(code) || LEGACY_EQUIPMENT_CODE_PATTERN.test(code);
}

function assertChangeAction(action) {
  if (!CHANGE_ACTIONS.has(action)) {
    throw new DomainError('不支持的设备变动类型', 400, 'INVALID_CHANGE_ACTION');
  }
  return action;
}

function assertWorkOrderTransition(from, to) {
  const allowed = WORK_ORDER_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new DomainError(`工单不能从“${from}”变更为“${to}”`, 409, 'INVALID_TRANSITION');
  }
}

function assertReviewScore(value, label) {
  const score = Number(value);
  if (!Number.isInteger(score) || score < MIN_REVIEW_SCORE || score > MAX_REVIEW_SCORE) {
    throw new DomainError(`${label}请打${MIN_REVIEW_SCORE}到${MAX_REVIEW_SCORE}星`, 400, 'VALIDATION_ERROR');
  }
  return score;
}

function assertRole(role, allowed) {
  if (!allowed.includes(role)) {
    throw new DomainError('当前角色无权执行此操作', 403, 'FORBIDDEN');
  }
}

class DomainError extends Error {
  constructor(message, status = 400, code = 'DOMAIN_ERROR') {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

module.exports = {
  CHANGE_ACTIONS,
  CHANGE_STATUSES,
  CLOSED_WORK_ORDER_STATUSES,
  MANUAL_EQUIPMENT_STATUSES,
  MAX_REVIEW_SCORE,
  MIN_REVIEW_SCORE,
  POST_ARRIVAL_STATUSES,
  REPAIR_EQUIPMENT_STATUSES,
  REVIEW_DIMENSIONS,
  UNDER_REPAIR_WORK_ORDER_STATUSES,
  WITHDRAWABLE_STATUSES,
  WORK_ORDER_STAGES,
  WORK_ORDER_TRANSITIONS,
  assertReviewScore,
  DomainError,
  assertChangeAction,
  assertRole,
  assertWorkOrderTransition,
  formatEquipmentCode,
  isValidEquipmentCode,
  normalizeEquipmentTypeCode,
  normalizeKeySpec,
  optionalText,
  positiveId,
  requireText,
};
