'use strict';

const state = {
  me: null,
  members: [],
  faultCodes: { codes: [], categories: [] },
  quickFaults: [],                      // 报修页的常用故障快捷按钮
  meta: null,                           // /api/meta，含二维码地址等部署信息
  patrols: [],
  photos: { repair: [], patrol: [] },   // 待上传的照片，按表单分组
  organization: null,
  organizationTree: [],
  equipment: [],
  equipmentTypes: [],
  workOrders: [],
  selectedWorkOrder: null,
  expandedNodes: new Set(JSON.parse(localStorage.getItem('ysm-expanded-tree') || '[]')),
  treeInitialized: false,
};

const LEVELS = { WORKER: 1, TECHNICIAN: 2, MANAGER: 3 };
const LEVEL_NAMES = { 1: '普工', 2: '技术员', 3: '管理员' };
const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED'];

// 前四个由管理员在档案里手工维护，后两个由维修工单自动维护，界面上不给选。
const EQUIPMENT_STATUS = {
  ACTIVE: { name: '在用', tone: '' },
  IDLE: { name: '闲置', tone: 'muted' },
  DISABLED: { name: '停用', tone: 'muted' },
  RETIRED: { name: '报废', tone: 'muted' },
  REPORTED: { name: '已报修', tone: 'pending' },
  REPAIRING: { name: '维修中', tone: 'danger' },
};
const MANUAL_EQUIPMENT_STATUSES = ['ACTIVE', 'IDLE', 'DISABLED', 'RETIRED'];

function statusName(status) {
  return EQUIPMENT_STATUS[status]?.name || status || '—';
}

function statusBadge(status) {
  const meta = EQUIPMENT_STATUS[status];
  return `<span class="status ${meta?.tone || ''}">${escapeHtml(meta?.name || status || '—')}</span>`;
}

function underRepair(status) {
  return status === 'REPORTED' || status === 'REPAIRING';
}

function level() {
  return state.me ? Number(state.me.level) : 0;
}

// 台账、产线结构和变动审核都是管理员的活；技术员进这些页面只读。
function canManage() {
  return level() >= LEVELS.MANAGER;
}

const labels = {
  SUBMITTED: '已提交', ASSIGNED: '已分派', ACCEPTED: '已接单', ARRIVED: '已到场',
  IN_PROGRESS: '维修中', WAITING_PARTS: '等待零件', OUTSOURCED: '外协中', TRIAL_RUN: '待试运行',
  PENDING_REVIEW: '待审核', COMPLETED: '已完成', CANCELLED: '已取消',
  INSTALL: '安装', MOVE: '移动', REMOVE: '拆除', REPLACE: '替换',
  PENDING: '待确认', APPROVED: '已确认', REJECTED: '已驳回',
  NORMAL: '一般', URGENT: '紧急', CRITICAL: '特急',
  STATUS_SYNC: '维修状态联动', CREATE: '建档', UPDATE: '修改档案', IMPORT_CREATE: '导入建档',
  CREATED: '提交报修', CLAIMED: '技术员接单', REASSIGNED: '转派',
  STATUS_CHANGED: '状态流转', REPAIR_DETAIL_UPDATED: '更新维修记录',
  EQUIPMENT_CORRECTED: '修正故障设备', FAULT_CLASSIFIED: '确认故障分类', PART_ADDED: '记录零件',
  WITHDRAWN: '报修人撤回', REVIEWED: '报修人评价', REVIEW_UPDATED: '修改评价',
  REOPENED: '重新报修', FROM_PATROL: '由巡检转入',
};

// 状态机由服务端 /api/meta 下发，前端不再抄一份——抄了就会和后端走散。
// 启动时还没拿到之前先给个空对象，"下一步"下拉会显示成没有可选项。
let nextStatuses = {};
// 有序阶段表和"算不算已到场"，同样由 /api/meta 下发。启动时给个空表，
// 拿到之前工单详情画不出步骤条（不会报错，只是没有步骤条）。
let workOrderStages = [];
let postArrivalStatuses = [];
let scannerPlugin = null;
let scanBusy = false;
let repairNotificationsPlugin = null;
let openingNotification = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value));
}

// 两个时刻之间的用时。缺任一端就说明这段还没走完，用 pending 说清卡在哪一步，
// 别显示成"0分钟"——那会被读成"响应零延迟"。
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分` : ''}`;
  return `${Math.floor(minutes / 1440)}天${Math.floor((minutes % 1440) / 60) ? `${Math.floor((minutes % 1440) / 60)}小时` : ''}`;
}

function elapsed(from, to, pending = '—') {
  if (!from || !to) return `<span class="status muted">${escapeHtml(pending)}</span>`;
  const minutes = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
  return formatDuration(minutes);
}

function formObject(form) {
  const result = {};
  for (const [key, value] of new FormData(form)) result[key] = value;
  for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) result[checkbox.name] = checkbox.checked;
  return result;
}

// ---- 现场照片：先在浏览器里压缩再传，别把几MB原图丢到车间WiFi上 ----

const MAX_PHOTOS = 6;
const PHOTO_MAX_EDGE = 1600;

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve({ name: file.name, dataUrl, content_base64: dataUrl.split(',')[1] });
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`无法读取图片：${file.name}`)); };
    image.src = url;
  });
}

function renderPhotoGrid(key) {
  const grid = document.querySelector(`[data-photo-grid="${key}"]`);
  if (!grid) return;
  const photos = state.photos[key] || [];
  grid.innerHTML = photos.map((photo, index) => `
    <figure class="photo-thumb">
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.name)}">
      <button type="button" class="photo-remove" data-photo-remove="${key}:${index}" title="移除">×</button>
    </figure>`).join('');
  grid.querySelectorAll('[data-photo-remove]').forEach((button) => button.addEventListener('click', () => {
    const [group, position] = button.dataset.photoRemove.split(':');
    state.photos[group].splice(Number(position), 1);
    renderPhotoGrid(group);
    if (group === 'repair') updateFaultTip();
  }));
}

async function handlePhotoPick(key, input) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  const photos = state.photos[key] || (state.photos[key] = []);
  if (photos.length + files.length > MAX_PHOTOS) return flash(`最多只能上传${MAX_PHOTOS}张照片`, 'error');
  for (const file of files) {
    if (!file.type.startsWith('image/')) { flash(`${file.name} 不是图片`, 'error'); continue; }
    try { photos.push(await compressImage(file)); }
    catch (error) { flash(error.message, 'error'); }
  }
  renderPhotoGrid(key);
  if (key === 'repair') updateFaultTip();
}

function takePhotos(key) {
  return (state.photos[key] || []).map((photo) => ({ content_base64: photo.content_base64, name: photo.name }));
}

function clearPhotos(key) {
  state.photos[key] = [];
  renderPhotoGrid(key);
}

function photoLightbox(attachment) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer photo-lightbox';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="lightbox-body">
    <button class="drawer-close">×</button>
    <img src="/api/attachments/${attachment.id}/file" alt="${escapeHtml(attachment.original_name || '现场照片')}">
    <p>${escapeHtml(attachment.original_name || '现场照片')} · ${escapeHtml(attachment.uploaded_by)} · ${formatTime(attachment.created_at)}</p>
  </div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  document.body.append(overlay);
}

// 已上传照片的只读缩略图条，工单详情和设备履历共用
function attachmentStrip(attachments) {
  if (!attachments?.length) return '';
  return `<div class="photo-grid readonly">${attachments.map((item) => `
    <figure class="photo-thumb"><img src="/api/attachments/${item.id}/file" loading="lazy"
      alt="${escapeHtml(item.original_name || '现场照片')}" onclick="openPhoto(${item.id})"></figure>`).join('')}</div>`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取所选文件'));
    reader.readAsDataURL(file);
  });
}

// 身份由HttpOnly会话Cookie携带，页面上不再有任何可自选的角色。
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `请求失败：${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code || '';
    throw error;
  }
  return payload.data;
}

function flash(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `flash ${type === 'error' ? 'error' : ''}`;
  node.textContent = message;
  document.querySelector('#flash').append(node);
  setTimeout(() => node.remove(), 3600);
}

async function guarded(task, successMessage) {
  try {
    const result = await task();
    if (successMessage) flash(successMessage);
    return result;
  } catch (error) {
    // 会话过期或被管理员停用时直接退回登录界面，不要让人对着一堆报错继续点。
    if (error.status === 401 && state.me) {
      state.me = null;
      flash('登录已失效，请重新登录', 'error');
      showAuthGate('login');
    } else if (error.code === 'PASSWORD_CHANGE_REQUIRED') {
      showAuthGate('password');
    } else {
      flash(error.message, 'error');
    }
    throw error;
  }
}

// ---- 登录与三级界面 ----

function showAuthGate(mode = 'login') {
  const scanButton = document.querySelector('#native-scan-button');
  if (scanButton) scanButton.hidden = true;
  stopNativeRepairNotifications();
  document.querySelector('#auth-gate').hidden = false;
  document.querySelector('#identity').hidden = true;
  document.querySelector('#login-form').hidden = mode !== 'login';
  document.querySelector('#first-password-form').hidden = mode !== 'password';
  if (mode === 'login') document.querySelector('#login-username').focus();
}

function hideAuthGate() {
  document.querySelector('#auth-gate').hidden = true;
  document.querySelector('#identity').hidden = false;
}

function getNativeScanner() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() ||
      !capacitor?.isPluginAvailable?.('CapacitorBarcodeScanner')) return null;
  if (!scannerPlugin) {
    scannerPlugin = capacitor.Plugins?.CapacitorBarcodeScanner ||
      capacitor.registerPlugin?.('CapacitorBarcodeScanner');
  }
  return scannerPlugin;
}

function refreshNativeScanButton() {
  const button = document.querySelector('#native-scan-button');
  if (!button) return;
  button.hidden = !(state.me && getNativeScanner());
}

function getNativeRepairNotifications() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() ||
      !capacitor?.isPluginAvailable?.('RepairNotifications')) return null;
  if (!repairNotificationsPlugin) {
    repairNotificationsPlugin = capacitor.Plugins?.RepairNotifications ||
      capacitor.registerPlugin?.('RepairNotifications');
  }
  return repairNotificationsPlugin;
}

async function stopNativeRepairNotifications() {
  const plugin = getNativeRepairNotifications();
  if (!plugin) return;
  try { await plugin.stopMonitoring(); } catch { /* 服务本来没启动也没关系 */ }
}

async function openPendingRepairNotification() {
  if (openingNotification || level() !== LEVELS.TECHNICIAN) return;
  const plugin = getNativeRepairNotifications();
  if (!plugin) return;
  openingNotification = true;
  try {
    const pending = await plugin.getPendingWorkOrder();
    const workOrderId = Number(pending?.workOrderId || 0);
    if (!workOrderId) return;
    activateView('repairs');
    await loadWorkOrders();
    if (workOrderId === -1) return;
    await openWorkOrder(workOrderId);
  } catch (error) {
    flash(error.message || '无法打开通知对应的工单', 'error');
  } finally {
    openingNotification = false;
  }
}

async function configureNativeRepairNotifications() {
  const plugin = getNativeRepairNotifications();
  if (!plugin) return;
  if (level() !== LEVELS.TECHNICIAN) {
    await stopNativeRepairNotifications();
    return;
  }
  try {
    const result = await plugin.startMonitoring({ userId: Number(state.me.user_id) });
    if (result?.enabled === false) {
      flash('报修通知未开启：请在安卓系统设置中允许通知权限', 'error');
      return;
    }
    await openPendingRepairNotification();
  } catch (error) {
    flash(error.message || '无法开启报修通知', 'error');
  }
}

async function startSession() {
  let me;
  try {
    me = await api('/api/session/me');
  } catch (error) {
    state.me = null;
    return showAuthGate('login');
  }
  state.me = me;
  if (me.must_change_password) return showAuthGate('password');
  hideAuthGate();
  document.querySelector('#identity-name').textContent = me.display_name;
  document.querySelector('#identity-level').textContent = `${LEVEL_NAMES[me.level] || ''} · ${me.username}`;
  applyLevelUi();
  await guarded(async () => { await refreshAll(); await handleScanLink(); });
  await configureNativeRepairNotifications();
}

// 后端按级别判权；这里同步隐藏用不上的入口，避免普工面对一屏无关功能。
function applyLevelUi() {
  const current = level();
  let firstVisible = null;
  for (const node of document.querySelectorAll('[data-min-level]')) {
    const visible = current >= Number(node.dataset.minLevel || 1);
    node.hidden = !visible;
    if (visible && !firstVisible && node.classList.contains('nav-item')) firstVisible = node;
  }
  // 侧栏隐藏时要同时把 .shell 收成一列，否则 main 会掉进侧栏那 190px 的网格列里。
  const noSidebar = current <= LEVELS.WORKER;
  document.querySelector('.sidebar').hidden = noSidebar;
  document.querySelector('.shell').classList.toggle('no-sidebar', noSidebar);
  // 左侧表单被级别隐藏后，右侧表格独占整行，别挤在窄栏里。
  for (const split of document.querySelectorAll('.split')) {
    const visible = [...split.children].filter((child) => !child.hidden);
    split.classList.toggle('single-column', visible.length <= 1);
  }

  const worker = current === LEVELS.WORKER;
  const technician = current === LEVELS.TECHNICIAN;
  document.querySelector('#repair-title').textContent = worker ? '设备报修' : '维修工单';
  document.querySelector('#repair-eyebrow').textContent = worker
    ? '发现故障就报，技术员会来处理'
    : technician ? '待接单池 · 我的维修任务' : '报修 · 派单 · 全部工单';
  document.querySelector('#work-order-list-title').textContent = worker ? '我的报修' : '工单列表';
  document.querySelector('#work-order-list-hint').textContent = worker
    ? '只显示你自己报修的工单'
    : technician ? '在待接单池点“我接这单”开始维修' : '点击工单查看和处理';
  // 技术员和管理员以处理工单为主，报修表单收进折叠区，别占掉半屏。
  document.querySelector('#repair-layout').classList.toggle('worker-mode', worker);
  document.querySelector('#repair-form').classList.toggle('collapsed-form', !worker);

  const target = firstVisible || document.querySelector('.nav-item[data-view="repairs"]');
  activateView(target.dataset.view);
  refreshNativeScanButton();
}

function activateView(view) {
  for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('active', button.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.classList.toggle('active', section.id === `view-${view}`);
}

async function logout() {
  await stopNativeRepairNotifications();
  try { await api('/api/session', { method: 'DELETE' }); } catch { /* 会话可能已经失效 */ }
  state.me = null;
  location.reload();
}

function openChangePasswordDrawer() {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">账号安全</p><h2>修改密码</h2>
    <form class="form-card" id="change-password-form">
      <label>当前密码<input type="password" name="old_password" autocomplete="current-password" required></label>
      <label>新密码<input type="password" name="new_password" autocomplete="new-password" minlength="8" required></label>
      <label>确认新密码<input type="password" name="confirm_password" autocomplete="new-password" minlength="8" required></label>
      <p class="hint">新密码至少8位，不能包含空格。</p>
      <button>保存新密码</button>
    </form></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#change-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formObject(event.currentTarget);
    if (payload.new_password !== payload.confirm_password) return flash('两次输入的新密码不一致', 'error');
    await guarded(() => api('/api/session/password', {
      method: 'POST', body: JSON.stringify({ old_password: payload.old_password, new_password: payload.new_password }),
    }), '密码已修改');
    close();
  });
  document.body.append(overlay);
}

// ---- 工单评价 ----

const REVIEW_DIMENSIONS = [
  { key: 'quality', name: '维修质量' },
  { key: 'attitude', name: '服务态度' },
  { key: 'speed', name: '响应速度' },
];

// 只读星级，用于列表和详情展示
function starsView(score, { showNumber = true } = {}) {
  if (score === null || score === undefined) return '<span class="status muted">未评价</span>';
  const full = Math.round(Number(score));
  return `<span class="stars-view" title="${escapeHtml(String(score))} 分">${
    [1, 2, 3, 4, 5].map((n) => `<span class="${n <= full ? 'on' : ''}">★</span>`).join('')
  }${showNumber ? `<em>${escapeHtml(String(score))}</em>` : ''}</span>`;
}

// 可点的星级控件。手机上一只手要能点准，所以按钮做得比较大。
function starsInput(key, value = 0) {
  return `<div class="stars-input" data-stars="${key}" data-value="${value}">${
    [1, 2, 3, 4, 5].map((n) => `<button type="button" data-score="${n}" class="${n <= value ? 'on' : ''}" aria-label="${n}星">★</button>`).join('')
  }<span class="stars-hint"></span></div>`;
}

const STAR_HINTS = { 1: '很不满意', 2: '不太满意', 3: '一般', 4: '满意', 5: '很满意' };

function bindStarsInput(root) {
  root.querySelectorAll('[data-stars]').forEach((group) => {
    const hint = group.querySelector('.stars-hint');
    const paint = (value) => {
      group.dataset.value = value;
      group.querySelectorAll('[data-score]').forEach((button) =>
        button.classList.toggle('on', Number(button.dataset.score) <= value));
      hint.textContent = STAR_HINTS[value] || '';
    };
    paint(Number(group.dataset.value) || 0);
    group.querySelectorAll('[data-score]').forEach((button) =>
      button.addEventListener('click', () => paint(Number(button.dataset.score))));
  });
}

function openReviewDrawer(workOrder, existing = null) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(workOrder.work_order_no)}</p>
    <h2>${existing ? '修改评价' : '评价这次维修'}</h2>
    <p class="hint">${escapeHtml(workOrder.final_equipment_code || workOrder.reported_equipment_code || '')} ${escapeHtml(workOrder.fault_symptom)}<br>技术员：${escapeHtml(workOrder.assignee || '未记录')}</p>
    <form class="form-card" id="review-form">
      ${REVIEW_DIMENSIONS.map((item) => `<div class="review-row"><span>${item.name}</span>${
        starsInput(item.key, existing ? Number(existing[`${item.key}_score`]) : 0)}</div>`).join('')}
      <label>想说点什么（选填）<textarea name="comment" rows="3" placeholder="比如：修得挺快，就是等人等了半小时">${escapeHtml(existing?.comment || '')}</textarea></label>
      <p class="hint">评价只有你自己和管理员能看到，技术员只能看到自己的综合平均分。</p>
      <button>${existing ? '保存修改' : '提交评价'}</button>
    </form></div>`;
  bindStarsInput(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#review-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = { comment: form.querySelector('[name="comment"]').value };
    for (const item of REVIEW_DIMENSIONS) {
      const value = Number(overlay.querySelector(`[data-stars="${item.key}"]`).dataset.value) || 0;
      if (!value) return flash(`请给「${item.name}」打个分`, 'error');
      payload[`${item.key}_score`] = value;
    }
    await guarded(() => api(`/api/work-orders/${workOrder.id}/review`, {
      method: 'POST', body: JSON.stringify(payload),
    }), existing ? '评价已更新' : '评价已提交，谢谢反馈');
    close();
    await loadWorkOrders();
  });
  document.body.append(overlay);
}

