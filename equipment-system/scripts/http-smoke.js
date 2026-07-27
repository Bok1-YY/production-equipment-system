'use strict';

const assert = require('node:assert/strict');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787';
const username = process.env.SMOKE_USERNAME || 'admin';
const password = process.env.SMOKE_PASSWORD || 'ysm-admin-2026';

let cookie = '';

// 身份靠会话Cookie，登录后的每个请求都要把它带上。
async function call(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

async function request(path, options = {}) {
  const response = await call(path, options);
  assert.equal(response.ok, true, `${path} returned ${response.status}`);
  return response;
}

(async () => {
  const page = await request('/');
  assert.match(await page.text(), /优胜美设备管理/);

  const health = await (await request('/api/health')).json();
  assert.equal(health.data.status, 'ok');

  // 没有会话时业务接口必须一律401，否则三级权限就是摆设。
  const anonymous = await call('/api/equipment');
  assert.equal(anonymous.status, 401, '未登录时设备接口应返回401');

  const badLogin = await call('/api/session', {
    method: 'POST', body: JSON.stringify({ username, password: '故意写错的密码' }),
  });
  assert.equal(badLogin.status, 401, '错误密码应返回401');

  const login = await call('/api/session', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(login.ok, true, `登录失败（${login.status}）。管理员改过密码时请设置 SMOKE_PASSWORD`);
  const session = (await login.json()).data;
  assert.equal(session.level, 3);
  assert.ok(cookie.startsWith('ysm_session='), '登录应下发会话Cookie');

  if (session.must_change_password) {
    const blocked = await call('/api/equipment');
    assert.equal(blocked.status, 403, '未改密时业务接口应被拦截');
    return console.log('HTTP smoke passed（管理员仍是初始密码，业务接口部分跳过）：页面、健康检查、401拦截、登录、强制改密拦截');
  }

  const me = await (await request('/api/session/me')).json();
  assert.equal(me.data.username, username.toLowerCase());

  const createdPayload = await (await request('/api/equipment', {
    method: 'POST',
    body: JSON.stringify({ standard_name: 'HTTP冒烟测试设备', category: '测试设备', type_code: 'EXT' }),
  })).json();
  assert.match(createdPayload.data.code, /^YSM-EXT-\d{4}$/);

  const qr = await request(`/api/qr/${createdPayload.data.qr_token}/image.svg`);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);

  const dashboard = await (await request('/api/dashboard')).json();
  assert.ok(dashboard.data.equipment >= 1);
  // 两段平均时长：没有已完成工单时必须是 null，不能是 0（0 会被读成"响应零延迟"）
  assert.ok(['number', 'object'].includes(typeof dashboard.data.avgResponseMinutes), '总览要带平均响应时长');
  assert.ok(['number', 'object'].includes(typeof dashboard.data.avgRepairMinutes), '总览要带平均维修时长');

  // 报修模块已经启用，工单接口不该再返回503。
  const workOrders = await (await request('/api/work-orders')).json();
  assert.ok(Array.isArray(workOrders.data));

  // 报修页的常用故障快捷按钮：一张工单都没有时也必须给得出东西，否则普工看到一排空按钮
  const frequent = await (await request('/api/fault-codes/frequent')).json();
  assert.ok(Array.isArray(frequent.data) && frequent.data.length > 0, '常用故障不能是空的');
  assert.equal(frequent.data.some((item) => item.code === 'GEN-ALL-OTHER'), false, '兜底码“其他”不该进快捷按钮');

  const users = await (await request('/api/users')).json();
  assert.ok(users.data.some((item) => item.level === 3), '至少要有一个管理员账号');
  assert.equal(users.data.some((item) => 'password_hash' in item), false, '成员接口不能回传密码材料');

  await request('/api/session', { method: 'DELETE' });
  const afterLogout = await call('/api/session/me');
  assert.equal(afterLogout.status, 401, '登出后会话应立即失效');

  console.log('HTTP smoke passed：页面、健康检查、401拦截、登录登出、设备创建、二维码、总览、工单、成员');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
