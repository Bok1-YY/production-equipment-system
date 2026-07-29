'use strict';

const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.join(__dirname, '..');
const gradleFile = path.join(mobileRoot, 'android', 'app', 'build.gradle');
const variablesFile = path.join(mobileRoot, 'android', 'variables.gradle');
const manifestFile = path.join(
  mobileRoot,
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml',
);
const sdkRoot = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;

let gradle = fs.readFileSync(gradleFile, 'utf8');
gradle = gradle.replace(
  /^\s*versionCode\s+.*$/m,
  '        versionCode = providers.gradleProperty("ysmVersionCode").getOrElse("1").toInteger()',
);
gradle = gradle.replace(
  /^\s*versionName\s+.*$/m,
  '        versionName = providers.gradleProperty("ysmVersionName").getOrElse("0.1-test")',
);
fs.writeFileSync(gradleFile, gradle);

let variables = fs.readFileSync(variablesFile, 'utf8');
variables = variables.replace(
  /^\s*minSdkVersion\s*=\s*\d+$/m,
  '    minSdkVersion = 26',
);
fs.writeFileSync(variablesFile, variables);

let manifest = fs.readFileSync(manifestFile, 'utf8');
if (!manifest.includes('android:usesCleartextTraffic=')) {
  manifest = manifest.replace(
    '<application',
    '<application android:usesCleartextTraffic="${ysmUsesCleartextTraffic}"',
  );
} else {
  manifest = manifest.replace(
    /android:usesCleartextTraffic="[^"]+"/,
    'android:usesCleartextTraffic="${ysmUsesCleartextTraffic}"',
  );
}
for (const permission of [
  'android.permission.CAMERA',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
]) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(
      '</manifest>',
      `    <uses-permission android:name="${permission}" />\n</manifest>`,
    );
  }
}
if (!manifest.includes('RepairNotificationService')) {
  manifest = manifest.replace(
    '<activity',
    '<service android:name=".RepairNotificationService" android:exported="false" android:foregroundServiceType="remoteMessaging" />\n\n        <activity',
  );
}
fs.writeFileSync(manifestFile, manifest);

if (sdkRoot) {
  fs.writeFileSync(
    path.join(mobileRoot, 'android', 'local.properties'),
    `sdk.dir=${sdkRoot.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`,
  );
}

console.log('Android 测试工程配置已校验。');
