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
const { DEFAULT_FAULT_CODES, FALLBACK_FAULT_CODE } = require('../src/fault-codes');

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
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  return { db, service, manager, worker, technician, process, equipment };
}

const codeByName = (service, code) => service.listFaultCodes().codes.find((item) => item.code === code);

test('预置故障码覆盖旧系统那批故障，并按三级结构分组', () => {
  const { db, service } = fixture();
  const { codes, categories } = service.listFaultCodes();
  assert.equal(codes.length, DEFAULT_FAULT_CODES.length);

  assert.deepEqual(categories.map((item) => item.category), ['电气故障', '机械故障', '液压气动', '综合']);
  const electrical = categories.find((item) => item.category === '电气故障');
  assert.ok(electrical.parts.some((item) => item.part === '主电机'));
  const motor = electrical.parts.find((item) => item.part === '主电机');
  assert.ok(motor.symptoms.length >= 4, '主电机下面应该有多个故障现象');
  assert.ok(motor.symptoms.every((item) => item.category === '电气故障' && item.part === '主电机'));

  // 旧系统那些故障都得有对应项
  const all = codes.map((item) => `${item.part}${item.symptom}`).join('|');
  for (const keyword of ['轴承', '链条', '漏油', '漏料', '短路', '磨损', '松动']) {
    assert.ok(all.includes(keyword), `预置故障码里缺少「${keyword}」`);
  }
  // 全部标记为系统预置，界面上要提示待确认
  assert.ok(codes.every((item) => item.is_seeded === 1));
  db.close();
});

test('拍照要求只加在拍了有用的故障上', () => {
  const { db, service } = fixture();
  assert.equal(codeByName(service, 'HY-PIP-OIL').requires_photo, 1, '漏油应该强制拍照');
  assert.equal(codeByName(service, 'ME-STR-DAMAGE').requires_photo, 1, '外观损坏应该强制拍照');
  assert.equal(codeByName(service, 'ME-BRG-NOISE').requires_photo, 0, '异响拍照没意义，不该强制');
  assert.equal(codeByName(service, 'EL-PWR-SHORT').default_urgency, 'CRITICAL');
  assert.equal(codeByName(service, 'EL-PWR-SHORT').requires_downtime, 1);
  db.close();
});

test('故障码表非空时不再补种，管理员删掉的预置项重启后不会复活', () => {
  // 必须用真实文件库：:memory: 关掉就没了，测不出"重启后"的行为。
  const file = path.join(os.tmpdir(), `ysm-faultcode-seed-${crypto.randomUUID()}.db`);
  try {
    const first = openDatabase(file);
    const before = new EquipmentService(first).listFaultCodes().codes.length;
    first.prepare('DELETE FROM fault_codes WHERE code=?').run('ME-BRG-NOISE');
    first.close();

    const second = openDatabase(file);   // 模拟重启：重新走一遍 migrate + seed
    const after = new EquipmentService(second).listFaultCodes().codes.length;
    assert.equal(after, before - 1, '删掉的预置项不该在重启后被重新种回来');
    assert.equal(new EquipmentService(second).listFaultCodes().codes.some((x) => x.code === 'ME-BRG-NOISE'), false);
    second.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch { /* 没有就算了 */ } }
  }
});

test('管理员可以增删改故障码，非管理员不能', () => {
  const { db, service, manager, technician, worker } = fixture();
  const created = service.createFaultCode({
    code: 'ME-GEAR-BROKEN', category: '机械故障', part: '齿轮箱', symptom: '打齿',
    suggested_action: '开盖检查齿面', default_urgency: 'URGENT', requires_photo: true,
  }, manager);
  assert.equal(created.is_seeded, 0, '人工新增的不算预置');
  assert.equal(created.requires_photo, 1);
  assert.ok(service.listFaultCodes().categories.find((c) => c.category === '机械故障').parts.some((p) => p.part === '齿轮箱'));

  const updated = service.updateFaultCode(created.id, { symptom: '打齿异响', status: 'DISABLED' }, manager);
  assert.equal(updated.symptom, '打齿异响');
  assert.equal(updated.status, 'DISABLED');
  // 停用之后不出现在报修用的列表里，但管理页看得到
  assert.equal(service.listFaultCodes().codes.some((item) => item.id === created.id), false);
  assert.equal(service.listFaultCodes({ includeDisabled: true }).codes.some((item) => item.id === created.id), true);

  assert.throws(() => service.createFaultCode({ code: 'X-1', category: 'a', part: 'b', symptom: 'c' }, technician), /无权/);
  assert.throws(() => service.updateFaultCode(created.id, { symptom: 'x' }, worker), /无权/);
  assert.throws(() => service.deleteFaultCode(created.id, technician), /无权/);
  assert.doesNotThrow(() => service.deleteFaultCode(created.id, manager));
  db.close();
});

test('重复的代码或“类别+部位+现象”组合会被拒绝', () => {
  const { db, service, manager } = fixture();
  assert.throws(() => service.createFaultCode({
    code: 'HY-PIP-OIL', category: '液压气动', part: '管路', symptom: '别的现象',
  }, manager), /已存在/);
  assert.throws(() => service.createFaultCode({
    code: 'NEW-CODE-1', category: '液压气动', part: '管路', symptom: '漏油',
  }, manager), /已存在/);
  assert.throws(() => service.createFaultCode({
    code: '小写不行', category: 'a', part: 'b', symptom: 'c',
  }, manager), /只能使用大写字母/);
  db.close();
});

