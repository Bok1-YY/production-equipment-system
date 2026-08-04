'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { openDatabase, DEFAULT_ADMIN_PASSWORD } = require('../src/db');
const { EquipmentService, ROLES } = require('../src/service');
const { createApplication } = require('../src/server');

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]).toString('base64');

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const payload = await response.json();
  return { response, payload };
}

async function login(base, username, password) {
  const result = await request(base, '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  return result.response.headers.get('set-cookie').split(';')[0];
}

function jsonOptions(cookie, method, body) {
  return {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

test('技改HTTP闭环：原始文件上传、移动端通知、逐项留证和审核应用', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-mod-http-'));
  const db = openDatabase(path.join(root, 'equipment.db'));
  const service = new EquipmentService(db, { attachmentRoot: path.join(root, 'attachments') });
  const seed = service.listUsers().find((item) => item.username === 'admin');
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'Ysm-admin-http-2026');
  const admin = { actor: seed.display_name, role: ROLES.ADMIN, level: 3, user_id: seed.id, username: seed.username };
  const createdTech = service.createUser({
    username: 'mod-http-tech', display_name: '技改接口技工', level: 2, password: 'Ysm-tech-temp-2026',
  }, admin);
  service.changeOwnPassword(createdTech.id, 'Ysm-tech-temp-2026', 'Ysm-tech-http-2026');
  const workshop = service.organization().workshops[0];
  const line = service.createLine({ workshop_id: workshop.id, code: 'HTTP-L01', name: '接口技改线' }, admin);
  const process = service.createProcess({ line_id: line.id, code: 'HTTP-P01', name: '接口工序' }, admin);
  const position = service.createPosition({ process_id: process.id, code: 'HTTP-S01', name: '接口机位' }, admin);
  const equipment = service.createEquipment({
    type_code: 'EXT', key_spec: 'HTTP', standard_name: '接口技改设备', category: '生产设备',
  }, admin);

  const app = createApplication({ db, service, host: '127.0.0.1', port: 0 });
  try {
    app.listen();
    await once(app.server, 'listening');
  } catch (error) {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (error.code === 'EPERM') return t.skip('当前环境禁止监听回环端口');
    throw error;
  }
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const adminCookie = await login(base, 'admin', 'Ysm-admin-http-2026');
  const techCookie = await login(base, 'mod-http-tech', 'Ysm-tech-http-2026');
  const created = await request(base, '/api/modification-tasks', jsonOptions(adminCookie, 'POST', {
    title: '接口端到端技改', objective: '验证全部HTTP边界', acceptance_criteria: '设备安装到指定机位',
    priority: 'URGENT', planned_start_at: '2026-08-04T01:00:00.000Z', due_at: '2027-08-05T01:00:00.000Z',
    primary_assignee_user_id: createdTech.id, collaborator_user_ids: [],
    items: [{
      target_type: 'EQUIPMENT', action: 'INSTALL', target_id: equipment.id,
      title: '安装测试设备', instructions: '按技术文件安装并拍照',
      payload: { to_position_id: position.id }, affects_operation: true, photo_required: true,
    }],
  }));
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const taskId = created.payload.data.task.id;
  const itemId = created.payload.data.items[0].id;

  const document = await request(base, `/api/modification-tasks/${taskId}/documents`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('安装方案.pdf') },
    body: Buffer.from('%PDF-1.4\n1 0 obj\n%%EOF'),
  });
  assert.equal(document.response.status, 201, JSON.stringify(document.payload));
  assert.equal(document.payload.data[0].disposition, 'inline');
  assert.match(document.payload.data[0].sha256, /^[a-f0-9]{64}$/);

  const published = await request(base, `/api/modification-tasks/${taskId}/publish`, jsonOptions(adminCookie, 'POST', {}));
  assert.equal(published.response.status, 200, JSON.stringify(published.payload));

  const device = await request(base, '/api/notification-device', jsonOptions(techCookie, 'POST', { device_label: 'http-test' }));
  assert.equal(device.response.status, 201, JSON.stringify(device.payload));
  const inbox = await request(base, '/api/notifications', {
    headers: { Authorization: `Bearer ${device.payload.data.token}` },
  });
  assert.equal(inbox.response.status, 200, JSON.stringify(inbox.payload));
  assert.equal(inbox.payload.data[0].entity_id, taskId);

  for (const action of ['acknowledge', 'arrive', 'start']) {
    const result = await request(base, `/api/modification-tasks/${taskId}/${action}`, jsonOptions(techCookie, 'POST', {}));
    assert.equal(result.response.status, 200, `${action}: ${JSON.stringify(result.payload)}`);
  }
  assert.equal(service.getEquipment(equipment.id).status, 'MODIFYING');
  const result = await request(base, `/api/modification-tasks/${taskId}/items/${itemId}/result`,
    jsonOptions(techCookie, 'PUT', { execution_result: '安装和接线均完成' }));
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const photo = await request(base, `/api/modification-tasks/${taskId}/items/${itemId}/photos`,
    jsonOptions(techCookie, 'POST', { attachments: [{ name: '完工.jpg', content_base64: jpeg }] }));
  assert.equal(photo.response.status, 201, JSON.stringify(photo.payload));
  const submitted = await request(base, `/api/modification-tasks/${taskId}/submit-review`,
    jsonOptions(techCookie, 'POST', { completion_summary: '现场全部完成' }));
  assert.equal(submitted.response.status, 200, JSON.stringify(submitted.payload));
  const approved = await request(base, `/api/modification-tasks/${taskId}/review`,
    jsonOptions(adminCookie, 'POST', { decision: 'APPROVED', note: '验收通过' }));
  assert.equal(approved.response.status, 200, JSON.stringify(approved.payload));
  assert.equal(service.activeInstallation(equipment.id).position_id, position.id);
  assert.equal(service.getEquipment(equipment.id).status, 'ACTIVE');
});
