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
  const workshop = service.organization().workshops[0];
  const line1 = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const line2 = service.createLine({ workshop_id: workshop.id, code: 'YSM-L02', name: '二号产线' }, manager);
  const process1 = service.createProcess({ line_id: line1.id, code: 'YSM-L01-P01', name: '一线工序' }, manager);
  const process2 = service.createProcess({ line_id: line2.id, code: 'YSM-L02-P01', name: '二线工序' }, manager);
  const equipment1 = service.createEquipment({ standard_name: '测试挤出机', category: '生产主机', type_code: 'EXT', key_spec: 'A' }, manager);
  const equipment2 = service.createEquipment({ standard_name: '测试混料机', category: '生产主机', type_code: 'MIX', key_spec: 'B' }, manager);
  const fault1 = service.createFaultCode({ code: 'REPORT-ELEC-01', category: '电气故障', part: '电机', symptom: '无法启动' }, manager);
  const fault2 = service.createFaultCode({ code: 'REPORT-ELEC-02', category: '电气故障', part: '控制器', symptom: '频繁报警' }, manager);

  const makeOrder = (process, equipment, faultCode, description, day, downtime) => {
    const order = service.createWorkOrder({
      process_id: process.id,
      equipment_id: equipment.id,
      fault_code_id: faultCode?.id,
      description,
      is_downtime: downtime > 0,
    }, worker).work_order;
    db.prepare('UPDATE work_orders SET reported_at=?, downtime_minutes=? WHERE id=?')
      .run(`2026-07-${String(day).padStart(2, '0')}T08:00:00.000Z`, downtime, order.id);
    return order;
  };
  const orders = [
    makeOrder(process1, equipment1, fault1, '', 2, 30),
    makeOrder(process1, equipment1, fault2, '', 3, 20),
    makeOrder(process2, equipment1, fault1, '', 4, 10),
    makeOrder(process2, equipment2, null, '未能判断具体故障', 5, 0),
  ];
  return { db, service, manager, worker, line1, line2, equipment1, orders };
}

test('运营报表按产线、故障类别及设备发生时产线排行', () => {
  const f = fixture();
  const input = { start: '2026-07-01', end: '2026-08-01' };
  const report = f.service.operationalReport(input, f.manager);

  assert.deepEqual(report.lines.map((item) => [item.line_name, item.fault_count]), [
    ['一号产线', 2], ['二号产线', 2],
  ]);
  assert.equal(report.fault_categories.find((item) => item.category === '电气故障').fault_count, 3,
    '同类别下不同部位和现象必须合并');
  assert.equal(report.fault_categories.find((item) => item.category === '未分类').fault_count, 1);
  const equipmentRows = report.equipment.filter((item) => item.equipment_id === f.equipment1.id);
  assert.deepEqual(equipmentRows.map((item) => [item.line_name, item.fault_count]), [
    ['一号产线', 2], ['二号产线', 1],
  ], '同一设备跨产线时按故障发生时产线拆开');
  f.db.close();
});

test('排行下钻只返回所选分组的工单，并沿用报表权限', () => {
  const f = fixture();
  const base = { start: '2026-07-01', end: '2026-08-01' };
  const byLine = f.service.operationalReportWorkOrders({ ...base, kind: 'line', line_id: f.line1.id }, f.manager);
  assert.equal(byLine.length, 2);
  assert.ok(byLine.every((item) => item.line_id === f.line1.id));

  const byCategory = f.service.operationalReportWorkOrders({
    ...base, kind: 'fault_category', category_key: '电气故障',
  }, f.manager);
  assert.equal(byCategory.length, 3);
  assert.ok(byCategory.every((item) => item.fault_category === '电气故障'));

  const byEquipmentLine = f.service.operationalReportWorkOrders({
    ...base, kind: 'equipment', equipment_id: f.equipment1.id, line_id: f.line2.id,
  }, f.manager);
  assert.equal(byEquipmentLine.length, 1);
  assert.equal(byEquipmentLine[0].id, f.orders[2].id);
  assert.throws(() => f.service.operationalReportWorkOrders({ ...base, kind: 'bad' }, f.manager), /下钻类型无效/);
  assert.throws(() => f.service.operationalReportWorkOrders({ ...base, kind: 'line', line_id: f.line1.id }, f.worker), /无权/);
  f.db.close();
});
