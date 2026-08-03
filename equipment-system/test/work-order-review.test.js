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
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seed.id));
  const worker = contextFor(service.createUser({ username: 'w001', display_name: '普工李四', level: 1 }, manager));
  const other = contextFor(service.createUser({ username: 'w002', display_name: '普工王五', level: 1 }, manager));
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));
  const technician2 = contextFor(service.createUser({ username: 't002', display_name: '技术员孙七', level: 2 }, manager));
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  return { db, service, manager, worker, other, technician, technician2, process, equipment, faultCode };
}

// 报修 → 抢单 → 修完 → 技术员结单，返回工单id
function repairAndClose(f, tech = f.technician, reporter = f.worker) {
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, reporter).work_order.id;
  f.service.assignWorkOrder(id, {}, tech);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(id, { to_status: status }, tech);
  }
  f.service.updateRepairDetail(id, { diagnosis: '测试诊断', repair_action: '测试维修' }, tech);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, tech);
  f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, tech);
  f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, tech);
  return id;
}

const review = (score = 5) => ({ quality_score: score, attitude_score: score, speed_score: score });
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64');
const photo = (name = '评价照片.jpg') => ({ content_base64: jpeg(), name });

test('技术员现在能自己结单，试运行完直通完成，不再需要管理员验收', () => {
  const f = fixture();
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, f.technician);

  const closed = f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician);
  assert.equal(closed.work_order.status, 'COMPLETED');
  assert.ok(closed.work_order.completed_at);
  assert.equal(f.service.getEquipment(f.equipment.id).status, 'ACTIVE', '结单后设备状态恢复');
  f.db.close();
});

test('结单前仍然必须填试运行结果——权限放开了这道自检更不能丢', () => {
  const f = fixture();
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS', 'TRIAL_RUN']) {
    f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  }
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician), /必须选择有效的试运行结果/);
  f.db.close();
});

test('工单没挂设备就不能开始维修——否则维修记录落不到任何设备账上', () => {
  const f = fixture();
  // 报修时选了"无法判断具体设备"
  const id = f.service.createWorkOrder({
    process_id: f.process.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  assert.equal(f.service.getWorkOrder(id).work_order.final_equipment_id, null);

  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician),
    /核对报修信息.*实际故障设备/);

  // 核对设备之后才能开始维修和结单
  f.service.correctWorkOrderEquipment(id, { equipment_id: f.equipment.id, reason: '到场后确认是这台' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);
  f.service.updateRepairDetail(id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  f.service.updateTrialResult(id, { trial_result: 'NORMAL' }, f.technician);
  const closed = f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician);
  assert.equal(closed.work_order.status, 'COMPLETED');
  assert.equal(closed.work_order.final_equipment_id, f.equipment.id);

  // 修完之后设备履历里确实认得到这次维修
  const history = f.service.equipmentHistory(f.equipment.id);
  assert.equal(history.summary.work_orders, 1);
  assert.equal(history.work_orders[0].id, id);
  f.db.close();
});

test('没挂设备的工单仍然可以被撤回和取消，只是不能"完成"', () => {
  const f = fixture();
  const toCancel = f.service.createWorkOrder({ process_id: f.process.id, fault_code_id: f.faultCode.id }, f.worker).work_order.id;
  assert.doesNotThrow(() => f.service.transitionWorkOrder(toCancel, { to_status: 'CANCELLED' }, f.manager),
    '管理员取消不该被设备归属卡住，否则误报的无主工单会永远挂着');

  const toWithdraw = f.service.createWorkOrder({ process_id: f.process.id, fault_code_id: f.faultCode.id }, f.worker).work_order.id;
  assert.doesNotThrow(() => f.service.withdrawWorkOrder(toWithdraw, { reason: '误报' }, f.worker));
  f.db.close();
});

test('取消仍然只有管理员能做，普工和技术员都不行', () => {
  const f = fixture();
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, f.technician), /无权/);
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, f.worker), /无权/);
  assert.doesNotThrow(() => f.service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, f.manager));
  f.db.close();
});

test('停在旧“待审核”状态的历史工单仍然结得掉', () => {
  const f = fixture();
  const id = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  f.service.assignWorkOrder(id, {}, f.technician);
  for (const status of ['ARRIVED', 'IN_PROGRESS']) {
    f.service.transitionWorkOrder(id, { to_status: status }, f.technician);
  }
  f.service.updateRepairDetail(id, { diagnosis: '测试诊断', repair_action: '测试维修' }, f.technician);
  // 手工造出改造前才会出现的状态
  f.db.prepare("UPDATE work_orders SET status='PENDING_REVIEW' WHERE id=?").run(id);
  assert.doesNotThrow(() => f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician),
    '删掉这条路径会让历史工单永远结不了单');
  f.db.close();
});

