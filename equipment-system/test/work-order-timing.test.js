'use strict';

// 四段时长的时间戳：报修 → 接单 → 到场 → 完成。
// 原先只有 started_at 和 completed_at，"路上花了多久"只能去历史表里翻文本。

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
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));
  const other = contextFor(service.createUser({ username: 't002', display_name: '技术员王五', level: 2 }, manager));

  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, manager, worker, technician, other, process, equipment, faultCode };
}

function report(f) {
  return f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order;
}

test('接单和到场各自留下时间戳，四段时长都能算', () => {
  const f = fixture();
  const created = report(f);
  assert.equal(created.assigned_at, null);
  assert.equal(created.arrived_at, null);

  const assigned = f.service.assignWorkOrder(created.id, {}, f.technician).work_order;
  assert.ok(assigned.assigned_at, '接单要落 assigned_at');
  assert.equal(assigned.arrived_at, null, '还没到场');

  const arrived = f.service.transitionWorkOrder(created.id, { to_status: 'ARRIVED' }, f.technician).work_order;
  assert.ok(arrived.arrived_at, '到场要落 arrived_at');

  const working = f.service.transitionWorkOrder(created.id, { to_status: 'IN_PROGRESS' }, f.technician).work_order;
  assert.ok(working.started_at);
  // 四个时刻按顺序排列，才能相减得出各段时长
  const stamps = [working.reported_at, working.assigned_at, working.arrived_at, working.started_at];
  assert.deepEqual(stamps, [...stamps].sort(), '时间戳必须单调递增，否则时长会算成负数');
  f.db.close();
});

test('转派不覆盖首次接单时间', () => {
  const f = fixture();
  const created = report(f);
  const first = f.service.assignWorkOrder(created.id, {}, f.technician).work_order;
  // 管理员转派给别人：assigned_at 应保持第一次接单的时刻
  const reassigned = f.service.assignWorkOrder(created.id, { assignee_user_id: f.other.user_id }, f.manager).work_order;
  assert.equal(reassigned.assigned_at, first.assigned_at, '"报修到有人接"该按第一个接手的人算');
  assert.equal(reassigned.assignee, '技术员王五');
  f.db.close();
});

test('回到维修中再走一遍，不会覆盖第一次到场时间', () => {
  const f = fixture();
  const created = report(f);
  f.service.assignWorkOrder(created.id, {}, f.technician);
  const arrived = f.service.transitionWorkOrder(created.id, { to_status: 'ARRIVED' }, f.technician).work_order;
  f.service.transitionWorkOrder(created.id, { to_status: 'IN_PROGRESS' }, f.technician);
  // 缺零件停一停再回来修
  f.service.transitionWorkOrder(created.id, { to_status: 'WAITING_PARTS' }, f.technician);
  const back = f.service.transitionWorkOrder(created.id, { to_status: 'IN_PROGRESS' }, f.technician).work_order;
  assert.equal(back.arrived_at, arrived.arrived_at);
  assert.equal(back.started_at, arrived.started_at ?? back.started_at);
  f.db.close();
});

test('总览的两个平均时长只统计时间戳齐全的已完成工单', () => {
  const f = fixture();
  // 没有任何已完成工单时是 null，而不是 0——0 会被读成"响应零分钟"
  assert.equal(f.service.dashboard().avgResponseMinutes, null);
  assert.equal(f.service.dashboard().avgRepairMinutes, null);

  const created = report(f);
  f.service.assignWorkOrder(created.id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(created.id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(created.id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  f.service.transitionWorkOrder(created.id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.updateTrialResult(created.id, { trial_result: 'NORMAL' }, f.technician);
  f.service.transitionWorkOrder(created.id, { to_status: 'COMPLETED' }, f.technician);

  const stats = f.service.dashboard();
  assert.equal(typeof stats.avgResponseMinutes, 'number');
  assert.equal(typeof stats.avgRepairMinutes, 'number');
  assert.ok(stats.avgResponseMinutes >= 0 && stats.avgRepairMinutes >= 0, '时长不能是负数');
  f.db.close();
});

test('改造前的老工单（没有到场时间）不会把均值拖下去', () => {
  const f = fixture();
  const created = report(f);
  f.service.assignWorkOrder(created.id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(created.id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(created.id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  f.service.transitionWorkOrder(created.id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.updateTrialResult(created.id, { trial_result: 'NORMAL' }, f.technician);
  f.service.transitionWorkOrder(created.id, { to_status: 'COMPLETED' }, f.technician);
  const before = f.service.dashboard();

  // 模拟一张改造前建的工单：已完成，但没有 arrived_at
  const legacy = report(f);
  f.db.prepare(`UPDATE work_orders SET status='COMPLETED', completed_at=?, arrived_at=NULL, assigned_at=NULL WHERE id=?`)
    .run(new Date().toISOString(), legacy.id);

  const after = f.service.dashboard();
  assert.equal(after.avgResponseMinutes, before.avgResponseMinutes, '时间戳不全的老工单要被排除在均值之外');
  assert.equal(after.avgRepairMinutes, before.avgRepairMinutes);
  f.db.close();
});