test('已被工单引用的故障码只能停用不能删除', () => {
  const { db, service, manager, worker, process, equipment } = fixture();
  const code = codeByName(service, 'ME-BRG-NOISE');
  service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: code.id,
  }, worker);
  assert.throws(() => service.deleteFaultCode(code.id, manager), /已被1张工单使用/);
  assert.doesNotThrow(() => service.updateFaultCode(code.id, { status: 'DISABLED' }, manager));
  db.close();
});

// 2026-07-26：故障码在报修时改为选填（录入点挪到结单，见 quick-report.test.js）。
// 但"既不选码也不写一句话"仍然要拒——那样的工单对技术员没有任何信息量。
test('报修不选故障代码时必须写一句话，故障现象由代码回填', () => {
  const { db, service, worker, process, equipment } = fixture();
  assert.throws(() => service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id,
  }, worker), /请用一句话说明/);

  const code = codeByName(service, 'ME-BRG-NOISE');
  const created = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: code.id,
  }, worker).work_order;
  assert.equal(created.fault_code_id, code.id);
  assert.equal(created.fault_symptom, '机械故障 / 轴承 / 异响', '故障现象应由故障码回填，供列表和履历直接显示');
  db.close();
});

test('故障码的默认紧急程度和停机标记会带过来，但报修人显式选择优先', () => {
  const { db, service, worker, process, equipment } = fixture();
  const critical = codeByName(service, 'EL-PWR-SHORT');
  const auto = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: critical.id,
    attachments: [{ content_base64: jpegBase64() }],
  }, worker).work_order;
  assert.equal(auto.urgency, 'CRITICAL');
  assert.equal(auto.is_downtime, 1);

  const overridden = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: critical.id,
    urgency: 'NORMAL', attachments: [{ content_base64: jpegBase64() }],
  }, worker).work_order;
  assert.equal(overridden.urgency, 'NORMAL', '报修人显式选的紧急程度优先');
  db.close();
});

test('选“其他”时必须填补充说明，并用补充说明作为故障现象', () => {
  const { db, service, worker, process, equipment } = fixture();
  const other = codeByName(service, FALLBACK_FAULT_CODE);
  assert.throws(() => service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: other.id,
  }, worker), /必须描述具体故障/);

  const created = service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: other.id,
    description: '开机后有股胶皮烧焦味，说不清是哪里',
  }, worker).work_order;
  assert.equal(created.fault_symptom, '开机后有股胶皮烧焦味，说不清是哪里', '不能让工单列表里排一堆“其他”');
  db.close();
});

test('停用的故障码不能用来报修', () => {
  const { db, service, manager, worker, process, equipment } = fixture();
  const code = codeByName(service, 'ME-BRG-NOISE');
  service.updateFaultCode(code.id, { status: 'DISABLED' }, manager);
  assert.throws(() => service.createWorkOrder({
    process_id: process.id, equipment_id: equipment.id, fault_code_id: code.id,
  }, worker), /已停用/);
  db.close();
});

// ---- 报修页的"常用故障"快捷按钮 ----

test('一张工单都没有时，快捷按钮回退到标了常用的那几条', () => {
  const { db, service, equipment } = fixture();
  const quick = service.frequentFaultCodes(equipment.id);
  assert.ok(quick.length > 0, '刚上线就打开报修页也不能是一排空按钮');
  // 预置里标了 is_common 的都是"站在机器边上就能判断"的整机级故障
  assert.ok(quick.slice(0, 3).every((item) => item.is_common === 1),
    '没有历史数据时，排在最前面的应该是常用标记那几条');
  assert.ok(quick.some((item) => item.symptom.includes('无法启动')));
  db.close();
});

test('快捷按钮里不出现兜底码「其他」', () => {
  const { db, service, equipment } = fixture();
  assert.ok(!service.frequentFaultCodes(equipment.id).some((item) => item.code === FALLBACK_FAULT_CODE),
    '点「其他」还要再填一段文字，和"不选码直接写一句话"完全重复');
  db.close();
});

test('攒起历史工单之后，快捷按钮改按频次排', () => {
  const { db, service, worker, process, equipment } = fixture();
  const hot = codeByName(service, 'ME-BRG-NOISE');
  for (let i = 0; i < 3; i += 1) {
    service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: hot.id }, worker);
  }
  const once = codeByName(service, 'ME-CHN-LOOSE');
  service.createWorkOrder({ process_id: process.id, equipment_id: equipment.id, fault_code_id: once.id }, worker);

  const quick = service.frequentFaultCodes(equipment.id);
  assert.equal(quick[0].code, 'ME-BRG-NOISE', '报得最多的排第一');
  assert.equal(quick[1].code, 'ME-CHN-LOOSE');
  // 频次不够 6 条时，剩下的用常用标记补齐，按钮不会只剩两个
  assert.equal(quick.length, 6);
  assert.equal(new Set(quick.map((item) => item.id)).size, 6, '补齐时不能出现重复项');
  db.close();
});

test('停用的故障码不会出现在快捷按钮里', () => {
  const { db, service, manager, equipment } = fixture();
  const target = service.frequentFaultCodes(equipment.id)[0];
  service.updateFaultCode(target.id, { ...target, status: 'DISABLED' }, manager);
  assert.ok(!service.frequentFaultCodes(equipment.id).some((item) => item.id === target.id));
  db.close();
});

test('管理员可以自己调整哪几条算常用', () => {
  const { db, service, manager, equipment } = fixture();
  const target = codeByName(service, 'ME-BRG-NOISE');
  assert.equal(target.is_common, 0);
  service.updateFaultCode(target.id, { ...target, is_common: 1 }, manager);
  assert.ok(service.frequentFaultCodes(equipment.id).some((item) => item.code === 'ME-BRG-NOISE'));
  db.close();
});

// 最小的合法 JPEG：魔数 + 结束标记，够通过服务端的格式校验
function jpegBase64() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
}