test('只有报修人本人能评价，且只有已完成的工单能评', () => {
  const f = fixture();
  const open = f.service.createWorkOrder({
    process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
  }, f.worker).work_order.id;
  assert.throws(() => f.service.reviewWorkOrder(open, review(), f.worker), /完成之后才能评价/);

  const id = repairAndClose(f);
  assert.throws(() => f.service.reviewWorkOrder(id, review(), f.other), /只有报修人本人/);
  assert.throws(() => f.service.reviewWorkOrder(id, review(), f.technician), /只有报修人本人/);
  assert.throws(() => f.service.reviewWorkOrder(id, review(), f.manager), /只有报修人本人/, '管理员也不能替别人评');

  const created = f.service.reviewWorkOrder(id, {
    quality_score: 4, attitude_score: 5, speed_score: 3, comment: '修得挺快，就是等人等了半小时',
  }, f.worker);
  assert.equal(created.quality_score, 4);
  assert.equal(created.overall_score, 4, '(4+5+3)/3 = 4');
  assert.equal(created.reviewer, '普工李四');
  assert.equal(created.technician, '技术员张三', '技术员姓名要做快照');
  assert.equal(created.technician_user_id, f.technician.user_id);
  f.db.close();
});

test('分数必须是1到5的整数', () => {
  const f = fixture();
  const id = repairAndClose(f);
  for (const bad of [0, 6, -1, 2.5, null, undefined, '好']) {
    assert.throws(() => f.service.reviewWorkOrder(id, { ...review(), quality_score: bad }, f.worker), /请打1到5星/);
  }
  assert.throws(() => f.service.reviewWorkOrder(id, { quality_score: 5 }, f.worker), /请打1到5星/, '三项都必填');
  f.db.close();
});

test('一单一评，可以修改，改动留痕', () => {
  const f = fixture();
  const id = repairAndClose(f);
  f.service.reviewWorkOrder(id, { ...review(2), comment: '没修好' }, f.worker);
  const updated = f.service.reviewWorkOrder(id, { ...review(5), comment: '后来又来看了一次，好了' }, f.worker);
  assert.equal(updated.quality_score, 5);
  assert.equal(updated.comment, '后来又来看了一次，好了');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS c FROM work_order_reviews WHERE work_order_id=?').get(id).c, 1, '不能产生第二条');

  const history = f.service.getWorkOrder(id).history.map((h) => h.event_type);
  assert.ok(history.includes('REVIEWED'));
  assert.ok(history.includes('REVIEW_UPDATED'));
  f.db.close();
});

test('技术员看不到单条评价，报修人和管理员看得到', () => {
  const f = fixture();
  const id = repairAndClose(f);
  f.service.reviewWorkOrder(id, { ...review(3), comment: '态度一般' }, f.worker);

  assert.ok(f.service.getWorkOrder(id, f.worker).review, '报修人看得到自己的评价');
  assert.equal(f.service.getWorkOrder(id, f.worker).review.comment, '态度一般');
  assert.ok(f.service.getWorkOrder(id, f.manager).review, '管理员看得到');

  const asTechnician = f.service.getWorkOrder(id, f.technician);
  assert.equal(asTechnician.review, null, '技术员不能看到单条评价');
  assert.equal(asTechnician.has_review, true, '但知道这单已经被评过了');

  // 不相干的普工连工单本身都看不到（既有的可见性规则），比"看得到工单但看不到评价"更严
  assert.throws(() => f.service.getWorkOrder(id, f.other), /只能查看自己报修的工单/);
  f.db.close();
});

test('评价照片独立保存，只有评价人和管理员可以查看', () => {
  const f = fixture();
  const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-review-'));
  f.service.attachmentRoot = attachmentRoot;
  const id = repairAndClose(f);
  const created = f.service.reviewWorkOrder(id, {
    ...review(4), attachments: [photo('修后仍渗油.jpg')],
  }, f.worker);
  assert.equal(created.attachments.length, 1);
  const attachmentId = created.attachments[0].id;
  assert.doesNotThrow(() => f.service.attachmentFile(attachmentId, f.worker));
  assert.doesNotThrow(() => f.service.attachmentFile(attachmentId, f.manager));
  assert.throws(() => f.service.attachmentFile(attachmentId, f.technician), /无权查看评价照片/);
  assert.throws(() => f.service.attachmentFile(attachmentId, f.other), /无权查看评价照片/);
  assert.equal(f.service.getWorkOrder(id, f.worker).review.attachments.length, 1);
  assert.equal(f.service.getWorkOrder(id, f.technician).review, null);
  assert.equal(f.service.listReviews(f.manager)[0].attachments.length, 1);

  const updated = f.service.reviewWorkOrder(id, { ...review(5), attachments: [photo('补充照片.jpg')] }, f.worker);
  assert.equal(updated.attachments.length, 2, '修改评价时新照片追加到原照片后面');
  f.service.deleteAttachment(attachmentId, f.worker);
  assert.equal(f.service.getWorkOrder(id, f.worker).review.attachments.length, 1);
  const remainingId = f.service.getWorkOrder(id, f.manager).review.attachments[0].id;
  f.service.deleteAttachment(remainingId, f.manager);
  assert.equal(f.service.getWorkOrder(id, f.manager).review.attachments.length, 0, '管理员可以管理评价照片');
  f.db.close();
  fs.rmSync(attachmentRoot, { recursive: true, force: true });
});

