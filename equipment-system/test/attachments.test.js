'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

function contextFor(user) {
  return { actor: user.display_name, user_id: user.id, username: user.username, level: user.level, role: levelToRole(user.level) };
}

// 每个测试用独立临时目录，绝不写到项目的 data/attachments 里去。
function fixture() {
  const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-attach-'));
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db, { attachmentRoot });
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
  const cleanup = () => { db.close(); fs.rmSync(attachmentRoot, { recursive: true, force: true }); };
  return { db, service, manager, worker, other, technician, process, equipment, faultCode, attachmentRoot, cleanup };
}

const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
const png = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1),
]).toString('base64');
const webp = () => Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16, 2),
]).toString('base64');

const photo = (content = jpeg(), name = '现场照片.jpg') => ({ content_base64: content, name });

function report(f, overrides = {}) {
  return f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id, ...overrides,
  }, overrides.as || f.worker);
}

test('报修时带照片：文件落盘、记录入库、能按工单读回来', () => {
  const f = fixture();
  const created = report(f, { attachments: [photo(), photo(png(), '细节.png')] });
  const attachments = created.attachments;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].mime, 'image/jpeg');
  assert.equal(attachments[1].mime, 'image/png');
  assert.equal(attachments[0].uploaded_by, '普工李四');
  assert.equal(attachments[0].original_name, '现场照片.jpg');

  // 文件真的写到磁盘上了，且按年月分目录
  const file = f.service.attachmentFile(attachments[0].id, f.worker);
  assert.ok(fs.existsSync(file.absolute));
  assert.match(file.file_path, /^\d{6}[/\\][0-9a-f]{32}\.jpg$/);
  // 接口不回传服务器上的绝对路径
  assert.equal('file_path' in attachments[0], false);
  f.cleanup();
});

test('只认魔数，伪装成图片的文件一律拒绝', () => {
  const f = fixture();
  const fakeJpg = Buffer.from('这其实是一段文本，不是图片').toString('base64');
  assert.throws(() => report(f, { attachments: [photo(fakeJpg, '假装是图.jpg')] }), /只能上传/);
  // 声明 mime 也没用，服务端根本不看它
  assert.throws(() => f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
    attachments: [{ content_base64: fakeJpg, mime: 'image/jpeg', name: 'x.jpg' }],
  }, f.worker), /只能上传/);
  assert.throws(() => report(f, { attachments: [photo('', '空文件.jpg')] }), /照片内容为空/);
  // 三种合法格式都能过
  assert.doesNotThrow(() => report(f, { attachments: [photo(jpeg()), photo(png()), photo(webp())] }));
  f.cleanup();
});

test('单张超过2MB、单个工单超过6张都会被拒绝', () => {
  const f = fixture();
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  assert.throws(() => report(f, { attachments: [photo(huge)] }), /不能超过2MB/);

  assert.throws(() => report(f, { attachments: Array.from({ length: 7 }, () => photo()) }), /最多只能上传6张/);

  const created = report(f, { attachments: Array.from({ length: 6 }, () => photo()) });
  assert.equal(created.attachments.length, 6);
  assert.throws(() => f.service.addWorkOrderAttachments(created.work_order.id, { attachments: [photo()] }, f.worker), /最多只能上传6张/);
  f.cleanup();
});

test('某一张不合法时，同批已写下的文件会被清理干净，工单也不会建出来', () => {
  const f = fixture();
  const before = f.service.listWorkOrders(f.manager).length;
  assert.throws(() => report(f, {
    attachments: [photo(), photo(Buffer.from('坏文件').toString('base64'), '坏的.jpg')],
  }), /只能上传/);
  assert.equal(f.service.listWorkOrders(f.manager).length, before, '照片失败时整张工单都不该建出来');

  // 临时目录里不该留下任何孤儿文件
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else files.push(full);
    }
  };
  if (fs.existsSync(f.attachmentRoot)) walk(f.attachmentRoot);
  assert.deepEqual(files, [], '失败回滚后不能留下孤儿文件');
  f.cleanup();
});

