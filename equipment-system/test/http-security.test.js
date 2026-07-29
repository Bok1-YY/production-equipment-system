'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { openDatabase, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');
const { createApplication } = require('../src/server');

function contextFor(user) {
  return {
    actor: user.display_name,
    user_id: user.id,
    username: user.username,
    level: user.level,
    role: levelToRole(user.level),
  };
}

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function login(base, username, password) {
  const { response, payload } = await jsonRequest(base, '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  return response.headers.get('set-cookie').split(';')[0];
}

async function rawRequest(port, content) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.end(content);
  let output = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { output += chunk; });
  await once(socket, 'close');
  return output;
}

test('HTTP边界：畸形Host不崩溃、权限收口、来源校验、幂等与登录锁定', async (t) => {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = contextFor(service.publicUser(seed.id));

  const workerCreated = service.createUser({
    username: 'w001', display_name: '普工李四', level: 1,
  }, manager);
  service.changeOwnPassword(workerCreated.id, workerCreated.initial_password, 'worker-pass-2026');
  const worker = contextFor(service.publicUser(workerCreated.id));
  const techCreated = service.createUser({
    username: 't001', display_name: '技术员张三', level: 2,
  }, manager);
  service.changeOwnPassword(techCreated.id, techCreated.initial_password, 'technician-2026');

  const workshop = service.organization().workshops[0];
  const line = service.createLine({
    workshop_id: workshop.id, code: 'YSM-L01', name: '一号线',
  }, manager);
  const processRow = service.createProcess({
    line_id: line.id, code: 'YSM-L01-EX', name: '挤出',
  }, manager);
  service.createEquipment({
    type_code: 'EXT', standard_name: '安全字段测试设备', category: '生产设备',
    serial_number: 'SECRET-SERIAL', responsible_person: '内部负责人', notes: '内部备注',
  }, manager);
  const fault = service.listFaultCodes().codes[0];

  const app = createApplication({ db, service, host: '127.0.0.1', port: 0 });
  try {
    app.listen();
    await once(app.server, 'listening');
  } catch (error) {
    if (error.code === 'EPERM') {
      db.close();
      t.skip('当前沙箱禁止监听回环端口；在常规测试环境会完整执行');
      return;
    }
    throw error;
  }
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const oldOrigin = process.env.YSM_TRUSTED_ORIGIN;
  t.after(async () => {
    if (oldOrigin === undefined) delete process.env.YSM_TRUSTED_ORIGIN;
    else process.env.YSM_TRUSTED_ORIGIN = oldOrigin;
    await new Promise((resolve) => app.close(resolve));
  });

  const health = await fetch(`${base}/api/health/live`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');

  const malformed = await rawRequest(port,
    'GET /api/health/live HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
  assert.match(malformed, /400 Bad Request/);
  assert.equal((await fetch(`${base}/api/health/live`)).status, 200,
    '畸形请求后服务仍应存活');

  assert.equal((await fetch(`${base}/api/users`)).status, 401);
  const workerCookie = await login(base, worker.username, 'worker-pass-2026');
  for (const path of ['/api/users', '/api/audit-logs', '/api/patrols/1']) {
    assert.equal((await fetch(`${base}${path}`, {
      headers: { Cookie: workerCookie },
    })).status, 403, `${path} 不应向普工开放`);
  }
  const workerEquipment = await jsonRequest(base, '/api/equipment', {
    headers: { Cookie: workerCookie },
  });
  assert.equal(workerEquipment.response.status, 200);
  assert.equal(workerEquipment.payload.data[0].serial_number, undefined);
  assert.equal(workerEquipment.payload.data[0].responsible_person, undefined);
  assert.equal(workerEquipment.payload.data[0].notes, undefined);

  const managerCookie = await login(base, manager.username, 'manager-2026');
  assert.equal((await fetch(`${base}/api/users`, {
    headers: { Cookie: managerCookie },
  })).status, 200);

  process.env.YSM_TRUSTED_ORIGIN = base;
  const crossOrigin = await fetch(`${base}/api/work-orders`, {
    method: 'POST',
    headers: {
      Cookie: workerCookie,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ process_id: processRow.id, fault_code_id: fault.id }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.ok(service.auditLogs(50, manager).some((item) => item.action === 'INVALID_ORIGIN'));

  const key = 'test-create-order-0001';
  const createOptions = {
    method: 'POST',
    headers: {
      Cookie: workerCookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ process_id: processRow.id, fault_code_id: fault.id }),
  };
  const first = await jsonRequest(base, '/api/work-orders', createOptions);
  const second = await jsonRequest(base, '/api/work-orders', createOptions);
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.equal(first.payload.data.work_order.id, second.payload.data.work_order.id);
  assert.equal(service.listWorkOrders(worker).length, 1);

  for (let index = 0; index < 5; index += 1) {
    await jsonRequest(base, '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: manager.username, password: 'wrong-password' }),
    });
  }
  const locked = await jsonRequest(base, '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: manager.username, password: 'manager-2026' }),
  });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.payload.error.code, 'ACCOUNT_LOCKED');
});
