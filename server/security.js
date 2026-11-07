/* ==========================================================================
   Security: password hashing, sessions, CSRF, rate limiting, TOTP 2FA,
   one-time email codes, audit log
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, now } = require('./db');
const { fail, parseCookies, clientIp } = require('./http');

const SESSION_COOKIE = 'nx_sid';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

/* ---------- passwords (scrypt) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !pw) return false;
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(h, 'base64');
  return ref.length === hash.length && crypto.timingSafeEqual(ref, hash);
}
function passwordProblems(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password is too long';
  if (!/[a-z]/.test(pw) || !/[A-Z0-9]/.test(pw)) return 'Use a mix of letters and numbers or capitals';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');

/* ---------- sessions ---------- */
function createSession(res, req, userId, pending2fa = false, opts = {}) {
  const t = token();
  const ts = now();
  const ttl = opts.ttlMs || SESSION_TTL;
  q.run('INSERT INTO sessions(user_id, token_hash, pending_2fa, user_agent, ip, created_at, last_seen_at, expires_at, impersonator_id) VALUES(?,?,?,?,?,?,?,?,?)',
    userId, sha256(t), pending2fa ? 1 : 0, String(req.headers['user-agent'] || '').slice(0, 200), clientIp(req), ts, ts, ts + ttl, opts.impersonatorId || null);
  setCookie(res, req, t, ttl / 1000);
  return t;
}
function setCookie(res, req, value, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  const prev = res.getHeader('Set-Cookie');
  const c = `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
function clearSession(req, res) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(t));
  setCookie(res, req, '', 0);
}
/** Resolve session + user. Returns null if absent/expired. */
function loadSession(req) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (!t) return null;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(t));
  if (!s || s.expires_at < now()) return null;
  const user = q.get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!user) return null;
  if (now() - s.last_seen_at > 60000) q.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now(), s.id);
  return { session: s, user };
}

/* ---------- guards (used by routes) ---------- */
function requireUser(ctx) {
  const s = ctx.auth;
  if (!s || s.session.pending_2fa) fail(401, 'Please sign in');
  if (s.user.status !== 'active') fail(403, 'Your account is suspended. Contact support.');
  if (s.user.email && !s.user.email_verified && !s.user.wallet_login) fail(403, 'Please verify your email first', { code: 'EMAIL_UNVERIFIED' });
  return s.user;
}
/* ---------- staff roles & permissions ----------
   loan_officer  → reviews applications and recommends; cannot approve money movement
   admin         → operations: approve/disburse loans, payouts, collections, invites, bots, status
   super_admin   → everything incl. settings, roles, balance adjustments, products, kill switch */
const STAFF_ROLES = ['loan_officer', 'admin', 'super_admin'];
const PERMS = {
  'admin.view': ['loan_officer', 'admin', 'super_admin'],
  'loans.review': ['loan_officer', 'admin', 'super_admin'],
  'loans.decide': ['admin', 'super_admin'],
  'loans.disburse': ['admin', 'super_admin'],
  'loans.collect': ['admin', 'super_admin'],
  'payouts.manage': ['admin', 'super_admin'],
  'actions.approve': ['admin', 'super_admin'],
  'users.view': ['loan_officer', 'admin', 'super_admin'],
  'users.manage': ['admin', 'super_admin'],
  'users.roles': ['super_admin'],
  'users.impersonate': ['super_admin'],
  'ledger.adjust': ['super_admin'],
  'invites.manage': ['admin', 'super_admin'],
  'bots.manage': ['admin', 'super_admin'],
  'platform.ops': ['admin', 'super_admin'],
  'platform.settings': ['super_admin'],
  'products.manage': ['super_admin'],
  'killswitch': ['super_admin']
};
const isStaff = (u) => STAFF_ROLES.includes(u.role);
const can = (u, perm) => !!(PERMS[perm] && PERMS[perm].includes(u.role));
function requirePerm(ctx, perm) {
  const u = requireUser(ctx);
  if (!isStaff(u)) fail(403, 'Admin access required');
  // optional platform policy: staff must use an authenticator app
  const { getSettings } = require('./db');
  if (getSettings().admin_2fa_required && !u.totp_enabled) fail(403, 'Set up two-factor authentication to use the admin console', { code: 'ADMIN_2FA_REQUIRED' });
  if (!can(u, perm)) fail(403, `Your role (${u.role.replace('_', ' ')}) can’t do this`);
  return u;
}
const requireAdmin = (ctx) => requirePerm(ctx, 'admin.view');
/** CSRF: mutating requests must carry a custom header (cannot be set cross-site without CORS preflight) */
function checkCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-nectra'] !== '1') fail(403, 'Missing CSRF header');
}

/* ---------- rate limiting (in-memory, per IP + bucket) ---------- */
const buckets = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  if (++b.n > max) fail(429, 'Too many attempts. Please wait a minute and try again.');
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

/* ---------- TOTP (RFC 6238) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code))) return false;
  const c = Math.floor(now() / 30000);
  for (let w = -1; w <= 1; w++) if (crypto.timingSafeEqual(Buffer.from(hotp(secret, c + w)), Buffer.from(String(code)))) return true;
  return false;
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));

/* ---------- one-time codes (email verification, withdrawals, reset) ---------- */
function issueCode({ userId, email, purpose, ref, ttlMin = 10 }) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  q.run('UPDATE codes SET used = 1 WHERE used = 0 AND purpose = ? AND (user_id = ? OR email = ?)', purpose, userId || null, email || null);
  q.run('INSERT INTO codes(user_id, email, purpose, code_hash, ref, created_at, expires_at) VALUES(?,?,?,?,?,?,?)', userId || null, email || null, purpose, sha256(code), ref == null ? null : String(ref), now(), now() + ttlMin * 60000);
  return code;
}
function consumeCode({ userId, email, purpose, code, ref }) {
  const row = q.get('SELECT * FROM codes WHERE used = 0 AND purpose = ? AND (user_id = ? OR email = ?) ORDER BY id DESC LIMIT 1', purpose, userId || null, email || null);
  if (!row || row.expires_at < now()) fail(400, 'Code expired — request a new one');
  if (row.attempts >= 5) fail(429, 'Too many wrong attempts — request a new code');
  if (ref && String(row.ref) !== String(ref)) fail(400, 'Code does not match this request');
  if (row.code_hash !== sha256(String(code || ''))) { q.run('UPDATE codes SET attempts = attempts + 1 WHERE id = ?', row.id); fail(400, 'Incorrect code'); }
  q.run('UPDATE codes SET used = 1 WHERE id = ?', row.id);
  return row;
}

/* ---------- idempotency ----------
   Money-moving routes run through idempotent(): when the client sends an Idempotency-Key header,
   the first response is stored and replayed for any retry with the same key (same user + route),
   and a concurrent duplicate gets 409 instead of executing twice. Keys expire after 24h. */
const IDEM_TTL = 24 * 3600 * 1000;
async function idempotent(c, userId, fn) {
  const key = String(c.req.headers['idempotency-key'] || '').slice(0, 100);
  if (!key) return fn();
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) fail(400, 'Invalid Idempotency-Key');
  const route = (c.req.method || 'POST') + ' ' + String(c.req.url || '').split('?')[0];
  q.run('DELETE FROM idempotency_keys WHERE created_at < ?', now() - IDEM_TTL);
  const prev = q.get('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?', userId, key);
  if (prev) {
    if (prev.route !== route) fail(422, 'Idempotency-Key was already used for a different request');
    if (prev.status === 'done') return { ...JSON.parse(prev.response), idempotentReplay: true };
    fail(409, 'This request is already being processed');
  }
  q.run("INSERT INTO idempotency_keys(user_id, key, route, status, created_at) VALUES(?,?,?,'running',?)", userId, key, route, now());
  try {
    const res = await fn();
    q.run("UPDATE idempotency_keys SET status = 'done', response = ? WHERE user_id = ? AND key = ?", JSON.stringify(res === undefined ? {} : res), userId, key);
    return res;
  } catch (e) {
    q.run('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?', userId, key); // failed: allow a clean retry
    throw e;
  }
}

/* ---------- audit ---------- */
function audit(actorId, action, target, meta, req) {
  q.run('INSERT INTO audit(actor_id, action, target, meta, ip, created_at) VALUES(?,?,?,?,?,?)', actorId || null, action, target == null ? null : String(target), meta ? JSON.stringify(meta) : null, req ? clientIp(req) : null, now());
}

module.exports = {
  hashPassword, verifyPassword, passwordProblems, sha256, token,
  createSession, clearSession, loadSession, requireUser, requireAdmin, requirePerm, can, isStaff, STAFF_ROLES, PERMS, checkCsrf, rateLimit,
  newTotpSecret, verifyTotp, hotp, issueCode, consumeCode, audit, idempotent, SESSION_COOKIE
};
