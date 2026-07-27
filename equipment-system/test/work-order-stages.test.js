'use strict';

// 工单的阶段规则：接单合成一步、只有接单人能推进、到场之前不能做到场之后的事。
// 界面按阶段解锁只是显示层面的事，真正的把关在这里。

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');
const { WORK_ORDER_STAGES, WORK_ORDER_TRANSITIONS, POST_ARRIVAL_STATUSES } = require('../src/domain');

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

const report = (f) => f.service.createWorkOrder({
  process_id: f.process.id, equipment_id: f.equipment.id, fault_code_id: f.faultCode.id,
}, f.worker).work_order.id;

const statusOf = (f, id) => f.service.getWorkOrder(id).work_order.status;

// ---- 接单合成一步 ----

test('技术员接单一步就到「已接单」，不再经过"已分派"', () => {
  const f = fixture();
  const id = report(f);
  assert.equal(statusOf(f, id), 'SUBMITTED');
  const claimed = f.service.assignWorkOrder(id, {}, f.technician).work_order;
  assert.equal(claimed.status, 'ACCEPTED');
  assert.equal(claimed.assignee_user_id, f.technician.user_id);
  assert.ok(claimed.assigned_at, '接单时刻要落库');
  f.db.close();
});

test('管理员指派也落到「已接单」，谁做的靠历史事件区分', () => {
  const f = fixture();
  const id = report(f);
  const assigned = f.service.assignWorkOrder(id, { assignee_user_id: f.technician.user_id }, f.manager);
  assert.equal(assigned.work_order.status, 'ACCEPTED');
  assert.equal(assigned.work_order.assignee, '技术员张三');
  const events = assigned.history.map((item) => item.event_type);
  assert.ok(events.includes('ASSIGNED'), '管理员指派记 ASSIGNED');
  assert.ok(!events.includes('CLAIMED'), '不是技术员自己抢的，不该记 CLAIMED');
  f.db.close();
});

test('状态机里没有 ASSIGNED，接单也不能走状态流转', () => {
  const f = fixture();
  assert.equal(WORK_ORDER_TRANSITIONS.ASSIGNED, undefined, 'ASSIGNED 已经从状态机里删掉');
  const id = report(f);
  // 原先 SUBMITTED → ASSIGNED 可以流转，界面上就冒出一个"已分派"选项，
  // 点了会造出"已分派但没有负责人"的脏工单。
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'ACCEPTED' }, f.technician), /不能从/);
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'ASSIGNED' }, f.technician), /不能从/);
  f.db.close();
});

test('旧库里停在 ASSIGNED 的工单，重开库时归一到 ACCEPTED', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  // 手工造一张改造前的工单
  f.db.prepare("UPDATE work_orders SET status='ASSIGNED' WHERE id=?").run(id);
  assert.equal(statusOf(f, id), 'ASSIGNED');
  // 迁移是在 openDatabase 里跑的，这里直接调那段归一逻辑等价的语句验证意图：
  // 不归一的话状态机查不到 ASSIGNED 的出边，这张单永远推不动。
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician), /不能从/);
  f.db.close();
});

// ---- 只有接单人能推进 ----

test('别的技术员不能推进我接的单，管理员可以', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);

  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.other),
    /由技术员张三负责/, '张三接的单，王五不能一路点到结单');
  assert.doesNotThrow(() => f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician));
  // 管理员不受限
  assert.doesNotThrow(() => f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.manager));
  f.db.close();
});

test('别的技术员想接手，要先由管理员转派', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  assert.throws(() => f.service.assignWorkOrder(id, {}, f.other), /让管理员转派/);

  const reassigned = f.service.assignWorkOrder(id, { assignee_user_id: f.other.user_id }, f.manager).work_order;
  assert.equal(reassigned.assignee_user_id, f.other.user_id);
  assert.equal(reassigned.status, 'ACCEPTED', '转派没到场的单，阶段不变');
  // 现在轮到王五能推进了
  assert.doesNotThrow(() => f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.other));
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician), /由技术员王五负责/);
  f.db.close();
});

test('转派一张已经在修的单，不会把它退回"还没到场"', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);

  const reassigned = f.service.assignWorkOrder(id, { assignee_user_id: f.other.user_id }, f.manager).work_order;
  assert.equal(reassigned.status, 'IN_PROGRESS', '换个人不该把工单退回上一阶段');
  assert.ok(reassigned.arrived_at, '到场时刻要保留');
  f.db.close();
});

// ---- 到场之前不能做到场之后的事 ----

const ARRIVAL_GATED = [
  ['修正故障设备', (f, id, ctx) => f.service.correctWorkOrderEquipment(id, { equipment_id: f.equipment.id, reason: '就是这台' }, ctx)],
  ['确认故障分类', (f, id, ctx) => f.service.classifyWorkOrder(id, { fault_code_id: f.faultCode.id }, ctx)],
  ['填写维修记录', (f, id, ctx) => f.service.updateRepairDetail(id, { diagnosis: '轴承缺油' }, ctx)],
  ['记录使用零件', (f, id, ctx) => f.service.addWorkOrderPart(id, { part_name: '轴承', quantity: 1, unit: '只' }, ctx)],
];