test('评分和评论不能从工单历史里漏给技术员', () => {
  const f = fixture();
  const id = repairAndClose(f);
  f.service.reviewWorkOrder(id, { quality_score: 1, attitude_score: 2, speed_score: 1, comment: '态度很差，修了三次没修好' }, f.worker);

  // 接口层把 review 剥成 null 了，但历史时间线技术员是看得到的——内容绝不能出现在那里
  const asTechnician = f.service.getWorkOrder(id, f.technician);
  const leak = JSON.stringify(asTechnician.history);
  assert.equal(leak.includes('态度很差'), false, '评论不能出现在工单历史里');
  assert.equal(leak.includes('"quality"'), false, '分数不能出现在工单历史的 details 里');
  assert.ok(asTechnician.history.some((h) => h.event_type === 'REVIEWED'), '但"已被评价"这个事实可以知道');

  // 整个返回体过一遍，确保没有任何字段夹带评价内容
  assert.equal(JSON.stringify(asTechnician).includes('态度很差'), false);
  f.db.close();
});

test('技术员只能拿到自己的综合分，拿不到别人的', () => {
  const f = fixture();
  const mine = repairAndClose(f, f.technician);
  f.service.reviewWorkOrder(mine, { quality_score: 4, attitude_score: 5, speed_score: 3 }, f.worker);
  const theirs = repairAndClose(f, f.technician2);
  f.service.reviewWorkOrder(theirs, { quality_score: 1, attitude_score: 1, speed_score: 1 }, f.worker);

  const summary = f.service.myReviewSummary(f.technician);
  assert.equal(summary.review_count, 1);
  assert.equal(summary.quality, 4);
  assert.equal(summary.attitude, 5);
  assert.equal(summary.speed, 3);
  assert.equal(summary.overall, 4);
  assert.equal('comment' in summary, false, '汇总里不能夹带评论内容');
  assert.equal('reviewer' in summary, false, '汇总里不能夹带评价人');

  // 传别人的 user_id 也只按会话里的算
  const spoofed = f.service.myReviewSummary({ ...f.technician, user_id: f.technician2.user_id });
  assert.equal(spoofed.review_count, 1);
  assert.equal(spoofed.overall, 1, '这里返回的是"传进来的那个会话"的分，不存在越权读别人');

  // 技术员无权调管理员的接口
  assert.throws(() => f.service.listReviews(f.technician), /无权/);
  assert.throws(() => f.service.technicianRanking(f.technician), /无权/);
  assert.throws(() => f.service.listReviews(f.worker), /无权/);
  f.db.close();
});

test('还没被评过的技术员，综合分是空不是零分', () => {
  const f = fixture();
  const summary = f.service.myReviewSummary(f.technician);
  assert.equal(summary.review_count, 0);
  assert.equal(summary.overall, null, '没人评过显示成0分会冤枉人');
  assert.equal(summary.quality, null);
  f.db.close();
});

test('管理员能看全部评价和技术员排行，停用的技术员仍计入历史', () => {
  const f = fixture();
  const first = repairAndClose(f, f.technician);
  f.service.reviewWorkOrder(first, { quality_score: 5, attitude_score: 5, speed_score: 5 }, f.worker);
  const second = repairAndClose(f, f.technician2);
  f.service.reviewWorkOrder(second, { quality_score: 2, attitude_score: 3, speed_score: 4, comment: '来得太慢' }, f.worker);

  const all = f.service.listReviews(f.manager);
  assert.equal(all.length, 2);
  assert.equal(all[0].comment, '来得太慢');
  assert.ok(all[0].work_order_no, '要带工单号');
  assert.ok(all[0].equipment_code, '要带设备');

  const ranking = f.service.technicianRanking(f.manager);
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0].technician, '技术员张三', '分高的排前面');
  assert.equal(ranking[0].overall, 5);
  assert.equal(ranking[1].overall, 3);

  // 技术员停用之后，历史评价仍然算得出来
  f.service.updateUser(f.technician.user_id, { status: 'DISABLED' }, f.manager);
  const afterDisable = f.service.technicianRanking(f.manager);
  assert.equal(afterDisable.length, 2, '停用的技术员不能从历史统计里消失');
  assert.equal(afterDisable[0].technician, '技术员张三');
  assert.equal(afterDisable[0].technician_status, 'DISABLED');
  f.db.close();
});

test('工单列表带待评价标记，设备履历带评分', () => {
  const f = fixture();
  const id = repairAndClose(f);
  assert.equal(f.service.listWorkOrders(f.worker)[0].has_review, 0, '刚结单时是待评价');

  f.service.reviewWorkOrder(id, { quality_score: 4, attitude_score: 4, speed_score: 4 }, f.worker);
  assert.equal(f.service.listWorkOrders(f.worker)[0].has_review, 1);

  const history = f.service.equipmentHistory(f.equipment.id);
  assert.equal(history.work_orders[0].review_overall, 4, '翻维修记录时能直接看出这次修得好不好');
  f.db.close();
});