async function reviewWorkOrder(id) {
  const detail = await guarded(() => api(`/api/work-orders/${id}`));
  openReviewDrawer(detail.work_order, detail.review);
}

function openWithdrawDrawer(item) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(item.work_order_no)}</p><h2>撤回这次报修</h2>
    <p class="hint">${escapeHtml(item.fault_symptom)}<br>${item.assignee ? `已经有技术员（${escapeHtml(item.assignee)}）接单，撤回后他会收到通知。` : '还没有技术员接单。'}</p>
    <form class="form-card" id="withdraw-form">
      <label>撤回原因*<textarea name="reason" rows="3" required placeholder="例如：自己重启后好了 / 报错设备了"></textarea></label>
      <div class="quick-fills"><button type="button" class="secondary small" data-quick-reason="自己处理好了，不用来了">自己好了</button><button type="button" class="secondary small" data-quick-reason="报错设备了，重新报一单">报错设备</button><button type="button" class="secondary small" data-quick-reason="误操作，不是设备故障">误操作</button></div>
      <button class="danger">确认撤回</button>
    </form></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelectorAll('[data-quick-reason]').forEach((button) => button.addEventListener('click', () => {
    overlay.querySelector('[name="reason"]').value = button.dataset.quickReason;
  }));
  overlay.querySelector('#withdraw-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await guarded(() => api(`/api/work-orders/${item.id}/withdraw`, {
      method: 'POST', body: JSON.stringify(formObject(form)),
    }), '报修已撤回');
    close();
    await Promise.all([loadWorkOrders(), level() >= LEVELS.TECHNICIAN ? loadDashboard() : Promise.resolve()]);
  });
  document.body.append(overlay);
}

function openReopenDrawer(item) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const categories = state.faultCodes.categories || [];
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(item.work_order_no)} · 修复后又坏了</p><h2>重新报修</h2>
    <p class="hint">设备和故障代码已经按上一单填好。如果这次的问题不一样，可以改。</p>
    <form class="form-card" id="reopen-form">
      <div class="detail-block"><div class="definition-grid">
        <div><small>设备</small>${escapeHtml(item.final_equipment_code || item.reported_equipment_code || '未指定')}</div>
        <div><small>上次故障</small>${escapeHtml(item.fault_symptom)}</div>
        <div><small>上次完成</small>${item.completed_at ? formatTime(item.completed_at) : '—'}</div>
        <div><small>上次技术员</small>${escapeHtml(item.assignee || '—')}</div>
      </div></div>
      <label>这次的故障（不改就沿用上次的）<select id="reopen-category"><option value="">沿用上次</option>${categories.map((c) => `<option value="${escapeHtml(c.category)}">${escapeHtml(c.category)}</option>`).join('')}</select></label>
      <label id="reopen-part-wrap" hidden>故障部位<select id="reopen-part"></select></label>
      <label id="reopen-symptom-wrap" hidden>故障现象<select name="fault_code_id" id="reopen-symptom"></select></label>
      <div class="form-row"><label>紧急程度<select name="urgency"><option value="NORMAL">一般</option><option value="URGENT">紧急</option><option value="CRITICAL">特急</option></select></label><label class="check bottom"><input type="checkbox" name="is_downtime">导致停机</label></div>
      <label>说明<textarea name="description" rows="3" placeholder="例如：上周修好后用了三天又出现同样问题"></textarea></label>
      <button>提交重新报修</button>
    </form></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  const partWrap = overlay.querySelector('#reopen-part-wrap');
  const symptomWrap = overlay.querySelector('#reopen-symptom-wrap');
  const partSelect = overlay.querySelector('#reopen-part');
  const symptomSelect = overlay.querySelector('#reopen-symptom');
  overlay.querySelector('#reopen-category').addEventListener('change', (event) => {
    const parts = categories.find((c) => c.category === event.target.value)?.parts || [];
    partWrap.hidden = !parts.length;
    symptomWrap.hidden = true;
    partSelect.innerHTML = `<option value="">请选择</option>${parts.map((p) => `<option value="${escapeHtml(p.part)}">${escapeHtml(p.part)}</option>`).join('')}`;
  });
  partSelect.addEventListener('change', (event) => {
    const category = overlay.querySelector('#reopen-category').value;
    const symptoms = categories.find((c) => c.category === category)?.parts.find((p) => p.part === event.target.value)?.symptoms || [];
    symptomWrap.hidden = !symptoms.length;
    symptomSelect.innerHTML = `<option value="">请选择</option>${symptoms.map((s) => `<option value="${s.id}">${escapeHtml(s.symptom)}</option>`).join('')}`;
  });
  overlay.querySelector('#reopen-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await guarded(() => api(`/api/work-orders/${item.id}/reopen`, {
      method: 'POST', body: JSON.stringify(formObject(form)),
    }), '已重新报修');
    close();
    flash(`新工单 ${result.work_order.work_order_no} 已提交`);
    await loadWorkOrders();
  });
  document.body.append(overlay);
}

// 技术员的自我评分卡：只有综合分，没有单条评价
async function loadMyReviewSummary() {
  const summary = await api('/api/reviews/me');
  const node = document.querySelector('#my-review-card');
  if (!node) return;
  node.hidden = false;
  node.innerHTML = summary.review_count ? `
    <div class="card-head"><h2>我的服务评价</h2><span class="pill">${summary.review_count} 条</span></div>
    <div class="my-review-body">
      <div class="my-review-overall"><strong>${summary.overall}</strong><small>综合</small>${starsView(summary.overall, { showNumber: false })}</div>
      <div class="my-review-dims">${REVIEW_DIMENSIONS.map((item) => `
        <div><span>${item.name}</span>${starsView(summary[item.key])}</div>`).join('')}</div>
    </div>
    <p class="hint">这里只显示综合平均分。单条评价和评价人对技术员不开放，避免有人因为怕被认出来而不敢如实打分。</p>`
    : `<div class="card-head"><h2>我的服务评价</h2></div>
       <p class="hint">还没有收到评价。报修人在工单完成后可以打分，这里会显示你的综合平均分。</p>`;
}

// ---- 服务评价（管理员）----

async function loadReviewAdmin() {
  const [ranking, reviews] = await Promise.all([api('/api/reviews/technicians'), api('/api/reviews')]);
  document.querySelector('#technician-ranking').innerHTML = ranking.length ? `
    <div class="table-wrap"><table><thead><tr><th>技术员</th><th>综合</th>${REVIEW_DIMENSIONS.map((d) => `<th>${d.name}</th>`).join('')}<th>评价数</th></tr></thead><tbody>
      ${ranking.map((item) => `<tr class="${item.technician_status === 'DISABLED' ? 'row-muted' : ''}">
        <td><strong>${escapeHtml(item.technician || '未记录')}</strong>${item.technician_status === 'DISABLED' ? '<br><small class="status muted">已停用</small>' : ''}</td>
        <td>${starsView(item.overall)}</td>
        ${REVIEW_DIMENSIONS.map((d) => `<td>${item[d.key] ?? '—'}</td>`).join('')}
        <td>${item.review_count}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">还没有任何评价</div>';

  document.querySelector('#review-count').textContent = `${reviews.length} 条`;
  document.querySelector('#review-list').innerHTML = reviews.length ? reviews.map((item) => `
    <article class="stack-item">
      <div class="stack-title"><strong>${escapeHtml(item.work_order_no)}</strong>${starsView(item.overall_score)}</div>
      <div class="stack-meta"><span>${escapeHtml(item.equipment_code || '')} ${escapeHtml(item.equipment_name || '')}</span><span>${escapeHtml(item.line_name || '')} ${escapeHtml(item.process_name || '')}</span></div>
      <div class="review-scores">${REVIEW_DIMENSIONS.map((d) => `<span>${d.name} ${item[`${d.key}_score`]}分</span>`).join('')}</div>
      ${item.comment ? `<p>“${escapeHtml(item.comment)}”</p>` : ''}
      <div class="stack-meta"><span>技术员：${escapeHtml(item.technician || '未记录')}</span><span>评价人：${escapeHtml(item.reviewer)}</span><span>${formatTime(item.created_at)}</span></div>
    </article>`).join('') : '<div class="empty">还没有任何评价</div>';
}

// ---- 故障代码：三级级联 + 管理页 ----

function selectedFaultCode() {
  const id = Number(document.querySelector('#fault-symptom')?.value || 0);
  return state.faultCodes.codes.find((item) => item.id === id) || null;
}

async function loadFaultCodes({ all = false } = {}) {
  state.faultCodes = await api(`/api/fault-codes${all ? '?all=1' : ''}`);
  renderFaultCascade();
  return state.faultCodes;
}

function renderFaultCascade() {
  const categorySelect = document.querySelector('#fault-category');
  if (!categorySelect) return;
  const categories = state.faultCodes.categories || [];
  const keepCategory = categorySelect.value;
  categorySelect.innerHTML = `<option value="">请选择</option>${categories.map((item) =>
    `<option value="${escapeHtml(item.category)}">${escapeHtml(item.category)}</option>`).join('')}`;
  if (categories.some((item) => item.category === keepCategory)) categorySelect.value = keepCategory;
  renderFaultParts();
}

function renderFaultParts() {
  const category = document.querySelector('#fault-category')?.value || '';
  const partSelect = document.querySelector('#fault-part');
  if (!partSelect) return;
  const parts = state.faultCodes.categories.find((item) => item.category === category)?.parts || [];
  const keep = partSelect.value;
  partSelect.innerHTML = `<option value="">${category ? '请选择' : '请先选故障类别'}</option>${parts.map((item) =>
    `<option value="${escapeHtml(item.part)}">${escapeHtml(item.part)}</option>`).join('')}`;
  if (parts.some((item) => item.part === keep)) partSelect.value = keep;
  renderFaultSymptoms();
}

function renderFaultSymptoms() {
  const category = document.querySelector('#fault-category')?.value || '';
  const part = document.querySelector('#fault-part')?.value || '';
  const symptomSelect = document.querySelector('#fault-symptom');
  if (!symptomSelect) return;
  const symptoms = state.faultCodes.categories
    .find((item) => item.category === category)?.parts.find((item) => item.part === part)?.symptoms || [];
  const keep = symptomSelect.value;
  symptomSelect.innerHTML = `<option value="">${part ? '请选择' : '请先选故障部位'}</option>${symptoms.map((item) =>
    `<option value="${item.id}">${escapeHtml(item.symptom)}</option>`).join('')}`;
  if (symptoms.some((item) => String(item.id) === keep)) symptomSelect.value = keep;
  updateFaultTip();
}

// 选中故障码后：显示处理建议、带出默认紧急程度和停机标记、提示是否必须拍照。
// 说明栏什么时候必填要和服务端一致：没选故障码时，那句话是技术员到场前唯一的信息来源，
// 必填；选了码（快捷按钮或完整级联）就不用再打字——省下这一步才是给普工减负的意义。
// 兜底码「其他」是例外，它本身不说明任何问题，必须有文字。
function updateFaultTip() {
  const code = selectedFaultCode();
  const tip = document.querySelector('#fault-tip');
  const photoHint = document.querySelector('#repair-photo-required');
  const descriptionLabel = document.querySelector('#repair-description-label');
  if (!tip) return;
  tip.hidden = !code?.suggested_action;
  if (code?.suggested_action) tip.textContent = `处理建议：${code.suggested_action}`;
  if (photoHint) photoHint.hidden = !code?.requires_photo;
  if (descriptionLabel) {
    const isFallback = code && /其他/.test(code.symptom);
    const needed = !code || isFallback;
    descriptionLabel.firstChild.textContent = needed ? '哪里不对劲*' : '补充说明';
    const box = descriptionLabel.querySelector('textarea');
    box.required = needed;
    box.placeholder = needed
      ? '例如：3号挤出机不出料了，刚才还是好的'
      : '选填。什么时候开始的、有没有自己处理过';
  }
  syncQuickFaultSelection();
  if (code) {
    const urgency = document.querySelector('#repair-urgency');
    if (urgency && !urgency.dataset.touched) urgency.value = code.default_urgency || 'NORMAL';
    const downtime = document.querySelector('#repair-downtime');
    if (downtime && code.requires_downtime && !downtime.dataset.touched) downtime.checked = true;
  }
  const submit = document.querySelector('#repair-form button[type="submit"], #repair-form button:not([type])');
  if (submit) {
    const missingPhoto = Boolean(code?.requires_photo) && !(state.photos.repair || []).length;
    submit.disabled = missingPhoto;
    submit.textContent = missingPhoto ? '请先拍一张现场照片' : '提交报修';
  }
}

// ---- 常用故障快捷按钮 ----
// 普工按不按都能提交；按下去等于替他把三级级联选完。选谁由服务端定：
// 有历史工单就按频次，没有就按管理员标的 is_common（见 service.frequentFaultCodes）。

async function loadQuickFaults() {
  const wrap = document.querySelector('#quick-fault-wrap');
  if (!wrap) return;
  const equipmentId = document.querySelector('#repair-equipment')?.value || '';
  try {
    state.quickFaults = await api(`/api/fault-codes/frequent${equipmentId ? `?equipment_id=${equipmentId}` : ''}`);
  } catch {
    state.quickFaults = [];   // 快捷按钮拿不到不该挡住报修，完整级联还在
  }
  renderQuickFaults();
}

function renderQuickFaults() {
  const wrap = document.querySelector('#quick-fault-wrap');
  const grid = document.querySelector('#quick-fault-grid');
  if (!wrap || !grid) return;
  const codes = state.quickFaults || [];
  wrap.hidden = !codes.length;
  // 要拍照的先标出来，别让普工点完才被拦住
  grid.innerHTML = codes.map((item) => `
    <button type="button" class="quick-fault-item" data-fault-code="${item.id}">
      <strong>${escapeHtml(item.symptom)}</strong>
      <small>${escapeHtml(item.part)}${item.requires_photo ? ' · 需拍照' : ''}</small>
    </button>`).join('');
  syncQuickFaultSelection();
}

function syncQuickFaultSelection() {
  const selected = document.querySelector('#fault-symptom')?.value || '';
  document.querySelectorAll('#quick-fault-grid [data-fault-code]').forEach((button) => {
    button.classList.toggle('active', button.dataset.faultCode === selected);
  });
  const clear = document.querySelector('#quick-fault-clear');
  if (clear) clear.hidden = !selected;
}

// 快捷按钮点下去要把三级级联也设好，否则表单里 fault_code_id 是空的，
// 而且展开"完整故障分类"时会看到和按钮对不上的状态。
function selectFaultCode(codeId) {
  const code = state.faultCodes.codes.find((item) => item.id === Number(codeId));
  if (!code) return;
  document.querySelector('#fault-category').value = code.category;
  renderFaultParts();
  document.querySelector('#fault-part').value = code.part;
  renderFaultSymptoms();
  document.querySelector('#fault-symptom').value = String(code.id);
  updateFaultTip();
}

function clearFaultCode() {
  document.querySelector('#fault-category').value = '';
  renderFaultParts();
  updateFaultTip();
}

// 选了设备就不用再选工序：服务端按当前安装关系推。没登记安装位置的设备推不出来，
// 那才把工序下拉放出来——让普工每次都选一遍工序是这个表单最没必要的一步。
function syncRepairProcessField() {
  const label = document.querySelector('#repair-process-label');
  const select = document.querySelector('#repair-process');
  const hint = document.querySelector('#repair-process-hint');
  if (!label || !select) return;
  const equipmentId = Number(document.querySelector('#repair-equipment')?.value || 0);
  const equipment = equipmentId ? state.equipment.find((item) => item.id === equipmentId) : null;
  const needed = !equipment || !equipment.process_id;
  label.hidden = !needed;
  select.required = needed;
  if (!needed) select.value = '';
  if (hint) {
    hint.textContent = equipment
      ? '这台设备还没登记安装位置，请选它在哪道工序上。'
      : '不确定是哪台设备时，至少要说清是哪道工序。';
  }
}

