/* ==========================================================================
   Admin API — every route requires role = admin and is audit-logged
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, tx, now, J, getSettings, setSetting, DEFAULT_SETTINGS } = require('../db');
const { fail, send } = require('../http');
const chain = require('../chain');
const S = require('../security');
const E = require('../engine');
const market = require('../market');
const { notify, broadcast, onlineCount } = require('../events');
const { sendMail } = require('../mail');
const { statusPayload, txRow } = require('./app');

/* Route → permission (staff roles: loan_officer < admin < super_admin) */
function permFor(c) {
  const m = c.req.method, p = c.req.url.split('?')[0];
  if (m === 'GET') return 'admin.view';
  const rules = [
    [/\/users\/\d+\/adjust$/, 'ledger.adjust'], [/\/users\/\d+$/, 'users.manage'], [/\/users\//, 'users.manage'],
    [/\/invites|\/waitlist/, 'invites.manage'], [/\/kill-switch$/, 'killswitch'], [/\/bots\//, 'bots.manage'],
    [/\/payouts\//, 'payouts.manage'], [/\/settings$/, 'platform.settings'], [/\/plans/, 'platform.settings'], [/\/kyc\//, 'users.manage'], [/\/broadcast$|\/status\//, 'platform.ops']
  ];
  for (const [re, perm] of rules) if (re.test(p)) return perm;
  return 'platform.ops';
}

const DAY = 864e5;
const num = (v, min = 0, max = 1e12, n = 'Value') => { const x = Number(v); if (!Number.isFinite(x) || x < min || x > max) fail(400, `${n} is out of range`); return x; };
const str = (v, m = 200) => String(v == null ? '' : v).trim().slice(0, m);
const page = (query) => { const p = Math.max(1, +query.page || 1); return { limit: 50, offset: (p - 1) * 50, page: p }; };
const userBrief = (u) => ({ score: u.credit_score, id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, emailVerified: !!u.email_verified, wallet: u.wallet_login, twoFA: !!u.totp_enabled, createdAt: u.created_at, lastLogin: u.last_login_at });

module.exports = (r) => {
  r.get('/api/admin/overview', (c) => {
    S.requirePerm(c, permFor(c));
    const since = now() - DAY;
    const signups = [];
    for (let i = 29; i >= 0; i--) { const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - i); signups.push({ t: d0.getTime(), n: q.val('SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ?', d0.getTime(), d0.getTime() + DAY) }); }
    return {
      users: q.val('SELECT COUNT(*) FROM users'), activeToday: q.val('SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_seen_at > ?', since), online: onlineCount(),
      botsRunning: q.val("SELECT COUNT(*) FROM bots WHERE status = 'running'"), botsTotal: q.val('SELECT COUNT(*) FROM bots'),
      volume24h: q.val('SELECT COALESCE(SUM(size * price), 0) FROM trades WHERE created_at > ?', since), trades24h: q.val('SELECT COUNT(*) FROM trades WHERE created_at > ?', since),
      pendingLoans: q.val("SELECT COUNT(*) FROM loans WHERE status = 'pending_review'"), approvedLoans: q.val("SELECT COUNT(*) FROM loans WHERE status = 'approved'"),
      loanBook: q.all("SELECT * FROM loans WHERE status IN ('disbursed','defaulted')").reduce((a, l) => a + E.loanOwed(l) - l.repaid, 0),
      pendingPayouts: q.val("SELECT COUNT(*) FROM withdrawals WHERE status = 'pending_admin'"), pendingActions: q.val("SELECT COUNT(*) FROM pending_actions WHERE status = 'pending'"),
      pendingKyc: q.val("SELECT COUNT(*) FROM kyc WHERE status = 'submitted'"),
      overdueLoans: q.val("SELECT COUNT(DISTINCT l.id) FROM loans l JOIN loan_instalments i ON i.loan_id = l.id WHERE l.status = 'disbursed' AND i.status != 'paid' AND i.due_at < ?", now()), defaulted: q.val("SELECT COUNT(*) FROM loans WHERE status = 'defaulted'"),
      market: market.source(), ai: require('../ai').enabled(), waitlist: q.val("SELECT COUNT(*) FROM waitlist WHERE status = 'pending'"),
      ledgerTotal: q.val('SELECT COALESCE(SUM(amount), 0) FROM ledger'), signups, status: statusPayload(),
      recentUsers: q.all('SELECT * FROM users ORDER BY created_at DESC LIMIT 6').map(userBrief),
      recentAudit: q.all('SELECT a.*, u.email actor FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 8'),
      settings: getSettings()
    };
  });

  /* ---------- users ---------- */
  r.get('/api/admin/users', (c) => {
    S.requirePerm(c, permFor(c));
    const { limit, offset, page: p } = page(c.query);
    const s = '%' + str(c.query.q, 80) + '%';
    const st = ['active', 'suspended'].includes(c.query.status) ? c.query.status : null;
    const where = '(email LIKE ? OR name LIKE ? OR wallet_login LIKE ? OR CAST(id AS TEXT) = ?) AND (? IS NULL OR status = ?)';
    const total = q.val(`SELECT COUNT(*) FROM users WHERE ${where}`, s, s, s, str(c.query.q), st, st);
    const rows = q.all(`SELECT * FROM users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, s, s, s, str(c.query.q), st, st, limit, offset)
      .map((u) => ({ ...userBrief(u), portfolio: E.portfolioValue(u.id), balance: E.accountBalance(u.id), bots: q.val('SELECT COUNT(*) FROM bots WHERE user_id = ?', u.id) }));
    return { rows, total, page: p };
  });
  r.get('/api/admin/users/:id', (c) => {
    S.requirePerm(c, permFor(c));
    const u = q.get('SELECT * FROM users WHERE id = ?', c.params.id); if (!u) fail(404, 'User not found');
    return {
      user: { ...userBrief(u), antiPhishing: u.anti_phishing, invite: u.invite_code, referredBy: u.referred_by, risk: J(u.risk), paperMode: !!u.paper_mode, whitelistOnly: !!u.whitelist_only },
      portfolio: E.portfolioValue(u.id), balance: E.accountBalance(u.id),
      wallets: q.all('SELECT id, name, address, kind, source, verified, balance FROM wallets WHERE user_id = ? ORDER BY id LIMIT 100', u.id),
      bots: q.all('SELECT * FROM bots WHERE user_id = ?', u.id).map((b) => E.botPayload(b)),
      loans: q.all('SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC', u.id).map(loanView),
      ledger: q.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', u.id),
      sessions: q.all('SELECT id, user_agent, ip, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', u.id, now()),
      transactions: q.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 30', u.id).map(txRow),
      audit: q.all('SELECT * FROM audit WHERE actor_id = ? OR target = ? ORDER BY id DESC LIMIT 30', u.id, String(u.id))
    };
  });
  r.patch('/api/admin/users/:id', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const u = q.get('SELECT * FROM users WHERE id = ?', c.params.id); if (!u) fail(404, 'User not found');
    if (u.id === a.id && (c.body.status === 'suspended' || (c.body.role && c.body.role !== a.role))) fail(400, 'You can’t suspend or change your own role');
    if (['active', 'suspended'].includes(c.body.status)) {
      q.run('UPDATE users SET status = ? WHERE id = ?', c.body.status, u.id);
      if (c.body.status === 'suspended') { q.run('DELETE FROM sessions WHERE user_id = ?', u.id); E.pauseAll(u.id, 'Account suspended'); }
    }
    if (c.body.role !== undefined) {
      if (!S.can(a, 'users.roles')) fail(403, 'Only super admins can change roles');
      if (!['user', ...S.STAFF_ROLES].includes(c.body.role)) fail(400, 'Unknown role');
      if (u.role === 'super_admin' && c.body.role !== 'super_admin' && q.val("SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND status = 'active'") <= 1) fail(400, 'At least one super admin must remain');
      q.run('UPDATE users SET role = ? WHERE id = ?', c.body.role, u.id);
      if (S.STAFF_ROLES.includes(c.body.role)) notify(u.id, 'security', 'Staff access granted', `You now have the ${c.body.role.replace('_', ' ')} role.${getSettings().admin_2fa_required ? ' Set up 2FA to use the admin console.' : ''}`, '/admin/');
    }
    S.audit(a.id, 'admin.user_update', u.id, c.body, c.req);
    return { ok: true };
  });
  /* Super admin only: start a session AS this user (support impersonation) */
  r.post('/api/admin/users/:id/impersonate', (c) => {
    const a = S.requirePerm(c, 'users.impersonate');
    const u = q.get('SELECT * FROM users WHERE id = ?', c.params.id); if (!u) fail(404, 'User not found');
    if (u.id === a.id) fail(400, 'That account is already you');
    if (S.isStaff(u)) fail(403, 'You can’t log in as another staff member');
    if (u.status !== 'active') fail(403, 'That account is suspended');
    S.createSession(c.res, c.req, u.id, false, { impersonatorId: a.id, ttlMs: 60 * 60 * 1000 }); // 1-hour impersonation session
    S.audit(a.id, 'admin.impersonate_start', u.id, { email: u.email }, c.req);
    return { ok: true, email: u.email, name: u.name };
  });
  r.post('/api/admin/users/:id/adjust', (c) => { const a = S.requirePerm(c, permFor(c)); return S.idempotent(c, a.id, () => {
    const u = q.get('SELECT * FROM users WHERE id = ?', c.params.id); if (!u) fail(404, 'User not found');
    const amount = num(c.body.amount, -1e9, 1e9, 'Amount'); if (!amount) fail(400, 'Amount required');
    const note = str(c.body.note, 200); if (!note) fail(400, 'A note is required for manual adjustments');
    const kind = ['bonus', 'trading_profit', 'adjustment'].includes(c.body.kind) ? c.body.kind : 'adjustment';
    if (kind === 'trading_profit' && amount < 0) fail(400, 'Trading-profit credits must be positive');
    if (amount < 0 && E.accountBalance(u.id) + amount < -1e-9) fail(400, 'Adjustment would make the balance negative');
    if (Math.abs(amount) >= getSettings().dual_approval_threshold) {
      const id = createAction(a, 'adjust', u.id, { userId: u.id, amount, note, kind, ref: str(c.body.ref, 120) || null }, Math.abs(amount), c.req);
      return { pending: true, actionId: id };
    }
    q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', u.id, amount, kind, str(c.body.ref, 120) || null, note, a.id, now());
    const label = kind === 'bonus' ? 'Bonus credited' : kind === 'trading_profit' ? 'Trading profit credited' : amount > 0 ? 'Account credited' : 'Account debited';
    notify(u.id, 'transfer', label, `${amount > 0 ? '+' : ''}$${amount.toFixed(2)} · ${note}`, 'wallets.html');
    S.audit(a.id, 'admin.ledger_adjust', u.id, { amount, note, kind }, c.req);
    return { balance: E.accountBalance(u.id) };
  }); });
  r.post('/api/admin/users/:id/reset-2fa', (c) => {
    const a = S.requirePerm(c, permFor(c));
    q.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending = NULL WHERE id = ?', c.params.id);
    notify(+c.params.id, 'security', '2FA was reset by support', 'Set up two-factor authentication again in Settings.', 'settings.html#security');
    S.audit(a.id, 'admin.reset_2fa', c.params.id, null, c.req);
    return { ok: true };
  });
  r.post('/api/admin/users/:id/logout', (c) => { const a = S.requirePerm(c, permFor(c)); const n = q.run('DELETE FROM sessions WHERE user_id = ?', c.params.id).changes; S.audit(a.id, 'admin.force_logout', c.params.id, null, c.req); return { revoked: n }; });
  r.post('/api/admin/users/:id/pause-bots', (c) => { const a = S.requirePerm(c, permFor(c)); const n = E.pauseAll(+c.params.id, 'Paused by admin'); if (n) notify(+c.params.id, 'bot', 'Bots paused by admin', `${n} bot(s) were paused by the NECTRA team.`, 'bot.html'); S.audit(a.id, 'admin.pause_user_bots', c.params.id, { n }, c.req); return { paused: n }; });

  /* ---------- invites & waitlist ---------- */
  r.get('/api/admin/invites', (c) => { S.requirePerm(c, permFor(c)); return { rows: q.all('SELECT i.*, u.email creator FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 500') }; });
  r.post('/api/admin/invites', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const count = Math.round(num(c.body.count || 1, 1, 100, 'Count')), uses = Math.round(num(c.body.maxUses || 1, 1, 10000, 'Max uses'));
    const custom = str(c.body.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const codes = [];
    for (let i = 0; i < count; i++) {
      let code = count === 1 && custom.length >= 6 ? custom : '';
      while (!code || q.get('SELECT 1 FROM invites WHERE code = ?', code)) { if (code && count === 1 && custom) fail(409, 'Code already exists'); code = crypto.randomBytes(5).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8).padEnd(8, '7'); }
      q.run('INSERT INTO invites(code, kind, created_by, max_uses, note, created_at) VALUES(?,?,?,?,?,?)', code, 'admin', a.id, uses, str(c.body.note, 100) || null, now());
      codes.push(code);
    }
    S.audit(a.id, 'admin.invites_create', null, { count, uses }, c.req);
    return { codes };
  });
  r.patch('/api/admin/invites/:code', (c) => { const a = S.requirePerm(c, permFor(c)); q.run('UPDATE invites SET active = ? WHERE code = ?', c.body.active ? 1 : 0, c.params.code); S.audit(a.id, 'admin.invite_toggle', c.params.code, { active: !!c.body.active }, c.req); return { ok: true }; });
  r.get('/api/admin/waitlist', (c) => { S.requirePerm(c, permFor(c)); return { rows: q.all('SELECT * FROM waitlist ORDER BY status = \'pending\' DESC, created_at ASC LIMIT 1000') }; });
  r.post('/api/admin/waitlist/:id/invite', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const w = q.get('SELECT * FROM waitlist WHERE id = ?', c.params.id); if (!w) fail(404, 'Not found');
    const code = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    q.run('INSERT INTO invites(code, kind, created_by, max_uses, note, created_at) VALUES(?,?,?,?,?,?)', code, 'admin', a.id, 1, 'Waitlist: ' + w.email, now());
    q.run("UPDATE waitlist SET status = 'invited', invite_code = ? WHERE id = ?", code, w.id);
    const base = process.env.PUBLIC_URL || `http://${c.req.headers.host}`;
    sendMail(w.email, 'Your NECTRA invite is here 🌸', `You’re in! Your invite code: ${code}\n\nCreate your account: ${base}/register.html`);
    S.audit(a.id, 'admin.waitlist_invite', w.id, { email: w.email }, c.req);
    return { code };
  });
  r.post('/api/admin/waitlist/:id/reject', (c) => { const a = S.requirePerm(c, permFor(c)); q.run("UPDATE waitlist SET status = 'rejected' WHERE id = ?", c.params.id); S.audit(a.id, 'admin.waitlist_reject', c.params.id, null, c.req); return { ok: true }; });

  /* ---------- loans: review → (dual) approval → re-check → disbursement → collection ---------- */
  const L = require('../loans');
  const loanView = require('./loans').loanView;
  const threshold = () => getSettings().dual_approval_threshold;
  r.get('/api/admin/loans', (c) => {
    S.requirePerm(c, permFor(c));
    const st = str(c.query.status, 20);
    const rows = q.all(`SELECT l.*, u.email, u.name, u.credit_score score FROM loans l JOIN users u ON u.id = l.user_id ${st && st !== 'all' ? (st === 'overdue' ? "WHERE l.status = 'disbursed' AND EXISTS (SELECT 1 FROM loan_instalments i WHERE i.loan_id = l.id AND i.status != 'paid' AND i.due_at < " + now() + ')' : 'WHERE l.status = ?') : ''} ORDER BY l.status = 'pending_review' DESC, l.created_at DESC LIMIT 500`, ...(st && st !== 'all' && st !== 'overdue' ? [st] : []));
    return { rows: rows.map((l) => ({ ...loanView(l), userId: l.user_id, email: l.email, name: l.name, score: l.score, flags: J(l.risk_flags, []).length, officerNote: l.officer_note })) };
  });
  r.get('/api/admin/loans/:id', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const l = q.get('SELECT * FROM loans WHERE id = ?', c.params.id); if (!l) fail(404, 'Loan not found');
    const u = q.get('SELECT * FROM users WHERE id = ?', l.user_id);
    const ck = l.check_id ? q.get('SELECT * FROM loan_checks WHERE id = ?', l.check_id) : null;
    const approvers = J(l.approvals, []).map((id) => (q.get('SELECT email FROM users WHERE id = ?', id) || {}).email);
    return {
      loan: loanView(l), user: userBrief(u), score: u.credit_score, band: L.scoreBand(u.credit_score).band, balance: E.accountBalance(u.id), portfolio: E.portfolioValue(u.id),
      check: ck ? { ...ck, results: J(ck.results, []) } : null, recheck: J(l.recheck, null), flags: J(l.risk_flags, []), officerNote: l.officer_note,
      approvers, needsDual: l.amount >= threshold(), threshold: threshold(), me: a.id, alreadyApproved: J(l.approvals, []).includes(a.id),
      product: q.get('SELECT * FROM loan_products WHERE id = ?', l.product_id),
      history: q.all('SELECT * FROM loans WHERE user_id = ? AND id != ? ORDER BY id DESC', u.id, l.id).map(loanView),
      wallets: q.all('SELECT name, address, family, source, verified FROM wallets WHERE user_id = ? AND verified = 1', u.id),
      treasury: { solana: getSettings().treasury_solana || null },
      audit: q.all("SELECT a.*, x.email actor FROM audit a LEFT JOIN users x ON x.id = a.actor_id WHERE a.action LIKE '%loan%' AND a.target = ? ORDER BY a.id DESC", String(l.id)),
      perms: Object.keys(S.PERMS).filter((p) => S.can(a, p))
    };
  });
  r.post('/api/admin/loans/:id/recommend', (c) => {
    const a = S.requirePerm(c, 'loans.review');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status = 'pending_review'", c.params.id); if (!l) fail(400, 'Only pending applications');
    const rec = c.body.recommendation === 'reject' ? 'reject' : 'approve';
    const note = `${rec === 'approve' ? '👍 Recommend approve' : '👎 Recommend reject'} — ${str(c.body.note, 300) || 'no note'} (${a.email})`;
    q.run('UPDATE loans SET officer_note = ?, updated_at = ? WHERE id = ?', note, now(), l.id);
    S.audit(a.id, 'admin.loan_recommend', l.id, { rec }, c.req);
    return { ok: true };
  });
  r.post('/api/admin/loans/:id/recheck', async (c) => {
    S.requirePerm(c, 'loans.review');
    const l = q.get('SELECT * FROM loans WHERE id = ?', c.params.id); if (!l) fail(404, 'Loan not found');
    try { return { recheck: await L.recheck(l) }; } catch (e) { fail(502, e.message); }
  });
  r.post('/api/admin/loans/:id/approve', (c) => {
    const a = S.requirePerm(c, 'loans.decide');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status = 'pending_review'", c.params.id); if (!l) fail(400, 'Only pending applications can be approved');
    if (l.user_id === a.id) fail(403, 'You can’t approve your own loan');
    const amount = c.body.amount ? num(c.body.amount, 1, l.amount, 'Approved amount') : l.amount;
    if (l.collateral_asset && l.collateral_status !== 'received') fail(400, `Collateral not received yet (${l.collateral_received}/${l.collateral_required} ${l.collateral_asset})`);
    const approvals = J(l.approvals, []);
    if (approvals.includes(a.id)) fail(400, 'You already approved this loan — a different admin must give the second approval');
    approvals.push(a.id);
    const needs = amount >= threshold() ? 2 : 1;
    if (approvals.length < needs) {
      q.run('UPDATE loans SET approvals = ?, amount = ?, admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?', JSON.stringify(approvals), amount, str(c.body.note, 300) || null, now(), l.id);
      notifyAdminsExcept(a.id, 'Second approval needed', `Loan #${l.id} ($${amount.toFixed(2)}) was approved by ${a.email} and needs a second admin.`, '/admin/#loans/' + l.id);
      S.audit(a.id, 'admin.loan_approve_1of2', l.id, { amount }, c.req);
      return { pending: true, approvals: approvals.length, needed: needs };
    }
    q.run("UPDATE loans SET status = 'approved', approvals = ?, amount = ?, admin_note = COALESCE(?, admin_note), reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(approvals), amount, str(c.body.note, 300) || null, a.id, now(), now(), l.id);
    const u = q.get('SELECT * FROM users WHERE id = ?', l.user_id);
    notify(u.id, 'transfer', 'Loan approved ✅', `Loan #${l.id} for $${amount.toFixed(2)} was approved. Funds will be sent shortly.`, 'loans.html#mine');
    if (u.email) sendMail(u.email, 'Your NECTRA loan was approved', `Loan #${l.id}: ${amount} ${l.asset} approved.`, u);
    S.audit(a.id, 'admin.loan_approve', l.id, { amount, approvals }, c.req);
    return { ok: true };
  });
  r.post('/api/admin/loans/:id/reject', (c) => {
    const a = S.requirePerm(c, 'loans.decide');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status IN ('pending_review','approved')", c.params.id); if (!l) fail(400, 'This loan can’t be rejected');
    const reason = str(c.body.reason, 300); if (!reason) fail(400, 'Give the applicant a reason');
    q.run("UPDATE loans SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", reason, a.id, now(), now(), l.id);
    const u = q.get('SELECT * FROM users WHERE id = ?', l.user_id);
    notify(u.id, 'transfer', 'Loan application declined', reason, 'loans.html#mine');
    if (u.email) sendMail(u.email, 'Update on your NECTRA loan application', `Application #${l.id} was declined: ${reason}`, u);
    S.audit(a.id, 'admin.loan_reject', l.id, { reason }, c.req);
    return { ok: true };
  });
  /** Re-check the wallet, then disburse: method ledger | onchain (verify a signature) */
  r.post('/api/admin/loans/:id/disburse', async (c) => { const a = S.requirePerm(c, 'loans.disburse'); return S.idempotent(c, a.id, async () => {
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status = 'approved'", c.params.id); if (!l) fail(400, 'Approve the loan before disbursing');
    let rc;
    try { rc = await L.recheck(l); } catch (e) { fail(502, 'Re-check failed: ' + e.message); }
    if (!rc.ok) {
      if (!(c.body.override && S.can(a, 'platform.settings') && str(c.body.overrideReason, 300))) fail(409, 'Wallet re-check failed — the borrower no longer meets the criteria', { recheck: rc });
      S.audit(a.id, 'admin.loan_recheck_override', l.id, { reason: c.body.overrideReason }, c.req);
    }
    const method = c.body.method === 'onchain' ? 'onchain' : 'ledger';
    const ref = str(c.body.ref, 140); if (!ref) fail(400, method === 'onchain' ? 'Paste the transaction signature' : 'Enter the payment reference');
    // one payment can only fund one loan: refuse a reference already used for another disbursement
    if (q.val('SELECT id FROM loans WHERE disburse_ref = ? AND id != ?', ref, l.id)) fail(409, 'This reference was already used to disburse another loan');
    if (method === 'onchain') {
      const token = ['USDC', 'USDT'].includes(c.body.token) ? c.body.token : 'USDC';
      const v = await require('../chains/solana').verifyTokenTransfer(ref, { to: l.wallet_address, token, amount: l.amount * 0.999 }).catch((e) => ({ ok: false, reason: e.message }));
      if (!v.ok) fail(400, 'On-chain verification failed: ' + v.reason);
    }
    // markDisbursed claims the loan atomically; false = another request (or the treasury auto-link) got there first
    if (!L.markDisbursed(l, { method, ref, by: a.id })) fail(409, 'This loan was already disbursed');
    S.audit(a.id, 'admin.loan_disburse', l.id, { method, ref, amount: l.amount, recheckOk: rc.ok }, c.req);
    return { ok: true, recheck: rc };
  }); });
  /** Unsigned treasury → borrower USDC transfer for an admin's treasury wallet to sign */
  r.post('/api/admin/loans/:id/disburse-build', async (c) => {
    S.requirePerm(c, 'loans.disburse');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status = 'approved'", c.params.id); if (!l) fail(400, 'Approve the loan first');
    const from = str(c.body.from, 64); if (!chain.isSolAddress(from)) fail(400, 'Connect the treasury wallet');
    if (!chain.isSolAddress(l.wallet_address)) fail(400, 'Borrower wallet is not on Solana — pay out manually and record the reference');
    try { return { tx: await require('../chains/solana').buildTokenTransfer(from, l.wallet_address, ['USDC', 'USDT'].includes(c.body.token) ? c.body.token : 'USDC', l.amount) }; }
    catch (e) { fail(502, 'Couldn’t build the transfer: ' + e.message); }
  });
  r.post('/api/admin/loans/:id/status', (c) => {
    const a = S.requirePerm(c, 'loans.decide');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status IN ('disbursed','defaulted')", c.params.id); if (!l) fail(400, 'Only active loans can be closed');
    const st = c.body.status === 'defaulted' ? 'defaulted' : 'repaid';
    q.run('UPDATE loans SET status = ?, admin_note = COALESCE(?, admin_note), updated_at = ? WHERE id = ?', st, str(c.body.note, 300) || null, now(), l.id);
    L.creditScore(l.user_id);
    notify(l.user_id, 'transfer', st === 'repaid' ? 'Loan marked repaid' : 'Loan marked in default', str(c.body.note, 300) || `Loan #${l.id}`, 'loans.html#mine');
    S.audit(a.id, 'admin.loan_' + st, l.id, null, c.req);
    return { ok: true };
  });
  /** Request a collection from the borrower's approvals — always needs a second admin */
  r.post('/api/admin/loans/:id/collect', (c) => {
    const a = S.requirePerm(c, 'loans.collect');
    const l = q.get("SELECT * FROM loans WHERE id = ? AND status IN ('defaulted','disbursed')", c.params.id); if (!l) fail(400, 'Only active or defaulted loans');
    if (l.status === 'disbursed' && !q.val("SELECT 1 FROM loan_instalments WHERE loan_id = ? AND status != 'paid' AND due_at < ?", l.id, now())) fail(400, 'Nothing is overdue on this loan');
    const amount = c.body.amount ? num(c.body.amount, 1, L.outstandingOf(l)) : L.outstandingOf(l);
    if (q.val("SELECT 1 FROM pending_actions WHERE type = 'collect' AND target = ? AND status IN ('pending','executing')", String(l.id))) fail(409, 'A collection for this loan is already waiting for approval or running');
    const id = createAction(a, 'collect', l.id, { loanId: l.id, amount }, amount, c.req);
    return { pending: true, actionId: id };
  });
  const productFields = (b) => [str(b.name, 60) || fail(400, 'Name required'), str(b.asset || 'USDC', 10).toUpperCase(), num(b.apr, 0, 200, 'APR'), num(b.min_amount, 1, 1e9, 'Min amount'), num(b.max_amount, 1, 1e9, 'Max amount'), Math.round(num(b.term_days, 1, 3650, 'Term')), num(b.min_balance_pct, 0, 1000, 'Min balance %'), Math.round(num(b.min_tx_count, 0, 1e6, 'Min transactions')), Math.round(num(b.min_wallet_age_days, 0, 3650, 'Min wallet age')),
    b.kind === 'collateral' ? 'collateral' : 'history', Math.round(num(b.instalments || 1, 1, 60, 'Instalments')), num(b.late_fee_pct == null ? 5 : b.late_fee_pct, 0, 100, 'Late fee'), Math.round(num(b.grace_days == null ? 3 : b.grace_days, 0, 90, 'Grace days')), str(b.collateral_assets || 'BTC,LTC', 40).toUpperCase(), num(b.collateral_ratio || 150, 100, 1000, 'Collateral ratio'), b.require_delegation === false || b.require_delegation === 0 ? 0 : 1];
  const PCOLS = 'name, asset, apr, min_amount, max_amount, term_days, min_balance_pct, min_tx_count, min_wallet_age_days, kind, instalments, late_fee_pct, grace_days, collateral_assets, collateral_ratio, require_delegation';
  r.get('/api/admin/loan-products', (c) => { S.requirePerm(c, permFor(c)); return { rows: q.all('SELECT * FROM loan_products ORDER BY id') }; });
  r.post('/api/admin/loan-products', (c) => {
    const a = S.requirePerm(c, 'products.manage'); const f = productFields(c.body); if (f[3] > f[4]) fail(400, 'Min amount must be ≤ max amount');
    const id = q.run(`INSERT INTO loan_products(${PCOLS}, created_at) VALUES(${PCOLS.split(',').map(() => '?').join(',')},?)`, ...f, now()).id;
    S.audit(a.id, 'admin.product_create', id, c.body, c.req); return { id };
  });
  r.patch('/api/admin/loan-products/:id', (c) => {
    const a = S.requirePerm(c, 'products.manage');
    if (c.body.active != null && Object.keys(c.body).length === 1) q.run('UPDATE loan_products SET active = ? WHERE id = ?', c.body.active ? 1 : 0, c.params.id);
    else { const f = productFields(c.body); if (f[3] > f[4]) fail(400, 'Min amount must be ≤ max amount'); q.run(`UPDATE loan_products SET ${PCOLS.split(', ').map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...f, c.params.id); }
    S.audit(a.id, 'admin.product_update', c.params.id, c.body, c.req); return { ok: true };
  });

  /* ---------- subscription plans ---------- */
  const PLANS = require('../plans');
  const sanitizePerks = (p = {}) => ({
    maxBots: Math.round(num(p.maxBots == null ? 2 : p.maxBots, 1, 1000, 'Max bots')),
    maxBudget: num(p.maxBudget == null ? 1000 : p.maxBudget, 1, 1e8, 'Max budget'),
    live: !!p.live, advanced: !!p.advanced, prioritySupport: !!p.prioritySupport,
    backtestRange: ['30D', '90D', '1Y'].includes(p.backtestRange) ? p.backtestRange : '90D',
    features: Array.isArray(p.features) ? p.features.slice(0, 12).map((x) => str(x, 80)).filter(Boolean) : []
  });
  const planFields = (b) => [str(b.name, 40) || 'Plan', str(b.slug, 30).toLowerCase().replace(/[^a-z0-9-]/g, '') || ('plan-' + Date.now()), str(b.tagline, 120),
    num(b.price_usd == null ? 0 : b.price_usd, 0, 1e6, 'Price'), num(b.price_yearly == null ? 0 : b.price_yearly, 0, 1e7, 'Annual price'),
    ['free', 'monthly', 'yearly'].includes(b.interval) ? b.interval : 'monthly',
    JSON.stringify(sanitizePerks(b.perks)), b.active === false || b.active === 0 ? 0 : 1, Math.round(num(b.sort == null ? 0 : b.sort, 0, 999, 'Sort'))];
  r.get('/api/admin/plans', (c) => { S.requirePerm(c, permFor(c)); return { enabled: getSettings().monetization_enabled !== false, rows: PLANS.listPlans(true), subscribers: q.all("SELECT plan_id, COUNT(*) n FROM subscriptions WHERE status = 'active' GROUP BY plan_id").reduce((a, x) => ((a[x.plan_id] = x.n), a), {}) }; });
  r.post('/api/admin/plans', (c) => {
    const a = S.requirePerm(c, 'platform.settings'); const f = planFields(c.body);
    if (q.get('SELECT 1 FROM plans WHERE slug = ?', f[1])) fail(400, 'A plan with that slug already exists');
    const id = q.run('INSERT INTO plans(name, slug, tagline, price_usd, price_yearly, interval, perks, active, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...f, now(), now()).id;
    S.audit(a.id, 'admin.plan_create', id, c.body, c.req); return { id };
  });
  r.patch('/api/admin/plans/:id', (c) => {
    const a = S.requirePerm(c, 'platform.settings');
    const cur = q.get('SELECT * FROM plans WHERE id = ?', c.params.id); if (!cur) fail(404, 'Plan not found');
    if (c.body.active != null && Object.keys(c.body).length === 1) q.run('UPDATE plans SET active = ?, updated_at = ? WHERE id = ?', c.body.active ? 1 : 0, now(), c.params.id);
    else { const f = planFields({ ...cur, perks: JSON.parse(cur.perks), ...c.body }); if (f[1] !== cur.slug && q.get('SELECT 1 FROM plans WHERE slug = ? AND id != ?', f[1], cur.id)) fail(400, 'Slug already in use'); q.run('UPDATE plans SET name=?, slug=?, tagline=?, price_usd=?, price_yearly=?, interval=?, perks=?, active=?, sort=?, updated_at=? WHERE id=?', ...f, now(), c.params.id); }
    S.audit(a.id, 'admin.plan_update', c.params.id, c.body, c.req); return { ok: true };
  });
  r.del('/api/admin/plans/:id', (c) => {
    const a = S.requirePerm(c, 'platform.settings');
    const cur = q.get('SELECT * FROM plans WHERE id = ?', c.params.id); if (!cur) fail(404, 'Plan not found');
    if (cur.slug === 'free') fail(400, 'The Free plan can’t be deleted — deactivate it instead');
    if (q.val("SELECT COUNT(*) FROM subscriptions WHERE plan_id = ? AND status = 'active'", cur.id)) fail(400, 'Active subscribers on this plan — deactivate it instead of deleting');
    q.run('DELETE FROM plans WHERE id = ?', cur.id); S.audit(a.id, 'admin.plan_delete', c.params.id, null, c.req); return { ok: true };
  });
  r.get('/api/admin/subscriptions', (c) => {
    S.requirePerm(c, permFor(c));
    const balanceRev = q.val("SELECT COALESCE(SUM(-amount),0) FROM ledger WHERE kind = 'subscription'") || 0;
    const cryptoRev = q.val("SELECT COALESCE(SUM(amount_usd),0) FROM plan_payments WHERE status = 'confirmed' AND provider != 'balance'") || 0;
    return { rows: q.all(`SELECT s.id, s.user_id, u.email, p.name plan, s.status, s.price_usd, s.interval, s.started_at, s.renews_at, s.auto_renew
      FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans p ON p.id = s.plan_id ORDER BY s.status = 'active' DESC, s.id DESC LIMIT 500`),
      payments: q.all(`SELECT pp.id, u.email, p.name plan, pp.provider, pp.amount_usd, pp.status, pp.network, pp.reference, pp.created_at
        FROM plan_payments pp JOIN users u ON u.id = pp.user_id JOIN plans p ON p.id = pp.plan_id ORDER BY pp.id DESC LIMIT 200`),
      revenue: balanceRev + cryptoRev, balanceRevenue: balanceRev, cryptoRevenue: cryptoRev };
  });

  /* ---------- KYC review ---------- */
  r.get('/api/admin/kyc', (c) => {
    S.requirePerm(c, permFor(c));
    const st = str(c.query && c.query.status, 20);
    const rows = q.all(`SELECT k.user_id, k.status, k.level, k.full_name, k.country, k.dob, k.id_type, k.id_last4, k.address, k.note,
      k.doc_front IS NOT NULL AS has_front, k.doc_back IS NOT NULL AS has_back, k.submitted_at, k.reviewed_at, u.email
      FROM kyc k JOIN users u ON u.id = k.user_id ${st ? 'WHERE k.status = ?' : ''} ORDER BY k.status = 'submitted' DESC, k.updated_at DESC LIMIT 500`, ...(st ? [st] : []));
    return { enabled: getSettings().kyc_enabled !== false, rows, counts: { submitted: q.val("SELECT COUNT(*) FROM kyc WHERE status = 'submitted'"), verified: q.val("SELECT COUNT(*) FROM kyc WHERE status = 'verified'"), rejected: q.val("SELECT COUNT(*) FROM kyc WHERE status = 'rejected'") } };
  });
  r.get('/api/admin/kyc/:id/doc', (c) => {
    S.requirePerm(c, 'users.view');
    const side = c.query && c.query.side === 'back' ? 'back' : 'front';
    const dataUrl = require('../compliance').kycDoc(+c.params.id, side);
    if (!dataUrl) fail(404, 'No document');
    return { side, dataUrl };
  });
  r.post('/api/admin/kyc/:id/decide', (c) => {
    const a = S.requirePerm(c, 'users.manage');
    const decision = c.body.decision === 'verified' ? 'verified' : 'rejected';
    const r2 = require('../compliance').decideKyc(+c.params.id, decision, str(c.body.note, 200), a.id);
    S.audit(a.id, 'admin.kyc_decide', c.params.id, { decision }, c.req);
    return { kyc: r2 };
  });

  /* ---------- loan book ---------- */
  r.get('/api/admin/loanbook', (c) => {
    S.requirePerm(c, permFor(c));
    const all = q.all('SELECT l.*, p.name product FROM loans l JOIN loan_products p ON p.id = l.product_id');
    const by = (st) => all.filter((l) => l.status === st);
    const active = by('disbursed');
    const overdue = active.filter((l) => q.val("SELECT 1 FROM loan_instalments WHERE loan_id = ? AND status != 'paid' AND due_at < ?", l.id, now()));
    const perProduct = {};
    for (const l of active.concat(by('defaulted'))) { const k = l.product; perProduct[k] = perProduct[k] || { product: k, count: 0, outstanding: 0, principal: 0 }; perProduct[k].count++; perProduct[k].outstanding += L.outstandingOf(l); perProduct[k].principal += l.amount; }
    const scores = q.all("SELECT credit_score s FROM users WHERE role = 'user'").map((x) => x.s);
    const bucket = (lo, hi) => scores.filter((s) => s >= lo && s < hi).length;
    return {
      totals: { applications: all.length, pending: by('pending_review').length, approved: by('approved').length, active: active.length, overdue: overdue.length, defaulted: by('defaulted').length, repaid: by('repaid').length,
        outstanding: active.concat(by('defaulted')).reduce((s, l) => s + L.outstandingOf(l), 0), disbursed: all.filter((l) => l.disbursed_at).reduce((s, l) => s + l.amount, 0),
        repaidTotal: all.reduce((s, l) => s + l.repaid, 0), collected: all.reduce((s, l) => s + (l.collected || 0), 0), lateFees: all.reduce((s, l) => s + (l.late_fees || 0), 0) },
      perProduct: Object.values(perProduct),
      overdue: overdue.map((l) => { const i = q.get("SELECT * FROM loan_instalments WHERE loan_id = ? AND status != 'paid' ORDER BY n LIMIT 1", l.id); const u = q.get('SELECT email FROM users WHERE id = ?', l.user_id); return { id: l.id, email: u && u.email, product: l.product, outstanding: L.outstandingOf(l), daysLate: Math.floor((now() - i.due_at) / 864e5), delegations: q.val("SELECT COUNT(*) FROM loan_delegations WHERE loan_id = ? AND status = 'confirmed'", l.id) }; }),
      defaults: by('defaulted').map((l) => ({ id: l.id, product: l.product, outstanding: L.outstandingOf(l), collected: l.collected || 0 })),
      scores: [['<500', bucket(0, 500)], ['500–599', bucket(500, 600)], ['600–699', bucket(600, 700)], ['700–779', bucket(700, 780)], ['780+', bucket(780, 9999)]]
    };
  });
  r.get('/api/admin/loans.csv', (c) => {
    S.requirePerm(c, permFor(c));
    const rows = q.all('SELECT l.*, u.email, p.name product FROM loans l JOIN users u ON u.id = l.user_id JOIN loan_products p ON p.id = l.product_id ORDER BY l.id');
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = 'id,email,product,status,amount,apr,term_days,instalments,owed,repaid,outstanding,late_fees,collected,credit_score,wallet,created,disbursed,due,disburse_method,disburse_ref\n' +
      rows.map((l) => [l.id, l.email, l.product, l.status, l.amount, l.apr, l.term_days, l.instalments, L.owedOf(l).toFixed(2), l.repaid.toFixed(2), L.outstandingOf(l).toFixed(2), l.late_fees, l.collected, l.credit_score, l.wallet_address, new Date(l.created_at).toISOString(), l.disbursed_at ? new Date(l.disbursed_at).toISOString() : '', l.due_at ? new Date(l.due_at).toISOString() : '', l.disburse_method || '', l.disburse_ref || ''].map(esc).join(',')).join('\n');
    send(c.res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nectra-loan-book.csv"' });
    return c.STREAM;
  });

  /* ---------- treasury & collector keys ---------- */
  r.get('/api/admin/treasury', async (c) => {
    S.requirePerm(c, permFor(c));
    const s = getSettings();
    const out = { settings: { treasury_solana: s.treasury_solana, treasury_evm: s.treasury_evm, treasury_tron: s.treasury_tron }, collectors: {} };
    try { const sol = require('../chains/solana'); const addr = sol.collectorAddress(); out.collectors.solana = { address: addr, sol: (await sol.conn.getBalance(new (require('@solana/web3.js').PublicKey)(addr))) / 1e9, note: 'Needs ~0.01 SOL for collection fees' }; } catch (e) { out.collectors.solana = { error: e.message }; }
    try { const evm = require('../chains/evm'); out.collectors.evm = { address: evm.collectorAddress(), note: 'Needs native gas on each chain you collect on' }; } catch (e) { out.collectors.evm = { error: e.message }; }
    try { const tron = require('../chains/tron'); out.collectors.tron = { address: tron.collectorAddress(), note: 'Needs TRX for energy' }; } catch (e) { out.collectors.tron = { error: e.message }; }
    out.collateral = { BTC: process.env.BTC_COLLATERAL_XPUB ? 'xpub configured' : 'DEV key (set BTC_COLLATERAL_XPUB)', LTC: process.env.LTC_COLLATERAL_XPUB ? 'xpub configured' : 'DEV key (set LTC_COLLATERAL_XPUB)' };
    out.market = market.source();
    out.ai = { enabled: require('../ai').enabled(), model: require('../ai').MODEL };
    return out;
  });

  /* ---------- two-admin action queue ---------- */
  function notifyAdminsExcept(exceptId, title, body, link) {
    q.all("SELECT id FROM users WHERE role IN ('admin','super_admin') AND status = 'active' AND id != ?", exceptId).forEach((x) => notify(x.id, 'security', title, body, link));
  }
  function createAction(a, type, target, payload, amount, req) {
    const id = q.run('INSERT INTO pending_actions(type, target, payload, amount, requested_by, approvals, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)', type, String(target), JSON.stringify(payload), amount, a.id, JSON.stringify([a.id]), now(), now()).id;
    notifyAdminsExcept(a.id, 'Approval needed', `${a.email} requested ${type} of $${Number(amount).toFixed(2)} — a second admin must approve.`, '/admin/#actions');
    S.audit(a.id, 'admin.action_request', id, { type, target, amount }, req);
    return id;
  }
  async function executeAction(act, approver) {
    const p = J(act.payload);
    if (act.type === 'adjust') {
      if (p.amount < 0 && E.accountBalance(p.userId) + p.amount < -1e-9) throw new Error('Adjustment would make the balance negative');
      const k = ['bonus', 'trading_profit', 'adjustment'].includes(p.kind) ? p.kind : 'adjustment';
      q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', p.userId, p.amount, k, p.ref || null, p.note, act.requested_by, now());
      notify(p.userId, 'transfer', k === 'bonus' ? 'Bonus credited' : k === 'trading_profit' ? 'Trading profit credited' : p.amount > 0 ? 'Account credited' : 'Account debited', `${p.amount > 0 ? '+' : ''}$${p.amount.toFixed(2)} · ${p.note}`, 'wallets.html');
      return { balance: E.accountBalance(p.userId) };
    }
    if (act.type === 'payout') return payoutPaid(p.withdrawalId, p.ref);
    if (act.type === 'collect') {
      const l = q.get('SELECT * FROM loans WHERE id = ?', p.loanId);
      const res = await L.collect(l, p.amount);
      notify(l.user_id, 'security', 'Collection executed', `Funds were collected from your approved wallets for overdue loan #${l.id}.`, 'loans.html#mine');
      return { results: res };
    }
    throw new Error('Unknown action');
  }
  r.get('/api/admin/actions', (c) => {
    S.requirePerm(c, permFor(c));
    return { rows: q.all('SELECT a.*, u.email requester FROM pending_actions a JOIN users u ON u.id = a.requested_by ORDER BY a.status = \'pending\' DESC, a.id DESC LIMIT 200').map((x) => ({ ...x, payload: J(x.payload), approvals: J(x.approvals, []), result: J(x.result, null) })) };
  });
  r.post('/api/admin/actions/:id/approve', async (c) => {
    const a = S.requirePerm(c, 'actions.approve');
    const act = q.get("SELECT * FROM pending_actions WHERE id = ? AND status = 'pending'", c.params.id); if (!act) fail(400, 'Action is not pending');
    const approvals = J(act.approvals, []);
    if (approvals.includes(a.id)) fail(403, 'A different admin must give the second approval');
    if (act.type === 'adjust' && !S.can(a, 'ledger.adjust')) fail(403, 'Only super admins can approve balance adjustments');
    approvals.push(a.id);
    q.run("UPDATE pending_actions SET approvals = ?, status = 'executing', updated_at = ? WHERE id = ?", JSON.stringify(approvals), now(), act.id);
    try {
      const result = await executeAction(act, a);
      q.run("UPDATE pending_actions SET status = 'executed', result = ?, updated_at = ? WHERE id = ?", JSON.stringify(result || {}), now(), act.id);
      S.audit(a.id, 'admin.action_execute', act.id, { type: act.type }, c.req);
      return { ok: true, result };
    } catch (e) {
      q.run("UPDATE pending_actions SET status = 'failed', result = ?, updated_at = ? WHERE id = ?", JSON.stringify({ error: e.message }), now(), act.id);
      fail(400, 'Execution failed: ' + e.message);
    }
  });
  r.post('/api/admin/actions/:id/reject', (c) => {
    const a = S.requirePerm(c, 'actions.approve');
    const n = q.run("UPDATE pending_actions SET status = 'rejected', result = ?, updated_at = ? WHERE id = ? AND status = 'pending'", JSON.stringify({ by: a.email, reason: str(c.body.reason, 200) }), now(), c.params.id).changes;
    if (!n) fail(400, 'Action is not pending');
    S.audit(a.id, 'admin.action_reject', c.params.id, null, c.req);
    return { ok: true };
  });

  /* ---------- payouts (account-balance withdrawals, processed manually) ---------- */
  r.get('/api/admin/payouts', (c) => {
    S.requirePerm(c, permFor(c));
    return { rows: q.all("SELECT w.*, u.email, u.name FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.source = 'account' AND w.status != 'awaiting_code' ORDER BY w.status = 'pending_admin' DESC, w.id DESC LIMIT 300") };
  });
  function payoutPaid(id, ref) {
    const w = q.get("SELECT * FROM withdrawals WHERE id = ? AND source = 'account' AND status = 'pending_admin'", id); if (!w) throw new Error('Payout is not pending');
    if (!q.run("UPDATE withdrawals SET status = 'paid', admin_ref = ?, updated_at = ? WHERE id = ? AND status = 'pending_admin'", ref, now(), w.id).changes) throw new Error('Payout is not pending');
    q.run('INSERT INTO transactions(user_id, type, token, amount, status, to_addr, signature, simulated, confirmations, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', w.user_id, 'Withdraw', w.token, w.amount, 'confirmed', w.to_addr, ref, 0, 32, 'Account payout (processed by NECTRA)', now(), now());
    notify(w.user_id, 'transfer', 'Payout sent', `${w.amount.toFixed(2)} was sent to ${w.to_addr.slice(0, 4)}…${w.to_addr.slice(-4)} · ref ${ref.slice(0, 16)}`, 'portfolio.html#history');
    return { ok: true };
  }
  r.post('/api/admin/payouts/:id/paid', (c) => { const a = S.requirePerm(c, permFor(c)); return S.idempotent(c, a.id, () => {
    const w = q.get("SELECT * FROM withdrawals WHERE id = ? AND source = 'account' AND status = 'pending_admin'", c.params.id); if (!w) fail(400, 'Payout is not pending');
    const ref = str(c.body.ref, 120); if (!ref) fail(400, 'Enter the on-chain signature or payment reference');
    if (q.val("SELECT id FROM withdrawals WHERE admin_ref = ? AND id != ?", ref, w.id)) fail(409, 'This reference was already recorded for another payout');
    if (w.amount >= getSettings().dual_approval_threshold) {
      if (q.val("SELECT 1 FROM pending_actions WHERE type = 'payout' AND target = ? AND status = 'pending'", String(w.id))) fail(409, 'Already waiting for a second approval');
      return { pending: true, actionId: createAction(a, 'payout', w.id, { withdrawalId: w.id, ref }, w.amount, c.req) };
    }
    payoutPaid(w.id, ref);
    S.audit(a.id, 'admin.payout_paid', w.id, { ref }, c.req);
    return { ok: true };
  }); });
  r.post('/api/admin/payouts/:id/reject', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const w = q.get("SELECT * FROM withdrawals WHERE id = ? AND source = 'account' AND status = 'pending_admin'", c.params.id); if (!w) fail(400, 'Payout is not pending');
    const reason = str(c.body.reason, 300) || 'Rejected by support';
    tx(() => {
      q.run("UPDATE withdrawals SET status = 'rejected', admin_note = ?, updated_at = ? WHERE id = ?", reason, now(), w.id);
      q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', w.user_id, w.amount, 'refund', 'W' + w.id, 'Payout rejected — funds returned', a.id, now());
    });
    notify(w.user_id, 'transfer', 'Payout rejected', `${reason}. $${w.amount.toFixed(2)} was returned to your account balance.`, 'wallets.html');
    S.audit(a.id, 'admin.payout_reject', w.id, { reason }, c.req);
    return { ok: true };
  });

  /* ---------- bots, transactions, platform kill-switch ---------- */
  r.get('/api/admin/bots', (c) => {
    S.requirePerm(c, permFor(c));
    return { rows: q.all('SELECT b.*, u.email FROM bots b JOIN users u ON u.id = b.user_id ORDER BY b.status = \'running\' DESC, b.updated_at DESC LIMIT 500').map((b) => ({ ...E.botPayload(b), email: b.email, userId: b.user_id, budget: b.budget, updated: b.updated_at })) };
  });
  r.post('/api/admin/bots/:id/pause', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const b = q.get('SELECT * FROM bots WHERE id = ?', c.params.id); if (!b) fail(404, 'Bot not found');
    q.run("UPDATE bots SET status = 'paused', paused_reason = 'Paused by admin', updated_at = ? WHERE id = ?", now(), b.id);
    notify(b.user_id, 'bot', `${b.name} paused by admin`, 'Contact support if you have questions.', 'bot.html');
    S.audit(a.id, 'admin.bot_pause', b.id, null, c.req); return { ok: true };
  });
  r.post('/api/admin/kill-switch', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const users = q.all("SELECT DISTINCT user_id FROM bots WHERE status = 'running'");
    let n = 0;
    users.forEach((u) => { const k = E.pauseAll(u.user_id, 'Platform-wide pause'); n += k; if (k) notify(u.user_id, 'bot', 'All bots paused (platform)', 'NECTRA paused all bots platform-wide. Open positions were kept.', 'bot.html'); });
    S.audit(a.id, 'admin.kill_switch', null, { n }, c.req);
    return { paused: n };
  });
  r.get('/api/admin/transactions', (c) => {
    S.requirePerm(c, permFor(c));
    const { limit, offset } = page(c.query);
    const t = str(c.query.type, 20);
    return { rows: q.all(`SELECT t.*, u.email FROM transactions t JOIN users u ON u.id = t.user_id ${t ? 'WHERE t.type = ?' : ''} ORDER BY t.id DESC LIMIT ? OFFSET ?`, ...(t ? [t] : []), limit, offset).map((x) => ({ ...txRow(x), email: x.email, userId: x.user_id })) };
  });
  r.get('/api/admin/ledger', (c) => { S.requirePerm(c, permFor(c)); return { rows: q.all('SELECT l.*, u.email FROM ledger l JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 300') }; });

  /* ---------- notifications broadcast ---------- */
  r.post('/api/admin/broadcast', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const title = str(c.body.title, 100), body = str(c.body.body, 500);
    if (!title || !body) fail(400, 'Title and message are required');
    const type = ['security', 'bot', 'price', 'transfer'].includes(c.body.type) ? c.body.type : 'bot';
    const users = q.all("SELECT id, email, anti_phishing FROM users WHERE status = 'active'");
    users.forEach((u) => { notify(u.id, type, title, body); if (c.body.email && u.email) sendMail(u.email, title, body, u); });
    S.audit(a.id, 'admin.broadcast', null, { title, n: users.length }, c.req);
    return { sent: users.length };
  });

  /* ---------- status, mailbox, audit, settings ---------- */
  r.patch('/api/admin/status/:name', (c) => {
    const a = S.requirePerm(c, permFor(c));
    const st = ['green', 'amber', 'red'].includes(c.body.state) ? c.body.state : fail(400, 'Invalid state');
    if (!q.get('SELECT 1 FROM status_components WHERE name = ?', c.params.name)) q.run('INSERT INTO status_components(name, state, sort, updated_at) VALUES(?,?,?,?)', c.params.name, st, 99, now());
    q.run('UPDATE status_components SET state = ?, note = ?, updated_at = ? WHERE name = ?', st, str(c.body.note, 200) || null, now(), c.params.name);
    broadcast('status', statusPayload());
    S.audit(a.id, 'admin.status', c.params.name, { state: st }, c.req);
    return statusPayload();
  });
  r.get('/api/admin/mailbox', (c) => { S.requirePerm(c, permFor(c)); return { rows: q.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200') }; });
  r.get('/api/admin/audit', (c) => {
    S.requirePerm(c, permFor(c));
    const { limit, offset } = page(c.query);
    const s = '%' + str(c.query.q, 60) + '%';
    return { rows: q.all('SELECT a.*, u.email actor FROM audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.action LIKE ? OR COALESCE(u.email, \'\') LIKE ? OR COALESCE(a.target, \'\') LIKE ? ORDER BY a.id DESC LIMIT ? OFFSET ?', s, s, s, limit, offset) };
  });
  r.get('/api/admin/settings', (c) => { S.requirePerm(c, permFor(c)); return { settings: getSettings() }; });
  r.patch('/api/admin/settings', (c) => {
    const a = S.requirePerm(c, permFor(c));
    if (c.body.admin_2fa_required === true && !a.totp_enabled) fail(400, 'Enable 2FA on your own account first (Settings → Security), so you don’t lock yourself out');
    if (c.body.treasury_solana && !chain.isSolAddress(String(c.body.treasury_solana))) fail(400, 'Treasury (Solana) is not a valid address');
    if (c.body.treasury_evm && !chain.isEvmAddress(String(c.body.treasury_evm))) fail(400, 'Treasury (EVM) is not a valid address');
    Object.keys(DEFAULT_SETTINGS).forEach((k) => {
      if (c.body[k] === undefined) return;
      const def = DEFAULT_SETTINGS[k];
      const v = typeof def === 'boolean' ? !!c.body[k] : typeof def === 'number' ? num(c.body[k], 0, 1e9, k) : str(c.body[k], 300);
      setSetting(k, v);
    });
    S.audit(a.id, 'admin.settings', null, c.body, c.req);
    return { settings: getSettings() };
  });
  r.get('/api/admin/market', (c) => { S.requirePerm(c, permFor(c)); return { tokens: market.tokens() }; });
};
