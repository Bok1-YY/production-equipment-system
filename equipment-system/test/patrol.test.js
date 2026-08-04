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

function fixture() {
  const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-patrol-'));
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db, { attachmentRoot });
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
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  // 把设备装到机位上，巡检时才能自动带出工序
  service.createCompositionChange({
    action: 'INSTALL', equipment_id: equipment.id, to_position_id: position.id, reason: '初始安装',
  }, manager);
  const change = service.listCompositionChanges()[0];
  service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, reviewer);

  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  const cleanup = () => { db.close(); fs.rmSync(attachmentRoot, { recursive: true, force: true }); };
  return { db, service, manager, worker, technician, process, position, equipment, faultCode, cleanup };
}

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
const photo = (name = '巡检照片.jpg') => ({ content_base64: jpeg(), name });

test('技术员扫码巡检：编号、拍照、发现说明都记下来，并自动带出所在工序', () => {
  const { service, technician, equipment, process, cleanup } = fixture();
  const created = service.createPatrolRecord({
    equipment_id: equipment.id,
    findings: '机头下方有轻微渗油，已擦净并紧固接头，观察中',
    attachments: [photo(), photo('渗油部位.jpg')],
  }, technician);

  assert.match(created.patrol_no, /^PT-\d{8}-00001$/);
  assert.equal(created.patroller, '技术员张三');
  assert.equal(created.patroller_user_id, technician.user_id);
  assert.equal(created.equipment_code, equipment.code);
  assert.equal(created.process_id, process.id, '只给了设备时应自动带出它当前所在的工序');
  assert.equal(created.process_name, '挤出工序');
  assert.equal(created.line_name, '一号产线');
  assert.equal(created.attachments.length, 2);
  assert.equal(created.work_order_id, null);

  const second = service.createPatrolRecord({ equipment_id: equipment.id, findings: '一切正常', attachments: [photo()] }, technician);
  assert.match(second.patrol_no, /^PT-\d{8}-00002$/, '巡检单号要连续发');
  cleanup();
});

test('巡检发现必填，且必须指明巡检对象', () => {
  const { service, technician, equipment, cleanup } = fixture();
  assert.throws(() => service.createPatrolRecord({ equipment_id: equipment.id }, technician), /巡检发现不能为空/);
  assert.throws(() => service.createPatrolRecord({ equipment_id: equipment.id, findings: '   ' }, technician), /巡检发现不能为空/);
  assert.throws(() => service.createPatrolRecord({ findings: '转了一圈没事' }, technician), /请先扫码或选择巡检的设备/);
  cleanup();
});

test('巡检必须至少提交一张现场照片', () => {
  const { service, technician, equipment, cleanup } = fixture();
  assert.throws(() => service.createPatrolRecord({
    equipment_id: equipment.id, findings: '设备运行正常', attachments: [],
  }, technician), (error) => error.code === 'PATROL_PHOTO_REQUIRED');
  cleanup();
});

test('普工不能巡检，也看不到巡检记录', () => {
  const { service, technician, worker, equipment, cleanup } = fixture();
  service.createPatrolRecord({ equipment_id: equipment.id, findings: '正常', attachments: [photo()] }, technician);
  assert.throws(() => service.createPatrolRecord({ equipment_id: equipment.id, findings: '我也来巡' }, worker), /无权/);
  assert.throws(() => service.listPatrolRecords(worker), /无权查看巡检记录/);
  assert.equal(service.listPatrolRecords(technician).length, 1);
  assert.equal(service.listPatrolRecords(null).length, 1, '服务内部调用不过滤');
  cleanup();
});

test('巡检照片不对普工开放', () => {
  const { service, technician, worker, equipment, cleanup } = fixture();
  const created = service.createPatrolRecord({
    equipment_id: equipment.id, findings: '皮带偏磨', attachments: [photo()],
  }, technician);
  const id = created.attachments[0].id;
  assert.doesNotThrow(() => service.attachmentFile(id, technician));
  assert.throws(() => service.attachmentFile(id, worker), /无权查看巡检照片/);
  cleanup();
});

test('当场解决不了的巡检可以转成维修工单，两边互相关联', () => {
  const { service, technician, equipment, faultCode, cleanup } = fixture();
  const patrol = service.createPatrolRecord({
    equipment_id: equipment.id, findings: '轴承处有持续异响，现场无法处理，需要停机拆检',
    attachments: [photo()],
  }, technician);

  const result = service.convertPatrolToWorkOrder(patrol.id, {
    fault_code_id: faultCode.id, urgency: 'URGENT',
  }, technician);

  assert.equal(result.work_order.reported_equipment_id, equipment.id);
  assert.equal(result.work_order.fault_code_id, faultCode.id);
  assert.equal(result.work_order.urgency, 'URGENT');
  assert.match(result.work_order.description, /由巡检 PT-\d{8}-00001 转入/);
  assert.match(result.work_order.description, /轴承处有持续异响/, '巡检发现要带进工单，技术员不用重打一遍');

  assert.equal(result.patrol.work_order_id, result.work_order.id);
  assert.equal(result.patrol.work_order_no, result.work_order.work_order_no);
  assert.equal(result.patrol.has_issue, 1);
  assert.ok(service.getWorkOrder(result.work_order.id).history.some((h) => h.event_type === 'FROM_PATROL'));

  // 转过一次就不能再转
  assert.throws(() => service.convertPatrolToWorkOrder(patrol.id, { fault_code_id: faultCode.id }, technician), /已经转过维修工单/);
  cleanup();
});