async function loadFaultCodeAdmin() {
  const data = await api('/api/fault-codes?all=1');
  const groups = new Map();
  for (const code of data.codes) {
    if (!groups.has(code.category)) groups.set(code.category, []);
    groups.get(code.category).push(code);
  }
  document.querySelector('#fault-seeded-notice').hidden = !data.codes.some((item) => item.is_seeded);
  document.querySelector('#fault-code-groups').innerHTML = data.codes.length ? [...groups].map(([category, codes]) => `
    <div class="card table-card fault-group"><div class="card-head"><h2>${escapeHtml(category)}</h2><span class="pill">${codes.length} 项</span></div>
    <div class="table-wrap"><table><thead><tr><th>代码</th><th>部位</th><th>现象</th><th>要求</th><th>处理建议</th><th>用量</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${codes.map((code) => `<tr class="${code.status === 'ACTIVE' ? '' : 'row-muted'}">
        <td><code>${escapeHtml(code.code)}</code>${code.is_seeded ? '<br><small class="status pending">待确认</small>' : ''}</td>
        <td>${escapeHtml(code.part)}</td>
        <td>${escapeHtml(code.symptom)}</td>
        <td>${code.is_common ? '<span class="status">常用</span> ' : ''}${code.requires_photo ? '<span class="status pending">须拍照</span> ' : ''}${code.requires_downtime ? '<span class="status danger">默认停机</span> ' : ''}${code.default_urgency !== 'NORMAL' ? `<span class="status pending">${escapeHtml(labels[code.default_urgency] || code.default_urgency)}</span>` : ''}</td>
        <td><small>${escapeHtml(code.suggested_action || '—')}</small></td>
        <td>${code.work_order_count || 0} 单</td>
        <td>${code.status === 'ACTIVE' ? '<span class="status">启用</span>' : '<span class="status muted">已停用</span>'}</td>
        <td><button class="secondary small" onclick="editFaultCode(${code.id})">编辑</button>${code.work_order_count ? '' : ` <button class="danger small" onclick="removeFaultCode(${code.id})">删除</button>`}</td>
      </tr>`).join('')}
    </tbody></table></div></div>`).join('') : '<div class="card"><div class="empty">还没有故障代码，报修功能需要至少一条</div></div>';
  return data;
}

function openFaultCodeDrawer(id = null) {
  const item = id ? state.faultCodes.codes.find((x) => x.id === id) : null;
  const isEdit = Boolean(item);
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const typeOptions = optionList(state.equipmentTypes, 'id', (x) => `${x.code} · ${x.name}`, true);
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">故障类别 → 故障部位 → 故障现象</p><h2>${isEdit ? '编辑故障代码' : '新增故障代码'}</h2>
    ${item?.is_seeded ? '<p class="hint status-note">这是系统预置的建议值，保存后会标记为已确认。</p>' : ''}
    <form class="form-card" id="fault-code-form">
      <label>代码*<input name="code" value="${escapeHtml(item?.code || '')}" ${isEdit ? 'readonly' : 'required'} placeholder="例如 ME-GEAR-BROKEN"></label>
      <div class="form-row"><label>故障类别*<input name="category" list="fault-category-options" value="${escapeHtml(item?.category || '')}" required></label><label>故障部位*<input name="part" value="${escapeHtml(item?.part || '')}" required></label></div>
      <datalist id="fault-category-options">${(state.faultCodes.categories || []).map((c) => `<option value="${escapeHtml(c.category)}">`).join('')}</datalist>
      <label>故障现象*<input name="symptom" value="${escapeHtml(item?.symptom || '')}" required></label>
      <label>处理建议<textarea name="suggested_action" rows="2" placeholder="技术员到场前能先做什么">${escapeHtml(item?.suggested_action || '')}</textarea></label>
      <div class="form-row"><label>默认紧急程度<select name="default_urgency"><option value="NORMAL">一般</option><option value="URGENT">紧急</option><option value="CRITICAL">特急</option></select></label><label>适用设备类型<select name="equipment_type_id">${typeOptions}</select></label></div>
      <label class="check"><input type="checkbox" name="requires_photo" ${item?.requires_photo ? 'checked' : ''}>报修时必须拍照</label>
      <label class="check"><input type="checkbox" name="requires_downtime" ${item?.requires_downtime ? 'checked' : ''}>默认勾选“导致停机”</label>
      <label class="check"><input type="checkbox" name="is_common" ${item?.is_common ? 'checked' : ''}>放进普工报修页的“常见故障”快捷按钮</label>
      <p class="hint">只勾普工站在机器边上就判断得了的（整机不启动、漏油这类）。攒够历史工单之后，快捷按钮会自动改按报修频次排。</p>
      ${isEdit ? '<label>状态<select name="status"><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>' : ''}
      <button>${isEdit ? '保存修改' : '创建故障代码'}</button>
    </form></div>`;
  if (item) {
    overlay.querySelector('[name="default_urgency"]').value = item.default_urgency || 'NORMAL';
    if (item.equipment_type_id) overlay.querySelector('[name="equipment_type_id"]').value = String(item.equipment_type_id);
    if (isEdit) overlay.querySelector('[name="status"]').value = item.status;
  }
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#fault-code-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await guarded(() => api(`/api/fault-codes${isEdit ? `/${id}` : ''}`, {
      method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(formObject(form)),
    }), `故障代码已${isEdit ? '更新' : '创建'}`);
    close();
    await Promise.all([loadFaultCodeAdmin(), loadFaultCodes(), loadQuickFaults()]);
  });
  document.body.append(overlay);
}

async function removeFaultCode(id) {
  const item = state.faultCodes.codes.find((x) => x.id === id);
  if (!item || !confirm(`确认删除故障代码「${item.category} / ${item.part} / ${item.symptom}」？`)) return;
  await guarded(() => api(`/api/fault-codes/${id}`, { method: 'DELETE' }), '故障代码已删除');
  await Promise.all([loadFaultCodeAdmin(), loadFaultCodes(), loadQuickFaults()]);
}

// ---- 巡检 ----

async function loadPatrols() {
  state.patrols = await api('/api/patrols');
  document.querySelector('#patrol-count').textContent = `${state.patrols.length} 条`;
  document.querySelector('#patrol-list').innerHTML = state.patrols.length ? state.patrols.map((item) => `
    <article class="stack-item ${item.has_issue && !item.work_order_id ? 'downtime' : ''}">
      <div class="stack-title"><strong>${escapeHtml(item.patrol_no)}</strong>
        ${item.work_order_id ? `<span class="status">已转 ${escapeHtml(item.work_order_no)}</span>`
          : item.has_issue ? '<span class="status pending">待跟进</span>' : '<span class="status muted">正常</span>'}</div>
      <div><strong>${escapeHtml(item.equipment_code || '未指定设备')}</strong> ${escapeHtml(item.equipment_name || '')}</div>
      <p>${escapeHtml(item.findings)}</p>
      ${attachmentStrip(item.attachments)}
      <div class="stack-meta"><span>${escapeHtml(item.line_name || '')} ${escapeHtml(item.process_name || '')}</span><span>${escapeHtml(item.patroller)}</span><span>${formatTime(item.patrolled_at)}</span></div>
      ${!item.work_order_id ? `<div class="stack-actions"><button class="small" onclick="openPatrolToWorkOrder(${item.id})">转维修工单</button></div>` : ''}
    </article>`).join('') : '<div class="empty">还没有巡检记录</div>';
}

function openPatrolToWorkOrder(id) {
  const patrol = state.patrols.find((x) => x.id === id);
  if (!patrol) return;
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const categories = state.faultCodes.categories || [];
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(patrol.patrol_no)}</p><h2>转成维修工单</h2>
    <div class="detail-block"><h3>巡检发现</h3><p>${escapeHtml(patrol.findings)}</p>
      <div class="definition-grid"><div><small>设备</small>${escapeHtml(patrol.equipment_code || '—')} ${escapeHtml(patrol.equipment_name || '')}</div>
      <div><small>工序</small>${escapeHtml(patrol.line_name || '')} / ${escapeHtml(patrol.process_name || '')}</div></div>
      ${attachmentStrip(patrol.attachments)}</div>
    <form class="form-card" id="patrol-convert-form">
      <p class="hint">巡检发现会自动写进工单的补充说明，不用重打一遍。</p>
      <label>故障类别*<select id="convert-category" required><option value="">请选择</option>${categories.map((c) => `<option value="${escapeHtml(c.category)}">${escapeHtml(c.category)}</option>`).join('')}</select></label>
      <label>故障部位*<select id="convert-part" required><option value="">请先选故障类别</option></select></label>
      <label>故障现象*<select name="fault_code_id" id="convert-symptom" required><option value="">请先选故障部位</option></select></label>
      <div class="form-row"><label>紧急程度<select name="urgency"><option value="NORMAL">一般</option><option value="URGENT">紧急</option><option value="CRITICAL">特急</option></select></label><label class="check bottom"><input type="checkbox" name="is_downtime">导致停机</label></div>
      <button>生成维修工单</button>
    </form></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  // 抽屉里的三级级联，逻辑同报修表单但作用在独立的 id 上
  const partSelect = overlay.querySelector('#convert-part');
  const symptomSelect = overlay.querySelector('#convert-symptom');
  overlay.querySelector('#convert-category').addEventListener('change', (event) => {
    const parts = categories.find((c) => c.category === event.target.value)?.parts || [];
    partSelect.innerHTML = `<option value="">请选择</option>${parts.map((p) => `<option value="${escapeHtml(p.part)}">${escapeHtml(p.part)}</option>`).join('')}`;
    symptomSelect.innerHTML = '<option value="">请先选故障部位</option>';
  });
  partSelect.addEventListener('change', (event) => {
    const category = overlay.querySelector('#convert-category').value;
    const symptoms = categories.find((c) => c.category === category)?.parts.find((p) => p.part === event.target.value)?.symptoms || [];
    symptomSelect.innerHTML = `<option value="">请选择</option>${symptoms.map((s) => `<option value="${s.id}">${escapeHtml(s.symptom)}</option>`).join('')}`;
  });
  overlay.querySelector('#patrol-convert-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await guarded(() => api(`/api/patrols/${id}/to-work-order`, {
      method: 'POST', body: JSON.stringify(formObject(form)),
    }), '已生成维修工单');
    close();
    flash(`工单 ${result.work_order.work_order_no} 已创建`);
    await Promise.all([loadPatrols(), loadWorkOrders(), loadDashboard()]);
  });
  document.body.append(overlay);
}

// ---- 成员管理（仅管理员） ----

async function loadMembers() {
  state.members = await api('/api/users');
  document.querySelector('#member-count').textContent = `${state.members.length} 人`;
  document.querySelector('#member-body').innerHTML = state.members.length ? state.members.map((item) => `
    <tr class="${item.status === 'ACTIVE' ? '' : 'row-muted'}">
      <td><strong>${escapeHtml(item.username)}</strong></td>
      <td>${escapeHtml(item.display_name)}${item.phone ? `<br><small>${escapeHtml(item.phone)}</small>` : ''}</td>
      <td><span class="level-badge level-${item.level}">${escapeHtml(LEVEL_NAMES[item.level] || item.level)}</span></td>
      <td>${item.status === 'ACTIVE' ? '<span class="status">启用</span>' : '<span class="status muted">已停用</span>'}${item.must_change_password ? '<br><small class="status pending">待改密</small>' : ''}</td>
      <td>${item.last_seen_at ? formatTime(item.last_seen_at) : '<span class="status muted">从未登录</span>'}</td>
      <td><button class="secondary small" onclick="editMember(${item.id})">编辑</button> <button class="secondary small" onclick="resetMemberPassword(${item.id})">重置密码</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">尚无成员</td></tr>';
}

function showInitialPassword(user, title) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(title)}</p><h2>${escapeHtml(user.display_name)} · ${escapeHtml(user.username)}</h2>
    <div class="password-callout"><small>初始密码（只显示这一次）</small><strong>${escapeHtml(user.initial_password)}</strong></div>
    <p class="hint">请当面或通过内部渠道告知本人。对方首次登录会被强制修改密码，之后系统里查不到这个密码。</p>
    <button id="copy-initial-password">复制密码</button></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#copy-initial-password').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(user.initial_password); flash('初始密码已复制'); }
    catch { flash('浏览器不允许复制，请手工记录', 'error'); }
  });
  document.body.append(overlay);
}

