'use strict';

// 普工报修减负：故障码从"报修必选"改成"结单前必填"，工序能从设备推出来就不用选。
// 这一组测试要守住的核心是：**旁路没有被打开**，只是录入点换了人。

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');
const { FALLBACK_FAULT_CODE } = require('../src/fault-codes');

function contextFor(user) {
  return { actor: user.display_name, user_id: user.id, username: user.username, level: user.level, role: levelToRole(user.level) };
}

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
  const position = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P01', name: '主机位' }, manager);
  // 装到机位上的设备：报修时只给设备就能推出工序
  const installed = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  // 没装到任何机位的设备：推不出工序，只能回头让人选
  const loose = service.createEquipment({
    standard_name: '备用混料机', category: '辅机', type_code: 'MIX', key_spec: 'H800',
  }, manager);
  service.createCompositionChange({
    action: 'INSTALL', equipment_id: installed.id, to_position_id: position.id, reason: '初始安装',
  }, manager);
  const change = service.listCompositionChanges()[0];
  service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, reviewer);

  return { db, service, manager, worker, technician, process, installed, loose };
}

const codeByName = (service, code) => service.listFaultCodes().codes.find((item) => item.code === code);

test('普工只给设备和一句话就能报修，工序按安装关系自动带出', () => {
  const { db, service, worker, process, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id,
    description: '3号挤出机不出料了',
  }, worker).work_order;

  assert.equal(created.process_id, process.id, '工序应由设备当前所在机位推出');
  assert.equal(created.fault_code_id, null, '报修时不强制选故障码');
  assert.equal(created.fault_symptom, '3号挤出机不出料了', '没有故障码时用普工原话当故障现象');
  assert.equal(created.status, 'SUBMITTED');
  db.close();
});

test('新报修进入技术员通知队列，接单后立即从队列消失', () => {
  const { db, service, manager, worker, technician, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id,
    description: '挤出机突然停机',
    urgency: 'CRITICAL',
    is_downtime: true,
  }, worker).work_order;

  const pending = service.pendingRepairNotifications(technician);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, created.id);
  assert.equal(pending[0].line_name, '一号产线');
  assert.equal(pending[0].equipment_name, '单螺杆挤出机');
  assert.equal(pending[0].fault_symptom, '挤出机突然停机');
  assert.throws(() => service.pendingRepairNotifications(worker), /无权/);
  assert.throws(() => service.pendingRepairNotifications(manager), /无权/);

  service.assignWorkOrder(created.id, {}, technician);
  assert.deepEqual(service.pendingRepairNotifications(technician), []);
  db.close();
});

test('既不选故障码也不写一句话的空报修会被拒', () => {
  const { db, service, worker, installed } = fixture();
  assert.throws(() => service.createWorkOrder({ equipment_id: installed.id }, worker), /请用一句话说明/);
  db.close();
});

test('设备没装到机位上时推不出工序，提示要手动选', () => {
  const { db, service, worker, process, loose } = fixture();
  assert.throws(() => service.createWorkOrder({
    equipment_id: loose.id, description: '混料机异响',
  }, worker), /还没安装到任何机位/);

  // 手动给了工序就能建
  const created = service.createWorkOrder({
    equipment_id: loose.id, process_id: process.id, description: '混料机异响',
  }, worker).work_order;
  assert.equal(created.process_id, process.id);
  db.close();
});

test('连设备都判断不了时，工序仍然必填', () => {
  const { db, service, worker } = fixture();
  assert.throws(() => service.createWorkOrder({ description: '车间里有异味' }, worker), /请选择所属工序/);
  db.close();
});

