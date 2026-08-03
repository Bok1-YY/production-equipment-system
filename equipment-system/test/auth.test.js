'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService, ROLES } = require('../src/service');
const {
  LEVELS,
  createSession,
  destroySession,
  hashPassword,
  levelToRole,
  parseCookies,
  resolveSession,
  verifyPassword,
} = require('../src/auth');

// 复刻服务端从会话构造调用上下文的方式，让测试与真实HTTP路径走同一套映射。
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
  const seedAdmin = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seedAdmin.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seedAdmin.id));
  const worker = contextFor(service.createUser({ username: 'w001', display_name: '普工李四', level: 1 }, manager));
  const technician = contextFor(service.createUser({ username: 't001', display_name: '技术员张三', level: 2 }, manager));
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'YSM-L01', name: '一号产线' }, manager);
  const process = service.createProcess({ line_id: line.id, code: 'YSM-L01-EX', name: '挤出工序' }, manager);
  const faultCode = service.listFaultCodes().codes.find((item) => item.code === 'ME-BRG-NOISE');
  const equipment = service.createEquipment({
    standard_name: '单螺杆挤出机', category: '生产主机', type_code: 'EXT', key_spec: '135',
  }, manager);
  return { db, service, manager, worker, technician, line, process, faultCode, equipment };
}

test('三级成员映射到内部权限令牌，管理员通过全部现有权限校验', () => {
  assert.equal(levelToRole(LEVELS.WORKER), ROLES.EMPLOYEE);
  assert.equal(levelToRole(LEVELS.TECHNICIAN), ROLES.TECHNICIAN);
  assert.equal(levelToRole(LEVELS.MANAGER), ROLES.ADMIN);
  assert.equal(levelToRole(9), null);
});

test('密码使用加盐哈希存储，错误密码和空密码都不通过', () => {
  const { hash, salt } = hashPassword('ysm-admin-2026');
  assert.notEqual(hash, 'ysm-admin-2026');
  assert.equal(verifyPassword('ysm-admin-2026', hash, salt), true);
  assert.equal(verifyPassword('ysm-admin-2027', hash, salt), false);
  assert.equal(verifyPassword('', hash, salt), false);
  assert.equal(verifyPassword('ysm-admin-2026', hash, 'wrong-salt'), false);
  assert.equal(verifyPassword('ysm-admin-2026', null, salt), false);
  // 相同明文两次哈希结果不同，说明每次都用了新的盐。
  assert.notEqual(hashPassword('same-password').hash, hashPassword('same-password').hash);
});

test('默认管理员首次登录必须改密，改密前后凭据切换正确', () => {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const loggedIn = service.login(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD);
  assert.equal(loggedIn.level, 3);
  assert.equal(loggedIn.must_change_password, 1);
  assert.throws(() => service.login(DEFAULT_ADMIN_USERNAME, '随便猜的密码'), /工号或密码不正确/);
  assert.throws(() => service.login('不存在的账号', DEFAULT_ADMIN_PASSWORD), /工号或密码不正确/);

  assert.throws(() => service.changeOwnPassword(loggedIn.id, '错误的原密码', 'manager-2026'), /原密码不正确/);
  assert.throws(() => service.changeOwnPassword(loggedIn.id, DEFAULT_ADMIN_PASSWORD, 'abc'), /至少需要12位/);
  assert.throws(() => service.changeOwnPassword(loggedIn.id, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_PASSWORD), /不能与原密码相同/);

  const changed = service.changeOwnPassword(loggedIn.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  assert.equal(changed.must_change_password, 0);
  assert.equal(service.login(DEFAULT_ADMIN_USERNAME, 'manager-2026').id, loggedIn.id);
  assert.throws(() => service.login(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD), /工号或密码不正确/);
  db.close();
});

test('会话可签发、滑动续期、登出失效，过期会话不可用', () => {
  const { db, service, manager, faultCode } = fixture();
  const session = createSession(db, manager.user_id);
  const resolved = resolveSession(db, session.token);
  assert.equal(resolved.user_id, manager.user_id);
  assert.equal(resolved.level, 3);
  assert.equal(resolved.role, ROLES.ADMIN);

  assert.equal(resolveSession(db, '伪造的令牌'), null);
  assert.equal(resolveSession(db, ''), null);
  assert.equal(resolveSession(db, undefined), null);

  destroySession(db, session.token);
  assert.equal(resolveSession(db, session.token), null);

  const expired = createSession(db, manager.user_id, -1000);
  assert.equal(resolveSession(db, expired.token), null);

  // 账号停用后，已经签发的会话立即失效。
  const worker = service.createUser({ username: 'w900', display_name: '待停用普工', level: 1 }, manager);
  const workerSession = createSession(db, worker.id);
  assert.ok(resolveSession(db, workerSession.token));
  service.updateUser(worker.id, { status: 'DISABLED' }, manager);
  assert.equal(resolveSession(db, workerSession.token), null);
  assert.throws(() => service.login('w900', '任意密码'), /工号或密码不正确/);
  db.close();
});

test('Cookie解析容忍空值和多余分号', () => {
  assert.deepEqual(parseCookies('ysm_session=abc123'), { ysm_session: 'abc123' });
  assert.deepEqual(parseCookies('a=1; ysm_session=abc123; b=2').ysm_session, 'abc123');
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('=novalue; ok=1'), { ok: '1' });
});