function openMemberDrawer(id = null) {
  const item = id ? state.members.find((x) => x.id === id) : null;
  const isEdit = Boolean(item);
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const levelOptions = [1, 2, 3].map((value) =>
    `<option value="${value}" ${item && Number(item.level) === value ? 'selected' : ''}>${value}级 · ${LEVEL_NAMES[value]}</option>`).join('');
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">三级成员</p><h2>${isEdit ? '编辑成员' : '新增成员'}</h2>
    <form class="form-card" id="member-form">
      <label>工号/登录名${isEdit ? '' : '*'}<input name="username" value="${escapeHtml(item?.username || '')}" ${isEdit ? 'readonly' : 'required'} placeholder="例如 w001"></label>
      <label>姓名*<input name="display_name" value="${escapeHtml(item?.display_name || '')}" required></label>
      <label>级别*<select name="level" required>${levelOptions}</select></label>
      <label>联系电话<input name="phone" value="${escapeHtml(item?.phone || '')}"></label>
      ${isEdit ? `<label>账号状态<select name="status"><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></label>` : '<p class="hint">系统会自动生成初始密码，保存后显示一次。</p>'}
      <button>${isEdit ? '保存修改' : '创建成员'}</button>
    </form></div>`;
  if (isEdit) overlay.querySelector('[name="status"]').value = item.status;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#member-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formObject(event.currentTarget);
    const saved = await guarded(() => api(`/api/users${isEdit ? `/${id}` : ''}`, {
      method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload),
    }), `成员已${isEdit ? '更新' : '创建'}`);
    close();
    await loadMembers();
    if (!isEdit) showInitialPassword(saved, '新成员已创建');
  });
  document.body.append(overlay);
}

async function resetMemberPassword(id) {
  const item = state.members.find((x) => x.id === id);
  if (!item || !confirm(`确认重置「${item.display_name}」的密码？该成员当前的登录会话会立即失效。`)) return;
  const result = await guarded(() => api(`/api/users/${id}/reset-password`, { method: 'POST' }), '密码已重置');
  await loadMembers();
  showInitialPassword(result, '密码已重置');
}

// ---- 设备选择器：分级 + 搜索 ----
// 205 台设备平铺在一个下拉里根本找不到（按编码排序，跟现场位置毫无关系）。
// 这里的设计是：**真实表单字段只有 [data-picker-equipment] 那一个 select**，
// 车间/产线两个下拉和搜索框都只是"缩小它的选项"的筛选器。
// 刻意保留原生 select——手机上原生选择器是系统级大列表，比自研下拉好按，而且不引入依赖。

const EQUIPMENT_PICKERS = {
  repair: { blank: '无法判断具体设备' },      // 普工确实分不清是哪台时的出口
  patrol: { blank: '请选择' },
  change: { blank: '请选择' },
  replacement: { blank: '请选择' },
};

function pickerParts(key) {
  const root = document.querySelector(`[data-picker="${key}"]`);
  if (!root) return null;
  return {
    root,
    search: root.querySelector('[data-picker-search]'),
    workshop: root.querySelector('[data-picker-workshop]'),
    line: root.querySelector('[data-picker-line]'),
    equipment: root.querySelector('[data-picker-equipment]'),
  };
}

// 下拉里一台设备怎么显示。工人是按"这条线第几位的那台"认机器的，所以工位顺序放最前，
// 接着是现场别名（台账里 205 台全都填了，例如"1#SPC混料机"——这是车间里真正的叫法），
// 最后才是系统编码。standard_name 太笼统（一堆"高速混料机"），认不出是哪台。
function equipmentOptionLabel(item) {
  const seat = item.position_sequence ? `${String(item.position_sequence).padStart(2, '0')} · ` : '';
  const site = item.alias || item.standard_name;
  return `${seat}${site} · ${item.code}`;
}

function matchesEquipmentSearch(item, keyword) {
  if (!keyword) return true;
  const haystack = [item.code, item.standard_name, item.alias, item.type_code, item.key_spec,
    item.legacy_code, item.line_name, item.position_name, item.position_code,
    item.workshop_name].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(keyword);
}

// 重画某个选择器的三个下拉。保持已选值不变——重新加载设备列表时不该把人选好的清掉。
function refreshEquipmentPicker(key) {
  const parts = pickerParts(key);
  if (!parts) return;
  const config = EQUIPMENT_PICKERS[key];
  const keyword = (parts.search?.value || '').trim().toLowerCase();
  const workshopId = Number(parts.workshop.value || 0);
  const lineId = Number(parts.line.value || 0);

  // 车间下拉：始终是全部车间（它是最外层筛选器，自己不该被筛）
  const workshops = state.organization?.workshops || [];
  const lines = state.organization?.lines || [];
  fillSelect(parts.workshop, '全部车间', workshops.map((item) => [item.id, item.name]), workshopId);
  // 产线下拉跟着车间收窄
  const visibleLines = workshopId ? lines.filter((item) => item.workshop_id === workshopId) : lines;
  fillSelect(parts.line, workshopId ? '全部产线' : '先选车间或直接选产线',
    visibleLines.map((item) => [item.id, item.name]), lineId);

  // 设备下拉：搜索和分级二者取一——两个一起用很容易交出空集，人会以为坏了。
  // 所以打字时忽略车间/产线（下面的事件里会把那两个下拉清空）。
  const filtered = state.equipment.filter((item) => {
    if (keyword) return matchesEquipmentSearch(item, keyword);
    if (lineId) return item.line_id === lineId;
    if (workshopId) return item.workshop_id === workshopId;
    return true;
  });

  // 按「车间 / 产线」分组。service.listEquipment 已经按车间→产线→工位顺序排好，
  // 这里只要顺序遍历就是对的，不用再排一遍。
  const groups = [];
  for (const item of filtered) {
    const title = item.line_id ? `${item.workshop_name || '未归属车间'} / ${item.line_name}` : '未安装';
    if (!groups.length || groups[groups.length - 1].title !== title) groups.push({ title, items: [] });
    groups[groups.length - 1].items.push(item);
  }
  const keep = parts.equipment.value;
  parts.equipment.innerHTML = `<option value="">${escapeHtml(config.blank)}</option>${groups.map((group) => `
    <optgroup label="${escapeHtml(group.title)}">${group.items.map((item) =>
      `<option value="${item.id}">${escapeHtml(equipmentOptionLabel(item))}</option>`).join('')}</optgroup>`).join('')}`;
  if (keep && filtered.some((item) => String(item.id) === keep)) parts.equipment.value = keep;

  const hint = filtered.length;
  if (parts.search) {
    parts.search.setAttribute('aria-label', `搜设备，当前 ${hint} 台可选`);
  }
}

function fillSelect(select, blankLabel, pairs, keepValue) {
  select.innerHTML = `<option value="">${escapeHtml(blankLabel)}</option>${pairs.map(([value, label]) =>
    `<option value="${value}">${escapeHtml(label)}</option>`).join('')}`;
  if (keepValue && pairs.some(([value]) => value === keepValue)) select.value = String(keepValue);
}

function bindEquipmentPickers() {
  for (const key of Object.keys(EQUIPMENT_PICKERS)) {
    const parts = pickerParts(key);
    if (!parts) continue;
    parts.workshop.addEventListener('change', () => {
      parts.line.value = '';               // 换了车间，原来选的产线多半不属于它了
      if (parts.search) parts.search.value = '';
      refreshEquipmentPicker(key);
      afterPickerChange(key);
    });
    parts.line.addEventListener('change', () => {
      if (parts.search) parts.search.value = '';
      refreshEquipmentPicker(key);
      afterPickerChange(key);
    });
    if (parts.search) parts.search.addEventListener('input', () => {
      // 打字就走搜索：清掉分级筛选，否则"搜索∩产线"经常是空的
      parts.workshop.value = '';
      parts.line.value = '';
      refreshEquipmentPicker(key);
    });
    parts.equipment.addEventListener('change', () => afterPickerChange(key));
  }
}

// 选定设备之后各表单自己要做的事
function afterPickerChange(key) {
  if (key !== 'repair') return;
  syncRepairProcessField();
  loadQuickFaults();
}

// 从外部（扫码）把选择器定位到一台设备或一条产线
function setEquipmentPicker(key, { equipmentId = null, lineId = null } = {}) {
  const parts = pickerParts(key);
  if (!parts) return;
  if (parts.search) parts.search.value = '';
  const item = equipmentId ? state.equipment.find((x) => x.id === Number(equipmentId)) : null;
  const targetLine = item?.line_id || (lineId ? Number(lineId) : null);
  const line = (state.organization?.lines || []).find((x) => x.id === targetLine);
  parts.workshop.value = line ? String(line.workshop_id) : '';
  parts.line.value = line ? String(line.id) : '';
  refreshEquipmentPicker(key);
  parts.equipment.value = item ? String(item.id) : '';
  afterPickerChange(key);
  return { line, item, count: [...parts.equipment.options].length - 1 };
}

function optionList(items, valueKey, labelBuilder, includeBlank = false) {
  return `${includeBlank ? '<option value="">请选择</option>' : ''}${items.map((item) =>
    `<option value="${escapeHtml(item[valueKey])}">${escapeHtml(labelBuilder(item))}</option>`).join('')}`;
}

function replaceOptions(selector, html) {
  const select = document.querySelector(selector);
  if (!select) return;
  const previous = select.value;
  select.innerHTML = html;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function loadMeta() {
  const meta = await api('/api/meta');
  state.meta = meta;
  nextStatuses = meta.work_order_transitions || {};
  workOrderStages = meta.work_order_stages || [];
  postArrivalStatuses = meta.post_arrival_statuses || [];
  if (Array.isArray(meta.withdrawable_statuses)) WITHDRAWABLE.splice(0, WITHDRAWABLE.length, ...meta.withdrawable_statuses);
}

async function loadDashboard() {
  const data = await api('/api/dashboard');
  const metrics = [
    ['设备总数', data.equipment, '已建档且未报废'],
    ['已安装', data.installedEquipment, '当前在机位'],
    ['维修状态设备', data.repairingEquipment, '已报修或维修中'],
    ['未结工单', data.openWorkOrders, `其中${data.downtimeWorkOrders}张停机`],
    ['待确认变动', data.pendingChanges, '需要管理员处理'],
    // 近30天已完成工单的两段平均时长。还没有数据时显示"—"，不显示 0。
    ['平均响应', data.avgResponseMinutes == null ? '—' : formatDuration(data.avgResponseMinutes), '报修到技术员到场'],
    ['平均维修', data.avgRepairMinutes == null ? '—' : formatDuration(data.avgRepairMinutes), '到场到结单'],
  ];
  document.querySelector('#metrics').innerHTML = metrics.map(([name, value, note]) =>
    `<article class="metric card"><span></span><strong>${value}</strong><small>${name} · ${note}</small></article>`).join('');
}

async function loadOrganization() {
  state.organization = await api('/api/organization');
  const o = state.organization;
  replaceOptions('#repair-process', optionList(o.processes, 'id', (x) => `${x.line_name} / ${x.name}`, true));
  replaceOptions('#change-position', optionList(o.positions, 'id', (x) => `${x.line_name} / ${x.process_name} / ${x.name}`, true));
  // 设备选择器的车间/产线两级来自这里，设备来自 loadEquipment()。
  // refreshAll() 里这两个请求是并发的，谁先回来不定——所以两边都要刷一次，
  // 否则先回来的那个渲染时另一半数据还是空的，车间下拉会只剩一个空选项。
  for (const key of Object.keys(EQUIPMENT_PICKERS)) refreshEquipmentPicker(key);
}

async function loadEquipmentTypes() {
  state.equipmentTypes = await api('/api/equipment-types');
  replaceOptions('#equipment-type', optionList(state.equipmentTypes, 'code', (item) => `${item.code} · ${item.name}`, true));
  updateEquipmentCodePreview();
}

function updateEquipmentCodePreview() {
  const type = document.querySelector('#equipment-type')?.value || '';
  const spec = String(document.querySelector('#equipment-key-spec')?.value || '').trim().toUpperCase();
  const node = document.querySelector('#equipment-code-preview');
  if (!node) return;
  node.textContent = type ? `YSM-${type}-${spec ? `${spec}-` : ''}下一流水` : '请选择设备类型';
}

function treeKey(type, id) { return `${type}-${id}`; }

function rememberExpanded() {
  localStorage.setItem('ysm-expanded-tree', JSON.stringify([...state.expandedNodes]));
}

function treeNode({ type, id, icon, name, code, note = '', badge = '', actions = '', alwaysActions = '', children = '', leaf = false, highlight = false, alert = false }) {
  const key = treeKey(type, id);
  const open = state.expandedNodes.has(key) && !leaf;
  // 新增、编辑、删除结构和装设备都是管理员的操作；alwaysActions（如"档案"）不分级别都能看。
  const nodeActions = `${alwaysActions}${canManage() ? actions : ''}`;
  return `<details class="tree-node ${leaf ? 'leaf' : ''} ${type === 'equipment' ? 'equipment-node' : ''} ${highlight ? 'highlight' : ''} ${alert ? 'alert' : ''}" data-tree-key="${key}" ${open ? 'open' : ''}>
    <summary><span class="node-icon">${icon}</span><span class="node-main"><strong>${escapeHtml(name)}</strong>${code ? `<span class="node-code">${escapeHtml(code)}</span>` : ''}${badge}${note ? `<span class="node-note">${escapeHtml(note)}</span>` : ''}</span>${nodeActions ? `<span class="node-actions">${nodeActions}</span>` : ''}</summary>
    ${leaf ? '' : `<div class="tree-children">${children || '<div class="empty-branch">暂无下级数据</div>'}</div>`}
  </details>`;
}

function renderOrganizationTree(focusKey = '') {
  let lineCount = 0, processCount = 0, positionCount = 0, installedCount = 0;
  const workshopCount = state.organizationTree.reduce((sum, factory) => sum + factory.workshops.length, 0);
  if (!state.treeInitialized && state.expandedNodes.size === 0) {
    for (const factory of state.organizationTree) {
      state.expandedNodes.add(treeKey('factory', factory.id));
      for (const workshop of factory.workshops) {
        state.expandedNodes.add(treeKey('workshop', workshop.id));
        for (const line of workshop.lines) state.expandedNodes.add(treeKey('line', line.id));
      }
    }
  }
  const html = state.organizationTree.map((factory) => treeNode({
    type: 'factory', id: factory.id, icon: '厂', name: factory.name, code: factory.code,
    actions: `<button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('workshop', ${factory.id})">＋车间</button>`,
    highlight: focusKey === treeKey('factory', factory.id),
    children: factory.workshops.map((workshop) => treeNode({
      type: 'workshop', id: workshop.id, icon: '间', name: workshop.name, code: workshop.code,
      actions: `<button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('workshop', ${factory.id}, ${workshop.id})">编辑</button><button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('line', ${workshop.id})">＋产线</button><button class="danger" onclick="event.preventDefault();event.stopPropagation();openDeleteStructure('workshop', ${workshop.id})">删除</button>`,
      highlight: focusKey === treeKey('workshop', workshop.id),
      children: workshop.lines.map((line) => {
        lineCount += 1;
        return treeNode({
          type: 'line', id: line.id, icon: '线', name: line.name, code: line.code,
          note: `${line.processes.length}个工序${line.supervisor ? ` · 主管：${line.supervisor}` : ''}`,
          actions: `<button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('line', ${workshop.id}, ${line.id})">编辑</button><button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('process', ${line.id})">＋工序</button><button class="danger" onclick="event.preventDefault();event.stopPropagation();openDeleteStructure('line', ${line.id})">删除</button>`,
          highlight: focusKey === treeKey('line', line.id),
          children: line.processes.map((process) => {
            processCount += 1;
            return treeNode({
              type: 'process', id: process.id, icon: '序', name: process.name, code: process.code,
              note: `${process.positions.length}个机位 · 顺序${process.sequence_no}`,
              actions: `<button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('process', ${line.id}, ${process.id})">编辑</button><button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('position', ${process.id})">＋机位</button><button class="danger" onclick="event.preventDefault();event.stopPropagation();openDeleteStructure('process', ${process.id})">删除</button>`,
              highlight: focusKey === treeKey('process', process.id),
              children: process.positions.map((position) => {
                positionCount += 1;
                if (position.equipment) installedCount += 1;
                const equipmentChild = position.equipment ? treeNode({
                  type: 'equipment', id: position.equipment.id, icon: '机', name: position.equipment.standard_name,
                  code: position.equipment.code, badge: statusBadge(position.equipment.status),
                  note: position.equipment.alias || position.equipment.category, leaf: true,
                  alwaysActions: `<button onclick="event.preventDefault();event.stopPropagation();openEquipmentProfile(${position.equipment.id})">档案</button>`,
                  highlight: focusKey === treeKey('equipment', position.equipment.id),
                  alert: underRepair(position.equipment.status),
                }) : '<div class="empty-branch">当前未安装设备</div>';
                return treeNode({
                  type: 'position', id: position.id, icon: '位', name: position.name, code: position.code,
                  // 机位默认收起，把设备的维修状态提到机位这一层，不展开也能看见。
                  badge: position.equipment && underRepair(position.equipment.status) ? statusBadge(position.equipment.status) : '',
                  alert: Boolean(position.equipment && underRepair(position.equipment.status)),
                  note: `${position.critical ? '关键机位 · ' : ''}${position.equipment ? `已安装${position.equipment.code}` : '空机位'}`,
                  actions: `<button onclick="event.preventDefault();event.stopPropagation();openStructureDrawer('position', ${process.id}, ${position.id})">编辑</button><button onclick="event.preventDefault();event.stopPropagation();prepareInstall(${position.id})">${position.equipment ? '变动' : '装设备'}</button><button class="danger" onclick="event.preventDefault();event.stopPropagation();openDeleteStructure('position', ${position.id})">删除</button>`,
                  highlight: focusKey === treeKey('position', position.id), children: equipmentChild,
                });
              }).join(''),
            });
          }).join(''),
        });
      }).join(''),
    })).join(''),
  })).join('');
  const root = document.querySelector('#organization-tree');
  root.innerHTML = html || '<div class="empty">尚未建立工厂结构</div>';
  document.querySelector('#tree-summary').textContent = `${workshopCount}个车间 · ${lineCount}条产线 · ${processCount}个工序 · ${positionCount}个机位 · ${installedCount}台已安装`;
  root.querySelectorAll('details[data-tree-key]').forEach((details) => details.addEventListener('toggle', () => {
    if (details.open) state.expandedNodes.add(details.dataset.treeKey); else state.expandedNodes.delete(details.dataset.treeKey);
    rememberExpanded();
  }));
  state.treeInitialized = true;
  rememberExpanded();
  if (focusKey) requestAnimationFrame(() => root.querySelector(`[data-tree-key="${focusKey}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

async function loadOrganizationTree(focusKey = '') {
  state.organizationTree = await api('/api/organization/tree');
  renderOrganizationTree(focusKey);
}

function findTreeItem(type, id) {
  for (const factory of state.organizationTree) {
    if (type === 'factory' && factory.id === id) return factory;
    for (const workshop of factory.workshops) {
      if (type === 'workshop' && workshop.id === id) return workshop;
      for (const line of workshop.lines) {
        if (type === 'line' && line.id === id) return line;
        for (const process of line.processes) {
          if (type === 'process' && process.id === id) return process;
          for (const position of process.positions) if (type === 'position' && position.id === id) return position;
        }
      }
    }
  }
  return null;
}

async function loadEquipment(search = '') {
  state.equipment = await api(`/api/equipment?search=${encodeURIComponent(search)}`);
  document.querySelector('#equipment-count').textContent = `${state.equipment.length} 台`;
  document.querySelector('#equipment-body').innerHTML = state.equipment.length ? state.equipment.map((item) => `
    <tr><td><strong>${escapeHtml(item.code)}</strong></td><td>${escapeHtml(item.standard_name)}${item.alias ? `<br><small>${escapeHtml(item.alias)}</small>` : ''}</td>
    <td>${statusBadge(item.status)}${underRepair(item.status) && item.baseline_status && item.baseline_status !== 'ACTIVE' ? `<br><small>结单后回到${escapeHtml(statusName(item.baseline_status))}</small>` : ''}</td>
    <td>${item.type_code ? `${escapeHtml(item.type_code)}${item.key_spec ? `<br><small>${escapeHtml(item.key_spec)}</small>` : ''}` : '<span class="status pending">旧编码</span>'}</td>
    <td>${escapeHtml(item.category)}</td><td>${item.position_name ? `${escapeHtml(item.line_name)} / ${escapeHtml(item.position_name)}` : '<span class="status muted">未安装</span>'}</td>
    <td>${item.verified ? '<span class="status">已核实</span>' : '<span class="status pending">待核实</span>'}</td>
    <td><button class="secondary small" onclick="openEquipmentProfile(${item.id})">档案</button> <button class="secondary small" onclick="showLabel(${item.id})">铭牌</button></td></tr>`).join('') : '<tr><td colspan="8" class="empty">尚无设备</td></tr>';
  for (const key of Object.keys(EQUIPMENT_PICKERS)) refreshEquipmentPicker(key);
  syncRepairProcessField();
}

async function loadChanges() {
  const changes = await api('/api/composition-changes');
  document.querySelector('#change-list').innerHTML = changes.length ? changes.map((item) => `
    <article class="stack-item"><div class="stack-title"><strong>${escapeHtml(item.change_no)} · ${labels[item.action]}</strong><span class="status ${item.status === 'PENDING' ? 'pending' : item.status === 'REJECTED' ? 'danger' : ''}">${labels[item.status] || item.status}</span></div>
    <div class="stack-meta"><span>${escapeHtml(item.equipment_code)} ${escapeHtml(item.equipment_name)}</span><span>${escapeHtml(item.from_position_name || '未安装')} → ${escapeHtml(item.to_position_name || '移除')}</span><span>${formatTime(item.effective_at)}</span><span>提交：${escapeHtml(item.submitted_by)}</span></div>
    <p>${escapeHtml(item.reason)}</p>${item.replacement_equipment_code ? `<p class="hint">替换为：${escapeHtml(item.replacement_equipment_code)} ${escapeHtml(item.replacement_equipment_name)}</p>` : ''}
    ${item.status === 'PENDING' ? `<div class="stack-actions"><button class="small" onclick="reviewChange(${item.id}, 'APPROVED')">确认生效</button><button class="small danger" onclick="reviewChange(${item.id}, 'REJECTED')">驳回</button></div>` : ''}
    </article>`).join('') : '<div class="empty">暂无设备变动申请</div>';
}

async function reviewChange(id, decision) {
  const note = decision === 'REJECTED' ? prompt('请输入驳回原因：') : prompt('审核备注（可留空）：') || '';
  if (decision === 'REJECTED' && !note) return;
  await guarded(() => api(`/api/composition-changes/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }), decision === 'APPROVED' ? '设备变动已确认生效' : '申请已驳回');
  await Promise.all([loadChanges(), loadEquipment(), loadDashboard(), refreshStructure()]);
}

const WITHDRAWABLE = ['SUBMITTED', 'ACCEPTED'];

