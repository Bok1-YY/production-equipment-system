'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { EquipmentService, ROLES } = require('../src/service');

const admin = { actor: '设备管理员', role: ROLES.EQUIPMENT_ADMIN };
const supervisor = { actor: '生产主管', role: ROLES.PRODUCTION_SUPERVISOR };
const technician = { actor: '技术员张三', role: ROLES.TECHNICIAN };
const employee = { actor: '员工李四', role: ROLES.EMPLOYEE };
const systemAdmin = { actor: '系统管理员', role: ROLES.ADMIN };

function equipmentInput(input) {
  return { type_code: 'EXT', key_spec: '', ...input };
}

function fixture() {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, admin);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, admin);
  const position1 = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P01', name: '主机位' }, admin);
  const position2 = service.createPosition({ process_id: process.id, code: 'YSM-L01-EX-P02', name: '备用机位' }, admin);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, line, process, position1, position2, faultCode };
}

test('一个工厂可新增多个车间，编码锁定且名称可修改', () => {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const factory = service.organization().factories[0];
  const created = service.createWorkshop({ factory_id: factory.id, code: 'ysm-ws02', name: '二号生产车间' }, admin);
  assert.equal(created.code, 'YSM-WS02');
  assert.equal(service.organizationTree()[0].workshops.length, 2);

  const updated = service.updateWorkshop(created.id, { code: 'SHOULD-NOT-CHANGE', name: '注塑车间' }, admin);
  assert.equal(updated.code, 'YSM-WS02');
  assert.equal(updated.name, '注塑车间');
  const line = service.createLine({ workshop_id: created.id, code: 'YSM-INJ-L01', name: '注塑一线' }, admin);
  assert.equal(service.organizationTree()[0].workshops.find((item) => item.id === created.id).lines[0].id, line.id);
  assert.throws(() => service.createWorkshop({ factory_id: factory.id, code: 'YSM-WS02', name: '重复车间' }, admin), /车间编码已存在/);
  assert.throws(() => service.createWorkshop({ factory_id: factory.id, code: 'YSM-WS03', name: '无权限车间' }, employee), /无权/);
  assert.ok(service.auditLogs().some((item) => item.entity_type === 'workshop' && item.action === 'UPDATE'));
  db.close();
});

test('结构可停用并保留历史，停用节点及其下级不能再创建业务', () => {
  const { db, service, process } = fixture();
  const qrToken = service.processQrLabels().find((item) => item.id === process.id).qr_token;
  const disabled = service.updateStructureStatus('process', process.id, { status: 'DISABLED' }, admin);
  assert.equal(disabled.status, 'DISABLED');
  assert.equal(service.organizationTree()[0].workshops[0].lines[0].processes[0].status, 'DISABLED');
  assert.throws(
    () => service.createPosition({
      process_id: process.id, code: 'YSM-L01-EX-P03', name: '停用工序下的机位',
    }, admin),
    /已停用/,
  );
  assert.throws(
    () => service.createWorkOrder({ process_id: process.id, description: '停用工序报修' }, employee),
    /已停用/,
  );
  assert.throws(() => service.resolveQr(qrToken, employee), /已停用/);
  assert.equal(service.processQrLabels().some((item) => item.id === process.id), false);

  const enabled = service.updateStructureStatus('process', process.id, { status: 'ACTIVE' }, admin);
  assert.equal(enabled.status, 'ACTIVE');
  assert.doesNotThrow(() => service.createWorkOrder({
    process_id: process.id, description: '重新启用后可以报修',
  }, employee));
  db.close();
});

test('设备自动获得永久流水码且二维码映射可解析', () => {
  const { db, service, faultCode } = fixture();
  const first = service.createEquipment(equipmentInput({ standard_name: '单螺杆挤出机', category: '生产主机', key_spec: '135' }), admin);
  const second = service.createEquipment(equipmentInput({ standard_name: '模具温控机', category: '辅助设备', type_code: 'CAL' }), admin);
  assert.equal(first.code, 'YSM-EXT-135-0001');
  assert.equal(second.code, 'YSM-CAL-0001');
  assert.equal(service.resolveQr(first.qr_token).target.code, first.code);
  const updated = service.updateEquipment(first.id, {
    ...first, standard_name: '更新后的设备名称', category: '生产主机', verified: true,
  }, admin);
  assert.equal(updated.code, first.code);
  assert.equal(updated.standard_name, '更新后的设备名称');
  assert.equal(updated.verified, 1);
  db.close();
});

