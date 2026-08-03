'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const QRCode = require('qrcode');
const { openDatabase } = require('./db');
const { DomainError, POST_ARRIVAL_STATUSES, REVIEW_DIMENSIONS, TRIAL_RESULTS, WITHDRAWABLE_STATUSES,
  WORK_ORDER_STAGES, WORK_ORDER_TRANSITIONS } = require('./domain');
const { EquipmentService, ROLES } = require('./service');
const {
  LEVELS,
  LEVEL_NAMES,
  SESSION_COOKIE,
  createNotificationDevice,
  createSession,
  destroySession,
  parseCookies,
  resolveNotificationDevice,
  resolveSession,
  revokeNotificationDevice,
} = require('./auth');
const {
  compositionExportBuffer,
  compositionTemplateBuffer,
  equipmentTemplateBuffer,
  operationalReportBuffer,
  parseCompositionWorkbook,
  parseEquipmentWorkbook,
} = require('./spreadsheets');

let PORT = Number(process.env.PORT || 8787);
let HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = path.join(__dirname, '..', 'web');
const MAX_BODY_BYTES = 20 * 1024 * 1024;

let db;
let service;

// 身份只从会话Cookie解析。不再信任任何请求头，页面上也不再有角色下拉框，
// 否则三级权限和审计日志的"操作人"都可以被随手伪造。
function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function contextFrom(request, options = {}) {
  if (options.notification) {
    const device = resolveNotificationDevice(db, bearerToken(request));
    if (device) {
      return {
        actor: device.display_name,
        user_id: device.user_id,
        username: device.username,
        level: device.level,
        role: device.role,
        must_change_password: false,
        notification_device_id: device.device_id,
      };
    }
  }
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = resolveSession(db, token, { touch: options.touch !== false });
  if (!session) return null;
  return {
    actor: session.display_name,
    user_id: session.user_id,
    username: session.username,
    level: session.level,
    role: session.role,
    must_change_password: session.must_change_password,
  };
}

function securityHeaders({ html = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (html) {
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join('; ');
  }
  if (process.env.YSM_SECURE_COOKIE === '1') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (process.env.YSM_SECURE_COOKIE === '1') parts.push('Secure');
  return parts.join('; ');
}

function successWithCookie(response, data, cookie, status = 200) {
  const body = JSON.stringify({ ok: true, data });
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Set-Cookie': cookie,
  });
  response.end(body);
}

function identity(context) {
  return {
    user_id: context.user_id,
    username: context.username,
    display_name: context.actor,
    level: context.level,
    level_name: LEVEL_NAMES[context.level],
    role: context.role,
    must_change_password: context.must_change_password,
  };
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function success(response, data, status = 200) {
  jsonResponse(response, status, { ok: true, data });
}

function downloadResponse(response, buffer, filename) {
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  response.end(buffer);
}

function workbookBuffer(body) {
  if (typeof body.content_base64 !== 'string' || !body.content_base64) {
    throw new DomainError('没有收到Excel文件内容', 400);
  }
  try { return Buffer.from(body.content_base64, 'base64'); }
  catch { throw new DomainError('Excel文件编码无效', 400); }
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new DomainError('请求内容超过20MB限制', 413, 'PAYLOAD_TOO_LARGE'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new DomainError('请求内容不是有效JSON', 400, 'INVALID_JSON'));
      }
    });
    request.on('error', reject);
  });
}

function match(pathname, pattern) {
  const result = pathname.match(pattern);
  return result ? result.slice(1) : null;
}

// 二维码里烧进去的地址前缀。没配 PUBLIC_BASE_URL 时按请求头推导——
// 那就意味着从工厂那台电脑打印出来的码里是 http://127.0.0.1:8787，手机扫不开。
// 所以 /api/meta 会把这个值原样下发，铭牌界面照实显示出来（见 §6.8）。
function qrBaseUrl(request) {
  if (process.env.PUBLIC_BASE_URL) {
    try {
      const configured = new URL(process.env.PUBLIC_BASE_URL);
      if (!['http:', 'https:'].includes(configured.protocol)) throw new Error('invalid protocol');
      return configured.toString().replace(/\/+$/, '');
    } catch {
      throw new DomainError('PUBLIC_BASE_URL配置无效', 500, 'INVALID_SERVER_CONFIG');
    }
  }
  const trustProxy = process.env.YSM_TRUST_PROXY === '1';
  const proto = trustProxy
    ? String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    : (request.socket.encrypted ? 'https' : 'http');
  const host = trustProxy
    ? String(request.headers['x-forwarded-host'] || request.headers.host || `${HOST}:${PORT}`).split(',')[0].trim()
    : String(request.headers.host || `${HOST}:${PORT}`).trim();
  return `${proto}://${host}`;
}

