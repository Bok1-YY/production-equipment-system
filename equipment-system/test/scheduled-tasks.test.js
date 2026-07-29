'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

function contextFor(user) {
  return {
    actor: user.display_name,
    user_id: user.id,
    username: user.username,
    level: user.level,
    role: levelToRole(user.level),
  };
}

function fixture() {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seed.id));
  const technician = contextFor(service.createUser({
    username: 't001', display_name: '技术员张三', level: 2,
  }, manager));
  const worker = contextFor(service.createUser({
    username: 'w001', display_name: '普工李四', level: 1,
  }, manager));
  const workshop = service.organization().workshops[0];
  const line = service.createLine({
    workshop_id: workshop.id, code: 'YSM-L01', name: '一号线',
  }, manager);
  const process = service.createProcess({
    line_id: line.id, code: 'YSM-L01-EX', name: '挤出',
  }, manager);
  const equipment = service.createEquipment({
    standard_name: '挤出机', category: '生产设备', type_code: 'EXT', key_spec: '135',
  }, manager);
  return { db, service, manager, technician, worker, process, equipment };
}

test('点检计划自动生成任务，逐项提交异常后可转维修工单', () => {
  const { db, service, manager, technician, worker, process } = fixture();
  const template = service.createTaskTemplate('INSPECTION', {
    name: '每日点检',
    items: [
      { item_name: '运行声音', item_type: 'CHECK', standard_text: '无异响' },
      { item_name: '轴承温度', item_type: 'NUMBER', unit: '℃', min_value: 0, max_value: 80 },
    ],
  }, manager);
  const plan = service.createTaskPlan('INSPECTION', {
    name: '挤出工序每日点检',
    template_id: template.id,
    target_type: 'PROCESS',
    target_id: process.id,
    schedule_type: 'DAILY',
    next_due_at: new Date(Date.now() - 1000).toISOString(),
    assignee_user_id: technician.user_id,
  }, manager);
  assert.equal(plan.task_kind, 'INSPECTION');
  assert.throws(() => service.listScheduledTasks('INSPECTION', worker), /无权/);

  const tasks = service.listScheduledTasks('INSPECTION', technician);
  assert.equal(tasks.length, 1);
  const completed = service.executeScheduledTask(tasks[0].id, {
    results: [
      { template_item_id: template.items[0].id, result_status: 'PASS' },
      { template_item_id: template.items[1].id, result_status: 'PASS', measured_value: 95, note: '温度偏高' },
    ],
    summary: '发现轴承温度偏高',
  }, technician);
  assert.equal(completed.status, 'ABNORMAL', '超上限应由服务端自动判为异常');
  assert.equal(completed.abnormal_event.status, 'OPEN');

  const converted = service.convertTaskAbnormalToWorkOrder(tasks[0].id, {}, technician);
  assert.equal(converted.task.status, 'CONVERTED');
  assert.equal(converted.work_order.process_id, process.id);
  assert.match(converted.work_order.description, /点检任务/);
  db.close();
});

test('保养模板必须有级别，人工任务完成后进入运营报表', () => {
  const { db, service, manager, technician, equipment } = fixture();
  assert.throws(() => service.createTaskTemplate('MAINTENANCE', {
    name: '错误模板', items: [{ item_name: '清洁' }],
  }, manager), /一级、二级或三级/);
  const template = service.createTaskTemplate('MAINTENANCE', {
    name: '一级保养',
    maintenance_level: 1,
    items: [
      { item_name: '清洁设备', item_type: 'CHECK' },
      { item_name: '润滑记录', item_type: 'TEXT' },
    ],
  }, manager);
  const task = service.createManualTask('MAINTENANCE', {
    template_id: template.id,
    target_type: 'EQUIPMENT',
    target_id: equipment.id,
    assignee_user_id: technician.user_id,
  }, manager);
  const completed = service.executeScheduledTask(task.id, {
    results: [
      { template_item_id: template.items[0].id, result_status: 'PASS' },
      { template_item_id: template.items[1].id, result_status: 'PASS', text_value: '加注2号润滑脂' },
    ],
  }, technician);
  assert.equal(completed.status, 'COMPLETED');

  const report = service.operationalReport({
    start: new Date(Date.now() - 86400000).toISOString(),
    end: new Date(Date.now() + 86400000).toISOString(),
  }, technician);
  assert.equal(report.tasks.find((item) => item.task_kind === 'MAINTENANCE').executed_count, 1);
  db.close();
});