test('设备编码按类型和关键规格分别计数，类型目录可维护但已使用类型不能删除', () => {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const first = service.createEquipment(equipmentInput({
    standard_name: '135挤出机一号', category: '生产主机', key_spec: '135',
  }), admin);
  const second = service.createEquipment(equipmentInput({
    standard_name: '135挤出机二号', category: '生产主机', key_spec: '135',
  }), admin);
  const otherSpec = service.createEquipment(equipmentInput({
    standard_name: '110挤出机一号', category: '生产主机', key_spec: '110',
  }), admin);
  const noSpec = service.createEquipment(equipmentInput({
    standard_name: '无规格挤出设备', category: '生产主机',
  }), admin);
  assert.deepEqual(
    [first.code, second.code, otherSpec.code, noSpec.code],
    ['YSM-EXT-135-0001', 'YSM-EXT-135-0002', 'YSM-EXT-110-0001', 'YSM-EXT-0001'],
  );

  const type = service.createEquipmentType({ code: 'TST', name: '测试设备' }, admin);
  assert.equal(service.updateEquipmentType(type.id, { name: '更名后的测试设备' }, admin).code, 'TST');
  assert.equal(service.deleteEquipmentType(type.id, admin).code, 'TST');
  const ext = service.listEquipmentTypes().find((item) => item.code === 'EXT');
  assert.throws(() => service.deleteEquipmentType(ext.id, admin), /已被4台设备使用/);
  db.close();
});

