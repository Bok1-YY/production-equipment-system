'use strict';

const fs = require('node:fs');
const path = require('node:path');

const serverUrl = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(serverUrl)) {
  throw new Error('用法：node scripts/configure-production.js https://正式域名');
}

const mobileRoot = path.join(__dirname, '..');
const config = {
  appId: process.env.YSM_ANDROID_APPLICATION_ID || 'com.ysm.equipment',
  appName: '优胜美设备管理',
  webDir: 'www',
  loggingBehavior: 'none',
  server: {
    url: serverUrl,
    cleartext: false,
    errorPath: 'offline.html',
  },
};
fs.writeFileSync(
  path.join(mobileRoot, 'capacitor.config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
);
process.stdout.write(`正式 Android 壳已配置为：${serverUrl}\n`);