test('管理员开户返回一次性初始密码，且任何接口都不回传密码哈希', () => {
  const { db, service, manager, worker, faultCode } = fixture();
  const created = service.createUser({ username: 'W002', display_name: '普工王五', level: 1, phone: '13800000000' }, manager);
  assert.equal(created.username, 'w002', '工号统一转小写');
  assert.equal(created.must_change_password, 1);
  assert.match(created.initial_password, /^ysm[a-z0-9]{14}$/);
  assert.equal(service.login('w002', created.initial_password).id, created.id);

  for (const item of [service.publicUser(created.id), ...service.listUsers()]) {
    assert.equal('password_hash' in item, false);
    assert.equal('password_salt' in item, false);
  }

  assert.throws(() => service.createUser({ username: 'w002', display_name: '重复工号', level: 1 }, manager), /该工号已经存在/);
  assert.throws(() => service.createUser({ username: 'w003', display_name: '级别越界', level: 4 }, manager), /成员级别/);
  assert.throws(() => service.createUser({ username: '带 空格', display_name: '非法工号', level: 1 }, manager), /工号只能使用/);
  assert.throws(() => service.createUser({ username: 'w004', display_name: '越权开户', level: 1 }, worker), /无权/);
  db.close();
});

test('重置密码会强制改密并踢掉旧会话，最后一个管理员不能停用或降级', () => {
  const { db, service, manager, technician, faultCode } = fixture();
  const technicianSession = createSession(db, technician.user_id);
  const reset = service.resetUserPassword(technician.user_id, manager);
  assert.match(reset.initial_password, /^ysm[a-z0-9]{14}$/);
  assert.equal(reset.must_change_password, 1);
  assert.equal(resolveSession(db, technicianSession.token), null, '重置密码后旧会话必须失效');
  assert.equal(service.login('t001', reset.initial_password).id, technician.user_id);

  assert.throws(() => service.updateUser(manager.user_id, { status: 'DISABLED' }, manager), /至少一个启用的管理员/);
  assert.throws(() => service.updateUser(manager.user_id, { level: 2 }, manager), /至少一个启用的管理员/);

  // 有第二个管理员之后就可以停用其中一个。
  const backup = service.createUser({ username: 'm002', display_name: '备用管理员', level: 3 }, manager);
  assert.doesNotThrow(() => service.updateUser(manager.user_id, { status: 'DISABLED' }, manager));
  assert.equal(service.publicUser(backup.id).level, 3);
  db.close();
});

test('普工只能看到自己报修的工单，别人的工单查不到', () => {
  const { db, service, manager, worker, technician, process, faultCode } = fixture();
  const other = contextFor(service.createUser({ username: 'w010', display_name: '普工赵六', level: 1 }, manager));
  const mine = service.createWorkOrder({ process_id: process.id, fault_code_id: faultCode.id }, worker);
  const theirs = service.createWorkOrder({ process_id: process.id, fault_code_id: faultCode.id }, other);

  const workerList = service.listWorkOrders(worker);
  assert.deepEqual(workerList.map((item) => item.id), [mine.work_order.id]);
  assert.equal(workerList[0].reporter, '普工李四');

  assert.equal(service.listWorkOrders(technician).length, 2, '技术员看全部工单');
  assert.equal(service.listWorkOrders(manager).length, 2, '管理员看全部工单');

  assert.doesNotThrow(() => service.getWorkOrder(mine.work_order.id, worker));
  assert.throws(() => service.getWorkOrder(theirs.work_order.id, worker), /只能查看自己报修的工单/);
  assert.doesNotThrow(() => service.getWorkOrder(theirs.work_order.id, technician));
  db.close();
});