test('设备台账导入先预览，待核实行阻断整批，成功提交后禁止重复文件', () => {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const rows = [
    {
      row_number: 3, standard_name: '135单螺杆挤出机', category: '单螺杆挤出机',
      type_code: 'EXT', key_spec: '135', legacy_code: 'OLD-EXT-01', review_status: '通过',
    },
    {
      row_number: 4, standard_name: '高速混料机组', category: '高速混料机组',
      type_code: 'MIX', key_spec: 'H800-C2500', legacy_code: 'OLD-MIX-01', review_status: '通过',
    },
  ];
  const before = service.listEquipment().length;
  const preview = service.previewEquipmentImport(rows);
  assert.equal(preview.summary.errors, 0);
  assert.deepEqual(preview.rows.map((item) => item.planned_code), [
    'YSM-EXT-135-0001', 'YSM-MIX-H800-C2500-0001',
  ]);
  assert.equal(service.listEquipment().length, before, '预览不得创建设备');

  const blockedRows = rows.map((row, index) => index ? { ...row, review_status: '待核实' } : row);
  assert.throws(
    () => service.commitEquipmentImport(blockedRows, { filename: '待核实.xlsx', file_hash: 'pending-hash' }, admin),
    /不能导入/,
  );
  assert.equal(service.listEquipment().length, 0, '任一行有错时整批不得落库');

  const result = service.commitEquipmentImport(rows, { filename: '设备台账.xlsx', file_hash: 'equipment-hash' }, admin);
  assert.deepEqual(result.equipment_codes, ['YSM-EXT-135-0001', 'YSM-MIX-H800-C2500-0001']);
  assert.throws(
    () => service.commitEquipmentImport(rows, { filename: '设备台账.xlsx', file_hash: 'equipment-hash' }, admin),
    /已经成功导入过/,
  );
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM import_batches WHERE import_type='EQUIPMENT' AND status='FAILED'`).get().count, 1);
  db.close();
});

test('生产主管提交安装和移动，设备科确认后保留历史组合', () => {
  const { db, service, line, position1, position2, faultCode } = fixture();
  const equipment = service.createEquipment(equipmentInput({ standard_name: '单螺杆挤出机', category: '生产主机' }), admin);
  const installedAt = new Date(Date.now() - 60_000).toISOString();
  const install = service.createCompositionChange({
    action: 'INSTALL', equipment_id: equipment.id, to_position_id: position1.id,
    effective_at: installedAt, reason: '设备首次安装',
  }, supervisor);
  service.reviewCompositionChange(install.id, { decision: 'APPROVED' }, admin);
  assert.equal(service.lineComposition(line.id).find((x) => x.position_id === position1.id).equipment_code, equipment.code);

  const movedAt = new Date().toISOString();
  const move = service.createCompositionChange({
    action: 'MOVE', equipment_id: equipment.id, to_position_id: position2.id,
    effective_at: movedAt, reason: '生产布局调整',
  }, supervisor);
  service.reviewCompositionChange(move.id, { decision: 'APPROVED' }, admin);
  assert.equal(service.lineComposition(line.id).find((x) => x.position_id === position2.id).equipment_code, equipment.code);
  assert.equal(service.lineComposition(line.id, new Date(Date.now() - 30_000).toISOString()).find((x) => x.position_id === position1.id).equipment_code, equipment.code);
  assert.ok(service.auditLogs().some((x) => x.entity_type === 'composition_change' && x.action === 'APPROVE'));
  db.close();
});

test('一个机位不能同时安装两台设备', () => {
  const { db, service, position1, faultCode } = fixture();
  const a = service.createEquipment(equipmentInput({ standard_name: '设备A', category: '生产设备' }), admin);
  const b = service.createEquipment(equipmentInput({ standard_name: '设备B', category: '生产设备' }), admin);
  const installA = service.createCompositionChange({ action: 'INSTALL', equipment_id: a.id, to_position_id: position1.id, reason: '安装A' }, supervisor);
  service.reviewCompositionChange(installA.id, { decision: 'APPROVED' }, admin);
  const installB = service.createCompositionChange({ action: 'INSTALL', equipment_id: b.id, to_position_id: position1.id, reason: '安装B' }, supervisor);
  assert.throws(() => service.reviewCompositionChange(installB.id, { decision: 'APPROVED' }, admin), /机位已被占用/);
  db.close();
});

test('报修、分派、维修记录、零件和审核形成完整历史', () => {
  const { db, service, process, faultCode } = fixture();
  const equipment = service.createEquipment(equipmentInput({ standard_name: '温控机', category: '辅助设备' }), admin);
  const created = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: faultCode.id, is_downtime: true,
  }, employee);
  const id = created.work_order.id;
  // 这个文件里的角色是账号体系之前的纯角色桩（没有 user_id），所以按姓名指派、
  // 并用管理员推进：推进工单现在要求是"接单人本人"，管理员不受限。
  // 技术员本人那条路径由 work-order-stages.test.js 用真实账号覆盖。
  service.assignWorkOrder(id, { assignee: '技术员张三' }, supervisor);
  service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, systemAdmin);
  service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, systemAdmin);
  service.updateRepairDetail(id, {
    diagnosis: '加热回路断路', root_cause: '接触器烧蚀', repair_action: '更换接触器并紧固线路',
    trial_result: '连续升温30分钟正常', downtime_minutes: 45, downtime_override_reason: '按现场停机记录修正',
  }, systemAdmin);
  service.addWorkOrderPart(id, { part_name: '交流接触器', specification: 'CJX2-2510', quantity: 1, unit: '只', source: '设备科备件柜' }, systemAdmin);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, systemAdmin);
  const completed = service.transitionWorkOrder(id, { to_status: 'COMPLETED', note: '验收正常' }, systemAdmin);
  assert.equal(completed.work_order.status, 'COMPLETED');
  assert.equal(completed.parts.length, 1);
  // 建单+接单+到场+维修中+维修记录+零件+试运行+完成 = 8 条（合并接单步骤后少了一条）
  assert.ok(completed.history.length >= 8, `历史只有 ${completed.history.length} 条`);
  db.close();
});

test('员工无权审核设备变动，设备科无权冒充技术员流转工单', () => {
  const { db, service, position1, process, faultCode } = fixture();
  const equipment = service.createEquipment(equipmentInput({ standard_name: '测试机', category: '生产设备' }), admin);
  const change = service.createCompositionChange({ action: 'INSTALL', equipment_id: equipment.id, to_position_id: position1.id, reason: '安装' }, supervisor);
  assert.throws(() => service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, employee), /无权/);
  const order = service.createWorkOrder({ process_id: process.id, fault_code_id: faultCode.id }, employee);
  service.assignWorkOrder(order.work_order.id, { assignee: '技术员张三' }, supervisor);
  assert.throws(() => service.transitionWorkOrder(order.work_order.id, { to_status: 'ARRIVED' }, admin), /无权/);
  assert.doesNotThrow(() => service.transitionWorkOrder(order.work_order.id, { to_status: 'ARRIVED' }, systemAdmin));
  db.close();
});

function compositionRow(overrides = {}) {
  return {
    row_number: 2,
    workshop_code: 'YSM-WS01', workshop_name: '生产车间',
    line_code: 'YSM-L02', line_name: '二号产线', supervisor: '王主管',
    process_code: 'YSM-L02-MIX', process_name: '混料工序', process_sequence: '1',
    position_code: 'YSM-L02-MIX-P01', position_name: '主混料机位', position_sequence: '1', position_critical: '是',
    equipment_code: '', legacy_code: 'OLD-MIX-001', equipment_name: '高速混料机', equipment_alias: '2号混料机',
    equipment_category: '生产主机', equipment_type_code: 'MIX', key_spec: 'H800-C2500',
    brand: '优胜', model: 'M100', serial_number: 'SN-MIX-001',
    responsible_person: '李工', equipment_critical: '是', effective_at: '', notes: '初始化',
    ...overrides,
  };
}

test('组合导入先预览不落库，确认后一次建立树、设备和安装日志', () => {
  const { db, service, faultCode } = fixture();
  const before = service.dashboard();
  const rows = [compositionRow()];
  const preview = service.previewCompositionImport(rows);
  assert.deepEqual(preview.summary, {
    rows: 1, errors: 0, warnings: 0, workshops_created: 0, lines_created: 1,
    processes_created: 1, positions_created: 1, equipment_created: 1, equipment_reused: 0, installations: 1,
  });
  assert.deepEqual(service.dashboard(), before, '预览阶段不得写入任何数据');

  const result = service.commitCompositionImport(rows, { filename: '组合.xlsx', file_hash: 'hash-one' }, admin);
  assert.equal(result.equipment_codes[0], 'YSM-MIX-H800-C2500-0001');
  const line = service.organizationTree()[0].workshops[0].lines.find((item) => item.code === 'YSM-L02');
  assert.equal(line.processes[0].positions[0].equipment.code, 'YSM-MIX-H800-C2500-0001');
  assert.ok(service.auditLogs().some((item) => item.entity_type === 'import_batch' && item.action === 'COMMIT'));
  assert.throws(
    () => service.commitCompositionImport(rows, { filename: '组合.xlsx', file_hash: 'hash-one' }, admin),
    /已经成功导入过/,
  );
  db.close();
});

test('组合导入严格复用原资产编号，并阻止文件内部层级冲突', () => {
  const { db, service, faultCode } = fixture();
  const existing = service.createEquipment(equipmentInput({
    standard_name: '高速混料机', category: '生产主机', legacy_code: 'old-mix-001', brand: '优胜', serial_number: 'SN-MIX-001',
  }), admin);
  const preview = service.previewCompositionImport([compositionRow({ equipment_name: '旧表里的别名名称' })]);
  assert.equal(preview.summary.equipment_reused, 1);
  assert.equal(preview.summary.equipment_created, 0);
  assert.match(preview.rows[0].warnings[0], /以台账为准/);
  service.commitCompositionImport([compositionRow({ equipment_name: '旧表里的别名名称' })], { filename: '复用.xlsx', file_hash: 'hash-two' }, admin);
  assert.equal(service.listEquipment().length, 1);
  assert.equal(service.listEquipment()[0].id, existing.id);

  const conflict = service.previewCompositionImport([
    compositionRow({ row_number: 2, position_code: 'YSM-L03-P01', line_code: 'YSM-L03', line_name: '三号线', process_code: 'YSM-L03-PRO', equipment_code: '', legacy_code: '', equipment_name: '', equipment_category: '', brand: '', model: '', serial_number: '' }),
    compositionRow({ row_number: 3, position_code: 'YSM-L03-P02', line_code: 'YSM-L03', line_name: '改名的三号线', process_code: 'YSM-L03-PRO', equipment_code: '', legacy_code: '', equipment_name: '', equipment_category: '', brand: '', model: '', serial_number: '' }),
  ]);
  assert.ok(conflict.summary.errors > 0);
  const countsBefore = service.organization();
  assert.throws(() => service.commitCompositionImport(conflict.rows.map((x) => x.row), { filename: '冲突.xlsx', file_hash: 'hash-three' }, admin), /不能导入/);
  assert.equal(service.organization().lines.length, countsBefore.lines.length, '错误文件不得部分落库');
  db.close();
});

test('结构分支只允许删除无业务历史的空分支，工单和安装历史都必须保留', () => {
  const empty = fixture();
  const preview = empty.service.structureDeletionPreview('line', empty.line.id);
  assert.equal(preview.deletable, true);
  assert.deepEqual(preview.counts, {
    workshops: 0, lines: 1, processes: 1, positions: 2,
    work_orders_to_delete: 0, patrol_records: 0,
  });
  const deleted = empty.service.deleteStructureBranch('line', empty.line.id, admin);
  assert.equal(deleted.deleted.positions, 2);
  assert.equal(empty.service.organization().lines.some((item) => item.id === empty.line.id), false);
  assert.ok(empty.service.auditLogs().some((item) => item.entity_type === 'structure_branch' && item.action === 'DELETE'));
  empty.db.close();

  const withOrder = fixture();
  withOrder.service.createWorkOrder({ process_id: withOrder.process.id, fault_code_id: withOrder.faultCode.id }, employee);
  const orderPreview = withOrder.service.structureDeletionPreview('line', withOrder.line.id);
  assert.equal(orderPreview.deletable, false);
  assert.equal(orderPreview.counts.work_orders_to_delete, 1);
  assert.match(orderPreview.blockers.join('；'), /维修工单/);
  assert.throws(() => withOrder.service.deleteStructureBranch('line', withOrder.line.id, admin), /维修工单/);
  assert.equal(withOrder.db.prepare('SELECT COUNT(*) AS count FROM work_orders').get().count, 1);
  assert.equal(withOrder.db.prepare('SELECT COUNT(*) AS count FROM work_order_history').get().count, 1);
  withOrder.db.close();

  const withInstallation = fixture();
  const equipment = withInstallation.service.createEquipment(equipmentInput({
    standard_name: '测试安装设备', category: '生产设备',
  }), admin);
  const change = withInstallation.service.createCompositionChange({
    action: 'INSTALL', equipment_id: equipment.id, to_position_id: withInstallation.position1.id, reason: '测试安装',
  }, supervisor);
  withInstallation.service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, admin);
  const usedPreview = withInstallation.service.structureDeletionPreview('workshop', withInstallation.service.organization().workshops[0].id);
  assert.equal(usedPreview.deletable, false);
  assert.match(usedPreview.blockers.join('；'), /安装历史/);
  assert.throws(
    () => withInstallation.service.deleteStructureBranch('position', withInstallation.position1.id, employee),
    /无权/,
  );
  withInstallation.db.close();
});

// ---- 设备清单里的层级字段：分级选择器（车间 → 产线 → 设备）全靠这几个字段 ----

test('设备清单带车间和工位顺序，且按车间/产线/工位排序', () => {
  const { db, service, line, process, position1, position2 } = fixture();
  const workshop = service.organization().workshops[0];
  // 故意让工位顺序和创建顺序相反，验证排序真的按 sequence_no 走
  service.updatePosition(position1.id, { code: position1.code, name: '主机位', sequence_no: 2 }, admin);
  service.updatePosition(position2.id, { code: position2.code, name: '备用机位', sequence_no: 1 }, admin);

  const first = service.createEquipment(equipmentInput({ standard_name: '挤出机A', category: '生产主机', key_spec: '135' }), admin);
  const second = service.createEquipment(equipmentInput({ standard_name: '挤出机B', category: '生产主机', key_spec: '110' }), admin);
  const approve = (input) => {
    service.createCompositionChange(input, supervisor);
    const change = service.listCompositionChanges()[0];
    service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, admin);
  };
  approve({ action: 'INSTALL', equipment_id: first.id, to_position_id: position1.id, reason: '装到主机位' });
  approve({ action: 'INSTALL', equipment_id: second.id, to_position_id: position2.id, reason: '装到备用机位' });
  // 一台不安装的：选择器要把它归到"未安装"分组，仍然选得到
  const loose = service.createEquipment(equipmentInput({ standard_name: '备用泵', category: '辅机', key_spec: 'X1' }), admin);

  const list = service.listEquipment();
  const byId = (id) => list.find((item) => item.id === id);

  assert.equal(byId(first.id).workshop_id, workshop.id, '分级选择器的第一级要靠 workshop_id');
  assert.equal(byId(first.id).workshop_name, workshop.name);
  assert.equal(byId(first.id).line_id, line.id);
  assert.equal(byId(first.id).process_id, process.id);
  assert.equal(byId(first.id).position_sequence, 2, '工位顺序要带出来——工人是按"这条线第几位"认机器的');
  assert.equal(byId(second.id).position_sequence, 1);

  // 未安装的设备这几个字段为 null，前端据此归到"未安装"分组
  assert.equal(byId(loose.id).workshop_id, null);
  assert.equal(byId(loose.id).line_id, null);
  assert.equal(byId(loose.id).position_sequence, null);

  // 排序：同一条产线上按工位顺序，未安装的排最后
  const installed = list.filter((item) => item.line_id === line.id);
  assert.deepEqual(installed.map((item) => item.position_sequence), [1, 2], '同一条产线上要按工位顺序返回');
  assert.equal(list[list.length - 1].id, loose.id, '未安装的设备排在最后');
  db.close();
});
