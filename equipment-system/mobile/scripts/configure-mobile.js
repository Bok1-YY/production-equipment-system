'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [serverUrl, sdkRoot] = process.argv.slice(2);
if (!/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(serverUrl || '')) {
  throw new Error(`无效的手机测试服务地址：${serverUrl || '未提供'}`);
}
if (!sdkRoot || !path.isAbsolute(sdkRoot)) {
  throw new Error('Android SDK 路径无效');
}

const mobileRoot = path.join(__dirname, '..');
const config = {
  appId: 'com.ysm.equipment.mobiletest',
  appName: '优胜美设备管理（测试）',
  webDir: 'www',
  loggingBehavior: 'debug',
  server: {
    url: serverUrl,
    cleartext: true,
    errorPath: 'offline.html',
  },
};

fs.writeFileSync(
  path.join(mobileRoot, 'capacitor.config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
);

const androidRoot = path.join(mobileRoot, 'android');
if (fs.existsSync(androidRoot)) {
  fs.writeFileSync(
    path.join(androidRoot, 'local.properties'),
    `sdk.dir=${sdkRoot.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`,
  );
}

console.log(`安卓测试壳将连接：${serverUrl}`);