test('转维修会触发设备状态联动', () => {
  const { service, technician, equipment, faultCode, cleanup } = fixture();
  assert.equal(service.getEquipment(equipment.id).status, 'ACTIVE');
  const patrol = service.createPatrolRecord({ equipment_id: equipment.id, findings: '需要停机处理', attachments: [photo()] }, technician);
  assert.equal(service.getEquipment(equipment.id).status, 'ACTIVE', '光巡检不改设备状态');
  service.convertPatrolToWorkOrder(patrol.id, { fault_code_id: faultCode.id }, technician);
  assert.equal(service.getEquipment(equipment.id).status, 'REPORTED', '转成工单后才进入报修状态');
  cleanup();
});

test('巡检转出的工单必须由接单技工拍维修完成照片才能结单', () => {
  const { service, technician, worker, equipment, faultCode, cleanup } = fixture();
  const patrol = service.createPatrolRecord({
    equipment_id: equipment.id,
    findings: '轴承持续异响，需要停机处理',
    attachments: [photo('巡检发现.jpg')],
  }, technician);
  const converted = service.convertPatrolToWorkOrder(patrol.id, {
    fault_code_id: faultCode.id, urgency: 'URGENT',
  }, technician);
  const id = converted.work_order.id;
  let detail = service.getWorkOrder(id);
  assert.equal(detail.work_order.source_patrol_id, patrol.id);
  assert.equal(detail.work_order.source_patrol_no, patrol.patrol_no);
  assert.equal(detail.work_order.requires_completion_photo, true);
  assert.deepEqual(detail.completion_attachments, []);

  service.assignWorkOrder(id, {}, technician);
  assert.throws(() => service.addWorkOrderCompletionAttachments(id, {
    attachments: [photo('过早拍摄.jpg')],
  }, technician), (error) => error.code === 'REPAIR_NOT_STARTED');

  service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, technician);
  service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, technician);
  assert.throws(() => service.addWorkOrderCompletionAttachments(id, {
    attachments: [photo('越权拍摄.jpg')],
  }, worker), /无权/);

  // 普通“补拍照片”不能冒充维修完成凭证。
  service.addWorkOrderAttachments(id, { attachments: [photo('普通补拍.jpg')] }, technician);
  service.updateRepairDetail(id, {
    diagnosis: '轴承润滑不足', repair_action: '补充润滑并调整轴承间隙',
  }, technician);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, technician);
  service.updateTrialResult(id, { trial_result: 'NORMAL' }, technician);
  assert.throws(() => service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, technician),
    (error) => error.code === 'REPAIR_COMPLETION_PHOTO_REQUIRED');

  const completionPhotos = service.addWorkOrderCompletionAttachments(id, {
    attachments: [photo('维修完成.jpg')],
  }, technician);
  assert.equal(completionPhotos.length, 1);
  assert.equal(completionPhotos[0].target_type, 'WORK_ORDER_COMPLETION');
  assert.doesNotThrow(() => service.attachmentFile(completionPhotos[0].id, technician));
  detail = service.getWorkOrder(id);
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.completion_attachments.length, 1);
  assert.ok(detail.history.some((item) => item.event_type === 'COMPLETION_PHOTO_ADDED'));
  assert.equal(service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, technician).work_order.status,
    'COMPLETED');
  cleanup();
});

test('巡检记录进入设备履历，并计入统计', () => {
  const { service, technician, equipment, cleanup } = fixture();
  service.createPatrolRecord({ equipment_id: equipment.id, findings: '正常', attachments: [photo()] }, technician);
  service.createPatrolRecord({ equipment_id: equipment.id, findings: '润滑已补', attachments: [photo()] }, technician);

  const history = service.equipmentHistory(equipment.id);
  assert.equal(history.patrols.length, 2);
  assert.equal(history.patrols[0].findings, '润滑已补', '最新的在最前');
  assert.equal(history.patrols[1].attachments.length, 1);
  assert.equal(history.summary.patrols, 2);
  assert.ok(history.summary.last_patrol_at);
  assert.equal(history.summary.photos, 2);
  cleanup();
});

test('没有关联工序的巡检不能转维修', () => {
  const { service, manager, technician, cleanup } = fixture();
  // 一台没装在任何机位上的设备
  const spare = service.createEquipment({
    standard_name: '仓库备用机', category: '生产主机', type_code: 'MIX',
  }, manager);
  const patrol = service.createPatrolRecord({ equipment_id: spare.id, findings: '库存机外观有锈迹', attachments: [photo()] }, technician);
  assert.equal(patrol.process_id, null);
  assert.throws(() => service.convertPatrolToWorkOrder(patrol.id, {}, technician), /没有关联工序/);
  cleanup();
});
