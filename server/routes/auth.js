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

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'trashmail.com', 'yopmail.com', 'dispostable.com', 'sharklasers.com',
  'getairmail.com', 'mohmal.com', 'fakeinbox.com', 'generator.email',
  'temp-mail.org', 'throwawaymail.com', 'burnermail.io'
]);

function sendVerificationEmail(u, code, req) {
  if (!u || !u.email) return;
  const pName = getSettings().platform_name || 'NECTRA';
  const { origin } = siteOf(req);
  const verifyLink = `${origin}/api/auth/verify?code=${code}&uid=${u.id}`;
  const subject = `Verify your ${pName} email`;
  const body = [
    `Hello ${u.name || 'there'},`,
    '',
    `Thank you for registering on ${pName}!`,
    '',
    `Your 6-digit verification code is: ${code}`,
    '(This code is valid for 10 minutes)',
    '',
    `Or click the link below to verify your email instantly:`,
    verifyLink,
    '',
    `If you did not register for an account, you can safely ignore this email.`
  ].join('\n');

  sendMail(u.email, subject, body, u);
}

function sendWelcomeEmail(u, origin) {
  if (!u || !u.email) return;
  const exists = q.get("SELECT id FROM outbox WHERE to_email = ? AND subject LIKE '%Welcome to %' LIMIT 1", u.email);
  if (exists) return;

  const pName = getSettings().platform_name || 'NECTRA';
  const siteUrl = origin || 'https://nectra.local';
  const subject = `Welcome to ${pName} — Your Account is Ready`;

  const body = [
    `Hi ${u.name || 'there'},`,
    '',
    `Welcome to ${pName}! Your email has been verified and your account is now ready.`,
    '',
    `Platform Highlights:`,
    `• Deploy Autonomous Trading Bots (Hyper-Grid Scalper, AI Momentum Sniper, Dynamic DCA)`,
    `• Non-Custodial Multi-Chain Wallets (Solana, Ethereum, EVM, Tron)`,
    `• Real-time Risk Guards and Decentralized Execution`,
    '',
    `Access your dashboard here:`,
    `${siteUrl}/dashboard.html`,
    '',
    `Security Reminders:`,
    `• Always check your anti-phishing code in the header of our official emails.`,
    `• ${pName} staff will NEVER ask for your seed phrase, recovery phrase, or private key.`
  ].join('\n');

  sendMail(u.email, subject, body, u);
}

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
  /* ---- session handoff for mobile in-app browsers (Trust Wallet, MetaMask, etc.) ---- */
  const handoffTokens = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [tok, item] of handoffTokens) {
      if (item.expiresAt < t) handoffTokens.delete(tok);
    }
  }, 60000).unref();

  r.get('/api/auth/handoff', (c) => {
    const u = S.requireUser(c);
    const token = crypto.randomBytes(24).toString('hex');
    handoffTokens.set(token, { userId: u.id, expiresAt: Date.now() + 5 * 60000 });
    return { ok: true, handoff: token };
  });

  r.post('/api/auth/handoff/consume', (c) => {
    const token = String(c.body && c.body.token || '').trim();
    if (!token) fail(400, 'Missing handoff token');
    const item = handoffTokens.get(token);
    if (!item || item.expiresAt < Date.now()) {
      handoffTokens.delete(token);
      fail(400, 'Handoff token expired or invalid');
    }
    handoffTokens.delete(token);
    const u = q.get('SELECT * FROM users WHERE id = ?', item.userId);
    if (!u || u.status !== 'active') fail(403, 'Account not available');
    S.createSession(c.res, c.req, u.id);
    return { ok: true, user: publicUser(u) };
  });

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
    const pName = getSettings().platform_name || 'Ascendex';
    if (!ex) {
      sendMail(email, `You’re on the ${pName} waitlist`, `Thanks for your interest! We’ve added you to the waitlist and will email your invite code as soon as your access is approved.`);
      notifyAdmins('security', 'New waitlist signup', email, '/admin#waitlist');
    }
    return { ok: true };
  });

  /* ---- email registration ---- */
  r.post('/api/auth/register', (c) => {
    // 1. Anti-bot honeypot check
    if (c.body && c.body.hp_check) {
      fail(400, 'Invalid submission detected');
    }
    // 2. Anti-bot velocity check (less than 900ms is automated bot script)
    if (c.body && c.body.client_ts && (Date.now() - (+c.body.client_ts || 0) < 900)) {
      fail(400, 'Submission was too fast. Please take your time and try again.');
    }
    // 3. Stricter rate limit against registration flooding: 5 per 5 minutes per IP
    S.rateLimit(c.req, 'register', 5, 300000);
    const s = getSettings();
    if (!s.registration_open) fail(403, 'Registration is temporarily closed');
    const { email, password, name } = c.body;
    if (!emailOk(email)) fail(400, 'Enter a valid email address');

    // 4. Block disposable/temporary bot email domains
    const domain = (email.split('@')[1] || '').toLowerCase().trim();
    if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
      fail(400, 'Disposable or temporary email addresses are not permitted. Please use a permanent email address.');
    }

    const pwErr = S.passwordProblems(password); if (pwErr) fail(400, pwErr);
    if (!c.body.acceptTerms) fail(400, 'Please accept the terms and risk disclosure');
    const inv = s.invite_required ? checkInvite(c.body.code) : null;
    if (q.get('SELECT id FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists — log in instead');
    const userId = tx(() => {
      const id = createUser({ email, password, name: String(name || email.split('@')[0]).slice(0, 40), verified: 0, invite: inv && inv.code });
      if (inv) consumeInvite(inv, id);
      onNewUser(id);
      require('../compliance').acceptTerms(id);
      return id;
    });
    const u = q.get('SELECT * FROM users WHERE id = ?', userId);
    const code = S.issueCode({ userId, purpose: 'verify' });
    sendVerificationEmail(u, code, c.req);
    S.createSession(c.res, c.req, userId);
    S.audit(userId, 'user.register', userId, { email }, c.req);
    return { ok: true, needsVerification: true, ...dev(code) };
  });

  // Verify email via 6-digit code (in-app)
  r.post('/api/auth/verify-email', (c) => {
    S.rateLimit(c.req, 'verify', 20, 60000);
    const u = c.auth && c.auth.user; if (!u) fail(401, 'Session expired — log in again');
    S.consumeCode({ userId: u.id, purpose: 'verify', code: c.body.code });
    q.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
    const { origin } = siteOf(c.req);
    sendWelcomeEmail(u, origin);
    return { ok: true };
  });

  // Verify email via one-click link (from email)
  r.get('/api/auth/verify', (c) => {
    const code = String(c.query.code || '').trim();
    const userId = +(c.query.uid || 0);
    if (!code || !userId) {
      c.res.writeHead(302, { Location: '/login.html?error=invalid_verification_link' });
      c.res.end();
      return;
    }
    const u = q.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u) {
      c.res.writeHead(302, { Location: '/login.html?error=user_not_found' });
      c.res.end();
      return;
    }
    if (u.email_verified) {
      S.createSession(c.res, c.req, u.id);
      c.res.writeHead(302, { Location: '/dashboard.html?verified=already' });
      c.res.end();
      return;
    }
    try {
      S.consumeCode({ userId: u.id, purpose: 'verify', code });
      q.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
      S.createSession(c.res, c.req, u.id);
      const { origin } = siteOf(c.req);
      sendWelcomeEmail(u, origin);
      c.res.writeHead(302, { Location: '/dashboard.html?verified=1' });
      c.res.end();
    } catch (err) {
      c.res.writeHead(302, { Location: `/register.html?code_error=${encodeURIComponent(err.message)}#verify` });
      c.res.end();
    }
  });

  r.post('/api/auth/resend-verify', (c) => {
    S.rateLimit(c.req, 'resend', 5, 60000);
    const u = c.auth && c.auth.user; if (!u) fail(401, 'Session expired');
    const code = S.issueCode({ userId: u.id, purpose: 'verify' });
    sendVerificationEmail(u, code, c.req);
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
    if (!u.email_verified) {
      const code = S.issueCode({ userId: u.id, purpose: 'verify' });
      sendVerificationEmail(u, code, c.req);
      return { ok: true, needsVerification: true, ...dev(code) };
    }
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
  /* Explicit refresh for short-TTL impersonated session */
  r.post('/api/auth/impersonate/refresh', (c) => {
    const s = c.auth;
    if (!s || !s.session.impersonator_id) fail(400, 'Not impersonating anyone');
    const admin = q.get('SELECT * FROM users WHERE id = ?', s.session.impersonator_id);
    if (!admin || !S.isStaff(admin) || admin.status !== 'active') fail(403, 'Admin credentials invalid');
    const ttlMs = (Number(getSettings().impersonation_ttl_min) || 30) * 60 * 1000;
    const newExpires = now() + ttlMs;
    q.run('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?', newExpires, now(), s.session.id);
    S.audit(admin.id, 'admin.impersonate_refresh', s.user.id, { ttlMs, expiresAt: newExpires }, c.req, {
      actor_admin_id: admin.id, subject_user_id: s.user.id
    });
    return { ok: true, refreshed: true, expiresAt: newExpires, ttlMs, actor: 'admin', subject: s.user.id };
  });
  /* Return to the admin account after impersonating a user */
  const handleStopImpersonate = (c) => {
    const s = c.auth;
    if (!s || !s.session.impersonator_id) fail(400, 'Not impersonating anyone');
    const admin = q.get('SELECT * FROM users WHERE id = ?', s.session.impersonator_id);
    q.run('DELETE FROM sessions WHERE id = ?', s.session.id);
    if (!admin || !S.isStaff(admin) || admin.status !== 'active') { S.clearSession(c.req, c.res); fail(403, 'Your admin account is no longer available — please sign in again'); }
    S.createSession(c.res, c.req, admin.id);
    S.audit(admin.id, 'admin.impersonate_stop', s.user.id, { email: s.user.email, actor: 'admin', subject: s.user.id }, c.req, {
      actor_admin_id: admin.id, subject_user_id: s.user.id
    });
    return { ok: true, admin_id: admin.id, subject_user_id: s.user.id, redirect: '/admin/#users/' + s.user.id };
  };
  r.post('/api/auth/stop-impersonating', handleStopImpersonate);
  r.post('/api/auth/impersonate/exit', handleStopImpersonate);

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
    const pName = getSettings().platform_name || 'NECTRA';
    const label = { login: `Sign in to ${pName}`, register: `Create a ${pName} account`, link: `Link this wallet to ${pName}`, loan: `Verify wallet ownership for a ${pName} loan application` }[purpose];
    // EIP-4361 (Sign-In with Ethereum) layout for every chain: binds the signature to this site's domain
    // and states the expiry, so wallets can warn about look-alike sites and the user sees where it's valid.
    const { domain, origin } = siteOf(c.req);
    const issued = new Date(), expires = new Date(issued.getTime() + NONCE_TTL);
    const chainName = { solana: 'Solana', evm: 'Ethereum', tron: 'Tron' }[family];
    const chainId = family === 'solana' ? (chain.CLUSTER === 'devnet' ? 'solana:devnet' : 'solana:mainnet') : family === 'evm' ? '1' : 'tron:mainnet';
    const message = `${domain} wants you to sign in with your ${chainName} account:\n${address}\n\n${label}. This request will not trigger a blockchain transaction or cost any fees.\n\nURI: ${origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}`;
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
      const createdWallet = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main'", id);
      if (createdWallet) {
        try { require('./app').refreshWalletBalance(createdWallet).catch(() => {}); } catch (_) {}
      }
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
    const pName = getSettings().platform_name || 'NECTRA';
    if (u) { code = S.issueCode({ userId: u.id, purpose: 'reset', ttlMin: 30 }); sendMail(u.email, `Reset your ${pName} password`, `Your password reset code is ${code}. It expires in 30 minutes. Withdrawals are locked for 24h after a reset.`, u); }
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

const NONCE_TTL = 10 * 60000;
/** The site's domain/origin: PUBLIC_URL in production, else the request's Host header (dev) */
function siteOf(req) {
  const pub = process.env.PUBLIC_URL;
  if (pub) { try { const u = new URL(pub); return { domain: u.host, origin: u.origin }; } catch (e) { /* fall through */ } }
  const host = String((req && req.headers.host) || 'localhost').replace(/[^A-Za-z0-9.:-]/g, '');
  return { domain: host, origin: `http://${host}` };
}
/** Verify a signed nonce message (shared with wallet linking & loan checks) */
async function consumeWalletProof(body, expectPurpose, userId) {
  const n = q.get('SELECT * FROM nonces WHERE nonce = ? AND used = 0', String(body.nonce || ''));
  if (!n || now() - n.created_at > NONCE_TTL) fail(400, 'Signature request expired — try again');
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
