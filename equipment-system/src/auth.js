'use strict';

const crypto = require('node:crypto');

const SCRYPT_KEY_LENGTH = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const NOTIFICATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'ysm_session';

const LEVELS = Object.freeze({ WORKER: 1, TECHNICIAN: 2, MANAGER: 3 });

const LEVEL_NAMES = Object.freeze({ 1: '普工', 2: '技术员', 3: '管理员' });

// 三级成员映射到服务层沿用的内部权限令牌。管理员映射到ADMIN，
// 因此现有全部assertRole检查无需改写即可通过。
const LEVEL_ROLES = Object.freeze({ 1: 'EMPLOYEE', 2: 'TECHNICIAN', 3: 'ADMIN' });

function normalizeLevel(value) {
  const level = Number(value);
  if (!Object.values(LEVELS).includes(level)) return null;
  return level;
}

function levelName(level) {
  return LEVEL_NAMES[Number(level)] || '未知级别';
}

function levelToRole(level) {
  return LEVEL_ROLES[Number(level)] || null;
}

function hashPassword(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEY_LENGTH).toString('hex');
  return { hash, salt };
}

function verifyPassword(plain, hash, salt) {
  if (typeof hash !== 'string' || typeof salt !== 'string' || !hash || !salt) return false;
  let expected;
  try { expected = Buffer.from(hash, 'hex'); } catch { return false; }
  const actual = crypto.scryptSync(String(plain ?? ''), salt, SCRYPT_KEY_LENGTH);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function sessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function createSession(db, userId, ttlMs = SESSION_TTL_MS) {
  const now = new Date();
  const token = sessionToken();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(`
    INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, Number(userId), now.toISOString(), expiresAt, now.toISOString(), expiresAt);
  return { token, expires_at: expiresAt, max_age_seconds: Math.max(0, Math.floor(ttlMs / 1000)) };
}

// 返回会话对应的启用用户。会话有绝对12小时上限；last_seen最多每5分钟落库一次，
// 避免页面并发请求和安卓通知轮询把SQLite变成持续写热点。
function resolveSession(db, token, options = {}) {
  if (typeof token !== 'string' || !token) return null;
  const normalized = typeof options === 'number' ? { ttlMs: options } : options;
  const ttlMs = normalized.ttlMs ?? SESSION_TTL_MS;
  const touch = normalized.touch !== false;
  const now = new Date();
  const nowIso = now.toISOString();
  db.prepare(`
    DELETE FROM sessions
    WHERE expires_at <= ? OR COALESCE(absolute_expires_at, expires_at) <= ?
  `).run(nowIso, nowIso);
  const row = db.prepare(`
    SELECT s.token, s.expires_at, s.absolute_expires_at, s.last_seen_at,
           u.id, u.username, u.display_name, u.level, u.status, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
      AND COALESCE(s.absolute_expires_at, s.expires_at) > ?
  `).get(token, nowIso, nowIso);
  if (!row) return null;
  if (row.status !== 'ACTIVE') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (touch && now.getTime() - lastSeen >= SESSION_TOUCH_INTERVAL_MS) {
    const absoluteMs = new Date(row.absolute_expires_at || row.expires_at).getTime();
    const renewed = new Date(Math.min(now.getTime() + ttlMs, absoluteMs)).toISOString();
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?')
      .run(nowIso, renewed, token);
  }
  return {
    token: row.token,
    user_id: row.id,
    username: row.username,
    display_name: row.display_name,
    level: Number(row.level),
    role: levelToRole(row.level),
    must_change_password: Number(row.must_change_password) === 1,
  };
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
  db.prepare(`
    UPDATE notification_devices SET revoked_at = COALESCE(revoked_at, ?)
    WHERE user_id = ?
  `).run(new Date().toISOString(), Number(userId));
}

function notificationTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createNotificationDevice(db, userId, deviceLabel, ttlMs = NOTIFICATION_TOKEN_TTL_MS) {
  const token = sessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const label = String(deviceLabel || '').trim().slice(0, 100) || null;
  if (label) {
    db.prepare(`
      UPDATE notification_devices SET revoked_at=COALESCE(revoked_at, ?)
      WHERE user_id=? AND device_label=? AND revoked_at IS NULL
    `).run(now.toISOString(), Number(userId), label);
  }
  const result = db.prepare(`
    INSERT INTO notification_devices(
      token_hash, user_id, device_label, created_at, expires_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(notificationTokenHash(token), Number(userId), label,
    now.toISOString(), expiresAt, now.toISOString());
  return { id: Number(result.lastInsertRowid), token, expires_at: expiresAt };
}

function resolveNotificationDevice(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const nowIso = new Date().toISOString();
  const row = db.prepare(`
    SELECT d.id AS device_id, d.user_id, d.last_seen_at, u.username, u.display_name,
           u.level, u.status, u.must_change_password
    FROM notification_devices d
    JOIN users u ON u.id = d.user_id
    WHERE d.token_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ?
  `).get(notificationTokenHash(token), nowIso);
  if (!row || row.status !== 'ACTIVE' || Number(row.must_change_password) === 1) return null;
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (Date.now() - lastSeen >= SESSION_TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE notification_devices SET last_seen_at=? WHERE id=?').run(nowIso, row.device_id);
  }
  return {
    device_id: Number(row.device_id),
    user_id: Number(row.user_id),
    username: row.username,
    display_name: row.display_name,
    level: Number(row.level),
    role: levelToRole(row.level),
  };
}

function revokeNotificationDevice(db, token, userId = null) {
  if (!token) return;
  const params = [new Date().toISOString(), notificationTokenHash(token)];
  let where = 'token_hash=?';
  if (userId) {
    where += ' AND user_id=?';
    params.push(Number(userId));
  }
  db.prepare(`UPDATE notification_devices SET revoked_at=COALESCE(revoked_at, ?) WHERE ${where}`).run(...params);
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { result[key] = part.slice(index + 1).trim(); }
  }
  return result;
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  NOTIFICATION_TOKEN_TTL_MS,
  createNotificationDevice,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  levelName,
  levelToRole,
  normalizeLevel,
  parseCookies,
  resolveNotificationDevice,
  resolveSession,
  revokeNotificationDevice,
  verifyPassword,
};