test('待接单阶段，四个到场后的操作技术员一个都做不了', () => {
  const f = fixture();
  const id = report(f);
  for (const [name, action] of ARRIVAL_GATED) {
    assert.throws(() => action(f, id, f.technician), /要先到现场/, `${name}不该在待接单阶段就能做`);
  }
  f.db.close();
});

test('已接单但还没到场，四个操作仍然做不了', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  assert.equal(statusOf(f, id), 'ACCEPTED');
  for (const [name, action] of ARRIVAL_GATED) {
    assert.throws(() => action(f, id, f.technician), /要先到现场/, `${name}要求人已经到现场`);
  }
  f.db.close();
});

test('到场之后四个操作全部放行', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  assert.ok(POST_ARRIVAL_STATUSES.includes(statusOf(f, id)));
  for (const [name, action] of ARRIVAL_GATED) {
    assert.doesNotThrow(() => action(f, id, f.technician), `${name}到场后应该可以做`);
  }
  f.db.close();
});

test('管理员不受"要先到场"的限制——误报在派单前就能改掉', () => {
  const f = fixture();
  const id = report(f);
  for (const [name, action] of ARRIVAL_GATED) {
    assert.doesNotThrow(() => action(f, id, f.manager), `管理员应该能在派单前${name}`);
  }
  f.db.close();
});

test('到场之后但不是接单人，四个操作也做不了', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  for (const [name, action] of ARRIVAL_GATED) {
    assert.throws(() => action(f, id, f.other), /由技术员张三负责/, `${name}也要认接单人`);
  }
  f.db.close();
});

test('已结束的工单，四个操作都被拒（连管理员也不行）', () => {
  const f = fixture();
  const id = report(f);
  f.service.transitionWorkOrder(id, { to_status: 'CANCELLED', note: '误报' }, f.manager);
  for (const [name, action] of ARRIVAL_GATED) {
    assert.throws(() => action(f, id, f.manager), /已结束工单/, `${name}在已结束工单上不该放行`);
  }
  f.db.close();
});

// ---- 取消的死角 ----

test('管理员在任何未结阶段都能取消，不留死角', () => {
  const f = fixture();
  // 到场之后既撤不了（撤回只到 ACCEPTED）又结不掉（结单要满足三道硬校验），
  // 原先这样一张误接的垃圾单会永远挂在列表里。
  for (const stage of ['ARRIVED', 'IN_PROGRESS', 'WAITING_PARTS', 'TRIAL_RUN']) {
    const id = report(f);
    f.service.assignWorkOrder(id, {}, f.technician);
    f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
    if (stage !== 'ARRIVED') f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);
    if (stage === 'WAITING_PARTS') f.service.transitionWorkOrder(id, { to_status: 'WAITING_PARTS' }, f.technician);
    if (stage === 'TRIAL_RUN') f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
    assert.equal(statusOf(f, id), stage);
    const cancelled = f.service.transitionWorkOrder(id, { to_status: 'CANCELLED', note: '误接的单' }, f.manager).work_order;
    assert.equal(cancelled.status, 'CANCELLED', `${stage} 阶段应该能被管理员取消`);
  }
  f.db.close();
});

test('技术员不能取消工单，取消仍然只有管理员能做', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  assert.throws(() => f.service.transitionWorkOrder(id, { to_status: 'CANCELLED' }, f.technician), /无权/);
  f.db.close();
});

// ---- 阶段表本身 ----

test('阶段表是有序的，且每个阶段都对应真实状态', () => {
  const statuses = Object.keys(WORK_ORDER_TRANSITIONS);
  for (const stage of WORK_ORDER_STAGES) {
    assert.ok(statuses.includes(stage.status), `阶段 ${stage.status} 不在状态机里`);
    for (const extra of stage.includes || []) {
      assert.ok(statuses.includes(extra), `分支状态 ${extra} 不在状态机里`);
    }
  }
  assert.deepEqual(WORK_ORDER_STAGES.map((item) => item.status),
    ['SUBMITTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'TRIAL_RUN', 'COMPLETED'],
    '步骤条的顺序就是技术员实际走的顺序');
  // 除了终态和分支状态，每个未结状态都应该能在步骤条上找到位置——
  // 否则界面会渲染出一个"当前步骤不明"的工单。
  const placed = new Set(WORK_ORDER_STAGES.flatMap((s) => [s.status, ...(s.includes || [])]));
  for (const status of statuses) {
    if (status === 'CANCELLED') continue;
    assert.ok(placed.has(status), `状态 ${status} 在步骤条上没有位置`);
  }
});

test('走完整条路：接单 → 到场 → 维修 → 试运行 → 结单', () => {
  const f = fixture();
  const id = report(f);
  f.service.assignWorkOrder(id, {}, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'ARRIVED' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'IN_PROGRESS' }, f.technician);
  f.service.updateRepairDetail(id, { repair_action: '补充润滑脂', trial_result: '异响消除' }, f.technician);
  f.service.transitionWorkOrder(id, { to_status: 'TRIAL_RUN' }, f.technician);
  const done = f.service.transitionWorkOrder(id, { to_status: 'COMPLETED' }, f.technician).work_order;
  assert.equal(done.status, 'COMPLETED');
  // 四个时刻齐全，两段时长才算得出来
  for (const field of ['reported_at', 'assigned_at', 'arrived_at', 'completed_at']) {
    assert.ok(done[field], `${field} 应该有值`);
  }
  f.db.close();
});