function workOrderCard(item) {
  const claimable = level() === LEVELS.TECHNICIAN && item.status === 'SUBMITTED';
  const isMine = item.reporter_user_id && state.me && item.reporter_user_id === state.me.user_id;
  const canWithdraw = (isMine || canManage()) && WITHDRAWABLE.includes(item.status);
  const canReview = isMine && item.status === 'COMPLETED';
  const canReopen = (isMine || canManage()) && item.status === 'COMPLETED';
  const statusClass = item.status === 'SUBMITTED' ? 'pending'
    : item.status === 'CANCELLED' ? 'danger' : item.status === 'COMPLETED' ? '' : 'muted';
  const actions = [
    claimable ? `<button class="small" onclick="event.stopPropagation();claimWorkOrder(${item.id})">我接这单</button>` : '',
    canWithdraw ? `<button class="secondary small" onclick="event.stopPropagation();withdrawWorkOrder(${item.id})">撤回</button>` : '',
    canReview ? `<button class="small" onclick="event.stopPropagation();reviewWorkOrder(${item.id})">${item.has_review ? '修改评价' : '评价'}</button>` : '',
    canReopen ? `<button class="secondary small" onclick="event.stopPropagation();reopenWorkOrder(${item.id})">重新报修</button>` : '',
  ].filter(Boolean).join('');
  return `<article class="stack-item ${item.is_downtime ? 'downtime' : ''}" onclick="openWorkOrder(${item.id})">
    <div class="stack-title"><strong>${escapeHtml(item.work_order_no)}</strong><span class="status ${statusClass}">${labels[item.status] || item.status}</span>${
      item.status === 'COMPLETED' && isMine && !item.has_review ? '<span class="status pending">待评价</span>' : ''}</div>
    <div><strong>${escapeHtml(item.fault_symptom)}</strong>${item.is_downtime ? '<span class="status danger">停机</span>' : ''}${item.urgency && item.urgency !== 'NORMAL' ? `<span class="status pending">${escapeHtml(labels[item.urgency] || item.urgency)}</span>` : ''}${
      level() >= LEVELS.TECHNICIAN && !item.final_equipment_id && !CLOSED_STATUSES.includes(item.status)
        ? '<span class="status danger">待认领设备</span>' : ''}${
      level() >= LEVELS.TECHNICIAN && !item.fault_code_id && !CLOSED_STATUSES.includes(item.status)
        ? '<span class="status danger">待分类故障</span>' : ''}</div>
    ${item.reopened_from_work_order_no ? `<div class="stack-meta"><span class="status pending">重报自 ${escapeHtml(item.reopened_from_work_order_no)}</span></div>` : ''}
    <div class="stack-meta"><span>${escapeHtml(item.line_name)} / ${escapeHtml(item.process_name)}</span><span>${escapeHtml(item.final_equipment_code || '设备待确认')}</span><span>报修：${escapeHtml(item.reporter)}</span><span>${formatTime(item.reported_at)}</span>${item.assignee ? `<span>技术员：${escapeHtml(item.assignee)}</span>` : ''}</div>
    ${actions ? `<div class="stack-actions">${actions}</div>` : ''}
  </article>`;
}

async function loadWorkOrders() {
  state.workOrders = await api('/api/work-orders');
  const container = document.querySelector('#work-order-list');
  if (!state.workOrders.length) {
    container.innerHTML = level() === LEVELS.WORKER
      ? '<div class="empty">你还没有提交过报修</div>'
      : '<div class="empty">暂无维修工单</div>';
    return;
  }
  if (level() === LEVELS.WORKER) {
    container.innerHTML = state.workOrders.map(workOrderCard).join('');
    return;
  }
  // 技术员和管理员先看待接单池，再看已经在处理的，最后是已经结束的。
  const groups = [
    ['待接单', state.workOrders.filter((item) => item.status === 'SUBMITTED')],
    ['处理中', state.workOrders.filter((item) => !['SUBMITTED', 'COMPLETED', 'CANCELLED'].includes(item.status))],
    ['已结束', state.workOrders.filter((item) => ['COMPLETED', 'CANCELLED'].includes(item.status))],
  ];
  container.innerHTML = groups.map(([title, items]) => items.length
    ? `<div class="stack-group"><h3>${title}<span class="pill">${items.length}</span></h3>${items.map(workOrderCard).join('')}</div>`
    : '').join('') || '<div class="empty">暂无维修工单</div>';
}

async function claimWorkOrder(id) {
  await guarded(() => api(`/api/work-orders/${id}/assign`, { method: 'POST', body: JSON.stringify({}) }), '已接单，可以开始维修');
  await Promise.all([loadWorkOrders(), loadDashboard()]);
}

async function openWorkOrder(id) {
  state.selectedWorkOrder = await guarded(() => api(`/api/work-orders/${id}`));
  renderWorkOrderDetail();
  document.querySelector('#work-order-drawer').hidden = false;
}

// 工单的阶段模型。每个阶段只给一个动词明确的主按钮，别再让人在"下一步"下拉里猜。
// 到场之后才解锁的区块见 arrived()，动手之后才解锁的见 working()。
const STAGE_ACTIONS = {
  ACCEPTED: { to: 'ARRIVED', label: '我到现场了' },
  ARRIVED: { to: 'IN_PROGRESS', label: '开始维修' },
  IN_PROGRESS: { to: 'TRIAL_RUN', label: '修完了，转试运行' },
  WAITING_PARTS: { to: 'IN_PROGRESS', label: '零件到了，继续维修' },
  OUTSOURCED: { to: 'IN_PROGRESS', label: '外协回来了，继续维修' },
  PENDING_REVIEW: { to: 'COMPLETED', label: '结单' },
};
// 维修中可以岔出去的分支，做成次要按钮
const STAGE_BRANCHES = {
  IN_PROGRESS: [{ to: 'WAITING_PARTS', label: '等零件' }, { to: 'OUTSOURCED', label: '转外协' }],
  TRIAL_RUN: [{ to: 'IN_PROGRESS', label: '试运行不通过，返工' }],
};

// 步骤条：当前走到第几步。等零件/外协/待审核并到所属阶段，不占独立步骤。
function stageBar(status) {
  if (!workOrderStages.length) return '';
  const index = workOrderStages.findIndex((stage) =>
    stage.status === status || (stage.includes || []).includes(status));
  if (status === 'CANCELLED') {
    return `<div class="stage-bar cancelled"><span class="stage-step current danger">已取消</span></div>`;
  }
  return `<div class="stage-bar">${workOrderStages.map((stage, i) => {
    const cls = i < index ? 'done' : i === index ? 'current' : '';
    const name = i === index && stage.status !== status ? labels[status] || status : stage.name;
    return `<span class="stage-step ${cls}">${escapeHtml(name)}</span>`;
  }).join('')}</div>`;
}

