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
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const position = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P01', name: '主机位' }, manager);
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, manager, worker, technician, line, process, position, equipment, faultCode };
}

const statusOf = (service, id) => service.getEquipment(id).status;

// 把工单从报修一路推到"待审核"，返回工单id。
function repairUpTo(service, technician, id, target) {
  const path = ['ARRIVED', 'IN_PROGRESS', 'TRIAL_RUN'];
  for (const status of path) {
    service.transitionWorkOrder(id, { to_status: status }, technician);
    if (status === target) return;
  }
}

test('报修两段联动：提交变已报修，开工变维修中，结单回到在用', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();
  assert.equal(statusOf(service, equipment.id), 'ACTIVE');

  const order = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id,
  }, worker);
  const id = order.work_order.id;
  assert.equal(statusOf(service, equipment.id), 'REPORTED', '提交报修后应变为已报修');

  service.assignWorkOrder(id, {}, technician);
  assert.equal(statusOf(service, equipment.id), 'REPORTED', '仅接单还不算开工');
  service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, technician);
  assert.equal(statusOf(service, equipment.id), 'REPORTED', '到场仍算已报修');

  service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, technician);
  assert.equal(statusOf(service, equipment.id), 'REPAIRING', '开工后应变为维修中');

  service.updateRepairDetail(id, { trial_result: '空载正常' }, technician);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, technician);
  assert.equal(statusOf(service, equipment.id), 'REPAIRING', '试运行仍算维修中');
  assert.equal(statusOf(service, equipment.id), 'REPAIRING', '待审核仍算维修中');

  service.transitionWorkOrder(id, { to_status: 'COMPLETED', note: '验收正常' }, technician);
  assert.equal(statusOf(service, equipment.id), 'ACTIVE', '结单后应恢复在用');
  db.close();
});

test('取消工单同样会恢复设备状态', () => {
  const { db, service, manager, worker, process, equipment, faultCode } = fixture();
  const id = service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker).work_order.id;
  assert.equal(statusOf(service, equipment.id), 'REPORTED');
  service.transitionWorkOrder(id, { to_status: 'CANCELLED', note: '现场确认是操作问题' }, manager);
  assert.equal(statusOf(service, equipment.id), 'ACTIVE');
  db.close();
});

test('同一设备多张工单时，关掉其中一张不会提前恢复', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();
  const first = service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker).work_order.id;
  const second = service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker).work_order.id;
  assert.equal(statusOf(service, equipment.id), 'REPORTED');

  service.assignWorkOrder(first, {}, technician);
  repairUpTo(service, technician, first, 'IN_PROGRESS');
  assert.equal(statusOf(service, equipment.id), 'REPAIRING', '有一张开工了就算维修中');

  service.updateRepairDetail(first, { trial_result: '异响消除' }, technician);
  service.transitionWorkOrder(first, { to_status: 'TRIAL_RUN' }, technician);
  service.transitionWorkOrder(first, { to_status: 'COMPLETED' }, technician);
  assert.equal(statusOf(service, equipment.id), 'REPORTED', '第二张还没结，应退回已报修而不是在用');

  service.transitionWorkOrder(second, { to_status: 'CANCELLED' }, manager);
  assert.equal(statusOf(service, equipment.id), 'ACTIVE', '全部结束后才恢复');
  db.close();
});

test('维修期间手工改状态改的是baseline，结单后才生效', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();
  const id = service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker).work_order.id;
  service.assignWorkOrder(id, {}, technician);
  repairUpTo(service, technician, id, 'IN_PROGRESS');
  assert.equal(statusOf(service, equipment.id), 'REPAIRING');

  const current = service.getEquipment(equipment.id);
  const updated = service.updateEquipment(equipment.id, { ...current, status: 'IDLE' }, manager);
  assert.equal(updated.status, 'REPAIRING', '维修期间手工修改不能冲掉维修中');
  assert.equal(updated.baseline_status, 'IDLE');

  service.updateRepairDetail(id, { trial_result: '正常' }, technician);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, technician);
  service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, technician);
  assert.equal(statusOf(service, equipment.id), 'IDLE', '结单后应落到手工选的闲置，而不是在用');
  db.close();
});

test('没有未结工单时手工改状态立即生效，且不能手工写入系统维护的状态', () => {
  const { db, service, manager, equipment, faultCode } = fixture();
  const current = service.getEquipment(equipment.id);
  assert.equal(service.updateEquipment(equipment.id, { ...current, status: 'DISABLED' }, manager).status, 'DISABLED');
  assert.throws(() => service.updateEquipment(equipment.id, { ...current, status: 'REPAIRING' }, manager), /由维修工单自动维护/);
  assert.throws(() => service.updateEquipment(equipment.id, { ...current, status: 'REPORTED' }, manager), /由维修工单自动维护/);
  assert.throws(() => service.updateEquipment(equipment.id, { ...current, status: '瞎填的' }, manager), /设备状态无效/);
  db.close();
});

test('修正故障设备后，旧设备恢复、新设备进入维修态', () => {
  const { db, service, manager, worker, technician, process, equipment, faultCode } = fixture();
  const other = service.createEquipment({
    standard_name: '真正故障的机器', category: '生产主机', type_code: 'EXT', key_spec: '110',
  }, manager);
  const id = service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker).work_order.id;
  service.assignWorkOrder(id, {}, technician);
  repairUpTo(service, technician, id, 'IN_PROGRESS');
  assert.equal(statusOf(service, equipment.id), 'REPAIRING');
  assert.equal(statusOf(service, other.id), 'ACTIVE');

  service.correctWorkOrderEquipment(id, { equipment_id: other.id, reason: '到场后发现是隔壁那台' }, technician);
  assert.equal(statusOf(service, equipment.id), 'ACTIVE', '报错的那台应恢复，不能卡在维修中');
  assert.equal(statusOf(service, other.id), 'REPAIRING', '实际故障设备应进入维修中');
  db.close();
});

test('报修没有指定设备时不会报错，也不影响任何设备状态', () => {
  const { db, service, worker, technician, process, equipment, faultCode } = fixture();
  const id = service.createWorkOrder({ process_id: process.id, fault_code_id: faultCode.id }, worker).work_order.id;
  assert.equal(statusOf(service, equipment.id), 'ACTIVE');
  service.assignWorkOrder(id, {}, technician);
  assert.doesNotThrow(() => service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, technician));
  assert.equal(statusOf(service, equipment.id), 'ACTIVE');
  db.close();
});

test('总览统计里能看到处于维修状态的设备数', () => {
  const { db, service, worker, process, equipment, faultCode } = fixture();
  assert.equal(service.dashboard().repairingEquipment, 0);
  service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker);
  assert.equal(service.dashboard().repairingEquipment, 1);
  db.close();
});

test('产线组合树上能看到设备的维修状态', () => {
  const { db, service, manager, worker, process, position, equipment, faultCode } = fixture();
  service.createCompositionChange({
    action: 'INSTALL', equipment_id: equipment.id, to_position_id: position.id, reason: '初始安装',
  }, manager);
  const change = service.listCompositionChanges()[0];
  service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, manager);

  const inTree = () => service.organizationTree()[0].workshops
    .flatMap((w) => w.lines).flatMap((l) => l.processes).flatMap((p) => p.positions)
    .find((pos) => pos.equipment)?.equipment;
  assert.equal(inTree().status, 'ACTIVE');
  service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id }, worker);
  assert.equal(inTree().status, 'REPORTED', '树上的设备状态应跟着工单走');
  db.close();
});
