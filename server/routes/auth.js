/* ==========================================================================
   Auth routes: invites, register, email verification, login + 2FA,
   wallet sign-in (Solana signMessage), password reset, waitlist
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, tx, now, J, getSettings } = require('../db');
const { fail } = require('../http');
const S = require('../security');
const chain = require('../chain');
const { sendMail } = require('../mail');
const { notify, notifyAdmins } = require('../events');
const { createUser, giveStarterPaper } = require('../seed');

const emailOk = (e) => typeof e === 'string' && e.length < 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const dev = (code) => (getSettings().demo_mode ? { devCode: code } : {});

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, initials: (u.name || 'U').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase(),
    emailVerified: !!u.email_verified, walletLogin: u.wallet_login, twoFA: !!u.totp_enabled, antiPhishing: u.anti_phishing,
    prefs: J(u.prefs), risk: J(u.risk), whitelistOnly: !!u.whitelist_only, paperMode: !!u.paper_mode, createdAt: u.created_at,
    staff: S.isStaff(u), perms: S.isStaff(u) ? Object.keys(S.PERMS).filter((p) => S.can(u, p)) : [], creditScore: u.credit_score
  };
}

function checkInvite(code) {
  const c = String(code || '').toUpperCase().trim();
  const inv = q.get('SELECT * FROM invites WHERE code = ? AND active = 1', c);
  if (!inv || inv.uses >= inv.max_uses) fail(400, 'That code isn’t valid or was already used');
  return inv;
}
function consumeInvite(inv, userId) {
  q.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
  if (inv.kind === 'referral' && inv.created_by) {
    q.run('UPDATE users SET referred_by = ? WHERE id = ?', inv.created_by, userId);
    notify(inv.created_by, 'bot', 'A friend joined with your code 🌸', `${inv.code} has now been used ${inv.uses + 1}/${inv.max_uses} times.`, 'referrals.html');
  }
}
function onNewUser(userId) { giveStarterPaper(userId, getSettings()); notifyAdmins('security', 'New user registered', `User #${userId} joined.`, '/admin#users'); }

async function sendLoginNotice(u, req) {
  const ua = String(req.headers['user-agent'] || 'Unknown device').slice(0, 80);
  notify(u.id, 'security', 'New sign-in', `${ua}. If this wasn’t you, revoke the session in Settings.`, 'settings.html#security');
}

module.exports = (r) => {
  /* ---- invites & waitlist ---- */
  r.post('/api/auth/invite/validate', (c) => {
    S.rateLimit(c.req, 'invite', 20, 60000);
    const s = getSettings();
    if (!s.registration_open) fail(403, 'Registration is temporarily closed');
    if (!s.invite_required) return { ok: true };
    const inv = checkInvite(c.body.code);
    return { ok: true, code: inv.code };
  });
  r.post('/api/waitlist', (c) => {
    S.rateLimit(c.req, 'waitlist', 5, 60000);
    const email = String(c.body.email || '').trim();
    if (!emailOk(email)) fail(400, 'Enter a valid email address');
    const ex = q.get('SELECT id FROM waitlist WHERE email = ?', email);
    if (!ex) q.run('INSERT INTO waitlist(email, referral, created_at) VALUES(?,?,?)', email, String(c.body.referral || '').slice(0, 40) || null, now());
    const pos = q.val('SELECT COUNT(*) FROM waitlist WHERE status = ?', 'pending');
    if (!ex) { sendMail(email, 'You’re on the NECTRA waitlist', `Thanks for your interest! Your position: #${pos}. We’ll email your invite code soon.`); notifyAdmins('security', 'New waitlist signup', email, '/admin#waitlist'); }
    return { ok: true, position: pos };
  });

  /* ---- email registration ---- */
  r.post('/api/auth/register', (c) => {
    S.rateLimit(c.req, 'register', 10, 60000);
    const s = getSettings();
    if (!s.registration_open) fail(403, 'Registration is temporarily closed');
    const { email, password, name } = c.body;
    if (!emailOk(email)) fail(400, 'Enter a valid email address');
    const pwErr = S.passwordProblems(password); if (pwErr) fail(400, pwErr);
    if (!c.body.acceptTerms) fail(400, 'Please accept the terms and risk disclosure');
    const inv = s.invite_required ? checkInvite(c.body.code) : null;
    if (q.get('SELECT id FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists — log in instead');
    const userId = tx(() => {
      const id = createUser({ email, password, name: String(name || email.split('@')[0]).slice(0, 40), verified: 0, invite: inv && inv.code });
      if (inv) consumeInvite(inv, id);
      onNewUser(id);
      return id;
    });
    const u = q.get('SELECT * FROM users WHERE id = ?', userId);
    const code = S.issueCode({ userId, purpose: 'verify' });
    sendMail(email, 'Verify your NECTRA email', `Your verification code is ${code}. It expires in 10 minutes.`, u);
    S.createSession(c.res, c.req, userId);
    S.audit(userId, 'user.register', userId, { email }, c.req);
    return { ok: true, needsVerification: true, ...dev(code) };
  });
  r.post('/api/auth/verify-email', (c) => {
    S.rateLimit(c.req, 'verify', 20, 60000);
    const u = c.auth && c.auth.user; if (!u) fail(401, 'Session expired — log in again');
    S.consumeCode({ userId: u.id, purpose: 'verify', code: c.body.code });
    q.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
    return { ok: true };
  });
  r.post('/api/auth/resend-verify', (c) => {
    S.rateLimit(c.req, 'resend', 5, 60000);
    const u = c.auth && c.auth.user; if (!u) fail(401, 'Session expired');
    const code = S.issueCode({ userId: u.id, purpose: 'verify' });
    sendMail(u.email, 'Your NECTRA verification code', `Your verification code is ${code}.`, u);
    return { ok: true, ...dev(code) };
  });

  /* ---- login + 2FA ---- */
  r.post('/api/auth/login', (c) => {
    S.rateLimit(c.req, 'login', 10, 60000);
    const u = q.get('SELECT * FROM users WHERE email = ?', String(c.body.email || ''));
    if (!u || !S.verifyPassword(String(c.body.password || ''), u.pw_hash)) { S.audit(u && u.id, 'auth.login_failed', c.body.email, null, c.req); fail(401, 'Incorrect email or password'); }
    if (u.status !== 'active') fail(403, 'This account is suspended');
    if (u.totp_enabled) { S.createSession(c.res, c.req, u.id, true); return { ok: true, twoFA: true }; }
    S.createSession(c.res, c.req, u.id);
    q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
    S.audit(u.id, 'auth.login', u.id, null, c.req);
    sendLoginNotice(u, c.req);
    if (!u.email_verified) { const code = S.issueCode({ userId: u.id, purpose: 'verify' }); sendMail(u.email, 'Verify your NECTRA email', `Your verification code is ${code}.`, u); return { ok: true, needsVerification: true, ...dev(code) }; }
    return { ok: true, user: publicUser(u) };
  });
  r.post('/api/auth/login/2fa', (c) => {
    S.rateLimit(c.req, '2fa', 10, 60000);
    const a = c.auth; if (!a || !a.session.pending_2fa) fail(401, 'Session expired — log in again');
    if (!S.verifyTotp(a.user.totp_secret, c.body.code)) fail(400, 'Incorrect code');
    q.run('UPDATE sessions SET pending_2fa = 0 WHERE id = ?', a.session.id);
    q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), a.user.id);
    S.audit(a.user.id, 'auth.login', a.user.id, { twoFA: true }, c.req);
    sendLoginNotice(a.user, c.req);
    return { ok: true, user: publicUser(a.user) };
  });
  r.post('/api/auth/logout', (c) => { S.clearSession(c.req, c.res); return { ok: true }; });
  r.get('/api/auth/me', (c) => {
    if (!c.auth) return { user: null };
    const imp = c.auth.session.impersonator_id ? q.get('SELECT email, name FROM users WHERE id = ?', c.auth.session.impersonator_id) : null;
    return { user: publicUser(c.auth.user), pending2fa: !!c.auth.session.pending_2fa, impersonatedBy: imp ? imp.email : null };
  });
  /* Return to the admin account after impersonating a user */
  r.post('/api/auth/stop-impersonating', (c) => {
    const s = c.auth;
    if (!s || !s.session.impersonator_id) fail(400, 'Not impersonating anyone');
    const admin = q.get('SELECT * FROM users WHERE id = ?', s.session.impersonator_id);
    q.run('DELETE FROM sessions WHERE id = ?', s.session.id);
    if (!admin || !S.isStaff(admin) || admin.status !== 'active') { S.clearSession(c.req, c.res); fail(403, 'Your admin account is no longer available — please sign in again'); }
    S.createSession(c.res, c.req, admin.id);
    S.audit(admin.id, 'admin.impersonate_stop', s.user.id, { email: s.user.email }, c.req);
    return { ok: true };
  });

  /* ---- wallet sign-in / register (Solana signMessage) ---- */
  r.post('/api/auth/wallet/nonce', (c) => {
    S.rateLimit(c.req, 'nonce', 30, 60000);
    let address = String(c.body.address || '').trim();
    const family = ['solana', 'evm', 'tron'].includes(c.body.family) ? c.body.family : 'solana';
    const purpose = ['login', 'register', 'link', 'loan'].includes(c.body.purpose) ? c.body.purpose : 'login';
    if (family === 'solana' && !chain.isSolAddress(address)) fail(400, 'Not a valid Solana address');
    if (family === 'evm') { if (!chain.isEvmAddress(address)) fail(400, 'Not a valid EVM address'); address = require('../chains/evm').getAddress(address); }
    if (family === 'tron' && !require('../chains/tron').isAddress(address)) fail(400, 'Not a valid Tron address');
    const nonce = crypto.randomBytes(12).toString('hex');
    const label = { login: 'Sign in to NECTRA', register: 'Create a NECTRA account', link: 'Link this wallet to NECTRA', loan: 'Verify wallet ownership for a NECTRA loan application' }[purpose];
    const message = `${label}\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\n\nThis request will not trigger a blockchain transaction or cost any fees.`;
    q.run('INSERT INTO nonces(nonce, address, purpose, message, user_id, created_at, family) VALUES(?,?,?,?,?,?,?)', nonce, address, purpose, message, c.auth ? c.auth.user.id : null, now(), family);
    return { nonce, message, address };
  });
  r.post('/api/auth/wallet/verify', async (c) => {
    S.rateLimit(c.req, 'wallet', 20, 60000);
    const n = await consumeWalletProof(c.body);
    if (n.purpose === 'login') {
      const u = q.get('SELECT * FROM users WHERE wallet_login = ?', n.address);
      if (!u) fail(404, 'No account is linked to this wallet yet. Register with an invite code first.');
      if (u.status !== 'active') fail(403, 'This account is suspended');
      if (u.totp_enabled) { S.createSession(c.res, c.req, u.id, true); return { ok: true, twoFA: true }; }
      S.createSession(c.res, c.req, u.id);
      q.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
      sendLoginNotice(u, c.req);
      return { ok: true, user: publicUser(u) };
    }
    if (n.purpose === 'register') {
      const s = getSettings();
      if (!s.registration_open) fail(403, 'Registration is temporarily closed');
      const inv = s.invite_required ? checkInvite(c.body.code) : null;
      if (q.get('SELECT id FROM users WHERE wallet_login = ?', n.address)) fail(409, 'This wallet already has an account — sign in instead');
      const id = tx(() => {
        const id = createUser({ email: null, password: null, name: 'Trader ' + n.address.slice(0, 4), verified: 1, invite: inv && inv.code });
        q.run('UPDATE users SET wallet_login = ? WHERE id = ?', n.address, id);
        q.run("INSERT INTO wallets(user_id, name, address, chain, family, kind, source, provider, verified, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, 'Main wallet', n.address, n.family === 'evm' ? 'EVM' : n.family === 'tron' ? 'Tron' : 'Solana', n.family, 'main', c.body.provider === 'Demo wallet' ? 'demo' : 'connected', String(c.body.provider || 'Wallet').slice(0, 40), 1, now(), now());
        q.run('UPDATE users SET onboarding = ? WHERE id = ?', JSON.stringify({ connect: true }), id);
        if (inv) consumeInvite(inv, id);
        onNewUser(id);
        return id;
      });
      S.createSession(c.res, c.req, id);
      S.audit(id, 'user.register_wallet', id, { address: n.address }, c.req);
      return { ok: true, user: publicUser(q.get('SELECT * FROM users WHERE id = ?', id)) };
    }
    fail(400, 'Unsupported purpose');
  });

  /* ---- password reset ---- */
  r.post('/api/auth/forgot', (c) => {
    S.rateLimit(c.req, 'forgot', 5, 60000);
    const u = q.get('SELECT * FROM users WHERE email = ?', String(c.body.email || ''));
    let code;
    if (u) { code = S.issueCode({ userId: u.id, purpose: 'reset', ttlMin: 30 }); sendMail(u.email, 'Reset your NECTRA password', `Your password reset code is ${code}. It expires in 30 minutes. Withdrawals are locked for 24h after a reset.`, u); }
    return { ok: true, ...(u ? dev(code) : {}) }; // same response whether or not the account exists
  });
  r.post('/api/auth/reset', (c) => {
    S.rateLimit(c.req, 'reset', 10, 60000);
    const u = q.get('SELECT * FROM users WHERE email = ?', String(c.body.email || ''));
    if (!u) fail(400, 'Incorrect code');
    S.consumeCode({ userId: u.id, purpose: 'reset', code: c.body.code });
    const pwErr = S.passwordProblems(c.body.password); if (pwErr) fail(400, pwErr);
    q.run('UPDATE users SET pw_hash = ?, email_verified = 1 WHERE id = ?', S.hashPassword(c.body.password), u.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    S.audit(u.id, 'auth.password_reset', u.id, null, c.req);
    notify(u.id, 'security', 'Password changed', 'Your password was reset and all sessions were signed out.', 'settings.html#security');
    return { ok: true };
  });
};

/** Verify a signed nonce message (shared with wallet linking & loan checks) */
async function consumeWalletProof(body, expectPurpose, userId) {
  const n = q.get('SELECT * FROM nonces WHERE nonce = ? AND used = 0', String(body.nonce || ''));
  if (!n || now() - n.created_at > 10 * 60000) fail(400, 'Signature request expired — try again');
  if (expectPurpose && n.purpose !== expectPurpose) fail(400, 'Signature was made for a different action');
  if (userId && n.user_id && n.user_id !== userId) fail(403, 'Signature belongs to another session');
  q.run('UPDATE nonces SET used = 1 WHERE nonce = ?', n.nonce); // single use, even when verification fails
  const sig = String(body.signature || '');
  const ok = n.family === 'evm' ? await require('../chains/evm').verifySignature(n.address, n.message, sig)
    : n.family === 'tron' ? await require('../chains/tron').verifySignature(n.address, n.message, sig)
    : chain.verifySignature(n.address, n.message, sig);
  if (!ok) fail(400, 'Signature could not be verified for this wallet');
  return n;
}
module.exports.consumeWalletProof = consumeWalletProof;
module.exports.publicUser = publicUser;