test('技术员补故障分类：故障现象被重写，普工原话仍留在补充说明里', () => {
  const { db, service, worker, technician, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '3号挤出机不出料了',
  }, worker).work_order;

  // 确认故障分类要求先到场——没到现场看过，分类无从判断
  service.assignWorkOrder(created.id, {}, technician);
  service.transitionWorkOrder(created.id, { to_status: 'ARRIVED' }, technician);
  const code = codeByName(service, 'ME-BRG-NOISE');
  const updated = service.classifyWorkOrder(created.id, { fault_code_id: code.id }, technician).work_order;

  assert.equal(updated.fault_code_id, code.id);
  assert.equal(updated.fault_symptom, '机械故障 / 轴承 / 异响', '下游列表和履历都直接显示这一行');
  assert.equal(updated.description, '3号挤出机不出料了', '普工的原话不能被覆盖掉');

  const history = service.getWorkOrder(created.id).history;
  assert.ok(history.some((item) => item.event_type === 'FAULT_CLASSIFIED'), '补分类要在时间线上留痕');
  db.close();
});

test('没补故障码就结不了单', () => {
  const { db, service, worker, technician, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '3号挤出机不出料了',
  }, worker).work_order;

  service.assignWorkOrder(created.id, {}, technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    service.transitionWorkOrder(created.id, { to_status: status }, technician);
  }
  service.updateRepairDetail(created.id, { diagnosis: '测试诊断', repair_action: '测试维修', trial_result: '空转10分钟正常出料' }, technician);
  service.transitionWorkOrder(created.id, { to_status: 'TRIAL_RUN' }, technician);

  assert.throws(() => service.transitionWorkOrder(created.id, { to_status: 'COMPLETED' }, technician),
    /必须用「确认故障分类」/, '报修时放开了故障码，结单这一关就必须收回来');

  service.classifyWorkOrder(created.id, { fault_code_id: codeByName(service, 'ME-BRG-NOISE').id }, technician);
  const done = service.transitionWorkOrder(created.id, { to_status: 'COMPLETED' }, technician).work_order;
  assert.equal(done.status, 'COMPLETED');
  db.close();
});

test('取消不受故障码必填的限制，误报的空单还能关掉', () => {
  const { db, service, manager, worker, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '看错了，其实是隔壁那台',
  }, worker).work_order;
  const cancelled = service.transitionWorkOrder(created.id, { to_status: 'CANCELLED', note: '误报' }, manager).work_order;
  assert.equal(cancelled.status, 'CANCELLED');
  db.close();
});

test('撤回不受故障码必填的限制', () => {
  const { db, service, worker, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '按错了',
  }, worker).work_order;
  const withdrawn = service.withdrawWorkOrder(created.id, { reason: '自己重启一下好了' }, worker).work_order;
  assert.equal(withdrawn.status, 'CANCELLED');
  db.close();
});

test('技术员补分类选“其他”时，用工单上已有的说明当故障现象', () => {
  const { db, service, worker, technician, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '开机后有股胶皮烧焦味',
  }, worker).work_order;
  service.assignWorkOrder(created.id, {}, technician);
  service.transitionWorkOrder(created.id, { to_status: 'ARRIVED' }, technician);
  const other = codeByName(service, FALLBACK_FAULT_CODE);
  const updated = service.classifyWorkOrder(created.id, { fault_code_id: other.id }, technician).work_order;
  assert.equal(updated.fault_symptom, '开机后有股胶皮烧焦味', '不能让工单列表里排一堆“其他”');
  db.close();
});

test('已结束的工单不能再改故障分类', () => {
  const { db, service, manager, worker, technician, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '按错了',
  }, worker).work_order;
  service.transitionWorkOrder(created.id, { to_status: 'CANCELLED', note: '误报' }, manager);
  assert.throws(() => service.classifyWorkOrder(created.id,
    { fault_code_id: codeByName(service, 'ME-BRG-NOISE').id }, technician), /已结束工单/);
  db.close();
});

test('普工不能自己改故障分类', () => {
  const { db, service, worker, installed } = fixture();
  const created = service.createWorkOrder({
    equipment_id: installed.id, description: '不出料',
  }, worker).work_order;
  assert.throws(() => service.classifyWorkOrder(created.id,
    { fault_code_id: codeByName(service, 'ME-BRG-NOISE').id }, worker), /无权/);
  db.close();
});
