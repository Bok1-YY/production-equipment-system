'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

function contextFor(user) {
  return { actor: user.display_name, user_id: user.id, username: user.username, level: user.level, role: levelToRole(user.level) };
}

// 建一台设备，装到一号机位，再移到二号机位，然后完整修一次。
function fixture() {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seed.id));
  const reviewer = contextFor(service.createUser({ username: 'm002', display_name: '审核管理员', level: 3 }, manager));
  const worker = contextFor(service.createUser({ username: 'w001', display_name: '普工李四', level: 1 }, manager));
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));

  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const first = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P01', name: '主机位' }, manager);
  const second = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P02', name: '备用机位' }, manager);
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);

  const approve = (input) => {
    service.createCompositionChange(input, manager);
    const change = service.listCompositionChanges()[0];
    return service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, reviewer);
  };
  approve({ action: 'INSTALL', equipment_id: equipment.id, to_position_id: first.id, reason: '初始安装' });
  approve({ action: 'MOVE', equipment_id: equipment.id, to_position_id: second.id, reason: '产线调整搬到备用机位' });

  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, manager, reviewer, worker, technician, process, first, second, equipment, faultCode };
}

test('设备履历汇总位置变动、维修工单、零件、档案修改和统计', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();

  const order = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id,
    fault_location: '机头右侧', is_downtime: true, urgency: 'URGENT',
  }, worker);
  const id = order.work_order.id;
  service.assignWorkOrder(id, {}, technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    service.transitionWorkOrder(id, { to_status: status }, technician);
  }
  service.updateRepairDetail(id, {
    diagnosis: '主接触器触点烧结，原因为触点老化', repair_action: '更换接触器',
    downtime_minutes: 95, downtime_override_reason: '按现场停机记录修正',
  }, technician);
  service.addWorkOrderPart(id, { part_name: '交流接触器', specification: 'CJX2-2510', quantity: 1, unit: '只' }, technician);
  service.addWorkOrderPart(id, { part_name: '熔断器', quantity: 2, unit: '只' }, technician);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, technician);
  service.updateTrialResult(id, { trial_result: 'NORMAL' }, technician);
  service.transitionWorkOrder(id, { to_status: 'COMPLETED', note: '验收正常' }, technician);

  const history = service.equipmentHistory(equipment.id);

  assert.equal(history.equipment.code, equipment.code);
  assert.equal(history.equipment.status, 'ACTIVE', '修完之后履历里的当前状态应已恢复');

  // 位置变动：装到主机位、移到备用机位，共两条安装记录，第一条已结束
  assert.equal(history.installations.length, 2);
  assert.equal(history.installations[0].position_name, '备用机位');
  assert.equal(history.installations[0].removed_at, null, '当前在位的那条没有结束时间');
  assert.equal(history.installations[1].position_name, '主机位');
  assert.ok(history.installations[1].removed_at, '搬走的那条应有结束时间');
  assert.equal(history.installations[1].reason, '初始安装');
  assert.equal(history.installations[1].submitted_by, '系统管理员');
  assert.equal(history.installations[0].line_name, '一号产线');

  assert.equal(history.changes.length, 2);
  assert.deepEqual(history.changes.map((item) => item.action), ['MOVE', 'INSTALL']);
  assert.equal(history.changes[0].to_position_name, '备用机位');

  // 维修工单：一张，带两条零件
  assert.equal(history.work_orders.length, 1);
  const repaired = history.work_orders[0];
  assert.equal(repaired.fault_code_id, faultCode.id);
  assert.equal(repaired.fault_symptom, '机械故障 / 轴承 / 异响', '故障现象由故障码回填');
  assert.equal(repaired.fault_location, '机头右侧');
  assert.equal(repaired.repair_action, '更换接触器');
  assert.equal(repaired.trial_result, 'NORMAL');
  assert.equal(repaired.reporter, '普工李四');
  assert.equal(repaired.assignee, '技术员张三');
  assert.equal(repaired.parts.length, 2);
  assert.deepEqual(repaired.parts.map((p) => p.part_name), ['交流接触器', '熔断器']);

  // 档案修改：建档、状态联动都会留痕
  assert.ok(history.audits.length >= 2);
  assert.ok(history.audits.some((item) => item.action === 'CREATE'));
  assert.ok(history.audits.some((item) => item.action === 'STATUS_SYNC'));

  const s = history.summary;
  assert.equal(s.work_orders, 1);
  assert.equal(s.completed_work_orders, 1);
  assert.equal(s.open_work_orders, 0);
  assert.equal(s.downtime_work_orders, 1);
  assert.equal(s.total_downtime_minutes, 95);
  assert.equal(s.parts_replaced, 2);
  assert.equal(s.position_changes, 2);
  assert.ok(s.last_repair_at);
  assert.equal(s.current_position, '一号产线 / 挤出工序 / 备用机位');
  assert.equal(typeof s.installed_days, 'number');
  db.close();
});

