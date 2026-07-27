'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const QRCode = require('qrcode');
const { openDatabase } = require('./db');
const { DomainError, POST_ARRIVAL_STATUSES, REVIEW_DIMENSIONS, WITHDRAWABLE_STATUSES,
  WORK_ORDER_STAGES, WORK_ORDER_TRANSITIONS } = require('./domain');
const { EquipmentService, ROLES } = require('./service');
const {
  LEVELS,
  LEVEL_NAMES,
  SESSION_COOKIE,
  createSession,
  destroySession,
  parseCookies,
  resolveSession,
} = require('./auth');
const {
  compositionExportBuffer,
  compositionTemplateBuffer,
  equipmentTemplateBuffer,
  parseCompositionWorkbook,
  parseEquipmentWorkbook,
} = require('./spreadsheets');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = path.join(__dirname, '..', 'web');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const db = openDatabase();
const service = new EquipmentService(db);

// 身份只从会话Cookie解析。不再信任任何请求头，页面上也不再有角色下拉框，
// 否则三级权限和审计日志的"操作人"都可以被随手伪造。
function contextFrom(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = resolveSession(db, token);
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

function sessionCookie(token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (process.env.YSM_SECURE_COOKIE === '1') parts.push('Secure');
  return parts.join('; ');
}

function successWithCookie(response, data, cookie, status = 200) {
  const body = JSON.stringify({ ok: true, data });
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function success(response, data, status = 200) {
  jsonResponse(response, status, { ok: true, data });
}

function downloadResponse(response, buffer, filename) {
  response.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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
        reject(new DomainError('请求内容超过12MB限制', 413, 'PAYLOAD_TOO_LARGE'));
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
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || `${HOST}:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  const context = contextFrom(request);
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await parseBody(request) : {};
  let params;

  if (method === 'GET' && pathname === '/api/health') return success(response, { status: 'ok', time: new Date().toISOString() });

  if (method === 'POST' && pathname === '/api/session') {
    const user = service.login(body.username, body.password);
    const session = createSession(db, user.id);
    return successWithCookie(response, {
      user_id: user.id, username: user.username, display_name: user.display_name,
      level: user.level, level_name: LEVEL_NAMES[user.level],
      must_change_password: Boolean(user.must_change_password),
    }, sessionCookie(session.token, session.max_age_seconds));
  }

  // 登录之后才有其他接口。静态页面仍然公开，因为登录界面本身要能打开。
  if (!context) throw new DomainError('请先登录', 401, 'UNAUTHORIZED');

  if (method === 'DELETE' && pathname === '/api/session') {
    destroySession(db, parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    return successWithCookie(response, { ok: true }, sessionCookie('', 0));
  }
  if (method === 'GET' && pathname === '/api/session/me') return success(response, identity(context));
  if (method === 'POST' && pathname === '/api/session/password') {
    const updated = service.changeOwnPassword(context.user_id, body.old_password, body.new_password);
    return success(response, { ...identity(context), must_change_password: Boolean(updated.must_change_password) });
  }

  // 初始密码或管理员重置的密码用完即废：改密之前不放行任何业务接口。
  if (context.must_change_password) {
    throw new DomainError('首次登录必须先修改密码', 403, 'PASSWORD_CHANGE_REQUIRED');
  }

  if (method === 'GET' && pathname === '/api/users') {
    return success(response, service.listUsers());
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
      features: { repair_module: true },
      work_order_statuses: Object.keys(WORK_ORDER_TRANSITIONS),
      // 前端的"下一步"下拉直接用这份，别在浏览器里再抄一遍状态机——抄了就会和后端走散。
      work_order_transitions: Object.fromEntries(
        Object.entries(WORK_ORDER_TRANSITIONS).map(([from, to]) => [from, [...to]])),
      withdrawable_statuses: WITHDRAWABLE_STATUSES,
      // 有序阶段表：界面用它画步骤条，回答"我在第几步、还剩几步"。
      work_order_stages: WORK_ORDER_STAGES,
      // 哪些状态算"技术员已到场"。前端按它决定四个操作区块什么时候解锁。
      post_arrival_statuses: POST_ARRIVAL_STATUSES,
      review_dimensions: REVIEW_DIMENSIONS,
      change_actions: ['INSTALL', 'MOVE', 'REMOVE', 'REPLACE'],
      // 铭牌界面要照实告诉人"码里烧进去的是这个地址"，没配就挂红色警告。
      // 205 张铭牌印错地址等于全废，这条提示不能藏。
      qr_base_url: qrBaseUrl(request),
      qr_base_url_configured: Boolean(process.env.PUBLIC_BASE_URL),
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
    return success(response, [
      { key: 'equipment', filename: '01_设备台账导入模板.xlsx', name: '设备台账导入模板' },
      { key: 'line-composition', filename: '02_产线组合初始化模板.xlsx', name: '产线组合初始化模板' },
    ]);
  }
  if (method === 'GET' && pathname === '/api/templates/equipment/download') {
    return downloadResponse(response, await equipmentTemplateBuffer(), '01_设备台账导入模板.xlsx');
  }
  if (method === 'GET' && pathname === '/api/templates/line-composition/download') {
    return downloadResponse(response, await compositionTemplateBuffer(), '02_产线组合初始化模板.xlsx');
  }
  if (method === 'GET' && pathname === '/api/exports/line-composition.xlsx') {
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

  if (method === 'GET' && pathname === '/api/equipment') {
    return success(response, service.listEquipment(url.searchParams.get('search') || ''));
  }
  if (method === 'POST' && pathname === '/api/equipment') return success(response, service.createEquipment(body, context), 201);
  if (method === 'POST' && pathname === '/api/equipment/import') {
    return success(response, service.importEquipment(body.rows, context), 201);
  }
  if (method === 'POST' && pathname === '/api/imports/equipment') {
    return success(response, service.importEquipment([], context), 410);
  }
  if (method === 'POST' && pathname === '/api/imports/equipment/preview') {
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
    return success(response, service.getEquipment(params[0]));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/qr\/([A-Za-z0-9_-]+)\/image\.svg$/))) {
    service.resolveQr(params[0]);
    const svg = await QRCode.toString(`${qrBaseUrl(request)}/?scan=${encodeURIComponent(params[0])}`, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 256,
    });
    response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
    return response.end(svg);
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/qr\/([A-Za-z0-9_-]+)$/))) {
    return success(response, service.resolveQr(params[0]));
  }
  if (method === 'GET' && (params = match(pathname, /^\/api\/lines\/(\d+)\/composition$/))) {
    return success(response, service.lineComposition(params[0], url.searchParams.get('at')));
  }
  if (method === 'POST' && pathname === '/api/imports/line-composition/preview') {
    const rows = await parseCompositionWorkbook(workbookBuffer(body));
    return success(response, service.previewCompositionImport(rows));
  }
  if (method === 'POST' && pathname === '/api/imports/line-composition/commit') {
    const buffer = workbookBuffer(body);
    const rows = await parseCompositionWorkbook(buffer);
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    return success(response, service.commitCompositionImport(rows, { filename: body.filename, file_hash: fileHash }, context), 201);
  }

  if (method === 'GET' && pathname === '/api/composition-changes') return success(response, service.listCompositionChanges());
  if (method === 'POST' && pathname === '/api/composition-changes') {
    return success(response, service.createCompositionChange(body, context), 201);
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/composition-changes\/(\d+)\/review$/))) {
    return success(response, service.reviewCompositionChange(params[0], body, context));
  }

  if (method === 'GET' && pathname === '/api/fault-codes') {
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
  if (method === 'POST' && pathname === '/api/patrols') return success(response, service.createPatrolRecord(body, context), 201);
  if (method === 'GET' && (params = match(pathname, /^\/api\/patrols\/(\d+)$/))) {
    return success(response, service.getPatrolRecord(params[0]));
  }
  if (method === 'POST' && (params = match(pathname, /^\/api\/patrols\/(\d+)\/to-work-order$/))) {
    return success(response, service.convertPatrolToWorkOrder(params[0], body, context), 201);
  }

  if (method === 'GET' && pathname === '/api/notifications/repairs') {
    return success(response, service.pendingRepairNotifications(context));
  }
  if (method === 'GET' && pathname === '/api/work-orders') return success(response, service.listWorkOrders(context));
  if (method === 'POST' && pathname === '/api/work-orders') return success(response, service.createWorkOrder(body, context), 201);
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
    return success(response, service.addWorkOrderPart(params[0], body, context), 201);
  }

  if (method === 'GET' && pathname === '/api/audit-logs') {
    return success(response, service.auditLogs(url.searchParams.get('limit')));
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
  catch { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return response.end('文件地址编码无效'); }
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, normalized);
  if (!filePath.startsWith(WEB_ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('页面不存在');
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    // 每次都回源校验，避免升级后浏览器还在跑旧的页面脚本。
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else serveStatic(request, response, url);
  } catch (error) {
    const status = error instanceof DomainError ? error.status : 500;
    const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof DomainError)) console.error(error);
    jsonResponse(response, status, { ok: false, error: { code, message: status === 500 ? '服务器内部错误' : error.message } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`优胜美设备系统已启动：http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
