'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

function contextFor(user) {
  return { actor: user.display_name, user_id: user.id, username: user.username, level: user.level, role: levelToRole(user.level) };
}

function fixture() {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seed.id));
  const worker = contextFor(service.createUser({ username: 'w001', display_name: '普工李四', level: 1 }, manager));
  const other = contextFor(service.createUser({ username: 'w002', display_name: '普工王五', level: 1 }, manager));
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, manager, worker, other, technician, process, equipment, faultCode };
}

function report(f, reporter = f.worker, overrides = {}) {
  return f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id, ...overrides,
  }, reporter).work_order.id;
}

test('报修人可以在技术员到场前撤回，到场之后不行', () => {
  const f = fixture();

  // 刚提交
  const justSubmitted = report(f);
  assert.doesNotThrow(() => f.service.withdrawWorkOrder(justSubmitted, { reason: '报错设备了' }, f.worker));

  // 技术员已接单（接单一步就到 ACCEPTED），还没到场 —— 仍可撤
  const claimed = report(f);
  f.service.assignWorkOrder(claimed, {}, f.technician);
  assert.equal(f.service.getWorkOrder(claimed).work_order.status, 'ACCEPTED');
  assert.doesNotThrow(() => f.service.withdrawWorkOrder(claimed, { reason: '自己重启一下好了' }, f.worker));

  // 技术员已到场 —— 人都来了，不能再撤
  const arrived = report(f);
  f.service.assignWorkOrder(arrived, {}, f.technician);
  f.service.transitionWorkOrder(arrived, { to_status: 'ARRIVED' }, f.technician);
  assert.throws(() => f.service.withdrawWorkOrder(arrived, { reason: '不修了' }, f.worker), /已经到场/);
  f.db.close();
});

test('撤回必须填原因，且只能撤自己的', () => {
  const f = fixture();
  const id = report(f);
  assert.throws(() => f.service.withdrawWorkOrder(id, {}, f.worker), /撤回原因不能为空/);
  assert.throws(() => f.service.withdrawWorkOrder(id, { reason: '  ' }, f.worker), /撤回原因不能为空/);
  assert.throws(() => f.service.withdrawWorkOrder(id, { reason: '手滑' }, f.other), /只能撤回自己提交的报修/);
  assert.throws(() => f.service.withdrawWorkOrder(id, { reason: '手滑' }, f.technician), /只能撤回自己提交的报修/);
  assert.doesNotThrow(() => f.service.withdrawWorkOrder(id, { reason: '手滑点错了' }, f.manager), '管理员可以代撤');
  f.db.close();
});

test('撤回后工单变已取消、设备状态恢复，历史事件区别于管理员取消', () => {
  const f = fixture();
  const id = report(f);
  assert.equal(f.service.getEquipment(f.equipment.id).status, 'REPORTED');

  const result = f.service.withdrawWorkOrder(id, { reason: '现场确认是操作问题，不是设备故障' }, f.worker);
  assert.equal(result.work_order.status, 'CANCELLED');
  assert.equal(f.service.getEquipment(f.equipment.id).status, 'ACTIVE', '撤回后设备状态要跟着恢复');

  const events = result.history.map((h) => h.event_type);
  assert.ok(events.includes('WITHDRAWN'), '要能分清"普工自己撤的"和"管理员取消的"');
  assert.equal(events.includes('STATUS_CHANGED'), false);
  const withdrawn = result.history.find((h) => h.event_type === 'WITHDRAWN');
  assert.equal(withdrawn.note, '现场确认是操作问题，不是设备故障');
  assert.equal(withdrawn.actor, '普工李四');
  assert.ok(f.service.auditLogs().some((item) => item.entity_type === 'work_order' && item.action === 'WITHDRAW'));
  f.db.close();
});

test('已经结束的工单不能撤回', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(id, { trial_result: '正常' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician);
  assert.throws(() => f.service.withdrawWorkOrder(id, { reason: '想撤' }, f.worker), /已经结束/);
  f.db.close();
});

// 报修 → 修完结单，返回工单id
function repairAndClose(f, overrides = {}) {
  const id = report(f, f.worker, overrides);
  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(id, { trial_result: '正常' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician);
  return id;
}

test('没修好可以重新报修，新单继承设备和故障码并关联原单', () => {
  const f = fixture();
  const original = repairAndClose(f, { fault_location: '机头右侧' });

  const result = f.service.reopenWorkOrder(original, {}, f.worker);
  const fresh = result.work_order;
  assert.notEqual(fresh.id, original);
  assert.equal(fresh.status, 'SUBMITTED');
  assert.equal(fresh.reported_equipment_id, f.equipment.id, '继承设备');
  assert.equal(fresh.fault_code_id, f.faultCode.id, '继承故障码');
  assert.equal(fresh.fault_location, '机头右侧', '继承故障位置');
  assert.equal(fresh.reopened_from_work_order_id, original, '关联原单');
  assert.match(fresh.description, /修复后问题再次出现/);
  assert.equal(f.service.getEquipment(f.equipment.id).status, 'REPORTED', '重新报修后设备重新进入报修状态');

  // 原单留痕，两边互相查得到
  const originalHistory = f.service.getWorkOrder(original).history;
  const reopened = originalHistory.find((h) => h.event_type === 'REOPENED');
  assert.ok(reopened, '原单要留痕');
  assert.match(reopened.note, /已重新报修：WO-/);
  assert.equal(f.service.listWorkOrders(f.worker).find((x) => x.id === fresh.id).reopened_from_work_order_no,
    f.service.getWorkOrder(original).work_order.work_order_no);
  f.db.close();
});

test('只有已完成的工单能重新报修，且只有报修人或管理员能发起', () => {
  const f = fixture();
  const open = report(f);
  assert.throws(() => f.service.reopenWorkOrder(open, {}, f.worker), /只有已完成的工单/);

  const done = repairAndClose(f);
  assert.throws(() => f.service.reopenWorkOrder(done, {}, f.other), /只能对自己报修的工单/);
  assert.throws(() => f.service.reopenWorkOrder(done, {}, f.technician), /只能对自己报修的工单/);
  assert.doesNotThrow(() => f.service.reopenWorkOrder(done, {}, f.manager), '管理员可以代发起');
  f.db.close();
});

test('重新报修时可以改故障码和紧急程度', () => {
  const f = fixture();
  const original = repairAndClose(f);
  const another = f.service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-STUCK');

  const result = f.service.reopenWorkOrder(original, {
    fault_code_id: another.id, urgency: 'CRITICAL', description: '这次直接卡死了',
  }, f.worker);
  assert.equal(result.work_order.fault_code_id, another.id);
  assert.equal(result.work_order.urgency, 'CRITICAL');
  assert.equal(result.work_order.description, '这次直接卡死了');
  assert.equal(result.work_order.fault_symptom, '机械故障 / 轴承 / 卡死不转');
  f.db.close();
});

test('重新报修出来的新单，走的还是完整流程', () => {
  const f = fixture();
  const original = repairAndClose(f);
  const fresh = f.service.reopenWorkOrder(original, {}, f.worker).work_order.id;

  // 新单是普通工单：能撤回、能被抢单、能评价
  assert.doesNotThrow(() => f.service.withdrawWorkOrder(fresh, { reason: '再看看' }, f.worker));
  assert.equal(f.service.getWorkOrder(fresh).work_order.status, 'CANCELLED');
  f.db.close();
});
