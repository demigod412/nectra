/* ==========================================================================
   v2 user routes
   - Loans: credit-scored limits, multi-chain eligibility, one wallet per open
     loan, collection approvals on every network, collateral escrow,
     instalments, repayments (account balance or on-chain, auto-detected)
   - On-chain token approvals / revokes (built here, signed in the wallet)
   - Live bots: dedicated wallet, funding, withdrawal
   - Web push subscriptions · server-built transfers
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, tx, now, J, getSettings } = require('../db');
const { fail } = require('../http');
const S = require('../security');
const chain = require('../chain');
const market = require('../market');
const E = require('../engine');
const L = require('../loans');
const push = require('../push');
const { notify, notifyAdmins } = require('../events');
const { sendMail } = require('../mail');
const { consumeWalletProof } = require('./auth');

const num = (v, min = 0, max = 1e12, name = 'Amount') => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} is out of range`); return n; };
const str = (v, max = 60) => String(v == null ? '' : v).trim().slice(0, max);
const lazy = (m) => { let x; return () => x || (x = require(m)); };
const sol = lazy('../chains/solana'), evm = lazy('../chains/evm'), tron = lazy('../chains/tron'), utxo = lazy('../chains/utxo');

function treasuries() {
  const s = getSettings();
  return { solana: s.treasury_solana || null, evm: s.treasury_evm || null, tron: s.treasury_tron || null };
}
function loanView(l) {
  const p = q.get('SELECT * FROM loan_products WHERE id = ?', l.product_id) || {};
  const owed = L.owedOf(l);
  return {
    id: l.id, product: p.name, kind: p.kind || 'history', amount: l.amount, asset: l.asset, apr: l.apr, termDays: l.term_days, instalmentsCount: l.instalments,
    status: l.status, wallet: l.wallet_address, purpose: l.purpose, owed, repaid: l.repaid, outstanding: Math.max(0, owed - l.repaid), lateFees: l.late_fees,
    dueAt: l.due_at, createdAt: l.created_at, disbursedAt: l.disbursed_at, disburseMethod: l.disburse_method, disburseSig: l.disburse_sig, note: l.admin_note,
    approvals: J(l.approvals, []).length, overdue: l.status === 'disbursed' && !!q.val("SELECT 1 FROM loan_instalments WHERE loan_id = ? AND status != 'paid' AND due_at < ?", l.id, now()),
    instalments: q.all('SELECT n, due_at, amount, paid, late_fee, status FROM loan_instalments WHERE loan_id = ? ORDER BY n', l.id),
    delegations: q.all('SELECT network, token, owner, amount, status, allowance, simulated FROM loan_delegations WHERE loan_id = ?', l.id),
    collateral: l.collateral_asset ? { asset: l.collateral_asset, required: l.collateral_required, received: l.collateral_received, address: l.collateral_address, status: l.collateral_status } : null
  };
}
module.exports.loanView = loanView;

module.exports = Object.assign((r) => {
  /* ======================= LOANS ======================= */
  r.get('/api/loans', (c) => {
    const u = S.requireUser(c);
    const score = L.creditScore(u.id);
    const band = L.scoreBand(score);
    return {
      products: q.all('SELECT * FROM loan_products WHERE active = 1 ORDER BY kind, min_amount').map((p) => ({ ...p, max_for_you: L.maxFor(p, score), collateral_assets: (p.collateral_assets || '').split(',').filter((a) => ['BTC', 'LTC'].includes(a)) })),
      loans: q.all('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC', u.id).map(loanView),
      accountBalance: E.accountBalance(u.id), demo: getSettings().demo_mode,
      credit: { score, band: band.band, multiplier: band.mult },
      repaymentAddresses: treasuries(),
      prices: { BTC: market.price('BTC'), LTC: market.price('LTC') }
    };
  });

  r.post('/api/loans/check', async (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'loancheck', 10, 60000);
    try { require('../compliance').requireTerms(u); require('../compliance').requireKycForLoan(u); } catch (e) { fail(e.status || 451, e.message); }
    const p = q.get('SELECT * FROM loan_products WHERE id = ? AND active = 1', c.body.productId); if (!p) fail(404, 'Loan product not found');
    const score = L.creditScore(u.id);
    const cap = Math.min(p.max_amount, L.maxFor(p, score));
    const amount = num(c.body.amount, p.min_amount, Math.max(cap, p.min_amount), `Amount (your limit is $${cap.toLocaleString()} at credit score ${score})`);
    if (q.val("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('pending_review','approved','disbursed','defaulted')", u.id)) fail(400, 'You already have an open loan or application. Repay or cancel it first.');
    const n = await consumeWalletProof(c.body, 'loan', u.id);
    const clash = L.walletInUse(n.address);
    if (clash) fail(409, 'This wallet already backs another open loan. Each wallet can secure only one loan at a time.');
    const demo = getSettings().demo_mode && c.body.provider === 'Demo wallet';
    if (c.body.provider === 'Demo wallet' && !getSettings().demo_mode) fail(403, 'Demo wallets can’t be used for loan checks');
    // remember the wallet (verified by the signature)
    let w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?)', u.id, n.address);
    if (!w) {
      const id = q.run("INSERT INTO wallets(user_id, name, address, chain, family, kind, source, provider, verified, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", u.id, 'Loan wallet', n.address, { solana: 'Solana', evm: 'EVM', tron: 'Tron' }[n.family], n.family, q.val("SELECT 1 FROM wallets WHERE user_id = ? AND kind='main'", u.id) || n.family !== 'solana' ? 'buyer' : 'main', demo ? 'demo' : 'connected', str(c.body.provider, 40), 1, now(), now()).id;
      w = q.get('SELECT * FROM wallets WHERE id = ?', id);
    } else q.run('UPDATE wallets SET verified = 1, verified_at = ? WHERE id = ?', now(), w.id);
    let snap;
    try { snap = await L.snapshot(w, { demo }); }
    catch (e) { if (!getSettings().demo_mode) fail(502, 'Couldn’t read your wallet from the network — try again shortly'); snap = { ...chain.simulatedSnapshot(n.address, market.price('SOL')), source: 'simulated (RPC unavailable)' }; }
    const ev = L.evaluate(p, amount, snap, u.id);
    if (p.kind === 'collateral') ev.results.push({ key: 'collateral', label: `Collateral ${p.collateral_ratio}% of the loan in BTC or LTC`, pass: null, value: 'Deposited after you submit' });
    const id = q.run('INSERT INTO loan_checks(user_id, product_id, amount, address, signature, provider, source, sol, usdc, usd, tx_count, age_days, results, eligible, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      u.id, p.id, amount, n.address, str(c.body.signature, 200), str(c.body.provider, 40), snap.source, snap.sol || 0, snap.usdc || 0, snap.usd, snap.txCount, snap.ageDays, JSON.stringify(ev.results), ev.eligible ? 1 : 0, now()).id;
    const owed = amount * (1 + p.apr / 100 * p.term_days / 365);
    let delegations = [];
    if (ev.eligible && p.require_delegation) delegations = await L.requiredDelegations(u.id, owed, n.address);
    S.audit(u.id, 'loan.check', id, { eligible: ev.eligible, source: snap.source, address: n.address }, c.req);
    return { checkId: id, eligible: ev.eligible, results: ev.results, snapshot: snap, address: n.address, family: n.family, product: p, amount, owed, credit: { score, band: L.scoreBand(score).band }, delegationsRequired: !!p.require_delegation, delegations, revokeLockedWhileOpen: getSettings().loan_approval_revoke_in_app === false };
  });

  /** Build the transaction/call the user's wallet must sign for one collection approval */
  r.post('/api/loans/delegations/request', async (c) => {
    const u = S.requireUser(c);
    const ck = q.get('SELECT * FROM loan_checks WHERE id = ? AND user_id = ?', c.body.checkId, u.id); if (!ck) fail(404, 'Eligibility check not found');
    const w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?) AND verified = 1', u.id, str(c.body.owner, 64)); if (!w) fail(403, 'That wallet isn’t verified on your account');
    const p = q.get('SELECT * FROM loan_products WHERE id = ?', ck.product_id);
    const owed = ck.amount * (1 + p.apr / 100 * p.term_days / 365);
    const d = { family: w.family, network: str(c.body.network, 20) || 'Solana', token: str(c.body.token, 10).toUpperCase(), owner: w.address, amount: +owed.toFixed(6) };
    if (w.source === 'demo') return { simulated: true, ...d };
    try { const req = await L.delegationRequest(d); if (!req) fail(400, `This wallet holds no ${d.token} on ${d.network} — nothing to approve`); return { ...d, request: req }; }
    catch (e) { if (e.status) throw e; fail(502, 'Couldn’t prepare the approval: ' + e.message); }
  });
  /** Record + verify a signed approval on-chain */
  r.post('/api/loans/delegations/confirm', async (c) => {
    const u = S.requireUser(c);
    const ck = q.get('SELECT * FROM loan_checks WHERE id = ? AND user_id = ?', c.body.checkId, u.id); if (!ck) fail(404, 'Eligibility check not found');
    const w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?) AND verified = 1', u.id, str(c.body.owner, 64)); if (!w) fail(403, 'That wallet isn’t verified on your account');
    const p = q.get('SELECT * FROM loan_products WHERE id = ?', ck.product_id);
    const owed = +(ck.amount * (1 + p.apr / 100 * p.term_days / 365)).toFixed(6);
    const simulated = w.source === 'demo';
    if (simulated && !getSettings().demo_mode) fail(403, 'Demo wallets are disabled');
    const spender = w.family === 'evm' ? evm().collectorAddress() : w.family === 'tron' ? tron().collectorAddress() : simulated ? 'SIMULATED' : sol().collectorAddress();
    const network = str(c.body.network, 20) || 'Solana', token = str(c.body.token, 10).toUpperCase();
    q.run("DELETE FROM loan_delegations WHERE check_id = ? AND owner = ? AND network = ? AND token = ? AND status != 'confirmed'", ck.id, w.address, network, token);
    const id = q.run('INSERT INTO loan_delegations(check_id, user_id, family, network, token, owner, spender, amount, tx, simulated, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ck.id, u.id, w.family, network, token, w.address, spender, owed, str(c.body.tx, 140) || null, simulated ? 1 : 0, 'pending', now()).id;
    const d = q.get('SELECT * FROM loan_delegations WHERE id = ?', id);
    let a = { allowance: 0 };
    for (let i = 0; i < 6 && a.allowance < owed * 0.999; i++) {  // allow a few seconds for confirmation
      try { a = await L.readAllowance(d); } catch (e) { /* not yet */ }
      if (a.allowance < owed * 0.999) await new Promise((res) => setTimeout(res, 2000));
    }
    const status = a.allowance >= owed * 0.999 ? 'confirmed' : 'pending';
    q.run('UPDATE loan_delegations SET status = ?, allowance = ?, balance = ?, checked_at = ? WHERE id = ?', status, a.allowance, a.balance, now(), id);
    if (status === 'confirmed') q.run('INSERT INTO approvals(user_id, wallet_name, token, spender, spender_address, amount, unlimited, verified, signature, created_at, family, network, onchain, owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', u.id, w.name, token, 'NECTRA loan collection', spender, owed, 0, 1, d.tx, now(), w.family, network, simulated ? 0 : 1, w.address);
    return { id, status, allowance: a.allowance };
  });
  r.get('/api/loans/delegations/:checkId', (c) => {
    const u = S.requireUser(c);
    return { rows: q.all('SELECT id, network, token, owner, amount, status, allowance, simulated FROM loan_delegations WHERE check_id = ? AND user_id = ?', c.params.checkId, u.id) };
  });

  r.post('/api/loans', async (c) => {
    const u = S.requireUser(c);
    try { require('../compliance').requireTerms(u); require('../compliance').requireKycForLoan(u); } catch (e) { fail(e.status || 451, e.message); }
    const ck = q.get('SELECT * FROM loan_checks WHERE id = ? AND user_id = ?', c.body.checkId, u.id);
    if (!ck) fail(404, 'Eligibility check not found — connect your wallet again');
    if (!ck.eligible) fail(400, 'This wallet doesn’t meet the loan criteria');
    if (now() - ck.created_at > 60 * 60000) fail(400, 'Eligibility check expired — please verify your wallet again');
    if (!c.body.accept) fail(400, 'Please accept the loan terms, including the collection approval');
    if (q.val('SELECT 1 FROM loans WHERE check_id = ?', ck.id)) fail(409, 'Already submitted');
    if (q.val("SELECT 1 FROM loans WHERE user_id = ? AND status IN ('pending_review','approved','disbursed','defaulted')", u.id)) fail(400, 'You already have an open loan or application');
    if (L.walletInUse(ck.address)) fail(409, 'This wallet already backs another open loan');
    const p = q.get('SELECT * FROM loan_products WHERE id = ?', ck.product_id);
    if (p.require_delegation) {
      const confirmed = q.all("SELECT * FROM loan_delegations WHERE check_id = ? AND status = 'confirmed'", ck.id);
      if (!confirmed.length) fail(400, 'Sign the collection approval on at least your loan wallet before submitting');
      const required = await L.requiredDelegations(u.id, ck.amount, ck.address);
      const missing = required.filter((d) => !d.demo && !confirmed.some((x) => x.owner.toLowerCase() === d.owner.toLowerCase() && x.network === d.network && x.token === d.token));
      if (missing.length) fail(400, `Approve collection on every wallet that holds stablecoins. Missing: ${missing.map((d) => `${d.token} on ${d.network} (${d.owner.slice(0, 6)}…)`).join(', ')}`);
    }
    let collateral = null;
    if (p.kind === 'collateral') {
      const asset = str(c.body.collateralAsset, 5).toUpperCase();
      if (!['BTC', 'LTC'].includes(asset) || !p.collateral_assets.includes(asset)) fail(400, 'Choose BTC or LTC collateral');
      collateral = { asset, required: +((ck.amount * p.collateral_ratio / 100) / market.price(asset)).toFixed(8) };
    }
    const score = L.creditScore(u.id);
    const id = tx(() => {
      const id = q.run(`INSERT INTO loans(user_id, product_id, check_id, amount, asset, apr, term_days, wallet_address, purpose, status, instalments, credit_score, collateral_asset, collateral_required, collateral_status, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, u.id, p.id, ck.id, ck.amount, p.asset, p.apr, p.term_days, ck.address, str(c.body.purpose, 200) || null, 'pending_review', p.instalments, score,
        collateral && collateral.asset, collateral && collateral.required, collateral ? 'awaiting' : null, now(), now()).id;
      q.run('UPDATE loan_delegations SET loan_id = ? WHERE check_id = ?', id, ck.id);
      if (collateral) q.run('UPDATE loans SET collateral_address = ? WHERE id = ?', utxo().depositAddress(collateral.asset, id).address, id);
      return id;
    });
    notifyAdmins('transfer', 'New loan application', `#${id} · $${ck.amount} ${p.name} · score ${score}`, '/admin/#loans/' + id);
    notify(u.id, 'transfer', 'Loan application submitted', `We’re reviewing your $${ck.amount} ${p.name} application.${collateral ? ` Send ${collateral.required} ${collateral.asset} collateral to the address shown.` : ''}`, 'loans.html#mine');
    if (u.email) sendMail(u.email, 'Loan application received', `Application #${id} for ${ck.amount} ${p.asset} (${p.name}) is under review.`, u);
    S.audit(u.id, 'loan.apply', id, { amount: ck.amount }, c.req);
    return { loan: loanView(q.get('SELECT * FROM loans WHERE id = ?', id)) };
  });
  r.post('/api/loans/:id/cancel', (c) => {
    const u = S.requireUser(c);
    const l = q.get("SELECT * FROM loans WHERE id = ? AND user_id = ? AND status IN ('pending_review','approved')", c.params.id, u.id);
    if (!l) fail(404, 'Only pending applications can be cancelled');
    q.run("UPDATE loans SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), l.id);
    S.audit(u.id, 'loan.cancel', l.id, null, c.req);
    return { ok: true };
  });
  r.post('/api/loans/:id/repay', (c) => { const u = S.requireUser(c); return S.idempotent(c, u.id, () => {
    const l = q.get("SELECT * FROM loans WHERE id = ? AND user_id = ? AND status IN ('disbursed','defaulted')", c.params.id, u.id); if (!l) fail(404, 'No active loan to repay');
    const amt = require('../money').round2(Math.min(num(c.body.amount, 0.01), L.outstandingOf(l))); // whole cents
    const bal = E.accountBalance(u.id);
    if (amt > bal + 1e-9) fail(400, `Your account balance is $${bal.toFixed(2)}. Top it up, or repay on-chain to the repayment address.`);
    q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_at) VALUES(?,?,?,?,?,?)', u.id, -amt, 'loan_repayment', 'L' + l.id, `Repayment for loan #${l.id}`, now());
    L.applyRepayment(l.id, amt, { kind: 'repayment', ref: 'account-balance' });
    return { loan: loanView(q.get('SELECT * FROM loans WHERE id = ?', l.id)), balance: E.accountBalance(u.id) };
  }); });
  r.get('/api/credit', (c) => { const u = S.requireUser(c); const s = L.creditScore(u.id); return { score: s, ...L.scoreBand(s) }; });

  /* ======================= ON-CHAIN APPROVALS ======================= */
  r.post('/api/approvals/build', async (c) => {
    const u = S.requireUser(c);
    const main = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main'", u.id); if (!main) fail(400, 'Connect a main wallet first');
    const token = str(c.body.token, 10).toUpperCase() || 'USDC';
    if (main.source === 'demo' || main.family !== 'solana') return { simulated: true };
    const amount = c.body.unlimited ? 1e12 : num(c.body.amount, 0.000001, 1e12);
    try { const t = await sol().buildApprove(main.address, token, sol().collectorAddress(), amount); if (!t) fail(400, `Your main wallet holds no ${token}`); return { tx: t, spender: sol().collectorAddress(), owner: main.address }; }
    catch (e) { if (e.status) throw e; fail(502, 'Couldn’t build the approval: ' + e.message); }
  });
  r.post('/api/approvals/:id/revoke-build', async (c) => {
    const u = S.requireUser(c);
    const a = q.get('SELECT * FROM approvals WHERE id = ? AND user_id = ? AND revoked_at IS NULL', c.params.id, u.id); if (!a) fail(404, 'Approval not found');
    const lockedLoan = L.revokeLocked(a);
    if (lockedLoan) fail(423, `This approval secures loan #${lockedLoan}. It can't be revoked in NECTRA until the loan is repaid.`);
    if (!a.onchain || a.family !== 'solana') return { simulated: !a.onchain, family: a.family, request: a.family === 'evm' ? await evm().revokeCall(a.network, a.token, a.spender_address) : null };
    return { tx: await sol().buildRevoke(a.owner, a.token) };
  });

  /* ======================= LIVE BOTS ======================= */
  const liveWithdrawing = new Set(); // bot ids with a withdrawal in flight (single process)
  r.post('/api/bots/:id/go-live', (c) => {
    const u = S.requireUser(c);
    const s = getSettings();
    if (!s.live_trading_enabled) fail(403, 'Live trading is not enabled on this platform yet');
    if (!require('../plans').perksFor(u.id).live) fail(402, 'Live trading is a Pro-plan feature. Upgrade on the Plans page to go live.');
    try { require('../compliance').requireKycForLive(u); } catch (e) { fail(e.status || 451, e.message); }
    if (!u.totp_enabled) fail(403, 'Enable 2FA (authenticator app) before going live');
    if (!S.verifyTotp(u.totp_secret, c.body.code)) fail(400, 'Incorrect 2FA code');
    const b = q.get("SELECT * FROM bots WHERE id = ? AND user_id = ?", c.params.id, u.id); if (!b) fail(404, 'Bot not found');
    if (!['Grid', 'DCA', 'Momentum', 'Scalp', 'Breakout', 'Dip-buy', 'Mean-reversion'].includes(b.strategy)) fail(400, `${b.strategy} bots run in paper mode only`);
    if (!require('../chains/solana').MINTS[b.pair.split('/')[0]]) fail(400, 'This token can’t be traded live yet');
    let w = q.get('SELECT * FROM bot_wallets WHERE bot_id = ?', b.id);
    if (!w) { const nw = sol().newBotWallet(); q.run('INSERT INTO bot_wallets(bot_id, address, secret, created_at) VALUES(?,?,?,?)', b.id, nw.address, nw.secret, now()); w = { address: nw.address }; }
    tx(() => {
      // return the paper allocation, start the live bot empty until funded
      E.addHolding(u.id, 'USDC', b.cash); if (b.position) E.addHolding(u.id, b.pair.split('/')[0], b.position);
      q.run("UPDATE bots SET mode = 'live', status = 'paused', paused_reason = 'Fund the bot wallet, then resume', live_address = ?, cash = 0, position = 0, avg_price = 0, budget = 0, state = '{}', updated_at = ? WHERE id = ?", w.address, now(), b.id);
    });
    S.audit(u.id, 'bot.go_live', b.id, { address: w.address }, c.req);
    notify(u.id, 'security', `${b.name} switched to LIVE`, `Fund its wallet ${w.address.slice(0, 4)}…${w.address.slice(-4)} with USDC (max $${s.live_bot_max_usd}) and ~0.02 SOL for fees.`, 'bot.html');
    return { address: w.address, maxUsd: s.live_bot_max_usd };
  });
  r.get('/api/bots/:id/wallet', async (c) => {
    const u = S.requireUser(c);
    const b = q.get('SELECT * FROM bots WHERE id = ? AND user_id = ?', c.params.id, u.id); if (!b || !b.live_address) fail(404, 'Not a live bot');
    const sym = b.pair.split('/')[0];
    try { const bal = await sol().walletBalances(b.live_address, ['USDC', sym]); q.run('UPDATE bots SET cash = ?, position = ?, budget = CASE WHEN budget = 0 THEN ? ELSE budget END WHERE id = ?', bal.USDC || 0, bal[sym] || 0, (bal.USDC || 0) + (bal[sym] || 0) * market.price(sym), b.id); return { address: b.live_address, balances: bal, maxUsd: getSettings().live_bot_max_usd }; }
    catch (e) { fail(502, 'Couldn’t read the bot wallet'); }
  });
  r.post('/api/bots/:id/live-withdraw', async (c) => {
    const u = S.requireUser(c);
    if (liveWithdrawing.has(+c.params.id)) fail(409, 'A withdrawal from this bot is already in progress');
    liveWithdrawing.add(+c.params.id);
    try { return await liveWithdraw(c, u); } finally { liveWithdrawing.delete(+c.params.id); }
  });
  async function liveWithdraw(c, u) {
    if (!u.totp_enabled || !S.verifyTotp(u.totp_secret, c.body.code)) fail(400, 'Incorrect 2FA code');
    const b = q.get('SELECT b.*, w.secret FROM bots b JOIN bot_wallets w ON w.bot_id = b.id WHERE b.id = ? AND b.user_id = ?', c.params.id, u.id); if (!b) fail(404, 'Not a live bot');
    const main = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main' AND verified = 1", u.id); if (!main) fail(400, 'Set a verified main wallet first');
    q.run("UPDATE bots SET status = 'paused', paused_reason = 'Withdrawing funds' WHERE id = ?", b.id);
    const sym = b.pair.split('/')[0], out = [];
    const bal = await sol().walletBalances(b.live_address, ['USDC', sym]);
    for (const t of ['USDC', sym]) if ((bal[t] || 0) > 0) { try { out.push({ token: t, amount: bal[t], sig: await sol().botWithdraw(b.secret, main.address, t, bal[t]) }); } catch (e) { out.push({ token: t, error: e.message }); } }
    if (bal.SOL > 0.003) { try { out.push({ token: 'SOL', amount: bal.SOL - 0.002, sig: await sol().botWithdraw(b.secret, main.address, 'SOL', bal.SOL - 0.002) }); } catch (e) { out.push({ token: 'SOL', error: e.message }); } }
    S.audit(u.id, 'bot.live_withdraw', b.id, { out }, c.req);
    return { transfers: out, to: main.address };
  }

  /* ======================= PUSH ======================= */
  r.get('/api/push/key', () => ({ key: push.init() ? push.publicKey : null }));
  r.post('/api/push/subscribe', (c) => { const u = S.requireUser(c); try { push.subscribe(u.id, c.body.subscription, c.req.headers['user-agent']); } catch (e) { fail(400, e.message); } return { ok: true }; });
  r.post('/api/push/unsubscribe', (c) => { const u = S.requireUser(c); push.unsubscribe(u.id, str(c.body.endpoint, 1000)); return { ok: true }; });
  r.post('/api/push/test', (c) => { const u = S.requireUser(c); notify(u.id, 'bot', 'Push notifications are on 🌸', 'You’ll get bot, price and loan alerts on this device.', 'notifications.html'); return { ok: true }; });

  /* ======================= TRANSACTION BUILDERS ======================= */
  r.post('/api/chain/build-transfer', async (c) => {
    const u = S.requireUser(c);
    const from = q.get('SELECT * FROM wallets WHERE user_id = ? AND address = ? AND verified = 1', u.id, str(c.body.from, 64)); if (!from) fail(403, 'Not one of your verified wallets');
    const to = str(c.body.to, 64); if (!chain.isSolAddress(to)) fail(400, 'Invalid destination');
    const amount = num(c.body.amount, 1e-9, 1e9);
    const token = str(c.body.token || 'SOL', 10).toUpperCase();
    try { return { tx: token === 'SOL' ? await sol().buildSolTransfer(from.address, to, amount) : await sol().buildTokenTransfer(from.address, to, token, amount) }; }
    catch (e) { fail(502, 'Couldn’t build the transaction: ' + e.message); }
  });
  r.get('/api/deposit/addresses', (c) => {
    const u = S.requireUser(c);
    return { wallets: q.all("SELECT id, name, address, family, chain, kind, source FROM wallets WHERE user_id = ? AND verified = 1 ORDER BY kind = 'main' DESC, id", u.id), evmNetworks: Object.keys(evm().NETWORKS) };
  });
}, { loanView });
