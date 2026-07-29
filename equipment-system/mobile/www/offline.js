'use strict';

document.querySelector('#retry').addEventListener('click', () => location.reload());

const plugin = (() => {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() ||
      !capacitor?.isPluginAvailable?.('ServerSettings')) return null;
  return capacitor.Plugins?.ServerSettings || capacitor.registerPlugin?.('ServerSettings');
})();

const form = document.querySelector('#server-form');
const input = document.querySelector('#server-url');
const status = document.querySelector('#status');

function showStatus(message = '', tone = '') {
  status.textContent = message;
  status.className = `status${tone ? ` ${tone}` : ''}`;
}

async function loadConfig() {
  if (!plugin) {
    form.hidden = true;
    return;
  }
  try {
    const config = await plugin.getConfig();
    input.value = config.serverUrl || '';
    document.querySelector('#default-url').textContent =
      `安装包默认地址：${config.defaultUrl}${config.custom ? '（当前使用了自定义地址）' : ''}`;
    showStatus(config.allowPrivateHttp
      ? '测试版允许局域网 HTTP 私有 IP；上云后请填写 HTTPS 域名。'
      : '正式版只接受 HTTPS 地址。');
  } catch (error) {
    showStatus(error.message || '读取配置失败', 'error');
  }
}

document.querySelector('#test').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  showStatus('正在检查服务器……');
  try {
    const result = await plugin.testConnection({ serverUrl: input.value });
    input.value = result.serverUrl;
    showStatus(`连接成功（HTTP ${result.status}）`, 'success');
  } catch (error) {
    showStatus(error.message || '连接失败，请检查地址和网络', 'error');
  } finally {
    event.currentTarget.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus('正在保存，APP 即将重新连接……');
  try {
    await plugin.save({ serverUrl: input.value });
  } catch (error) {
    showStatus(error.message || '保存失败', 'error');
    button.disabled = false;
  }
});

document.querySelector('#reset').addEventListener('click', async () => {
  if (!window.confirm('恢复安装包内置的服务器地址并重新连接？')) return;
  showStatus('正在恢复默认地址，APP 即将重新连接……');
  try {
    await plugin.reset();
  } catch (error) {
    showStatus(error.message || '恢复失败', 'error');
  }
});

loadConfig();
