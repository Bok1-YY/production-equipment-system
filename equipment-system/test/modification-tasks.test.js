'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { EquipmentService, ROLES } = require('../src/service');

const jpeg = () => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]).toString('base64');

function fixture() {
  const db = openDatabase(':memory:');
  const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-modification-'));
  const service = new EquipmentService(db, { attachmentRoot });
  const adminUser = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const admin = { actor: '系统管理员', role: ROLES.ADMIN, level: 3, user_id: adminUser.id, username: 'admin' };
  const first = service.createUser({ username: 'tech-a', display_name: '主技工', level: 2, password: 'Ysm-test-2026-a' }, admin);
  const second = service.createUser({ username: 'tech-b', display_name: '协作技工', level: 2, password: 'Ysm-test-2026-b' }, admin);
  const primary = { actor: first.display_name, role: ROLES.TECHNICIAN, level: 2, user_id: first.id, username: first.username };
  const collaborator = { actor: second.display_name, role: ROLES.TECHNICIAN, level: 2, user_id: second.id, username: second.username };
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-MOD-L01', name: '技改测试线' }, admin);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-MOD-P01', name: '技改工序' }, admin);
  const position = service.createPosition({ process_id: process.id, code: 'YSM-MOD-S01', name: '目标机位' }, admin);
  const equipment = service.createEquipment({
    type_code: 'EXT', key_spec: 'TEST', standard_name: '待改造设备', category: '生产设备',
  }, admin);
  const cleanup = () => {
    db.close();
    fs.rmSync(attachmentRoot, { recursive: true, force: true });
  };
  return { db, service, attachmentRoot, admin, primary, collaborator, line, position, equipment, cleanup };
}

function addDocument(service, taskId, admin, name = '方案.pdf') {
  service.db.prepare(`
    INSERT INTO attachments(target_type,target_id,file_path,original_name,mime,size,uploaded_by,
      uploader_user_id,created_at,revision_no,sha256,disposition)
    VALUES ('MODIFICATION_DOCUMENT',?,?,?,?,?,?,?,?,?,?,?)
  `).run(taskId, 'test/document.pdf', name, 'application/pdf', 8, admin.actor, admin.user_id,
    new Date().toISOString(), 1, 'test-hash', 'inline');
}

function draft(service, actors, items) {
  const detail = service.createModificationTask({
    title: '一号线设备改造', objective: '完成设备安装并更新现场布局', acceptance_criteria: '安装牢固且资料一致',
    priority: 'URGENT', planned_start_at: '2026-08-04T01:00:00.000Z', due_at: '2027-08-05T01:00:00.000Z',
    primary_assignee_user_id: actors.primary.user_id,
    collaborator_user_ids: actors.collaborator ? [actors.collaborator.user_id] : [],
    items,
  }, actors.admin);
  addDocument(service, detail.task.id, actors.admin);
  return detail;
}

test('技改任务需全员确认、逐项留证，管理员审核后才应用设备安装关系', () => {
  const f = fixture();
  try {
    const created = draft(f.service, f, [{
      target_type: 'EQUIPMENT', action: 'INSTALL', target_id: f.equipment.id,
      title: '安装主机', instructions: '按图纸安装到目标机位',
      payload: { to_position_id: f.position.id }, affects_operation: true, photo_required: true,
    }]);
    const id = created.task.id;
    f.service.publishModificationTask(id, {}, f.admin);
    f.service.acknowledgeModificationTask(id, {}, f.primary);
    assert.equal(f.service.getModificationTask(id, f.admin).task.status, 'PUBLISHED');
    f.service.acknowledgeModificationTask(id, {}, f.collaborator);
    f.service.arriveModificationTask(id, {}, f.primary);
    f.service.startModificationTask(id, {}, f.primary);
    assert.equal(f.service.getEquipment(f.equipment.id).status, 'MODIFYING');
    const item = f.service.getModificationTask(id, f.primary).items[0];
    f.service.updateModificationItemResult(id, item.id, { execution_result: '安装完成，紧固和接线正常' }, f.primary);
    f.service.addModificationItemPhotos(id, item.id, {
      attachments: [{ name: '完工照片.jpg', content_base64: jpeg() }],
    }, f.collaborator);
    f.service.submitModificationTask(id, { completion_summary: '全部按方案完成', outstanding_issues: '' }, f.primary);
    assert.equal(f.service.activeInstallation(f.equipment.id), null, '待审核阶段不得提前改变安装关系');
    const approved = f.service.reviewModificationTask(id, { decision: 'APPROVED' }, f.admin);
    assert.equal(approved.task.status, 'APPROVED');
    assert.equal(f.service.activeInstallation(f.equipment.id).position_id, f.position.id);
    assert.equal(f.service.getEquipment(f.equipment.id).status, 'ACTIVE');
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM composition_changes WHERE modification_task_id=?').get(id).count, 1);
  } finally { f.cleanup(); }
});