function renderWorkOrderDetail() {
  const detail = state.selectedWorkOrder;
  const w = detail.work_order;
  const current = level();
  const canRepair = current >= LEVELS.TECHNICIAN;
  const canClose = current >= LEVELS.MANAGER;
  const closed = CLOSED_STATUSES.includes(w.status);
  // 推进工单要求是接单人本人，管理员不受限（服务端 assertOwnWorkOrder 同一套判定）。
  const isMineToWork = canClose || (w.assignee_user_id && w.assignee_user_id === state.me.user_id);
  // 到场之后才能判断是哪台设备、什么故障；动手之后才有诊断和零件。
  const arrived = postArrivalStatuses.includes(w.status);
  const working = !['ARRIVED'].includes(w.status) && arrived;
  const canOperate = isMineToWork && !closed;
  const equipmentOptions = optionList(state.equipment, 'id', (x) => `${x.code} · ${x.standard_name}`, true);
  const technicianOptions = optionList(
    state.members.filter((item) => item.status === 'ACTIVE' && Number(item.level) >= LEVELS.TECHNICIAN),
    'id', (x) => `${x.display_name} · ${LEVEL_NAMES[x.level]}`, true);
  const claimable = current === LEVELS.TECHNICIAN && w.status === 'SUBMITTED';

  const problemBlock = `
    <section class="detail-block"><h3>问题信息</h3><div class="definition-grid">
      <div><small>产线 / 工序</small>${escapeHtml(w.line_name)} / ${escapeHtml(w.process_name)}</div>
      <div><small>最终设备</small>${escapeHtml(w.final_equipment_code || '待确认')} ${escapeHtml(w.final_equipment_name || '')}</div>
      <div><small>报修人</small>${escapeHtml(w.reporter)}</div>
      <div><small>报修时间</small>${formatTime(w.reported_at)}</div>
      <div><small>故障现象</small>${escapeHtml(w.fault_symptom)}${w.fault_code_id ? '' : '<span class="status danger">待分类</span>'}</div>
      <div><small>故障位置</small>${escapeHtml(w.fault_location || '—')}</div>
      <div><small>紧急程度</small>${escapeHtml(labels[w.urgency] || w.urgency || '一般')}</div>
      <div><small>停机</small>${w.is_downtime ? '是' : '否'}</div>
      <div><small>负责技术员</small>${escapeHtml(w.assignee || '待接单')}</div>
      <div><small>响应用时</small>${elapsed(w.reported_at, w.arrived_at, w.assigned_at ? '已接单，未到场' : '等待接单')}</div>
      <div><small>维修用时</small>${elapsed(w.arrived_at, w.completed_at, w.arrived_at ? '维修中' : '未到场')}</div>
      ${w.description ? `<div class="wide"><small>补充说明</small>${escapeHtml(w.description)}</div>` : ''}
    </div>
    ${detail.attachments?.length ? `<h4 class="photo-heading">现场照片（${detail.attachments.length}）</h4>${attachmentStrip(detail.attachments)}` : ''}
    ${canRepair && !CLOSED_STATUSES.includes(w.status) ? `<div class="photo-field-head compact"><span></span><label class="button-link file-button small">补拍照片<input type="file" accept="image/*" capture="environment" multiple id="work-order-photo-input"></label></div>` : ''}
    </section>`;

  const repairResultBlock = `
    <section class="detail-block"><h3>维修结果</h3><div class="definition-grid">
      <div class="wide"><small>诊断</small>${escapeHtml(w.diagnosis || '维修中，暂无')}</div>
      <div class="wide"><small>维修方法</small>${escapeHtml(w.repair_action || '维修中，暂无')}</div>
      <div><small>试运行结果</small>${escapeHtml(w.trial_result || '—')}</div>
      <div><small>完成时间</small>${w.completed_at ? formatTime(w.completed_at) : '—'}</div>
    </div></section>`;

  // 评价对技术员不可见：后端已经把 review 剥成 null，这里连块都不渲染。
  const reviewBlock = detail.review ? `
    <section class="detail-block"><h3>报修人评价 ${starsView(detail.review.overall_score)}</h3>
      <div class="review-scores">${REVIEW_DIMENSIONS.map((d) => `<span>${d.name} ${detail.review[`${d.key}_score`]}分</span>`).join('')}</div>
      ${detail.review.comment ? `<p>“${escapeHtml(detail.review.comment)}”</p>` : ''}
      <p class="hint">${escapeHtml(detail.review.reviewer)} · ${formatTime(detail.review.created_at)}</p>
    </section>` : '';

  const historyBlock = `
    <section class="detail-block"><h3>工单进度</h3>${detail.history.map((h) => `
      <div class="history-item"><strong>${escapeHtml(labels[h.event_type] || h.event_type)}</strong> ${h.from_status ? `${labels[h.from_status] || h.from_status} → ${labels[h.to_status] || h.to_status}` : ''}
      <br><small>${formatTime(h.created_at)} · ${escapeHtml(h.actor)} ${h.note ? `· ${escapeHtml(h.note)}` : ''}</small></div>`).join('')}</section>`;

  // 普工只读：看得到进度和结果，看不到任何维修操作表单。
  const workerView = `${problemBlock}${repairResultBlock}${reviewBlock}${historyBlock}`;

  // ── 当前这一步：一个主按钮 + 可选的分支按钮。不是接单人就什么都不给。 ──
  const action = STAGE_ACTIONS[w.status];
  const branches = STAGE_BRANCHES[w.status] || [];
  const stepButton = (item, cls = '') =>
    `<button class="${cls}" data-to-status="${item.to}">${escapeHtml(item.label)}</button>`;

  let stageBody;
  if (closed) {
    stageBody = `<p class="hint">工单${labels[w.status]}，不能再操作。</p>`;
  } else if (claimable) {
    stageBody = `<p class="hint">这单还没有人接。接单之后就可以去现场了。</p><p><button id="claim-button">我接这单</button></p>`;
  } else if (!isMineToWork) {
    stageBody = `<p class="hint">这张工单由 <strong>${escapeHtml(w.assignee || '——')}</strong> 负责，需要接手请让管理员转派。</p>`;
  } else if (w.status === 'TRIAL_RUN') {
    // 结单单独一张检查清单，见下
    stageBody = `<p class="hint">试运行完就可以结单了，往下看「结单前检查」。</p>
      ${branches.map((b) => stepButton(b, 'secondary')).join(' ')}`;
  } else if (action) {
    stageBody = `<p>${stepButton(action)} ${branches.map((b) => stepButton(b, 'secondary')).join(' ')}</p>`;
  } else {
    stageBody = `<p class="hint">当前阶段没有可执行的下一步。</p>`;
  }

  const stageBlock = `
    <section class="detail-block stage-block"><h3>当前这一步</h3>
      ${stageBody}
      ${canClose && !closed ? `<form class="inline-form" id="assign-form"><label>${w.assignee ? '转派给' : '指派技术员'}<select name="assignee_user_id" required>${technicianOptions}</select></label><label>备注<input name="note"></label><button class="secondary">${w.assignee ? '转派' : '指派'}</button></form>
        <p><button class="danger small" data-to-status="CANCELLED" data-confirm="确认取消这张工单？">取消工单</button></p>` : ''}
    </section>`;

  // ── 到场之后才解锁：判断是哪台设备、什么故障，人得在现场 ──
  const arrivedBlocks = !arrived ? '' : `
    <section class="detail-block ${w.fault_code_id ? '' : 'needs-attention'}"><h3>确认故障分类${w.fault_code_id ? '' : '<span class="status danger">结单前必填</span>'}</h3>
      <p class="hint">${w.fault_code_id
        ? `当前分类：${escapeHtml(w.fault_symptom)}。到场后发现报的不对可以在这里改。`
        : '<strong>报修人没有选故障分类，结单会被拒绝。</strong>普工只写了现象，到场看过的你才分得准——选完这次的故障代码才能结单，否则这次故障进不了任何统计。'}</p>
      ${canOperate ? `<form class="inline-form" id="classify-form">
        <label>故障类别<select id="detail-fault-category">${optionList(state.faultCodes.categories, 'category', (x) => x.category, true)}</select></label>
        <label>故障部位<select id="detail-fault-part"><option value="">请先选类别</option></select></label>
        <label>故障现象<select name="fault_code_id" id="detail-fault-symptom" required><option value="">请先选部位</option></select></label>
        <button>保存分类</button></form>` : ''}</section>
    <section class="detail-block ${w.final_equipment_id ? '' : 'needs-attention'}"><h3>修正故障设备${w.final_equipment_id ? '' : '<span class="status danger">结单前必填</span>'}</h3>
      <p class="hint">${w.final_equipment_id
        ? '报修时设备填错或没填的，在这里改成实际维修的设备，维修记录才能算到对的设备上。'
        : '<strong>这张工单还没挂到任何设备上，结单会被拒绝。</strong>报修人当时选的是"无法判断具体设备"，请指明你实际维修的是哪台——否则这次维修记不到任何设备账上，设备履历和故障统计都会漏掉它。'}</p>
      ${canOperate ? `<form class="inline-form" id="correct-form"><label>实际设备<select name="equipment_id">${equipmentOptions}</select></label><label>修正原因<input name="reason" required></label><button>保存修正</button></form>` : ''}</section>`;

  // ── 开始维修之后才解锁：没动手就没有诊断，也不会用掉零件 ──
  const workingBlocks = !working ? '' : `
    <section class="detail-block"><h3>诊断与维修记录</h3>${canOperate
      ? `<form class="inline-form" id="repair-detail-form"><label class="wide">诊断<textarea name="diagnosis">${escapeHtml(w.diagnosis || '')}</textarea></label><label class="wide">根本原因<textarea name="root_cause">${escapeHtml(w.root_cause || '')}</textarea></label><label class="wide">维修方法<textarea name="repair_action">${escapeHtml(w.repair_action || '')}</textarea></label><label>停机分钟<input type="number" min="0" name="downtime_minutes" value="${escapeHtml(w.downtime_minutes ?? '')}"></label><label>试运行结果<input name="trial_result" value="${escapeHtml(w.trial_result || '')}"></label><button>保存维修记录</button></form>`
      : '<p class="hint">只有接单人能填。</p>'}</section>
    <section class="detail-block"><h3>使用零件</h3>${canOperate
      ? `<form class="inline-form" id="part-form"><label>零件名称<input name="part_name" required></label><label>型号规格<input name="specification"></label><label>数量<input type="number" step="0.01" min="0.01" name="quantity" value="1" required></label><label>单位<input name="unit" value="个" required></label><label>来源<input name="source"></label><label>旧件处理<input name="old_part_disposition"></label><button>添加零件</button></form>` : ''}
      <div class="table-wrap"><table><thead><tr><th>零件</th><th>规格</th><th>数量</th><th>来源</th><th>记录人</th></tr></thead><tbody>${detail.parts.length ? detail.parts.map((p) => `<tr><td>${escapeHtml(p.part_name)}</td><td>${escapeHtml(p.specification || '—')}</td><td>${p.quantity} ${escapeHtml(p.unit)}</td><td>${escapeHtml(p.source || '—')}</td><td>${escapeHtml(p.recorded_by)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">未记录零件</td></tr>'}</tbody></table></div></section>`;

  // ── 结单前检查：三道硬校验各一行，缺哪项一眼看到，按钮就在下面 ──
  // 判定条件必须和服务端 transitionWorkOrder 里那三个 if 保持一致。
  // 这里只是把它们提前显示出来，把关仍然在服务端。
  const checks = [
    { ok: Boolean(w.trial_result), name: '试运行结果', value: w.trial_result, fix: '在上面「诊断与维修记录」里填' },
    { ok: Boolean(w.final_equipment_id), name: '故障设备归属', value: w.final_equipment_code, fix: '在上面「修正故障设备」里指明' },
    { ok: Boolean(w.fault_code_id), name: '故障分类', value: w.fault_symptom, fix: '在上面「确认故障分类」里选' },
  ];
  const missing = checks.filter((item) => !item.ok).length;
  const closeBlock = (w.status !== 'TRIAL_RUN' && w.status !== 'PENDING_REVIEW') || !canOperate ? '' : `
    <section class="detail-block ${missing ? 'needs-attention' : 'ready'}"><h3>结单前检查</h3>
      <ul class="check-list">${checks.map((item) => `<li class="${item.ok ? 'ok' : 'bad'}">
        <span class="check-mark">${item.ok ? '✓' : '✗'}</span>
        <strong>${item.name}</strong>
        <span>${item.ok ? escapeHtml(item.value || '已填写') : `还没填 —— ${item.fix}`}</span></li>`).join('')}</ul>
      <p>${missing
        ? `<button disabled>还差 ${missing} 项才能结单</button>`
        : '<button data-to-status="COMPLETED">结单</button>'}</p></section>`;

  const repairView = `
    ${stageBlock}
    ${problemBlock}
    ${arrivedBlocks}
    ${workingBlocks}
    ${closeBlock}
    ${reviewBlock}
    ${historyBlock}`;

  document.querySelector('#work-order-detail').innerHTML = `
    <p class="eyebrow">维修工单</p><h1>${escapeHtml(w.work_order_no)}</h1>
    <span class="status">${labels[w.status] || w.status}</span>
    ${stageBar(w.status)}
    ${canRepair ? repairView : workerView}`;
  if (canRepair) bindWorkOrderForms(w.id);
}

function bindWorkOrderForms(id) {
  const bind = (selector, handler) => { const form = document.querySelector(selector); if (form) form.addEventListener('submit', handler); };
  const photoInput = document.querySelector('#work-order-photo-input');
  if (photoInput) photoInput.addEventListener('change', async () => {
    const files = [...photoInput.files];
    photoInput.value = '';
    if (!files.length) return;
    const attachments = [];
    for (const file of files) {
      try { const compressed = await compressImage(file); attachments.push({ content_base64: compressed.content_base64, name: compressed.name }); }
      catch (error) { flash(error.message, 'error'); }
    }
    if (!attachments.length) return;
    await guarded(() => api(`/api/work-orders/${id}/attachments`, { method: 'POST', body: JSON.stringify({ attachments }) }), '照片已上传');
    state.selectedWorkOrder = await api(`/api/work-orders/${id}`);
    renderWorkOrderDetail();
  });
  const claim = document.querySelector('#claim-button');
  if (claim) claim.addEventListener('click', async () => { await mutateWorkOrder(`/api/work-orders/${id}/assign`, 'POST', {}, '已接单，可以开始维修'); });
  bind('#assign-form', async (event) => { event.preventDefault(); await mutateWorkOrder(`/api/work-orders/${id}/assign`, 'POST', formObject(event.currentTarget), '工单已指派'); });
  // 阶段按钮：每个按钮自带目标状态，不再用一个通用的"下一步"下拉。
  // 按钮文案就是动作本身（"我到现场了""结单"），技术员不用猜还剩几步。
  for (const button of document.querySelectorAll('#work-order-detail [data-to-status]')) {
    button.addEventListener('click', async () => {
      if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
      button.disabled = true;
      const ok = await mutateWorkOrder(`/api/work-orders/${id}/transition`, 'POST',
        { to_status: button.dataset.toStatus }, `已${button.textContent.trim()}`);
      // 失败时按钮要能再点（成功的话整块已经重渲染了）
      if (!ok) button.disabled = false;
    });
  }
  bind('#correct-form', async (event) => { event.preventDefault(); await mutateWorkOrder(`/api/work-orders/${id}/correct-equipment`, 'POST', formObject(event.currentTarget), '故障设备已修正'); });
  bindDetailFaultCascade();
  bind('#classify-form', async (event) => { event.preventDefault(); await mutateWorkOrder(`/api/work-orders/${id}/fault-code`, 'POST', formObject(event.currentTarget), '故障分类已确认'); });
  bind('#repair-detail-form', async (event) => { event.preventDefault(); await mutateWorkOrder(`/api/work-orders/${id}/repair-detail`, 'PUT', formObject(event.currentTarget), '维修记录已保存'); });
  bind('#part-form', async (event) => { event.preventDefault(); await mutateWorkOrder(`/api/work-orders/${id}/parts`, 'POST', formObject(event.currentTarget), '零件使用已记录'); });
}

// 工单详情里那份三级级联是独立的一套控件（报修表单那套在另一个页面上，
// id 不能重名），所以联动也要单独接一次。
function bindDetailFaultCascade() {
  const categorySelect = document.querySelector('#detail-fault-category');
  const partSelect = document.querySelector('#detail-fault-part');
  const symptomSelect = document.querySelector('#detail-fault-symptom');
  if (!categorySelect || !partSelect || !symptomSelect) return;
  const parts = () => state.faultCodes.categories.find((item) => item.category === categorySelect.value)?.parts || [];
  const renderParts = () => {
    partSelect.innerHTML = `<option value="">${categorySelect.value ? '请选择' : '请先选类别'}</option>${
      parts().map((item) => `<option value="${escapeHtml(item.part)}">${escapeHtml(item.part)}</option>`).join('')}`;
    renderSymptoms();
  };
  const renderSymptoms = () => {
    const symptoms = parts().find((item) => item.part === partSelect.value)?.symptoms || [];
    symptomSelect.innerHTML = `<option value="">${partSelect.value ? '请选择' : '请先选部位'}</option>${
      symptoms.map((item) => `<option value="${item.id}">${escapeHtml(item.symptom)}</option>`).join('')}`;
  };
  categorySelect.addEventListener('change', renderParts);
  partSelect.addEventListener('change', renderSymptoms);
  // 已经有分类的，把当前值预选上，免得技术员想微调时要从头选一遍
  const current = state.faultCodes.codes.find((item) => item.id === state.selectedWorkOrder?.work_order?.fault_code_id);
  if (current) {
    categorySelect.value = current.category;
    renderParts();
    partSelect.value = current.part;
    renderSymptoms();
    symptomSelect.value = String(current.id);
  }
}

// guarded() 会把错误抛出去给需要它的调用方（比如导入按钮要重新启用）。
// 表单提交这一路不需要，失败信息已经用 flash 给用户看过了——不吞掉的话
// 每次预期内的校验失败都会变成一条未处理的 Promise 拒绝，把控制台刷满，
// 也让"监听 Runtime.exceptionThrown 找真 bug"这个验证手段失去信噪比。
async function mutateWorkOrder(path, method, body, message) {
  let updated;
  try {
    updated = await guarded(() => api(path, { method, body: JSON.stringify(body) }), message);
  } catch { return false; }
  state.selectedWorkOrder = updated;
  renderWorkOrderDetail();
  await Promise.all([loadWorkOrders(), loadDashboard()]);
  return true;
}

async function loadLogs() {
  const logs = await api('/api/audit-logs?limit=300');
  document.querySelector('#audit-body').innerHTML = logs.length ? logs.map((log) => `<tr><td>${formatTime(log.created_at)}</td><td>${escapeHtml(log.actor)}</td><td>${escapeHtml(log.entity_type)}</td><td>${escapeHtml(log.action)}</td><td>#${log.entity_id}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">暂无日志</td></tr>';
}

// 铭牌上**刻意不印车间/产线/工位**。设备调线、移机、替换之后铭牌不会变成错的——
// 而这套系统最值钱的设计就是 equipment_installations 记得住设备搬过哪些位置。
// 位置扫码就看得到，而且是当前的；印死在铭牌上反而会让人按过期信息找错机器。
function labelHtml(item) {
  return `<div class="label-preview"><small>优胜美设备</small>
    <strong>${escapeHtml(item.code)}</strong>
    <span>${escapeHtml(item.alias || item.standard_name)}</span>
    <small>${escapeHtml(item.alias ? item.standard_name : '')}</small>
    <small>${escapeHtml([item.brand, item.model].filter(Boolean).join(' / ') || '品牌型号待补')}</small>
    <img class="label-qr" src="/api/qr/${encodeURIComponent(item.qr_token)}/image.svg" alt="设备二维码">
    <small>扫码报修</small></div>`;
}

// 二维码里烧进去的地址。没配 PUBLIC_BASE_URL 时会是 127.0.0.1，手机扫不开，
// 那就等于白印——所以这条警告必须显示实际地址，而且躲不过去。
function qrAddressNotice() {
  const configured = state.meta?.qr_base_url_configured;
  const base = state.meta?.qr_base_url || '（未知）';
  return configured
    ? `<p class="hint">二维码指向 <code>${escapeHtml(base)}</code>。</p>`
    : `<div class="notice-danger"><strong>先别批量打印。</strong>当前二维码里烧进去的地址是
        <code>${escapeHtml(base)}</code>——这是本机地址，<strong>手机扫了打不开</strong>。
        请先确定内网访问地址或域名，配好服务的 <code>PUBLIC_BASE_URL</code> 再打印，
        否则贴上去的铭牌全部作废。现在可以先看排版。</div>`;
}

function showLabel(id) {
  const item = state.equipment.find((x) => x.id === id);
  if (!item) return;
  const preview = document.createElement('div');
  preview.className = 'drawer';
  preview.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <h2>设备铭牌预览</h2>
    ${qrAddressNotice()}
    <p class="hint">铭牌不印车间和产线——设备移机之后铭牌才不会变成错的。位置扫码就看得到。</p>
    <div class="label-sheet">${labelHtml(item)}</div>
    <p><button onclick="window.print()">打印这一张</button></p></div>`;
  preview.querySelector('.drawer-backdrop').onclick = () => preview.remove();
  preview.querySelector('.drawer-close').onclick = () => preview.remove();
  document.body.append(preview);
}

// 按产线批量出铭牌：拿着一叠走一条线贴完，不会串。铭牌按工位顺序排。
function openLabelBatch() {
  const overlay = document.createElement('div');
  overlay.className = 'drawer label-batch';
  const lines = state.organization?.lines || [];
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <h2>批量打印设备铭牌</h2>
    ${qrAddressNotice()}
    <div class="no-print">
      <div class="form-row">
        <label>车间<select id="batch-workshop"><option value="">请选择</option>${
          (state.organization?.workshops || []).map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('')}</select></label>
        <label>产线<select id="batch-line"><option value="">先选车间</option></select></label>
      </div>
      <p class="hint" id="batch-summary">选一条产线，铭牌会按工位顺序排好。</p>
      <p><button id="batch-print" disabled>打印这条产线的铭牌</button></p>
    </div>
    <div class="label-sheet" id="batch-sheet"></div></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;

  const workshopSelect = overlay.querySelector('#batch-workshop');
  const lineSelect = overlay.querySelector('#batch-line');
  const sheet = overlay.querySelector('#batch-sheet');
  const summary = overlay.querySelector('#batch-summary');
  const printButton = overlay.querySelector('#batch-print');

  const render = () => {
    const lineId = Number(lineSelect.value || 0);
    // state.equipment 已经按车间→产线→工位顺序排好（service.listEquipment 的 ORDER BY），
    // 这里过滤一下顺序就是对的。
    const items = lineId ? state.equipment.filter((x) => x.line_id === lineId) : [];
    sheet.innerHTML = items.map(labelHtml).join('');
    summary.textContent = lineId
      ? `${items.length} 台设备，${items.length} 张铭牌，按工位顺序排列。`
      : '选一条产线，铭牌会按工位顺序排好。';
    printButton.disabled = !items.length;
  };
  workshopSelect.addEventListener('change', () => {
    const workshopId = Number(workshopSelect.value || 0);
    const visible = workshopId ? lines.filter((l) => l.workshop_id === workshopId) : [];
    lineSelect.innerHTML = `<option value="">${workshopId ? '请选择产线' : '先选车间'}</option>${
      visible.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('')}`;
    render();
  });
  lineSelect.addEventListener('change', render);
  printButton.addEventListener('click', () => window.print());
  document.body.append(overlay);
}

function profileBasicTab(item, openOrder) {
  const statusOptions = MANUAL_EQUIPMENT_STATUSES.map((value) =>
    `<option value="${value}">${statusName(value)}</option>`).join('');
  // 维修期间下拉里选的是"结单后回到什么状态"，必须说清楚，否则会以为改了没生效。
  const repairNote = underRepair(item.status)
    ? `<p class="hint status-note">当前因${openOrder ? `工单 ${escapeHtml(openOrder.work_order_no)} ` : '未结维修工单'}被系统置为「${statusName(item.status)}」。这里选的是结单后要回到的状态。</p>`
    : '';
  if (!canManage()) {
    return `<div class="definition-grid">
      <div><small>标准名称</small>${escapeHtml(item.standard_name)}</div>
      <div><small>现场别名</small>${escapeHtml(item.alias || '—')}</div>
      <div><small>设备类别</small>${escapeHtml(item.category)}</div>
      <div><small>类型 / 规格</small>${escapeHtml(item.type_code || '旧编码')} ${escapeHtml(item.key_spec || '')}</div>
      <div><small>品牌 / 型号</small>${escapeHtml([item.brand, item.model].filter(Boolean).join(' / ') || '—')}</div>
      <div><small>出厂编号</small>${escapeHtml(item.serial_number || '—')}</div>
      <div><small>当前状态</small>${statusBadge(item.status)}</div>
      <div><small>负责人</small>${escapeHtml(item.responsible_person || '—')}</div>
      <div><small>启用日期</small>${escapeHtml(item.commissioned_on || '—')}</div>
      <div><small>原资产编号</small>${escapeHtml(item.legacy_code || '—')}</div>
      <div><small>关键设备</small>${item.critical ? '是' : '否'}</div>
      <div><small>资料核实</small>${item.verified ? '已核实' : '待核实'}</div>
      <div class="wide"><small>备注</small>${escapeHtml(item.notes || '—')}</div>
      <div class="wide"><small class="hint">档案内容由管理员维护，你可以查看全部履历。</small></div>
    </div>`;
  }
  return `<form class="form-card flush" id="equipment-edit-form">
    <label>标准设备名称<input name="standard_name" required value="${escapeHtml(item.standard_name)}"></label><label>现场别名<input name="alias" value="${escapeHtml(item.alias || '')}"></label><label>设备类别<input name="category" required value="${escapeHtml(item.category)}"></label>
    <div class="form-row"><label>类型代码<input value="${escapeHtml(item.type_code || '旧编码')}" readonly></label><label>关键规格<input value="${escapeHtml(item.key_spec || '')}" readonly></label></div>
    <div class="form-row"><label>品牌<input name="brand" value="${escapeHtml(item.brand || '')}"></label><label>型号<input name="model" value="${escapeHtml(item.model || '')}"></label></div><label>出厂编号<input name="serial_number" value="${escapeHtml(item.serial_number || '')}"></label>
    <div class="form-row"><label>负责人<input name="responsible_person" value="${escapeHtml(item.responsible_person || '')}"></label><label>启用日期<input type="date" name="commissioned_on" value="${escapeHtml(item.commissioned_on || '')}"></label></div>
    <label>${underRepair(item.status) ? '结单后的状态' : '设备状态'}<select name="status">${statusOptions}</select></label>${repairNote}
    <label>原资产编号<input name="legacy_code" value="${escapeHtml(item.legacy_code || '')}"></label><label>数据来源<input name="data_source" value="${escapeHtml(item.data_source || '现场盘点')}"></label>
    <label class="check"><input type="checkbox" name="critical" ${item.critical ? 'checked' : ''}>关键设备</label><label class="check"><input type="checkbox" name="verified" ${item.verified ? 'checked' : ''}>资料已核实</label><label>备注<textarea name="notes">${escapeHtml(item.notes || '')}</textarea></label><button>保存设备档案</button></form>`;
}

function profileMovementTab(history) {
  if (!history.installations.length && !history.changes.length) {
    return '<div class="empty">这台设备还没有安装到任何机位</div>';
  }
  const installs = history.installations.map((item) => `
    <div class="history-item ${item.removed_at ? '' : 'current'}">
      <strong>${escapeHtml(item.line_name)} / ${escapeHtml(item.process_name)} / ${escapeHtml(item.position_name)}</strong>
      ${item.removed_at ? '' : '<span class="status">当前在位</span>'}
      <br><small>${formatTime(item.installed_at)} 起${item.removed_at ? ` · ${formatTime(item.removed_at)} 移出` : ''}</small>
      ${item.change_no ? `<br><small>${escapeHtml(item.change_no)} · ${escapeHtml(labels[item.action] || item.action)} · ${escapeHtml(item.reason || '')}</small>
      <br><small>提交：${escapeHtml(item.submitted_by || '—')}${item.reviewed_by ? ` · 审核：${escapeHtml(item.reviewed_by)}` : ''}</small>` : ''}
    </div>`).join('');
  const changes = history.changes.map((item) => `
    <div class="history-item">
      <strong>${escapeHtml(item.change_no)} · ${escapeHtml(labels[item.action] || item.action)}</strong>
      <span class="status ${item.status === 'PENDING' ? 'pending' : item.status === 'REJECTED' ? 'danger' : ''}">${escapeHtml(labels[item.status] || item.status)}</span>
      ${item.as_replacement ? '<span class="status muted">作为替换设备</span>' : ''}
      <br><small>${escapeHtml(item.from_position_name || '未安装')} → ${escapeHtml(item.to_position_name || '移除')} · 生效 ${formatTime(item.effective_at)}</small>
      <br><small>${escapeHtml(item.reason)}</small>
      <br><small>提交：${escapeHtml(item.submitted_by)}${item.reviewed_by ? ` · 审核：${escapeHtml(item.reviewed_by)}` : ''}${item.review_note ? ` · ${escapeHtml(item.review_note)}` : ''}</small>
    </div>`).join('');
  return `<section class="detail-block"><h3>在位记录</h3>${installs || '<div class="empty">暂无</div>'}</section>
    <section class="detail-block"><h3>变动申请</h3>${changes || '<div class="empty">暂无</div>'}</section>`;
}

function profileRepairTab(history) {
  if (!history.work_orders.length) return '<div class="empty">这台设备还没有维修记录</div>';
  return history.work_orders.map((w) => `
    <section class="detail-block ${w.reported_only ? 'faded' : ''}">
      <h3>${escapeHtml(w.work_order_no)}
        <span class="status ${w.status === 'COMPLETED' ? '' : w.status === 'CANCELLED' ? 'danger' : 'pending'}">${escapeHtml(labels[w.status] || w.status)}</span>
        ${w.is_downtime ? '<span class="status danger">停机</span>' : ''}
        ${w.reported_only ? '<span class="status muted">报到这台，实际不是这台</span>' : ''}
      </h3>
      <div class="definition-grid">
        <div><small>报修人 / 时间</small>${escapeHtml(w.reporter)} · ${formatTime(w.reported_at)}</div>
        <div><small>技术员</small>${escapeHtml(w.assignee || '未接单')}</div>
        <div><small>停机时长</small>${w.downtime_minutes ? `${w.downtime_minutes} 分钟` : '—'}</div>
        <div class="wide"><small>故障现象</small>${escapeHtml(w.fault_symptom)}${w.fault_location ? `（${escapeHtml(w.fault_location)}）` : ''}</div>
        ${w.diagnosis ? `<div class="wide"><small>诊断</small>${escapeHtml(w.diagnosis)}</div>` : ''}
        ${w.root_cause ? `<div class="wide"><small>根本原因</small>${escapeHtml(w.root_cause)}</div>` : ''}
        ${w.repair_action ? `<div class="wide"><small>维修方法</small>${escapeHtml(w.repair_action)}</div>` : ''}
        ${w.trial_result ? `<div class="wide"><small>试运行结果</small>${escapeHtml(w.trial_result)}</div>` : ''}
        <div><small>完成时间</small>${w.completed_at ? formatTime(w.completed_at) : '—'}</div>
      </div>
      ${w.attachments?.length ? `<h4 class="photo-heading">现场照片（${w.attachments.length}）</h4>${attachmentStrip(w.attachments)}` : ''}
      ${w.parts.length ? `<div class="table-wrap"><table><thead><tr><th>更换零件</th><th>规格</th><th>数量</th><th>来源</th><th>记录人</th></tr></thead><tbody>
        ${w.parts.map((p) => `<tr><td>${escapeHtml(p.part_name)}</td><td>${escapeHtml(p.specification || '—')}</td><td>${p.quantity} ${escapeHtml(p.unit)}</td><td>${escapeHtml(p.source || '—')}</td><td>${escapeHtml(p.recorded_by)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="hint">本次没有更换零件</p>'}
    </section>`).join('');
}

function profilePatrolTab(history) {
  if (!history.patrols.length) return '<div class="empty">这台设备还没有巡检记录</div>';
  return history.patrols.map((item) => `
    <section class="detail-block">
      <h3>${escapeHtml(item.patrol_no)}
        ${item.work_order_id ? `<span class="status">已转 ${escapeHtml(item.work_order_no)}</span>`
          : item.has_issue ? '<span class="status pending">待跟进</span>' : '<span class="status muted">正常</span>'}</h3>
      <div class="definition-grid">
        <div><small>巡检人 / 时间</small>${escapeHtml(item.patroller)} · ${formatTime(item.patrolled_at)}</div>
        <div><small>位置</small>${escapeHtml(item.line_name || '—')} ${escapeHtml(item.process_name || '')}</div>
        <div class="wide"><small>发现的问题与处理</small>${escapeHtml(item.findings)}</div>
      </div>
      ${item.attachments?.length ? attachmentStrip(item.attachments) : ''}
    </section>`).join('');
}

function profileAuditTab(history) {
  if (!history.audits.length) return '<div class="empty">暂无档案修改记录</div>';
  return history.audits.map((log) => {
    let detail = '';
    try {
      const before = log.before_json ? JSON.parse(log.before_json) : null;
      const after = log.after_json ? JSON.parse(log.after_json) : null;
      if (log.action === 'STATUS_SYNC' && before && after) {
        detail = `${statusName(before.status)} → ${statusName(after.status)}`;
      } else if (before && after) {
        // 只列真正变了的字段，避免把整份档案铺出来。
        const changed = Object.keys(after)
          .filter((key) => !['updated_at', 'created_at'].includes(key) && String(before[key] ?? '') !== String(after[key] ?? ''))
          .map((key) => `${key}：${String(before[key] ?? '空')} → ${String(after[key] ?? '空')}`);
        detail = changed.join('；');
      }
    } catch { detail = ''; }
    return `<div class="history-item"><strong>${escapeHtml(labels[log.action] || log.action)}</strong>
      <br><small>${formatTime(log.created_at)} · ${escapeHtml(log.actor)}</small>
      ${detail ? `<br><small>${escapeHtml(detail)}</small>` : ''}</div>`;
  }).join('');
}

async function openEquipmentProfile(id) {
  const history = await guarded(() => api(`/api/equipment/${id}/history`));
  const item = history.equipment;
  const s = history.summary;
  const openOrder = history.work_orders.find((w) => !w.reported_only && !['COMPLETED', 'CANCELLED'].includes(w.status));
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  // 灯箱要能找到这些照片，暂存到 state
  state.equipmentProfile = {
    photos: [...history.work_orders.flatMap((w) => w.attachments || []),
      ...history.patrols.flatMap((p) => p.attachments || [])],
  };
  const tabs = [
    ['basic', canManage() ? '基本信息' : '基本信息（只读）'],
    ['movement', `位置变动 (${history.installations.length})`],
    ['repair', `维修记录 (${s.work_orders})`],
    ['patrol', `巡检记录 (${history.patrols.length})`],
    ['audit', `档案修改 (${history.audits.length})`],
  ];
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button>
    <p class="eyebrow">${escapeHtml(item.code)} · 永久编码不可修改</p>
    <h2>${escapeHtml(item.standard_name)} ${statusBadge(item.status)}</h2>
    <p class="hint">${escapeHtml(s.current_position || '当前未安装在任何机位')}${s.installed_days !== null ? ` · 已在位 ${s.installed_days} 天` : ''}</p>
    <div class="import-summary profile-summary">
      <div><strong>${s.work_orders}</strong>维修次数</div>
      <div><strong>${s.open_work_orders}</strong>未结工单</div>
      <div><strong>${s.total_downtime_minutes}</strong>累计停机(分)</div>
      <div><strong>${s.parts_replaced}</strong>更换零件</div>
      <div><strong>${s.patrols}</strong>巡检次数</div>
      <div><strong>${s.last_repair_at ? formatTime(s.last_repair_at).split(' ')[0] : '—'}</strong>上次维修</div>
    </div>
    <div class="tab-bar">${tabs.map(([key, name], index) =>
      `<button class="tab ${index === 0 ? 'active' : ''}" data-tab="${key}">${escapeHtml(name)}</button>`).join('')}</div>
    <div class="tab-panel active" data-panel="basic">${profileBasicTab(item, openOrder)}</div>
    <div class="tab-panel" data-panel="movement">${profileMovementTab(history)}</div>
    <div class="tab-panel" data-panel="repair">${profileRepairTab(history)}</div>
    <div class="tab-panel" data-panel="patrol">${profilePatrolTab(history)}</div>
    <div class="tab-panel" data-panel="audit">${profileAuditTab(history)}</div>
  </div>`;

  const statusSelect = overlay.querySelector('[name="status"]');
  // 下拉展示的是baseline（结单后要回到的状态），不是当前可能被工单改写的status。
  if (statusSelect) statusSelect.value = MANUAL_EQUIPMENT_STATUSES.includes(item.baseline_status) ? item.baseline_status
    : (MANUAL_EQUIPMENT_STATUSES.includes(item.status) ? item.status : 'ACTIVE');
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    overlay.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === button));
    overlay.querySelectorAll('.tab-panel').forEach((panel) =>
      panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
  }));
  const form = overlay.querySelector('#equipment-edit-form');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await guarded(() => api(`/api/equipment/${id}`, { method: 'PUT', body: JSON.stringify(formObject(form)) }), '设备档案已更新');
    close();
    await Promise.all([loadEquipment(), loadOrganizationTree()]);
  });
  document.body.append(overlay);
}

function openEquipmentTypeManager() {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const render = () => {
    overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button><p class="eyebrow">属性型设备编码</p><h2>设备类型代码</h2>
      <form class="inline-form" id="type-create-form"><label>类型代码<input name="code" maxlength="4" pattern="[A-Za-z]{2,4}" placeholder="例如 EXT" required></label><label>中文名称<input name="name" placeholder="例如 挤出机" required></label><button>新增类型</button></form>
      <div class="type-list">${state.equipmentTypes.map((item) => `<div class="type-row"><code>${escapeHtml(item.code)}</code><input data-type-name="${item.id}" value="${escapeHtml(item.name)}"><span><button class="secondary small" data-save-type="${item.id}">保存</button> <button class="danger small" data-delete-type="${item.id}" ${item.equipment_count ? 'disabled' : ''}>删除</button></span></div>`).join('')}</div>`;
    const close = () => overlay.remove();
    overlay.querySelector('.drawer-backdrop').onclick = close;
    overlay.querySelector('.drawer-close').onclick = close;
    overlay.querySelector('#type-create-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await guarded(() => api('/api/equipment-types', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) }), '设备类型已新增');
      await loadEquipmentTypes();
      render();
    });
    overlay.querySelectorAll('[data-save-type]').forEach((button) => button.addEventListener('click', async () => {
      const id = button.dataset.saveType;
      const name = overlay.querySelector(`[data-type-name="${id}"]`).value;
      await guarded(() => api(`/api/equipment-types/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }), '类型名称已更新');
      await loadEquipmentTypes();
      render();
    }));
    overlay.querySelectorAll('[data-delete-type]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('确认删除这个未使用的设备类型？')) return;
      await guarded(() => api(`/api/equipment-types/${button.dataset.deleteType}`, { method: 'DELETE' }), '设备类型已删除');
      await loadEquipmentTypes();
      render();
    }));
  };
  render();
  document.body.append(overlay);
}

async function openDeleteStructure(type, id) {
  const preview = await guarded(() => api(`/api/structure/${type}/${id}/delete-preview`));
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const c = preview.counts;
  const blockers = preview.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button><p class="eyebrow">删除前安全检查</p><h2>${escapeHtml(preview.target.label)}：${escapeHtml(preview.target.name)}</h2><p class="hint">${escapeHtml(preview.target.code)}</p>
    <div class="delete-summary"><div><strong>${c.workshops}</strong>车间</div><div><strong>${c.lines}</strong>产线</div><div><strong>${c.processes}</strong>工序</div><div><strong>${c.positions}</strong>机位</div><div><strong>${c.work_orders_to_delete}</strong>关联工单将删除</div></div>
    ${blockers ? `<div class="blocker-list"><strong>当前不能删除</strong><ul>${blockers}</ul><p>已经生效的设备安装和组合变动历史必须保留。</p></div>` : `<div class="detail-block"><p>该分支没有设备安装或组合变动历史，可以删除。关联维修工单及其零件、流转记录会一并删除，并保留本次分支删除审计。</p><label>输入节点名称确认<input id="delete-confirm-name" placeholder="${escapeHtml(preview.target.name)}"></label><button class="danger" id="confirm-structure-delete" disabled>确认删除整个分支</button></div>`}`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  const input = overlay.querySelector('#delete-confirm-name');
  const button = overlay.querySelector('#confirm-structure-delete');
  if (input && button) {
    input.addEventListener('input', () => { button.disabled = input.value.trim() !== preview.target.name; });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await guarded(() => api(`/api/structure/${type}/${id}`, { method: 'DELETE' }), `${preview.target.label}及其无历史下级已删除`);
        close();
        await refreshStructure();
      } catch { button.disabled = false; }
    });
  }
  document.body.append(overlay);
}

function openStructureDrawer(kind, parentId, id = null) {
  const item = id ? findTreeItem(kind, id) : null;
  const isEdit = Boolean(item);
  const titles = { workshop: '车间', line: '产线', process: '工序', position: '机位' };
  const parentFields = { workshop: 'factory_id', line: 'workshop_id', process: 'line_id', position: 'process_id' };
  const endpoints = { workshop: 'workshops', line: 'lines', process: 'processes', position: 'positions' };
  const placeholder = { workshop: 'YSM-WS02', line: 'YSM-L01', process: 'YSM-L01-EX', position: 'YSM-L01-EX-P01' };
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  let extraFields = '';
  if (kind === 'line') extraFields = `<label>生产主管<input name="supervisor" value="${escapeHtml(item?.supervisor || '')}"></label>`;
  if (kind === 'process') extraFields = `<label>工序顺序<input type="number" min="1" name="sequence_no" value="${item?.sequence_no || 1}"></label>`;
  if (kind === 'position') extraFields = `<label>机位顺序<input type="number" min="1" name="sequence_no" value="${item?.sequence_no || 1}"></label><label class="check"><input type="checkbox" name="critical" ${item?.critical ? 'checked' : ''}>关键机位</label>`;
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button><p class="eyebrow">产线组合树</p><h2>${isEdit ? '编辑' : '新增'}${titles[kind]}</h2><form class="form-card" id="structure-node-form">
    ${isEdit ? '' : `<input type="hidden" name="${parentFields[kind]}" value="${parentId}">`}
    <label>${titles[kind]}编码<input name="code" placeholder="${placeholder[kind]}" value="${escapeHtml(item?.code || '')}" ${isEdit ? 'readonly' : 'required'}></label>
    <label>${titles[kind]}名称<input name="name" value="${escapeHtml(item?.name || '')}" required></label>${extraFields}<button>${isEdit ? '保存修改' : `创建${titles[kind]}`}</button></form></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  overlay.querySelector('#structure-node-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formObject(event.currentTarget);
    const result = await guarded(() => api(`/api/${endpoints[kind]}${isEdit ? `/${id}` : ''}`, {
      method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(payload),
    }), `${titles[kind]}已${isEdit ? '更新' : '创建'}`);
    const parentType = kind === 'workshop' ? 'factory' : kind === 'line' ? 'workshop' : kind === 'process' ? 'line' : 'process';
    state.expandedNodes.add(treeKey(parentType, parentId));
    state.expandedNodes.add(treeKey(kind, result.id));
    close();
    await refreshStructure(treeKey(kind, result.id));
  });
  document.body.append(overlay);
}

function prepareInstall(positionId) {
  const position = findTreeItem('position', positionId);
  document.querySelector('[data-view="changes"]').click();
  document.querySelector('#change-position').value = String(positionId);
  if (position?.equipment) {
    document.querySelector('#change-action').value = 'REPLACE';
    setEquipmentPicker('change', { equipmentId: position.equipment.id });
  } else {
    document.querySelector('#change-action').value = 'INSTALL';
  }
  document.querySelector('#change-action').dispatchEvent(new Event('change'));
}

function showEquipmentImportPreview(file, contentBase64, preview) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const s = preview.summary;
  const rowHtml = preview.rows.filter((row) => row.errors.length || row.warnings.length).map((row) => `
    <div class="import-row ${row.errors.length ? 'error' : 'warning'}"><strong>第${row.row_number}行 · ${escapeHtml(row.row.standard_name || '未填写名称')}</strong>${row.planned_code ? `<span> · ${escapeHtml(row.planned_code)}</span>` : ''}
    ${row.errors.map((message) => `<p>错误：${escapeHtml(message)}</p>`).join('')}${row.warnings.map((message) => `<p>提醒：${escapeHtml(message)}</p>`).join('')}</div>`).join('');
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button><p class="eyebrow">设备台账整批导入预览</p><h2>${escapeHtml(file.name)}</h2>
    <div class="import-summary"><div><strong>${s.rows}</strong>设备行</div><div><strong>${s.equipment_created}</strong>计划新建</div><div><strong>${s.warnings}</strong>提醒</div><div><strong>${s.errors}</strong>错误</div></div>
    <div class="import-errors">${rowHtml || '<div class="empty">校验通过，没有错误或提醒</div>'}</div>
    <div class="detail-block"><p>${s.errors ? '当前没有写入任何设备。请先修正全部错误，再重新上传。' : '确认后将整批写入；任何一步失败都会全部回滚，永久码以系统最终发码为准。'}</p><button id="commit-equipment-import" ${s.errors ? 'disabled' : ''}>确认整批导入</button></div></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  const commit = overlay.querySelector('#commit-equipment-import');
  if (commit && !s.errors) commit.addEventListener('click', async () => {
    commit.disabled = true;
    try {
      const result = await guarded(() => api('/api/imports/equipment/commit', {
        method: 'POST', body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
      }), '设备台账已整批导入');
      close();
      await Promise.all([loadEquipment(), loadDashboard(), loadOrganizationTree(), loadEquipmentTypes()]);
      flash(`导入完成：${result.rows}台设备，永久码已全部生成`);
    } catch { commit.disabled = false; }
  });
  document.body.append(overlay);
}

function showCompositionImportPreview(file, contentBase64, preview) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer';
  const s = preview.summary;
  const rowHtml = preview.rows.filter((row) => row.errors.length || row.warnings.length).map((row) => `
    <div class="import-row ${row.errors.length ? 'error' : 'warning'}"><strong>第${row.row_number}行 · ${escapeHtml(row.row.position_code || '未填写机位')}</strong>
    ${row.errors.map((message) => `<p>错误：${escapeHtml(message)}</p>`).join('')}${row.warnings.map((message) => `<p>提醒：${escapeHtml(message)}</p>`).join('')}</div>`).join('');
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer-panel"><button class="drawer-close">×</button><p class="eyebrow">组合导入预览</p><h2>${escapeHtml(file.name)}</h2>
    <div class="import-summary"><div><strong>${s.rows}</strong>数据行</div><div><strong>${s.lines_created}</strong>新产线</div><div><strong>${s.equipment_created}</strong>新设备</div><div><strong>${s.installations}</strong>安装关系</div><div><strong>${s.processes_created}</strong>新工序</div><div><strong>${s.positions_created}</strong>新机位</div><div><strong>${s.warnings}</strong>提醒</div><div><strong>${s.errors}</strong>错误</div></div>
    <div class="import-errors">${rowHtml || '<div class="empty">校验通过，没有错误或提醒</div>'}</div>
    <div class="detail-block"><p>${s.errors ? '请先修改Excel中的错误，再重新选择文件。当前没有任何数据写入系统。' : '全部校验通过。点击确认后将整批写入，任何一步失败都会全部回滚。'}</p><button id="commit-composition-import" ${s.errors ? 'disabled' : ''}>确认整批导入</button></div></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelector('.drawer-close').onclick = close;
  const commit = overlay.querySelector('#commit-composition-import');
  if (commit && !s.errors) commit.addEventListener('click', async () => {
    commit.disabled = true;
    try {
      const result = await guarded(() => api('/api/imports/line-composition/commit', {
        method: 'POST', body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
      }), '产线组合已整批导入');
      close();
      await Promise.all([refreshStructure(), loadEquipment(), loadChanges(), loadDashboard()]);
      flash(`导入完成：${result.lines_created}条新产线、${result.equipment_created}台新设备、${result.installations}条安装关系`);
    } catch { commit.disabled = false; }
  });
  document.body.append(overlay);
}

async function refreshStructure(focusKey = '') {
  await Promise.all([loadOrganization(), loadOrganizationTree(focusKey)]);
}

// 只加载当前级别用得上的数据：普工不需要台账树、变动申请和成员清单。
async function refreshAll() {
  const current = level();
  // meta 要先拿到：里面有状态机，工单详情的"下一步"依赖它。
  await loadMeta();
  const tasks = [loadOrganization(), loadEquipment(), loadWorkOrders(), loadFaultCodes(), loadQuickFaults()];
  if (current >= LEVELS.TECHNICIAN) {
    tasks.push(loadDashboard(), loadOrganizationTree(), loadEquipmentTypes(), loadPatrols(), loadMyReviewSummary());
  }
  if (current >= LEVELS.MANAGER) tasks.push(loadChanges(), loadMembers());
  await Promise.all(tasks);
}

// 扫铭牌二维码进来：普工只会报修，直达；技术员既可能报修也可能是在巡检，给个二选一。
async function handleScanToken(token) {
  const resolved = await api(`/api/qr/${encodeURIComponent(token)}`);
  const target = resolved.target_type === 'EQUIPMENT'
    ? { equipmentId: resolved.target.id, processId: resolved.target.process_id, label: `${resolved.target.code} ${resolved.target.standard_name}` }
    // 工序码不会再印（二维码只贴单台机器），但万一有人扫到，就按它所属产线处理：
    // 把选择器缩到这条线上的那几台设备，比只填个工序有用。
    : { equipmentId: null, processId: resolved.target.id, lineId: resolved.target.line_id,
        label: `${resolved.target.line_name} / ${resolved.target.name}` };

  if (level() >= LEVELS.TECHNICIAN && target.equipmentId) return askScanIntent(target);
  applyScanToRepair(target);
}

async function handleScanLink() {
  const raw = new URLSearchParams(location.search).get('scan');
  if (!raw) return;
  const token = window.YsmScannerUtils.extractScanToken(raw);
  await handleScanToken(token);
}

function scanErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/cancel|取消|canceled|cancelled/i.test(message)) return '';
  if (/permission|camera access|相机|权限|denied|not allowed/i.test(message)) {
    return '无法使用相机，请在系统设置中允许“优胜美设备管理”使用相机';
  }
  if (/network|fetch|failed to fetch|网络|连接/i.test(message)) {
    return '二维码已识别，但当前无法连接测试服务，请检查手机和电脑是否连接同一 Wi-Fi';
  }
  return message || '扫码失败，请重试';
}

