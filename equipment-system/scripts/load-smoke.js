'use strict';

const { once } = require('node:events');
const { openDatabase, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { createApplication } = require('../src/server');

const concurrency = Math.max(1, Number(process.env.YSM_LOAD_CONCURRENCY) || 30);
const requestsPerClient = Math.max(1, Number(process.env.YSM_LOAD_REQUESTS_PER_CLIENT) || 20);

async function main() {
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const admin = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(admin.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const app = createApplication({ db, service, host: '127.0.0.1', port: 0 });
  app.listen();
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: admin.username, password: 'manager-2026' }),
    });
    if (!login.ok) throw new Error(`登录失败：HTTP ${login.status}`);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const times = [];
    let failures = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async (_, client) => {
      for (let index = 0; index < requestsPerClient; index += 1) {
        const began = performance.now();
        const endpoint = (client + index) % 3 === 0
          ? '/api/dashboard' : (client + index) % 3 === 1 ? '/api/organization/tree' : '/api/work-orders';
        const response = await fetch(`${base}${endpoint}`, { headers: { Cookie: cookie } });
        times.push(performance.now() - began);
        if (!response.ok) failures += 1;
        await response.arrayBuffer();
      }
    }));
    const duration = performance.now() - start;
    times.sort((a, b) => a - b);
    const percentile = (ratio) => times[Math.min(times.length - 1, Math.floor(times.length * ratio))];
    const result = {
      concurrency,
      requests: times.length,
      failures,
      seconds: Math.round(duration) / 1000,
      requests_per_second: Math.round((times.length / duration) * 1000),
      p50_ms: Math.round(percentile(0.5)),
      p95_ms: Math.round(percentile(0.95)),
      p99_ms: Math.round(percentile(0.99)),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (failures || result.p95_ms > 2000) {
      throw new Error('并发冒烟未达到“零失败且P95不超过2秒”的上线门槛');
    }
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