function trustedOrigin() {
  const value = process.env.YSM_TRUSTED_ORIGIN || '';
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new DomainError('服务器可信来源配置无效', 500, 'INVALID_SERVER_CONFIG');
  }
}

function validateHost(request) {
  const rawHost = String(request.headers.host || '').trim();
  if (!rawHost || rawHost.length > 255 || /[\s/@\\]/.test(rawHost)) {
    throw new DomainError('请求域名无效', 400, 'INVALID_HOST');
  }
  let parsed;
  try { parsed = new URL(`http://${rawHost}`); }
  catch { throw new DomainError('请求域名无效', 400, 'INVALID_HOST'); }
  if (parsed.username || parsed.password || parsed.pathname !== '/') {
    throw new DomainError('请求域名无效', 400, 'INVALID_HOST');
  }
  const expected = trustedOrigin();
  if (expected && parsed.host !== new URL(expected).host) {
    const remote = String(request.socket.remoteAddress || '');
    const localProbe = ['/api/health', '/api/health/live', '/api/health/ready'].includes(
      String(request.url || '').split('?')[0]
    ) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
      && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (localProbe) return;
    throw new DomainError('请求域名不受信任', 400, 'INVALID_HOST');
  }
}

function validateOrigin(request) {
  const method = String(request.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  const expected = trustedOrigin();
  const origin = request.headers.origin;
  if (!expected || !origin) return;
  let actual;
  try {
    const parsed = new URL(String(origin));
    actual = `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new DomainError('请求来源无效', 403, 'INVALID_ORIGIN');
  }
  if (actual !== expected) throw new DomainError('请求来源不受信任', 403, 'INVALID_ORIGIN');
}

function requestIp(request) {
  if (process.env.YSM_TRUST_PROXY === '1') {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 100);
  }
  return String(request.socket.remoteAddress || 'unknown').slice(0, 100);
}

function requireManager(context) {
  if (!context || Number(context.level) < LEVELS.MANAGER) {
    throw new DomainError('当前级别无权执行此操作', 403, 'FORBIDDEN');
  }
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  const notificationRequest = ['/api/notifications/repairs', '/api/notification-device'].includes(pathname);
  const context = contextFrom(request, { notification: notificationRequest, touch: !notificationRequest });
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await parseBody(request) : {};
  let params;

  if (method === 'GET' && ['/api/health', '/api/health/live'].includes(pathname)) {
    return success(response, { status: 'ok', time: new Date().toISOString() });
  }
  if (method === 'GET' && pathname === '/api/health/ready') {
    const database = db.prepare('SELECT 1 AS ok').get();
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (!database?.ok || foreignKeys.length) {
      throw new DomainError('数据库未就绪', 503, 'NOT_READY');
    }
    return success(response, { status: 'ready', database: 'ok', time: new Date().toISOString() });
  }

  if (method === 'POST' && pathname === '/api/session') {
    const user = service.login(body.username, body.password, { source_ip: requestIp(request) });
    const session = createSession(db, user.id);
    return successWithCookie(response, {
      user_id: user.id, username: user.username, display_name: user.display_name,
      level: user.level, level_name: LEVEL_NAMES[user.level],
      must_change_password: Boolean(user.must_change_password),
    }, sessionCookie(session.token, session.max_age_seconds));
  }

  // 登录之后才有其他接口。静态页面仍然公开，因为登录界面本身要能打开。
  if (!context) throw new DomainError('请先登录', 401, 'UNAUTHORIZED');

  if (method === 'DELETE' && pathname === '/api/notification-device') {
    const token = bearerToken(request);
    if (!token || !context.notification_device_id) {
      throw new DomainError('通知设备令牌无效', 401, 'UNAUTHORIZED');
    }
    revokeNotificationDevice(db, token, context.user_id);
    return success(response, { revoked: true });
  }

  if (method === 'DELETE' && pathname === '/api/session') {
    destroySession(db, parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    return successWithCookie(response, { ok: true }, sessionCookie('', 0));
  }
  if (method === 'GET' && pathname === '/api/session/me') return success(response, identity(context));
  if (method === 'POST' && pathname === '/api/session/password') {
    const updated = service.changeOwnPassword(context.user_id, body.old_password, body.new_password);
    const session = createSession(db, updated.id);
    const nextContext = {
      ...context, actor: updated.display_name, username: updated.username,
      must_change_password: Boolean(updated.must_change_password),
    };
    return successWithCookie(response, identity(nextContext), sessionCookie(session.token, session.max_age_seconds));
  }

  // 初始密码或管理员重置的密码用完即废：改密之前不放行任何业务接口。
  if (context.must_change_password) {
    throw new DomainError('首次登录必须先修改密码', 403, 'PASSWORD_CHANGE_REQUIRED');
  }

  if (method === 'POST' && pathname === '/api/notification-device') {
    if (Number(context.level) !== LEVELS.TECHNICIAN) {
      throw new DomainError('只有技术员需要开启待接单通知', 403, 'FORBIDDEN');
    }
    return success(response, createNotificationDevice(db, context.user_id, body.device_label), 201);
  }

  if (method === 'GET' && pathname === '/api/users') {
    return success(response, service.listUsers(context));
  }
  if (method === 'POST' && pathname === '/api/users') {
    return success(response, service.createUser(body, context), 201);
  }
  if (method === 'PUT' && (params = match(pathname, /^\/api\/users\/(\d+)$/))) {
    return success(response, service.updateUser(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/users\/(\d+)\/reset-password$/))) {
    return success(response, service.resetUserPassword(params[0], context));
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return success(response, {
      roles: ROLES,
      levels: LEVELS,
      level_names: LEVEL_NAMES,
      features: {
        repair_module: true,
        structured_inspection: true,
        scheduled_maintenance: true,
        process_qr: true,
        operational_reports: true,
      },
      work_order_statuses: Object.keys(WORK_ORDER_TRANSITIONS),
      // 前端的"下一步"下拉直接用这份，别在浏览器里再抄一遍状态机——抄了就会和后端走散。
      work_order_transitions: Object.fromEntries(
        Object.entries(WORK_ORDER_TRANSITIONS).map(([from, to]) => [from, [...to]])),
      withdrawable_statuses: WITHDRAWABLE_STATUSES,
      // 有序阶段表：界面用它画步骤条，回答"我在第几步、还剩几步"。
      work_order_stages: WORK_ORDER_STAGES,
      // 哪些状态算"技术员已到场"。前端按它决定四个操作区块什么时候解锁。
      post_arrival_statuses: POST_ARRIVAL_STATUSES,
      trial_results: TRIAL_RESULTS,
      review_dimensions: REVIEW_DIMENSIONS,
      change_actions: ['INSTALL', 'MOVE', 'REMOVE', 'REPLACE'],
      // 铭牌界面要照实告诉人"码里烧进去的是这个地址"，没配就挂红色警告。
      // 205 张铭牌印错地址等于全废，这条提示不能藏。
      qr_base_url: qrBaseUrl(request),
      qr_base_url_configured: Boolean(process.env.PUBLIC_BASE_URL),
      legal: {
        company_name: process.env.YSM_COMPANY_NAME || '优胜美',
        contact: process.env.YSM_COMPANY_CONTACT || '',
        privacy_url: process.env.YSM_PRIVACY_URL || '',
        icp_record: process.env.YSM_ICP_RECORD || '',
        public_security_record: process.env.YSM_PUBLIC_SECURITY_RECORD || '',
        app_record: process.env.YSM_APP_RECORD || '',
      },
    });
  }
  if (method === 'GET' && pathname === '/api/dashboard') return success(response, service.dashboard());
  if (method === 'GET' && pathname === '/api/organization') return success(response, service.organization());
  if (method === 'GET' && pathname === '/api/organization/tree') return success(response, service.organizationTree());
  if (method === 'GET' && (params = match(pathname, /^\/api\/structure\/(workshop|line|process|position)\/(\d+)\/delete-preview$/))) {
    return success(response, service.structureDeletionPreview(params[0], params[1]));
  }
  if (method === 'DELETE' && (params = match(pathname, /^\/api\/structure\/(workshop|line|process|position)\/(\d+)$/))) {
    return success(response, service.deleteStructureBranch(params[0], params[1], context));
  }
  if (method === 'GET' && pathname === '/api/equipment-types') return success(response, service.listEquipmentTypes());
  if (method === 'POST' && pathname === '/api/equipment-types') return success(response, service.createEquipmentType(body, context), 201);
  if (method === 'PUT' && (params = match(pathname, /^\/api\/equipment-types\/(\d+)$/))) {
    return success(response, service.updateEquipmentType(params[0], body, context));
  }
  if (method === 'DELETE' && (params = match(pathname, /^\/api\/equipment-types\/(\d+)$/))) {
    return success(response, service.deleteEquipmentType(params[0], context));
  }
  if (method === 'GET' && pathname === '/api/templates') {
    requireManager(context);
    return success(response, [
      { key: 'equipment', filename: '01_设备台账导入模板.xlsx', name: '设备台账导入模板' },
      { key: 'line-composition', filename: '02_产线组合初始化模板.xlsx', name: '产线组合初始化模板' },
    ]);
  }
  if (method === 'GET' && pathname === '/api/templates/equipment/download') {
    requireManager(context);
    return downloadResponse(response, await equipmentTemplateBuffer(), '01_设备台账导入模板.xlsx');
  }
  if (method === 'GET' && pathname === '/api/templates/line-composition/download') {
    requireManager(context);
    return downloadResponse(response, await compositionTemplateBuffer(), '02_产线组合初始化模板.xlsx');
  }
  if (method === 'GET' && pathname === '/api/exports/line-composition.xlsx') {
    requireManager(context);
    return downloadResponse(response, await compositionExportBuffer(service.compositionExportRows()), '当前产线组合.xlsx');
  }
  if (method === 'POST' && pathname === '/api/workshops') return success(response, service.createWorkshop(body, context), 201);
  if (method === 'POST' && pathname === '/api/lines') return success(response, service.createLine(body, context), 201);
  if (method === 'POST' && pathname === '/api/processes') return success(response, service.createProcess(body, context), 201);
  if (method === 'POST' && pathname === '/api/positions') return success(response, service.createPosition(body, context), 201);
  if (method === 'PUT' && (params = match(pathname, /^\/api\/workshops\/(\d+)$/))) return success(response, service.updateWorkshop(params[0], body, context));
  if (method === 'PUT' && (params = match(pathname, /^\/api\/lines\/(\d+)$/))) return success(response, service.updateLine(params[0], body, context));
  if (method === 'PUT' && (params = match(pathname, /^\/api\/processes\/(\d+)$/))) return success(response, service.updateProcess(params[0], body, context));
  if (method === 'PUT' && (params = match(pathname, /^\/api\/positions\/(\d+)$/))) return success(response, service.updatePosition(params[0], body, context));
  if (method === 'PATCH' && (params = match(pathname, /^\/api\/structure\/(workshop|line|process|position)\/(\d+)\/status$/))) {
    return success(response, service.updateStructureStatus(params[0], params[1], body, context));
  }

  if (method === 'GET' && pathname === '/api/equipment') {
    return success(response, service.listEquipment(url.searchParams.get('search') || '', context));
  }
  if (method === 'POST' && pathname === '/api/equipment') return success(response, service.createEquipment(body, context), 201);
  if (method === 'POST' && pathname === '/api/equipment/import') {
    return success(response, service.importEquipment(body.rows, context), 201);
  }
  if (method === 'POST' && pathname === '/api/imports/equipment') {
    return success(response, service.importEquipment([], context), 410);
  }
  if (method === 'POST' && pathname === '/api/imports/equipment/preview') {
    requireManager(context);
    const rows = await parseEquipmentWorkbook(workbookBuffer(body));
    return success(response, service.previewEquipmentImport(rows));
  }
  if (method === 'POST' && pathname === '/api/imports/equipment/commit') {
    const buffer = workbookBuffer(body);
    const rows = await parseEquipmentWorkbook(buffer);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    return success(response, service.commitEquipmentImport(rows, { filename: body.filename, file_hash: fileHash }, context), 201);
  }
  if (method === 'PUT' && (params = match(pathname, /^\/api\/equipment\/(\d+)$/))) {
    return success(response, service.updateEquipment(params[0], body, context));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/equipment\/(\d+)\/history$/))) {
    // 履历含维修详情和审计记录，普工不开放；技术员查维修史是刚需。
    if (context.level < LEVELS.TECHNICIAN) throw new DomainError('当前级别无权查看设备履历', 403, 'FORBIDDEN');
    return success(response, service.equipmentHistory(params[0]));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/equipment\/(\d+)$/))) {
    return success(response, service.getEquipment(params[0], context));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/qr\/([A-Za-z0-9_-]+)\/image\.svg$/))) {
    service.resolveQr(params[0]);
    const svg = await QRCode.toString(`${qrBaseUrl(request)}/?scan=${encodeURIComponent(params[0])}`, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 256,
    });
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
    });
    return response.end(svg);
  }
  if (method === 'GET' && pathname === '/api/qr/process-labels') {
    return success(response, service.processQrLabels(url.searchParams.get('line_id'), context));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/qr\/([A-Za-z0-9_-]+)$/))) {
    return success(response, service.recordQrScan(params[0], context, {
      source_ip: requestIp(request),
      user_agent: request.headers['user-agent'],
    }));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/lines\/(\d+)\/composition$/))) {
    return success(response, service.lineComposition(params[0], url.searchParams.get('at')));
  }
  if (method === 'POST' && pathname === '/api/imports/line-composition/preview') {
    requireManager(context);
    const rows = await parseCompositionWorkbook(workbookBuffer(body));
    return success(response, service.previewCompositionImport(rows));
  }
  if (method === 'POST' && pathname === '/api/imports/line-composition/commit') {
    const buffer = workbookBuffer(body);
    const rows = await parseCompositionWorkbook(buffer);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    return success(response, service.commitCompositionImport(rows, { filename: body.filename, file_hash: fileHash }, context), 201);
  }

  if (method === 'GET' && pathname === '/api/composition-changes') {
    requireManager(context);
    return success(response, service.listCompositionChanges());
  }
  if (method === 'POST' && pathname === '/api/composition-changes') {
    return success(response, service.createCompositionChange(body, context), 201);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/composition-changes\/(\d+)\/review$/))) {
    return success(response, service.reviewCompositionChange(params[0], body, context));
  }

  if (method === 'GET' && pathname === '/api/fault-codes') {
    if (url.searchParams.get('all') === '1') requireManager(context);
    // 管理页要看到停用的，报修表单只要启用的。
    return success(response, service.listFaultCodes({ includeDisabled: url.searchParams.get('all') === '1' }));
  }
  // 报修界面的"常用故障"快捷按钮。设备不传也能用，只是排不出针对性。
  if (method === 'GET' && pathname === '/api/fault-codes/frequent') {
    return success(response, service.frequentFaultCodes(url.searchParams.get('equipment_id') || null));
  }
  if (method === 'POST' && pathname === '/api/fault-codes') return success(response, service.createFaultCode(body, context), 201);
  if (method === 'PUT' && (params = match(pathname, /^\/api\/fault-codes\/(\d+)$/))) {
    return success(response, service.updateFaultCode(params[0], body, context));
  }
  if (method === 'DELETE' && (params = match(pathname, /^\/api\/fault-codes\/(\d+)$/))) {
    return success(response, service.deleteFaultCode(params[0], context));
  }

  if (method === 'GET' && (params = match(pathname, /^\/api\/attachments\/(\d+)\/file$/))) {
    const file = service.attachmentFile(params[0], context);
    response.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': file.size,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    return fs.createReadStream(file.absolute).pipe(response);
  }
  if (method === 'DELETE' && (params = match(pathname, /^\/api\/attachments\/(\d+)$/))) {
    return success(response, service.deleteAttachment(params[0], context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/attachments$/))) {
    return success(response, service.addWorkOrderAttachments(params[0], body, context), 201);
  }

  // 技术员只能看自己的综合分，服务端只认会话里的 user_id。放在 /api/reviews 之前匹配。
  if (method === 'GET' && pathname === '/api/reviews/me') {
    if (context.level < LEVELS.TECHNICIAN) throw new DomainError('当前级别没有服务评分', 403, 'FORBIDDEN');
    return success(response, service.myReviewSummary(context));
  }
  if (method === 'GET' && pathname === '/api/reviews/technicians') return success(response, service.technicianRanking(context));
  if (method === 'GET' && pathname === '/api/reviews') return success(response, service.listReviews(context));

  if (method === 'GET' && pathname === '/api/patrols') return success(response, service.listPatrolRecords(context));
  if (method === 'POST' && pathname === '/api/patrols') {
    const created = service.executeIdempotent(context, 'CREATE_PATROL',
      request.headers['idempotency-key'], body, () => service.createPatrolRecord(body, context));
    return success(response, created, 201);
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/patrols\/(\d+)$/))) {
    return success(response, service.getPatrolRecord(params[0], context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/patrols\/(\d+)\/to-work-order$/))) {
    return success(response, service.convertPatrolToWorkOrder(params[0], body, context), 201);
  }

  if (method === 'GET' && (params = match(pathname, /^\/api\/task-templates\/(inspection|maintenance)$/))) {
    return success(response, service.listTaskTemplates(params[0].toUpperCase(), context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/task-templates\/(inspection|maintenance)$/))) {
    return success(response,
      service.createTaskTemplate(params[0].toUpperCase(), body, context), 201);
  }
  if (method === 'PATCH' && (params = match(pathname, /^\/api\/task-templates\/(\d+)\/status$/))) {
    return success(response, service.updateTaskTemplateStatus(params[0], body, context));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/task-plans\/(inspection|maintenance)$/))) {
    return success(response, service.listTaskPlans(params[0].toUpperCase(), context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/task-plans\/(inspection|maintenance)$/))) {
    return success(response,
      service.createTaskPlan(params[0].toUpperCase(), body, context), 201);
  }
  if (method === 'PATCH' && (params = match(pathname, /^\/api\/task-plans\/(\d+)\/status$/))) {
    return success(response, service.updateTaskPlanStatus(params[0], body, context));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/tasks\/(inspection|maintenance)$/))) {
    return success(response, service.listScheduledTasks(params[0].toUpperCase(), context, {
      status: url.searchParams.get('status'),
    }));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/tasks\/(inspection|maintenance)$/))) {
    return success(response,
      service.createManualTask(params[0].toUpperCase(), body, context), 201);
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/tasks\/(\d+)$/))) {
    return success(response, service.getScheduledTask(params[0], context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/tasks\/(\d+)\/execute$/))) {
    const executed = service.executeIdempotent(context, `EXECUTE_TASK:${params[0]}`,
      request.headers['idempotency-key'], body,
      () => service.executeScheduledTask(params[0], body, context));
    return success(response, executed);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/tasks\/(\d+)\/to-work-order$/))) {
    const converted = service.executeIdempotent(context, `CONVERT_TASK:${params[0]}`,
      request.headers['idempotency-key'], body,
      () => service.convertTaskAbnormalToWorkOrder(params[0], body, context));
    return success(response, converted, 201);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/tasks\/(\d+)\/close-abnormal$/))) {
    return success(response, service.closeTaskAbnormal(params[0], body, context));
  }

  if (method === 'GET' && pathname === '/api/reports/operations') {
    return success(response, service.operationalReport({
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
    }, context));
  }
  if (method === 'GET' && pathname === '/api/reports/operations/work-orders') {
    return success(response, service.operationalReportWorkOrders({
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
      kind: url.searchParams.get('kind'),
      line_id: url.searchParams.get('line_id'),
      category_key: url.searchParams.get('category_key'),
      equipment_id: url.searchParams.get('equipment_id'),
    }, context));
  }
  if (method === 'GET' && pathname === '/api/reports/operations.xlsx') {
    const report = service.operationalReport({
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
    }, context);
    return downloadResponse(response, await operationalReportBuffer(report),
      `设备运营报表_${report.range.start.slice(0, 10)}_${report.range.end.slice(0, 10)}.xlsx`);
  }

  if (method === 'GET' && pathname === '/api/notifications/repairs') {
    return success(response, service.pendingRepairNotifications(context));
  }
  if (method === 'GET' && pathname === '/api/work-orders') return success(response, service.listWorkOrders(context));
  if (method === 'POST' && pathname === '/api/work-orders') {
    const created = service.executeIdempotent(context, 'CREATE_WORK_ORDER',
      request.headers['idempotency-key'], body, () => service.createWorkOrder(body, context));
    return success(response, created, 201);
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/work-orders\/(\d+)$/))) {
    return success(response, service.getWorkOrder(params[0], context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/assign$/))) {
    return success(response, service.assignWorkOrder(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/transition$/))) {
    return success(response, service.transitionWorkOrder(params[0], body, context));
  }
  if (method === 'PUT' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/repair-detail$/))) {
    return success(response, service.updateRepairDetail(params[0], body, context));
  }
  if (method === 'PUT' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/trial-result$/))) {
    return success(response, service.updateTrialResult(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/correct-equipment$/))) {
    return success(response, service.correctWorkOrderEquipment(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/fault-code$/))) {
    return success(response, service.classifyWorkOrder(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/withdraw$/))) {
    return success(response, service.withdrawWorkOrder(params[0], body, context));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/review$/))) {
    return success(response, service.reviewWorkOrder(params[0], body, context), 201);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/reopen$/))) {
    return success(response, service.reopenWorkOrder(params[0], body, context), 201);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/work-orders\/(\d+)\/parts$/))) {
    const created = service.executeIdempotent(context, `ADD_WORK_ORDER_PART:${params[0]}`,
      request.headers['idempotency-key'], body,
      () => service.addWorkOrderPart(params[0], body, context));
    return success(response, created, 201);
  }

  if (method === 'GET' && pathname === '/api/audit-logs') {
    return success(response, service.auditLogs(url.searchParams.get('limit'), context));
  }
  throw new DomainError('接口不存在', 404, 'NOT_FOUND');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

function serveStatic(request, response, url) {
  let requested;
  try { requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch {
    response.writeHead(400, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('文件地址编码无效');
  }
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, normalized);
  const relative = path.relative(WEB_ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)
      || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { ...securityHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('页面不存在');
  }
  const extension = path.extname(filePath);
  response.writeHead(200, {
    ...securityHeaders({ html: extension === '.html' }),
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    // 每次都回源校验，避免升级后浏览器还在跑旧的页面脚本。
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(response);
}

function createApplication(options = {}) {
  PORT = Number(options.port ?? process.env.PORT ?? 8787);
  HOST = options.host ?? process.env.HOST ?? '127.0.0.1';
  db = options.db || openDatabase(options.dbPath);
  service = options.service || new EquipmentService(db, options.serviceOptions);

  const server = http.createServer(async (request, response) => {
    try {
      validateHost(request);
      validateOrigin(request);
      // URL解析使用固定、可信的基址，绝不再把未经校验的Host拼进去。
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else serveStatic(request, response, url);
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 500;
      const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      if (!(error instanceof DomainError)) console.error(error);
      if (['INVALID_HOST', 'INVALID_ORIGIN'].includes(code)) {
        try {
          service.audit('security', 0, code, `来源:${requestIp(request)}`, null, {
            method: request.method,
            path: String(request.url || '').slice(0, 500),
            source_ip: requestIp(request),
          });
        } catch { /* 安全日志不能反过来影响错误响应 */ }
      }
      if (!response.writableEnded && !response.destroyed) {
        jsonResponse(response, status, {
          ok: false,
          error: { code, message: status === 500 ? '服务器内部错误' : error.message },
        });
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end([
        'HTTP/1.1 400 Bad Request',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Length: 11',
        '',
        'Bad Request',
      ].join('\r\n'));
    }
  });

  return {
    db,
    service,
    server,
    host: HOST,
    port: PORT,
    listen(callback) {
      return server.listen(PORT, HOST, callback);
    },
    close(callback) {
      server.close(() => {
        db.close();
        callback?.();
      });
    },
  };
}

if (require.main === module) {
  const application = createApplication();
  application.listen(() => {
    console.log(`优胜美设备系统已启动：http://${HOST}:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(1), 25_000);
    forceTimer.unref();
    application.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createApplication,
  securityHeaders,
  validateHost,
  validateOrigin,
};