test('故障码要求拍照时，不传照片的报修会被拒绝', () => {
  const f = fixture();
  const leak = f.service.listFaultCodes().codes.find((item) => item.code === 'HY-PIP-OIL');
  assert.equal(leak.requires_photo, 1);
  assert.throws(() => f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: leak.id,
  }, f.worker), /必须上传现场照片/);
  assert.doesNotThrow(() => f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: leak.id,
    attachments: [photo()],
  }, f.worker));
  f.cleanup();
});

test('照片可见性跟着工单走：普工看不到别人工单的照片', () => {
  const f = fixture();
  const created = report(f, { attachments: [photo()] });
  const id = created.attachments[0].id;
  assert.doesNotThrow(() => f.service.attachmentFile(id, f.worker), '报修人自己能看');
  assert.doesNotThrow(() => f.service.attachmentFile(id, f.technician), '技术员能看');
  assert.doesNotThrow(() => f.service.attachmentFile(id, f.manager), '管理员能看');
  assert.throws(() => f.service.attachmentFile(id, f.other), /只能查看自己报修的工单/);
  f.cleanup();
});

test('照片只能自己或管理员删，且工单结束后不能再删', () => {
  const f = fixture();
  const created = report(f, { attachments: [photo(), photo()] });
  const [first, second] = created.attachments;
  assert.throws(() => f.service.deleteAttachment(first.id, f.other), /只能删除自己上传的照片/);
  assert.doesNotThrow(() => f.service.deleteAttachment(first.id, f.worker));
  assert.doesNotThrow(() => f.service.deleteAttachment(second.id, f.manager), '管理员可以删任何人的');
  assert.equal(f.service.listAttachments('WORK_ORDER', created.work_order.id).length, 0);

  const another = report(f, { attachments: [photo()] });
  const id = another.work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, f.manager);
  assert.throws(() => f.service.deleteAttachment(another.attachments[0].id, f.manager), /已结束工单的照片不能删除/);
  assert.throws(() => f.service.addWorkOrderAttachments(id, { attachments: [photo()] }, f.manager), /已结束工单不能再上传/);
  f.cleanup();
});

test('删除照片会同时清掉磁盘文件', () => {
  const f = fixture();
  const created = report(f, { attachments: [photo()] });
  const file = f.service.attachmentFile(created.attachments[0].id, f.worker);
  assert.ok(fs.existsSync(file.absolute));
  f.service.deleteAttachment(created.attachments[0].id, f.worker);
  assert.equal(fs.existsSync(file.absolute), false, '删记录也要删文件，否则磁盘会一直涨');
  f.cleanup();
});

test('技术员可以给进行中的工单补照片，普工只能补自己的', () => {
  const f = fixture();
  const created = report(f);
  const id = created.work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  const added = f.service.addWorkOrderAttachments(id, { attachments: [photo(png(), '维修后.png')] }, f.technician);
  assert.equal(added.length, 1);
  assert.equal(added[0].uploaded_by, '技术员张三');
  assert.ok(f.service.getWorkOrder(id).history.some((h) => h.event_type === 'PHOTO_ADDED'));

  assert.throws(() => f.service.addWorkOrderAttachments(id, { attachments: [photo()] }, f.other), /只能查看自己报修的工单/);
  assert.throws(() => f.service.addWorkOrderAttachments(id, { attachments: [] }, f.technician), /没有收到照片/);
  f.cleanup();
});

test('设备履历里带上工单照片和统计', () => {
  const f = fixture();
  report(f, { attachments: [photo(), photo()] });
  const history = f.service.equipmentHistory(f.equipment.id);
  assert.equal(history.work_orders[0].attachments.length, 2);
  assert.equal(history.summary.photos, 2);
  f.cleanup();
});