test('多项审批任一项目冲突时整单回滚，不留下半条安装关系', () => {
  const f = fixture();
  try {
    const secondEquipment = f.service.createEquipment({
      type_code: 'EXT', key_spec: 'TEST2', standard_name: '第二台设备', category: '生产设备',
    }, f.admin);
    const created = draft(f.service, { ...f, collaborator: null }, [f.equipment, secondEquipment].map((equipment, index) => ({
      target_type: 'EQUIPMENT', action: 'INSTALL', target_id: equipment.id,
      title: `安装设备${index + 1}`, instructions: '安装到同一机位以模拟审批冲突',
      payload: { to_position_id: f.position.id }, affects_operation: false, photo_required: false,
      photo_exemption_reason: '事务冲突测试',
    })));
    const id = created.task.id;
    f.service.publishModificationTask(id, {}, f.admin);
    f.service.acknowledgeModificationTask(id, {}, f.primary);
    f.service.arriveModificationTask(id, {}, f.primary);
    f.service.startModificationTask(id, {}, f.primary);
    for (const item of f.service.getModificationTask(id, f.primary).items) {
      f.service.updateModificationItemResult(id, item.id, { execution_result: '测试完成' }, f.primary);
    }
    f.service.submitModificationTask(id, { completion_summary: '准备审批' }, f.primary);
    assert.throws(
      () => f.service.reviewModificationTask(id, { decision: 'APPROVED' }, f.admin),
      /机位已被占用/,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM equipment_installations').get().count, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM composition_changes WHERE modification_task_id=?').get(id).count, 0);
    assert.equal(f.service.getModificationTask(id, f.admin).task.status, 'PENDING_REVIEW');
  } finally { f.cleanup(); }
});

test('现场偏差触发方案修订，旧确认失效且未改项目施工证据保留', () => {
  const f = fixture();
  try {
    const created = draft(f.service, f, [{
      target_type: 'EQUIPMENT', action: 'RETROFIT', target_id: f.equipment.id,
      title: '更新设备型号', instructions: '按铭牌更新型号', payload: { profile: { model: 'M-2026' } },
      affects_operation: true, photo_required: false, photo_exemption_reason: '仅核对铭牌资料',
    }]);
    const id = created.task.id;
    f.service.publishModificationTask(id, {}, f.admin);
    f.service.acknowledgeModificationTask(id, {}, f.primary);
    f.service.acknowledgeModificationTask(id, {}, f.collaborator);
    f.service.arriveModificationTask(id, {}, f.primary);
    f.service.startModificationTask(id, {}, f.primary);
    const item = f.service.getModificationTask(id, f.primary).items[0];
    f.service.updateModificationItemResult(id, item.id, { execution_result: '铭牌已核对' }, f.primary);
    f.service.reportModificationDeviation(id, { note: '现场补充了一份接线图，需要管理员追加资料' }, f.collaborator);
    f.service.reviseModificationTask(id, { reason: '追加接线图' }, f.admin);
    addDocument(f.service, id, f.admin, '接线图.pdf');
    f.service.publishModificationTask(id, { reason: '补充技术文件，不改变施工项目' }, f.admin);
    const revised = f.service.getModificationTask(id, f.admin);
    assert.equal(revised.task.revision_no, 2);
    assert.equal(revised.task.status, 'PUBLISHED');
    assert.equal(revised.items[0].execution_result, '铭牌已核对');
    assert.ok(revised.members.every((member) => member.acknowledged_revision === 0));
  } finally { f.cleanup(); }
});

test('空产线可以在任务审核时删除，有历史的结构仍被阻止', () => {
  const f = fixture();
  try {
    const created = draft(f.service, { ...f, collaborator: null }, [{
      target_type: 'LINE', action: 'DELETE', target_id: f.line.id,
      title: '删除空测试线', instructions: '确认无业务历史后删除整条空线', payload: {},
      affects_operation: false, photo_required: false, photo_exemption_reason: '系统资料清理无需现场照片',
    }]);
    const id = created.task.id;
    f.service.publishModificationTask(id, {}, f.admin);
    f.service.acknowledgeModificationTask(id, {}, f.primary);
    f.service.arriveModificationTask(id, {}, f.primary);
    f.service.startModificationTask(id, {}, f.primary);
    const item = f.service.getModificationTask(id, f.primary).items[0];
    f.service.updateModificationItemResult(id, item.id, { execution_result: '确认该线未投入使用' }, f.primary);
    f.service.submitModificationTask(id, { completion_summary: '确认可以删除' }, f.primary);
    f.service.reviewModificationTask(id, { decision: 'APPROVED' }, f.admin);
    assert.equal(f.service.organization().lines.some((line) => line.id === f.line.id), false);
  } finally { f.cleanup(); }
});