test('普工报修→技术员抢单→技术员结单→普工评价的闭环', () => {
  const { db, service, manager, worker, technician, process, faultCode, equipment } = fixture();
  // 普工选的是"无法判断具体设备"——这是允许的入口，技术员到场后负责认领。
  const created = service.createWorkOrder({
    process_id: process.id, fault_code_id: faultCode.id, is_downtime: true, urgency: 'URGENT',
  }, worker);
  const id = created.work_order.id;
  assert.equal(created.work_order.status, 'SUBMITTED');
  assert.equal(created.work_order.reporter, '普工李四');
  assert.equal(created.work_order.reporter_user_id, worker.user_id);

  // 普工不能自己接单，也不能推进维修流程。
  assert.throws(() => service.assignWorkOrder(id, { assignee: '普工李四' }, worker), /无权/);
  assert.throws(() => service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, worker), /无权|不能从/);

  const claimed = service.assignWorkOrder(id, {}, technician);
  assert.equal(claimed.work_order.status, 'ACCEPTED');
  assert.equal(claimed.work_order.assignee, '技术员张三');
  assert.equal(claimed.work_order.assignee_user_id, technician.user_id);
  assert.ok(claimed.history.some((item) => item.event_type === 'CLAIMED'));

  service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, technician);
  service.correctWorkOrderEquipment(id, { equipment_id: equipment.id, reason: '到场后确认是主挤出机' }, technician);
  service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, technician);
  service.updateRepairDetail(id, {
    diagnosis: '主接触器触点烧结，原因为触点老化', repair_action: '更换接触器',
  }, technician);
  service.addWorkOrderPart(id, { part_name: '交流接触器', quantity: 1, unit: '只' }, technician);
  service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, technician);
  service.updateTrialResult(id, { trial_result: 'NORMAL' }, technician);

  // 2026-07-26 起结单权限下放给技术员：验收由报修人的评价承担，管理员不必在场。
  const completed = service.transitionWorkOrder(id, { to_status: 'COMPLETED', note: '已修复' }, technician);
  assert.equal(completed.work_order.status, 'COMPLETED');
  assert.ok(completed.work_order.completed_at);
  // 但取消仍然只有管理员能做，技术员不能一键把别人的报修作废。
  assert.throws(() => service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, technician), /无权|不能从/);

  // 报修人始终看得到自己那张工单的最新状态，并且现在轮到他评价。
  assert.equal(service.listWorkOrders(worker)[0].status, 'COMPLETED');
  assert.equal(service.listWorkOrders(worker)[0].has_review, 0, '结单后是待评价');
  const review = service.reviewWorkOrder(id, {
    quality_score: 5, attitude_score: 4, speed_score: 4, comment: '修得挺快',
  }, worker);
  assert.equal(review.overall_score, 4.3);
  assert.equal(service.listWorkOrders(worker)[0].has_review, 1);
  // 技术员只看得到自己的综合分，看不到这条评价本身。
  assert.equal(service.getWorkOrder(id, technician).review, null);
  assert.equal(service.myReviewSummary(technician).overall, 4.3);
  db.close();
});

test('技术员只能给自己接单，不能抢已被他人接走的工单', () => {
  const { db, service, manager, worker, technician, process, faultCode } = fixture();
  const other = contextFor(service.createUser({ username: 't002', display_name: '技术员孙七', level: 2 }, manager));
  const id = service.createWorkOrder({ process_id: process.id, fault_code_id: faultCode.id }, worker).work_order.id;

  assert.throws(() => service.assignWorkOrder(id, { assignee: '技术员孙七' }, technician), /只能自己接单/);
  assert.throws(() => service.assignWorkOrder(id, { assignee_user_id: other.user_id }, technician), /只能自己接单/);

  service.assignWorkOrder(id, {}, technician);
  assert.throws(() => service.assignWorkOrder(id, {}, other), /已由技术员张三负责/);

  // 管理员可以强制转派给别的技术员。
  const reassigned = service.assignWorkOrder(id, { assignee_user_id: other.user_id, note: '张三请假' }, manager);
  assert.equal(reassigned.work_order.assignee, '技术员孙七');
  assert.equal(reassigned.work_order.assignee_user_id, other.user_id);
  assert.throws(() => service.assignWorkOrder(id, { assignee_user_id: worker.user_id }, manager), /只能指派给技术员或管理员/);
  db.close();
});

test('成员相关操作全部写入审计日志', () => {
  const { db, service, manager, faultCode } = fixture();
  const created = service.createUser({ username: 'w200', display_name: '审计普工', level: 1 }, manager);
  service.updateUser(created.id, { display_name: '审计普工改名' }, manager);
  service.resetUserPassword(created.id, manager);
  service.login('w200', service.resetUserPassword(created.id, manager).initial_password);

  const actions = service.auditLogs().filter((item) => item.entity_type === 'user').map((item) => item.action);
  for (const action of ['CREATE', 'UPDATE', 'RESET_PASSWORD', 'LOGIN', 'CHANGE_PASSWORD']) {
    assert.ok(actions.includes(action), `审计日志缺少${action}`);
  }
  // 审计日志里不能出现任何密码材料。
  const dump = JSON.stringify(service.auditLogs());
  assert.equal(dump.includes('password_hash'), false);
  assert.equal(dump.includes('password_salt'), false);
  db.close();
});