test('被替换下来的旧设备，履历里也能看到那次替换', () => {
  const { db, service, manager, reviewer, equipment, second, faultCode } = fixture();
  const replacement = service.createEquipment({
    standard_name: '备用挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  service.createCompositionChange({
    action: 'REPLACE', equipment_id: equipment.id, replacement_equipment_id: replacement.id, reason: '主机大修换备机',
  }, manager);
  const change = service.listCompositionChanges()[0];
  service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, reviewer);

  const oldHistory = service.equipmentHistory(equipment.id);
  assert.ok(oldHistory.changes.some((item) => item.action === 'REPLACE'), '被换下来的设备要看得到这次替换');
  assert.equal(oldHistory.installations[0].removed_at !== null, true, '已经不在机位上');

  const newHistory = service.equipmentHistory(replacement.id);
  const asReplacement = newHistory.changes.find((item) => item.action === 'REPLACE');
  assert.ok(asReplacement, '顶上来的设备也要看得到这次替换');
  assert.equal(asReplacement.as_replacement, 1, '标明它是作为替换设备出现的');
  assert.equal(newHistory.installations.length, 1);
  assert.equal(newHistory.installations[0].position_name, second.name);
  db.close();
});

test('报修时挂错设备，两台的履历各自反映真实情况', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();
  const actual = service.createEquipment({
    standard_name: '真正故障的机器', category: '生产主机', type_code: 'EXT', key_spec: '110',
  }, manager);
  const id = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id,
  }, worker).work_order.id;
  service.assignWorkOrder(id, {}, technician);
  // 修正设备要求先到场——"到场发现是隔壁那台"本来就得人在现场才说得出来
  service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, technician);
  service.correctWorkOrderEquipment(id, { equipment_id: actual.id, reason: '到场发现是隔壁那台' }, technician);

  const reportedHistory = service.equipmentHistory(equipment.id);
  const wrong = reportedHistory.work_orders.find((item) => item.id === id);
  assert.ok(wrong, '当初被报到的设备仍能看到这张单');
  assert.equal(wrong.reported_only, 1, '但要标明它只是被报到、最终不归它');
  assert.equal(reportedHistory.summary.work_orders, 0, '统计不把它算成这台的维修次数');

  const actualHistory = service.equipmentHistory(actual.id);
  assert.equal(actualHistory.summary.work_orders, 1, '实际维修的设备才计入统计');
  assert.equal(actualHistory.work_orders[0].reported_only, 0);
  db.close();
});

test('新建但从未安装、从未维修的设备，履历为空但不报错', () => {
  const { db, service, manager, faultCode } = fixture();
  const fresh = service.createEquipment({
    standard_name: '仓库里的新机器', category: '生产主机', type_code: 'MIX',
  }, manager);
  const history = service.equipmentHistory(fresh.id);
  assert.deepEqual(history.installations, []);
  assert.deepEqual(history.changes, []);
  assert.deepEqual(history.work_orders, []);
  assert.equal(history.summary.work_orders, 0);
  assert.equal(history.summary.installed_days, null);
  assert.equal(history.summary.current_position, null);
  assert.equal(history.summary.last_repair_at, null);
  assert.ok(history.audits.some((item) => item.action === 'CREATE'));
  assert.throws(() => service.equipmentHistory(999999), /设备不存在/);
  db.close();
});