test('编辑草稿可以交换项目顺序，也能复用被删项目的序号和引用编号', () => {
  const f = fixture();
  try {
    const base = {
      affects_operation: false, photo_required: false, photo_exemption_reason: '资料性调整无需拍照',
    };
    const created = draft(f.service, { ...f, collaborator: null }, [
      { ...base, target_type: 'LINE', action: 'UPDATE', target_id: f.line.id, sequence_no: 1,
        client_ref: 'ref-a', title: '产线改名', instructions: '更新产线名称', payload: { name: '技改新线名' } },
      { ...base, target_type: 'POSITION', action: 'UPDATE', target_id: f.position.id, sequence_no: 2,
        client_ref: 'ref-b', title: '机位改名', instructions: '更新机位名称', payload: { name: '技改新机位' } },
    ]);
    const id = created.task.id;
    const [first, second] = created.items;
    const asInput = (item, overrides) => ({
      id: item.id, target_type: item.target_type, action: item.action, target_id: item.target_id,
      client_ref: item.client_ref, title: item.title, instructions: item.instructions,
      payload: item.payload, affects_operation: item.affects_operation,
      photo_required: item.photo_required, photo_exemption_reason: item.photo_exemption_reason,
      ...overrides,
    });
    // 交换两个项目的顺序：老实现逐行 UPDATE 会撞 UNIQUE(task_id, sequence_no)
    const swapped = f.service.updateModificationTask(id, {
      items: [asInput(second, { sequence_no: 1 }), asInput(first, { sequence_no: 2 })],
    }, f.admin);
    assert.deepEqual(swapped.items.map((item) => item.title), ['机位改名', '产线改名']);
    // 删掉一项后，新项目复用它让出的序号和任务内引用编号
    const replaced = f.service.updateModificationTask(id, {
      items: [
        asInput(swapped.items[0]),
        { ...base, target_type: 'LINE', action: 'UPDATE', target_id: f.line.id, sequence_no: 2,
          client_ref: 'ref-a', title: '第二次产线调整', instructions: '再次更新产线资料', payload: { name: '最终线名' } },
      ],
    }, f.admin);
    assert.deepEqual(replaced.items.map((item) => item.title), ['机位改名', '第二次产线调整']);
    assert.equal(replaced.items[1].client_ref, 'ref-a');
  } finally { f.cleanup(); }
});

test('完工照片批次里任一张非法时整批回滚，不留孤儿附件记录', () => {
  const f = fixture();
  try {
    const created = draft(f.service, { ...f, collaborator: null }, [{
      target_type: 'EQUIPMENT', action: 'INSTALL', target_id: f.equipment.id,
      title: '安装主机', instructions: '按图纸安装到目标机位',
      payload: { to_position_id: f.position.id }, affects_operation: false, photo_required: true,
    }]);
    const id = created.task.id;
    f.service.publishModificationTask(id, {}, f.admin);
    f.service.acknowledgeModificationTask(id, {}, f.primary);
    f.service.arriveModificationTask(id, {}, f.primary);
    f.service.startModificationTask(id, {}, f.primary);
    const item = f.service.getModificationTask(id, f.primary).items[0];
    assert.throws(() => f.service.addModificationItemPhotos(id, item.id, {
      attachments: [
        { name: '合法.jpg', content_base64: jpeg() },
        { name: '非法.jpg', content_base64: Buffer.from('不是图片').toString('base64') },
      ],
    }, f.primary), /只能上传 JPG、PNG 或 WEBP/);
    assert.equal(f.db.prepare(
      "SELECT COUNT(*) count FROM attachments WHERE target_type='MODIFICATION_ITEM' AND target_id=?"
    ).get(item.id).count, 0, '失败批次不能留下指向已删除文件的附件行');
    assert.equal(f.db.prepare(
      "SELECT COUNT(*) count FROM modification_task_history WHERE task_id=? AND event_type='ITEM_PHOTO_ADDED'"
    ).get(id).count, 0, '失败批次不能留下上传历史');
  } finally { f.cleanup(); }
});