async function startNativeScan() {
  if (scanBusy) return;
  const scanner = getNativeScanner();
  if (!scanner) return flash('当前安装包不支持扫码，请安装最新 APK', 'error');

  const button = document.querySelector('#native-scan-button');
  scanBusy = true;
  button.disabled = true;
  button.querySelector('span').textContent = '识别中';
  try {
    const result = await scanner.scanBarcode({
      hint: 0,
      scanInstructions: '请将设备铭牌二维码放入框内',
      scanButton: false,
      scanText: '识别二维码',
      cameraDirection: 1,
      scanOrientation: 3,
      cancelButtonAccessibilityLabel: '取消扫码',
      torchButtonOnAccessibilityLabel: '关闭手电筒',
      torchButtonOffAccessibilityLabel: '打开手电筒',
      android: { scanningLibrary: 'zxing' },
    });
    if (!result?.ScanResult) return;
    const token = window.YsmScannerUtils.extractScanToken(result.ScanResult);
    await handleScanToken(token);
  } catch (error) {
    const message = scanErrorMessage(error);
    if (message) flash(message, 'error');
  } finally {
    scanBusy = false;
    button.disabled = false;
    button.querySelector('span').textContent = '扫码';
  }
}

function applyScanToRepair(target) {
  activateView('repairs');
  document.querySelector('#repair-form').classList.remove('collapsed-form');
  if (target.processId) document.querySelector('#repair-process').value = String(target.processId);
  const result = setEquipmentPicker('repair', { equipmentId: target.equipmentId, lineId: target.lineId });
  if (target.equipmentId) {
    flash(`已识别：${target.label}，说一句哪里不对劲就能提交`);
    document.querySelector('#repair-description').focus();
    return;
  }
  // 扫到的是产线/工序码：选择器已经缩到这条线，让人从这几台里挑
  flash(`已识别：${target.label}，这条线上有 ${result?.count || 0} 台设备，选一台`);
  pickerParts('repair')?.equipment.focus();
}

