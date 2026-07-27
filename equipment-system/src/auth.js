'use strict';

const crypto = require('node:crypto');

const SCRYPT_KEY_LENGTH = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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
  db.prepare(`
    INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, Number(userId), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), now.toISOString());
  return { token, expires_at: new Date(now.getTime() + ttlMs).toISOString(), max_age_seconds: Math.floor(ttlMs / 1000) };
}

// 返回会话对应的启用用户，同时顺延有效期（滑动续期）。过期或账号停用一律返回null。
function resolveSession(db, token, ttlMs = SESSION_TTL_MS) {
  if (typeof token !== 'string' || !token) return null;
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
  const row = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.level, u.status, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, nowIso);
  if (!row) return null;
  if (row.status !== 'ACTIVE') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const renewed = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?').run(nowIso, renewed, token);
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
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  levelName,
  levelToRole,
  normalizeLevel,
  parseCookies,
  resolveSession,
  verifyPassword,
};
