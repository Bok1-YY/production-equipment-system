'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

function contextFor(user) {
  return { actor: user.display_name, user_id: user.id, username: user.username, level: user.level, role: levelToRole(user.level) };
}

function fixture(filename = ':memory:') {
  const db = openDatabase(filename);
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  if (seed.must_change_password) service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
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

function readyForTrial(f) {
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);
  f.service.updateRepairDetail(id, { diagnosis: '轴承缺油', repair_action: '补充润滑脂' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  return id;
}

test('试运行结果只能在待试运行阶段填写，带问题运行必须说明问题', () => {
  const f = fixture();
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  assert.throws(() => f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, f.technician), /待试运行/);

  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  f.service.updateRepairDetail(id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  assert.throws(() => f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, f.other), /由技术员张三负责/);
  assert.throws(() => f.service.updateTrialResult(id, { trial_result: '随便写' }, f.technician), /有效的试运行结果/);
  assert.throws(() => f.service.updateTrialResult(id, { trial_result: 'OPERABLE_WITH_ISSUES' }, f.technician), /必须填写问题说明/);

  const updated = f.service.updateTrialResult(id, {
    trial_result: 'OPERABLE_WITH_ISSUES', trial_issue_description: '低速时仍有轻微异响',
  }, f.technician);
  assert.equal(updated.work_order.trial_issue_description, '低速时仍有轻微异响');
  assert.ok(updated.history.some((item) => item.event_type === 'TRIAL_RESULT_UPDATED'));
  assert.equal(f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician).work_order.status, 'COMPLETED');
  f.db.close();
});

test('无法运行不能结单，返修后再次试运行必须重新选择结果', () => {
  const f = fixture();
  const id = readyForTrial(f);
  f.service.updateTrialResult(id, { trial_result: 'UNABLE_TO_RUN', trial_issue_description: '应被清除' }, f.technician);
  assert.equal(f.service.getWorkOrder(id).work_order.trial_issue_description, null);
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician), /无法运行.*不能结单/);

  f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);
  assert.equal(f.service.getWorkOrder(id).work_order.trial_result, 'UNABLE_TO_RUN', '返修期间保留上次失败结果供查看');
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  assert.equal(f.service.getWorkOrder(id).work_order.trial_result, null, '新一轮试运行不能沿用上次结果');
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician), /必须选择有效的试运行结果/);
  f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, f.technician);
  assert.equal(f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician).work_order.status, 'COMPLETED');
  f.db.close();
});

test('旧诊断和根本原因在升级时合并为诊断原因且只迁移一次', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-diagnosis-'));
  const filename = path.join(tempDir, 'equipment.db');
  try {
    const f = fixture(filename);
    const id = f.service.createWorkOrder({
      process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
    }, f.worker).work_order.id;
    f.db.prepare('UPDATE work_orders SET diagnosis=?, root_cause=? WHERE id=?')
      .run('主接触器触点烧结', '触点老化', id);
    f.db.prepare('DELETE FROM schema_migrations WHERE version=3').run();
    f.db.close();

    const reopened = openDatabase(filename);
    const migrated = reopened.prepare('SELECT diagnosis, root_cause FROM work_orders WHERE id=?').get(id);
    assert.equal(migrated.diagnosis, '主接触器触点烧结\n根本原因：触点老化');
    assert.equal(migrated.root_cause, null);
    reopened.close();

    const reopenedAgain = openDatabase(filename);
    assert.equal(reopenedAgain.prepare('SELECT diagnosis FROM work_orders WHERE id=?').get(id).diagnosis,
      '主接触器触点烧结\n根本原因：触点老化', '重复启动不能再次拼接根本原因');
    reopenedAgain.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