function applyScanToPatrol(target) {
  activateView('patrol');
  setEquipmentPicker('patrol', { equipmentId: target.equipmentId });
  flash(`已识别：${target.label}，请填写巡检发现`);
  document.querySelector('#patrol-findings').focus();
}

function askScanIntent(target) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer scan-intent';
  overlay.innerHTML = `<div class="drawer-backdrop"></div><div class="intent-card">
    <p class="eyebrow">扫码成功</p><h2>${escapeHtml(target.label)}</h2>
    <p class="hint">要做什么？</p>
    <div class="intent-actions">
      <button data-intent="patrol">登记巡检</button>
      <button class="secondary" data-intent="repair">报修</button>
    </div></div>`;
  const close = () => overlay.remove();
  overlay.querySelector('.drawer-backdrop').onclick = close;
  overlay.querySelectorAll('[data-intent]').forEach((button) => button.addEventListener('click', () => {
    close();
    if (button.dataset.intent === 'patrol') applyScanToPatrol(target); else applyScanToRepair(target);
  }));
  document.body.append(overlay);
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', async () => {
  activateView(button.dataset.view);
  if (button.dataset.view === 'logs') await guarded(loadLogs);
  if (button.dataset.view === 'members') await guarded(loadMembers);
  if (button.dataset.view === 'repairs') await guarded(loadWorkOrders);
  if (button.dataset.view === 'patrol') await guarded(loadPatrols);
  if (button.dataset.view === 'fault-codes') await guarded(loadFaultCodeAdmin);
  if (button.dataset.view === 'reviews') await guarded(loadReviewAdmin);
}));

const refreshHandlers = {
  logs: loadLogs, members: loadMembers, repairs: loadWorkOrders, reviews: loadReviewAdmin,
  patrol: loadPatrols, 'fault-codes': loadFaultCodeAdmin, dashboard: loadDashboard,
};
document.querySelectorAll('[data-refresh]').forEach((button) =>
  button.addEventListener('click', () => guarded(refreshHandlers[button.dataset.refresh] || loadDashboard)));
document.querySelectorAll('[data-close-drawer]').forEach((node) => node.addEventListener('click', () => { document.querySelector('#work-order-drawer').hidden = true; }));

document.querySelector('#equipment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const created = await guarded(() => api('/api/equipment', { method: 'POST', body: JSON.stringify(formObject(form)) }), '设备已建档并分配永久编码');
  form.reset();
  updateEquipmentCodePreview();
  await Promise.all([loadEquipment(), loadDashboard()]);
  showLabel(created.id);
});

document.querySelector('#add-workshop').addEventListener('click', () => {
  const factory = state.organizationTree[0];
  if (!factory) return flash('系统中没有可用工厂', 'error');
  openStructureDrawer('workshop', factory.id);
});
document.querySelector('#refresh-tree').addEventListener('click', () => guarded(() => refreshStructure(), '产线组合树已刷新'));
document.querySelector('#equipment-type').addEventListener('change', updateEquipmentCodePreview);
document.querySelector('#equipment-key-spec').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  updateEquipmentCodePreview();
});
document.querySelector('#manage-equipment-types').addEventListener('click', openEquipmentTypeManager);
document.querySelector('#search-equipment').addEventListener('click', () => guarded(() => loadEquipment(document.querySelector('#equipment-search').value)));
document.querySelector('#equipment-import').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const contentBase64 = await fileToBase64(file);
    const preview = await guarded(() => api('/api/imports/equipment/preview', {
      method: 'POST', body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
    }));
    showEquipmentImportPreview(file, contentBase64, preview);
  } catch (error) { flash(error.message, 'error'); }
  event.target.value = '';
});
document.querySelector('#composition-import').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const contentBase64 = await fileToBase64(file);
    const preview = await guarded(() => api('/api/imports/line-composition/preview', {
      method: 'POST', body: JSON.stringify({ filename: file.name, content_base64: contentBase64 }),
    }));
    showCompositionImportPreview(file, contentBase64, preview);
  } catch (error) { flash(error.message, 'error'); }
  event.target.value = '';
});

document.querySelector('#change-action').addEventListener('change', (event) => {
  const value = event.target.value;
  document.querySelector('#replacement-wrap').hidden = value !== 'REPLACE';
  document.querySelector('#to-position-wrap').hidden = ['REMOVE', 'REPLACE'].includes(value);
});
document.querySelector('#change-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await guarded(() => api('/api/composition-changes', { method: 'POST', body: JSON.stringify(formObject(form)) }), '设备变动申请已提交');
  form.reset();
  refreshEquipmentPicker('change');
  refreshEquipmentPicker('replacement');
  document.querySelector('#change-action').dispatchEvent(new Event('change'));
  await Promise.all([loadChanges(), loadDashboard()]);
});

document.querySelector('#repair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { ...formObject(form), attachments: takePhotos('repair') };
  // 报修是普工唯一的高频入口，校验失败（比如这条故障码要求拍照）是常态而不是异常。
  // guarded() flash 完还会抛，这里必须接住：否则每次都多一条未处理的 Promise 拒绝，
  // 让"监听 Runtime.exceptionThrown 找真 bug"这个验证手段失去信噪比。
  // 失败时故意不走下面的 reset/clearPhotos——已经填的内容和拍好的照片要留着。
  try {
    await guarded(() => api('/api/work-orders', { method: 'POST', body: JSON.stringify(payload) }), '报修已提交，技术员会尽快处理');
  } catch { return; }
  form.reset();
  clearPhotos('repair');
  document.querySelector('#repair-urgency').dataset.touched = '';
  document.querySelector('#repair-downtime').dataset.touched = '';
  document.querySelector('#fault-fold').open = false;
  renderFaultCascade();
  // form.reset() 把选择器的搜索框和车间/产线下拉也清了，选项要跟着重画
  refreshEquipmentPicker('repair');
  syncRepairProcessField();
  await loadWorkOrders();
  if (level() >= LEVELS.TECHNICIAN) await loadDashboard();
});

bindEquipmentPickers();   // 四个设备选择器的筛选联动，静态标签，绑一次
document.querySelector('#fault-category').addEventListener('change', renderFaultParts);
document.querySelector('#fault-part').addEventListener('change', renderFaultSymptoms);
document.querySelector('#fault-symptom').addEventListener('change', updateFaultTip);
document.querySelector('#quick-fault-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-fault-code]');
  if (button) selectFaultCode(button.dataset.faultCode);
});
document.querySelector('#quick-fault-clear').addEventListener('click', clearFaultCode);
// 报修人一旦自己动过这两项，就不再被故障码的默认值覆盖
document.querySelector('#repair-urgency').addEventListener('change', (event) => { event.target.dataset.touched = '1'; });
document.querySelector('#repair-downtime').addEventListener('change', (event) => { event.target.dataset.touched = '1'; });
document.querySelectorAll('[data-photo-input]').forEach((input) =>
  input.addEventListener('change', () => handlePhotoPick(input.dataset.photoInput, input)));

document.querySelector('#patrol-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { ...formObject(form), attachments: takePhotos('patrol') };
  await guarded(() => api('/api/patrols', { method: 'POST', body: JSON.stringify(payload) }), '巡检记录已提交');
  form.reset();
  clearPhotos('patrol');
  refreshEquipmentPicker('patrol');
  await loadPatrols();
});
document.querySelectorAll('[data-quick-fill]').forEach((button) => button.addEventListener('click', () => {
  const box = document.querySelector('#patrol-findings');
  box.value = box.value.trim() ? `${box.value.trim()}；${button.dataset.quickFill}` : button.dataset.quickFill;
  box.focus();
}));
document.querySelector('#add-fault-code').addEventListener('click', () => openFaultCodeDrawer());

// 注意：event.currentTarget 在第一个await之后就会变成null，
// 凡是await之后还要用表单的，都必须先同步存下引用。
document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const hint = document.querySelector('#login-hint');
  button.disabled = true;
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify(formObject(form)) });
    form.reset();
    hint.textContent = '忘记密码请联系管理员重置。';
    hint.classList.remove('error-text');
    await startSession();
  } catch (error) {
    hint.textContent = error.message;
    hint.classList.add('error-text');
  } finally { button.disabled = false; }
});

document.querySelector('#first-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = formObject(form);
  if (payload.new_password !== payload.confirm_password) return flash('两次输入的新密码不一致', 'error');
  // 原密码打错是最常见的用户失误。guarded() flash 完还会把错误抛出去，这里不接住的话
  // 每次打错都会多出一条未处理的 Promise 拒绝——用户看不见，但会污染控制台，
  // 也让"监听 Runtime.exceptionThrown 找真 bug"这个验证手段失去信噪比。
  try {
    await guarded(() => api('/api/session/password', {
      method: 'POST', body: JSON.stringify({ old_password: payload.old_password, new_password: payload.new_password }),
    }), '密码已设置，欢迎使用');
  } catch { return; }
  form.reset();
  await startSession();
});

// 技术员和管理员的报修表单默认收起，点标题展开——他们主要是处理工单，不是报修。
document.querySelector('#repair-form').querySelector('h2').addEventListener('click', (event) => {
  const form = event.currentTarget.closest('form');
  if (form.classList.contains('collapsed-form')) form.classList.remove('collapsed-form');
});

document.querySelector('#cancel-first-password').addEventListener('click', logout);
document.querySelector('#logout').addEventListener('click', logout);
document.querySelector('#native-scan-button').addEventListener('click', startNativeScan);
document.querySelector('#open-change-password').addEventListener('click', openChangePasswordDrawer);
document.querySelector('#add-member').addEventListener('click', () => openMemberDrawer());

window.reviewChange = reviewChange;
window.openWorkOrder = openWorkOrder;
window.claimWorkOrder = claimWorkOrder;
window.showLabel = showLabel;
window.openLabelBatch = openLabelBatch;
window.openEquipmentProfile = openEquipmentProfile;
window.editMember = (id) => openMemberDrawer(id);
window.resetMemberPassword = resetMemberPassword;
window.editFaultCode = (id) => openFaultCodeDrawer(id);
window.removeFaultCode = removeFaultCode;
window.openPatrolToWorkOrder = openPatrolToWorkOrder;
window.reviewWorkOrder = reviewWorkOrder;
window.withdrawWorkOrder = (id) => {
  const item = state.workOrders.find((x) => x.id === id);
  if (item) openWithdrawDrawer(item);
};
window.reopenWorkOrder = (id) => {
  const item = state.workOrders.find((x) => x.id === id);
  if (item) openReopenDrawer(item);
};
window.openPhoto = (id) => {
  const all = [...state.patrols.flatMap((p) => p.attachments || []),
    ...(state.selectedWorkOrder?.attachments || []), ...(state.equipmentProfile?.photos || [])];
  photoLightbox(all.find((item) => item.id === id) || { id, uploaded_by: '', created_at: null });
};
window.openStructureDrawer = openStructureDrawer;
window.prepareInstall = prepareInstall;
window.openDeleteStructure = openDeleteStructure;

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.me) return;
  openPendingRepairNotification();
  if (document.querySelector('#view-structure').classList.contains('active')) guarded(() => refreshStructure()).catch(() => {});
  if (document.querySelector('#view-repairs').classList.contains('active')) guarded(loadWorkOrders).catch(() => {});
});

document.querySelector('#change-effective').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
startSession().catch((error) => flash(error.message, 'error'));
