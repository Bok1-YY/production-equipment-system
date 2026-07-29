'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openDatabase, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { createApplication } = require('../src/server');
const { levelToRole } = require('../src/auth');

const chromePath = process.env.CHROME_BIN || '/usr/bin/google-chrome';

function cdpClient(url) {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else events.push(message);
  });
  return {
    async ready() { await once(socket, 'open'); },
    call(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    events,
    close() { socket.close(); },
  };
}

async function waitFor(client, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.value) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`浏览器等待超时：${expression}`);
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`浏览器表达式执行失败：${JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome不存在：${chromePath}`);
  const db = openDatabase(':memory:');
  const service = new EquipmentService(db);
  const seed = service.listUsers().find((item) => item.username === DEFAULT_ADMIN_USERNAME);
  service.changeOwnPassword(seed.id, DEFAULT_ADMIN_PASSWORD, 'manager-2026');
  const manager = {
    actor: seed.display_name,
    user_id: seed.id,
    username: seed.username,
    level: seed.level,
    role: levelToRole(seed.level),
  };
  const workshop = service.organization().workshops[0];
  const line = service.createLine({
    workshop_id: workshop.id,
    code: 'YSM-MOBILE-L01',
    name: '4#叉车生产线',
  }, manager);
  const processRow = service.createProcess({
    line_id: line.id,
    code: 'YSM-MOBILE-L01-EQ',
    name: '设备组合（台账初始化）',
  }, manager);
  service.createPosition({
    process_id: processRow.id,
    code: 'YSM-MOBILE-L01-EQ-P01',
    name: '叉车主机安装机位',
  }, manager);
  const app = createApplication({ db, service, host: '127.0.0.1', port: 0 });
  app.listen();
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-browser-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let client;
  try {
    const browserWs = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome调试端口启动超时')), 15000);
      chrome.stderr.setEncoding('utf8');
      chrome.stderr.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chrome.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome提前退出：${code}\n${output}`));
      });
    });
    const debugBase = browserWs.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    let pages = [];
    const deadline = Date.now() + 10000;
    while (!pages.length && Date.now() < deadline) {
      pages = await fetch(`${debugBase}/json/list`).then((response) => response.json());
      if (!pages.length) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const page = pages.find((item) => item.type === 'page' && item.url.startsWith(`http://127.0.0.1:${port}`))
      || pages.find((item) => item.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('没有找到浏览器页面');
    client = cdpClient(page.webSocketDebuggerUrl);
    await client.ready();
    await client.call('Runtime.enable');
    await client.call('Page.enable');
    await client.call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(client, `document.querySelector('#login-form') && !document.querySelector('#auth-gate').hidden`);
    await client.call('Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('#login-username').value = 'admin';
        document.querySelector('#login-form [name="password"]').value = 'manager-2026';
        document.querySelector('#login-form').requestSubmit();
      })()`,
    });
    await waitFor(client, `!document.querySelector('#identity').hidden
      && document.querySelector('#view-dashboard').classList.contains('active')`, 15000);
    await client.call('Runtime.evaluate', {
      expression: `document.querySelector('.nav-item[data-view="inspection"]').click()`,
    });
    await waitFor(client, `document.querySelector('#view-inspection').classList.contains('active')
      && document.querySelector('[data-task-kind="inspection"] [data-task-list]').textContent.includes('没有任务')`);
    await client.call('Runtime.evaluate', {
      expression: `document.querySelector('.nav-item[data-view="structure"]').click()`,
    });
    await waitFor(client, `document.querySelector('#view-structure').classList.contains('active')
      && [...document.querySelectorAll('#organization-tree button')].some((button) => button.textContent === '编辑')`);
    await client.call('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('#organization-tree button')]
        .find((button) => button.textContent === '编辑').click()`,
    });
    await waitFor(client, `Boolean(document.querySelector('#toggle-structure-status'))`);

    // 同一套真实页面切到安卓常见的 360px 视口，专门防止中文名称再次被压成一字一行。
    // 重新导航会清掉上面结构编辑抽屉，但保留同一浏览器上下文中的登录 Cookie。
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await client.call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(client, `!document.querySelector('#identity').hidden
      && !document.querySelector('#mobile-more-button').hidden`, 15000);
    await evaluate(client, `document.querySelector('.nav-item[data-view="structure"]').click()`);
    await waitFor(client, `document.querySelector('#view-structure').classList.contains('active')
      && document.querySelector('#organization-tree .tree-node')`);
    await evaluate(client, `document.querySelectorAll('#organization-tree details').forEach((node) => {
      node.open = true;
    })`);
    await waitFor(client, `[...document.querySelectorAll('#organization-tree .tree-node')]
      .some((node) => node.dataset.treeKey.startsWith('position-'))`);

    const treeLayout = await evaluate(client, `(() => {
      const root = document.documentElement;
      const names = [...document.querySelectorAll('#organization-tree .node-main strong')]
        .map((node) => {
          const box = node.getBoundingClientRect();
          const mainBox = node.closest('.node-main').getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 20;
          return { text: node.textContent.trim(), width: mainBox.width, lines: box.height / lineHeight };
        });
      return {
        viewport: innerWidth,
        documentWidth: root.scrollWidth,
        minimumNameWidth: Math.min(...names.map((item) => item.width)),
        maximumNameLines: Math.max(...names.map((item) => item.lines)),
      };
    })()`);
    if (treeLayout.documentWidth > treeLayout.viewport + 1) {
      throw new Error(`手机页面发生横向溢出：${JSON.stringify(treeLayout)}`);
    }
    if (treeLayout.minimumNameWidth < 80 || treeLayout.maximumNameLines > 4.2) {
      throw new Error(`树节点名称仍被过度挤压：${JSON.stringify(treeLayout)}`);
    }

    const nodeMenuState = await evaluate(client, `(() => {
      const details = [...document.querySelectorAll('#organization-tree details')]
        .find((node) => node.dataset.treeKey.startsWith('process-'));
      const before = details.open;
      details.querySelector('[data-open-node-actions]').click();
      return { before, after: details.open };
    })()`);
    if (nodeMenuState.before !== nodeMenuState.after) {
      throw new Error('点击树节点“操作”误触发了节点展开或收起');
    }
    await waitFor(client, `!document.querySelector('#mobile-action-sheet').hidden
      && document.querySelector('#mobile-action-list').textContent.includes('编辑')
      && document.querySelector('#mobile-action-list').textContent.includes('机位')`);
    await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await waitFor(client, `document.querySelector('#mobile-action-sheet').hidden`);

    await evaluate(client, `document.querySelector('#mobile-more-button').click()`);
    await waitFor(client, `!document.querySelector('#mobile-action-sheet').hidden
      && document.querySelector('#mobile-action-list').textContent.includes('修改密码')
      && document.querySelector('#mobile-action-list').textContent.includes('退出')`);
    await evaluate(client, `document.querySelector('[data-close-mobile-actions]').click()`);
    await waitFor(client, `document.querySelector('#mobile-action-sheet').hidden`);

    await evaluate(client, `document.querySelector('#view-structure .mobile-toolbar-more').click()`);
    await waitFor(client, `!document.querySelector('#mobile-action-sheet').hidden
      && document.querySelector('#mobile-action-list').textContent.includes('新增车间')
      && document.querySelector('#mobile-action-list').textContent.includes('打印工序二维码')`);
    await evaluate(client, `document.querySelector('[data-close-mobile-actions]').click()`);
    await waitFor(client, `document.querySelector('#mobile-action-sheet').hidden`);

    if (process.env.YSM_MOBILE_SCREENSHOT) {
      const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      });
      fs.writeFileSync(process.env.YSM_MOBILE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }

    await evaluate(client, `document.querySelector('.nav-item[data-view="equipment"]').click()`);
    await waitFor(client, `document.querySelector('#view-equipment').classList.contains('active')
      && document.querySelector('#equipment-body tr')`);
    const tableLayout = await evaluate(client, `(() => {
      const wrap = document.querySelector('#view-equipment .table-wrap');
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        tableClientWidth: wrap.clientWidth,
        tableScrollWidth: wrap.scrollWidth,
      };
    })()`);
    if (tableLayout.documentWidth > tableLayout.viewport + 1 ||
        tableLayout.tableScrollWidth <= tableLayout.tableClientWidth) {
      throw new Error(`手机表格没有限制在自身滚动区域：${JSON.stringify(tableLayout)}`);
    }

    await client.call('Emulation.setDeviceMetricsOverride', {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: true,
    });
    await waitFor(client, `innerWidth === 412`);
    const widePhoneOverflow = await evaluate(client,
      `document.documentElement.scrollWidth - innerWidth`);
    if (widePhoneOverflow > 1) {
      throw new Error(`412px 手机视口发生横向溢出：${widePhoneOverflow}px`);
    }

    const exceptions = client.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    if (exceptions.length) {
      throw new Error(`浏览器发生脚本异常：${JSON.stringify(exceptions[0].params)}`);
    }
    process.stdout.write(
      '浏览器冒烟通过：桌面业务、360/412px 手机布局、树节点操作菜单和表内横向滚动正常\n',
    );
  } finally {
    client?.close();
    if (chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([
        once(chrome, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    if (chrome.exitCode === null) {
      chrome.kill('SIGKILL');
      await once(chrome, 'exit');
    }
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(`浏览器临时目录稍后由系统清理：${error.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
