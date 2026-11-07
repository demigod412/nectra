/* ==========================================================================
   Loans domain logic (shared by user routes, admin routes and the engine)
   - credit score → limit multiplier
   - multi-chain wallet snapshots for eligibility + re-checks
   - instalment schedules, late fees, reminders, defaults
   - collection delegations (Solana SPL / EVM ERC-20 / Tron TRC-20)
   - on-chain repayment detection + disbursement auto-linking
   - BTC/LTC collateral escrow monitoring
   ========================================================================== */
'use strict';
const { q, tx, now, J, getSettings, kvGet, kvSet } = require('./db');
const chain = require('./chain');
const market = require('./market');
const { notify, notifyAdmins } = require('./events');
const { sendMail } = require('./mail');
const push = require('./push');

const DAY = 864e5;
const OPEN = ['pending_review', 'approved', 'disbursed'];
const lazy = (m) => { let x; return () => x || (x = require(m)); };
const sol = lazy('./chains/solana'), evm = lazy('./chains/evm'), tron = lazy('./chains/tron'), utxo = lazy('./chains/utxo');

/* ---------------- credit score ---------------- */
function creditScore(userId) {
  const u = q.get('SELECT created_at FROM users WHERE id = ?', userId);
  if (!u) return 600;
  const inst = q.get(`SELECT SUM(i.status = 'paid' AND i.late_fee = 0) ontime, SUM(i.late_fee > 0) late FROM loan_instalments i JOIN loans l ON l.id = i.loan_id WHERE l.user_id = ?`, userId) || {};
  const repaid = q.val("SELECT COUNT(*) FROM loans WHERE user_id = ? AND status = 'repaid'", userId) || 0;
  const defaults = q.val("SELECT COUNT(*) FROM loans WHERE user_id = ? AND status = 'defaulted'", userId) || 0;
  const wallets = q.val('SELECT COUNT(*) FROM wallets WHERE user_id = ? AND verified = 1', userId) || 0;
  const ageDays = (now() - u.created_at) / DAY;
  let s = 600 + Math.min(150, (inst.ontime || 0) * 15) - (inst.late || 0) * 35 - defaults * 220 + Math.min(120, repaid * 40) + Math.min(50, ageDays / 6) + Math.min(30, wallets * 10);
  s = Math.round(Math.max(300, Math.min(850, s)));
  q.run('UPDATE users SET credit_score = ? WHERE id = ?', s, userId);
  return s;
}
const scoreBand = (s) => (s < 500 ? { band: 'Poor', mult: 0.5 } : s < 600 ? { band: 'Fair', mult: 0.75 } : s < 700 ? { band: 'Good', mult: 1 } : s < 780 ? { band: 'Very good', mult: 1.25 } : { band: 'Excellent', mult: 1.5 });
const maxFor = (product, score) => Math.round(product.max_amount * scoreBand(score).mult);

/* ---------------- money helpers (integer cents — see money.js for the loan policy) ---------------- */
const M = require('./money');
const owedOf = (l) => M.fromCents(M.owedCents(l));
const outstandingOf = (l) => M.fromCents(M.outstandingCents(l));

/* ---------------- multi-chain wallet snapshot ---------------- */
async function snapshot(wallet, { demo } = {}) {
  const p = market.price;
  if (demo) { const s = chain.simulatedSnapshot(wallet.address, p('SOL')); return { ...s, family: wallet.family, detail: `${s.sol.toFixed(4)} SOL + ${s.usdc.toFixed(2)} USDC, simulated` }; }
  if (wallet.family === 'evm') {
    const b = await evm().balances(wallet.address);
    let usd = 0, tx = 0; const parts = [];
    for (const [net, r] of Object.entries(b)) {
      if (r.error) continue;
      const v = r.native * p(r.nativeSym === 'POL' ? 'POL' : r.nativeSym) + (r.USDC || 0) + (r.USDT || 0);
      usd += v; tx += r.txCount;
      if (v > 0.01) parts.push(`${net} $${v.toFixed(2)}`);
    }
    return { usd, txCount: tx, ageDays: null, detail: parts.join(' · ') || 'no balance', source: 'rpc', family: 'evm', usdc: Object.values(b).reduce((a, r) => a + (r.USDC || 0), 0), sol: 0 };
  }
  if (wallet.family === 'tron') {
    const b = await tron().balances(wallet.address);
    const hist = await (await fetch(`${process.env.TRON_RPC || 'https://api.trongrid.io'}/v1/accounts/${wallet.address}/transactions?limit=200`)).json().catch(() => ({}));
    return { usd: b.TRX * p('TRX') + b.USDT, txCount: (hist.data || []).length, ageDays: b.createdAt ? (now() - b.createdAt) / DAY : null, detail: `${b.TRX.toFixed(2)} TRX + ${b.USDT.toFixed(2)} USDT`, source: 'rpc', family: 'tron', usdc: b.USDT, sol: 0 };
  }
  const s = await chain.walletSnapshot(wallet.address, p('SOL'));
  const usdt = await sol().tokenState(wallet.address, 'USDT').then((x) => x.balance).catch(() => 0);
  return { ...s, usd: s.usd + usdt, detail: `${s.sol.toFixed(4)} SOL + ${s.usdc.toFixed(2)} USDC${usdt ? ` + ${usdt.toFixed(2)} USDT` : ''}`, family: 'solana' };
}
function evaluate(product, amount, snap, userId) {
  const need = amount * product.min_balance_pct / 100;
  const results = [
    { key: 'balance', label: `Wallet value ≥ ${product.min_balance_pct}% of the loan ($${need.toFixed(2)})`, pass: snap.usd >= need, value: `$${snap.usd.toFixed(2)}${snap.detail ? ` (${snap.detail})` : ''}` },
    { key: 'txs', label: `At least ${product.min_tx_count} on-chain transactions`, pass: snap.txCount >= product.min_tx_count, value: snap.txCount >= 1000 ? '1000+' : String(snap.txCount) },
    { key: 'age', label: `Wallet active for ${product.min_wallet_age_days}+ days`, pass: snap.ageDays == null ? null : snap.ageDays >= product.min_wallet_age_days, value: snap.ageDays == null ? 'Not available on this chain — staff will review' : `${Math.floor(snap.ageDays)} days` },
    { key: 'account', label: 'No defaulted loans', pass: !q.val("SELECT 1 FROM loans WHERE user_id = ? AND status = 'defaulted'", userId), value: 'Checked' }
  ];
  return { results, eligible: results.every((r) => r.pass !== false) };
}
/** One wallet may back only one open loan, across ALL users */
function walletInUse(address, exceptLoanId) {
  return q.get(`SELECT id, user_id FROM loans WHERE LOWER(wallet_address) = LOWER(?) AND status IN ('pending_review','approved','disbursed') AND id != ?`, address, exceptLoanId || 0);
}

/** Fresh re-check of a loan's wallet against its product (used before disbursement + periodically) */
async function recheck(loan) {
  const p = q.get('SELECT * FROM loan_products WHERE id = ?', loan.product_id);
  const w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?)', loan.user_id, loan.wallet_address) || { address: loan.wallet_address, family: 'solana', source: 'connected' };
  const demo = w.source === 'demo' && getSettings().demo_mode;
  let snap;
  try { snap = await snapshot(w, { demo }); }
  catch (e) { if (!getSettings().demo_mode) throw new Error('Could not read the wallet from the network'); snap = { ...chain.simulatedSnapshot(w.address, market.price('SOL')), source: 'simulated (RPC unavailable)' }; }
  const ev = evaluate(p, loan.amount, snap, loan.user_id);
  const dels = await refreshDelegations(loan.id);
  const delegOk = !p.require_delegation || dels.some((d) => d.status === 'confirmed');
  const out = { at: now(), ...ev, snapshot: { usd: snap.usd, txCount: snap.txCount, ageDays: snap.ageDays, source: snap.source }, delegations: dels.map((d) => ({ network: d.network, token: d.token, status: d.status, allowance: d.allowance })), delegationOk: delegOk };
  out.ok = ev.eligible && delegOk;
  q.run('UPDATE loans SET recheck = ?, updated_at = ? WHERE id = ?', JSON.stringify(out), now(), loan.id);
  return out;
}

/* ---------------- collection delegations ---------------- */
/** Which approvals the borrower must sign: one per supported token they hold, on every verified wallet */
/**
 * Approvals the borrower must sign: always on the loan wallet, plus every token
 * (USDC/USDT) held on any other verified wallet, on every network.
 */
async function requiredDelegations(userId, owed, loanWallet) {
  const ws = q.all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1 AND source != 'watch'", userId);
  const isLoan = (w) => loanWallet && w.address.toLowerCase() === String(loanWallet).toLowerCase();
  const out = [];
  for (const w of ws) {
    if (w.source === 'demo') { if (isLoan(w)) out.push({ family: 'solana', network: 'Solana', token: 'USDC', owner: w.address, demo: true }); continue; }
    try {
      if (w.family === 'solana') {
        for (const t of ['USDC', 'USDT']) { const st = await sol().tokenState(w.address, t); if (st.balance > 0 || (t === 'USDC' && isLoan(w))) out.push({ family: 'solana', network: 'Solana', token: t, owner: w.address, balance: st.balance, spender: sol().collectorAddress() }); }
      } else if (w.family === 'evm') {
        const b = await evm().balances(w.address);
        const before = out.length;
        for (const [net, r] of Object.entries(b)) for (const t of ['USDC', 'USDT']) if ((r[t] || 0) > 0) out.push({ family: 'evm', network: net, token: t, owner: w.address, balance: r[t], spender: evm().collectorAddress() });
        if (out.length === before && isLoan(w)) out.push({ family: 'evm', network: 'Base', token: 'USDC', owner: w.address, balance: 0, spender: evm().collectorAddress() }); // cheap-gas default
      } else if (w.family === 'tron') {
        const b = await tron().balances(w.address);
        if (b.USDT > 0 || isLoan(w)) out.push({ family: 'tron', network: 'Tron', token: 'USDT', owner: w.address, balance: b.USDT, spender: tron().collectorAddress() });
      }
    } catch (e) { /* unreachable network: user can retry */ }
  }
  return out.map((d) => ({ ...d, amount: +owed.toFixed(6) }));
}
/** Build what the client must sign for a delegation */
async function delegationRequest(d) {
  if (d.family === 'solana') return { kind: 'solana', tx: await sol().buildApprove(d.owner, d.token, sol().collectorAddress(), d.amount) };
  if (d.family === 'evm') return { kind: 'evm', ...(await evm().approveCall(d.network, d.token, evm().collectorAddress(), d.amount)) };
  if (d.family === 'tron') return { kind: 'tron', ...tron().approveCall(tron().collectorAddress(), d.amount) };
  return null;
}
async function readAllowance(d) {
  if (d.simulated) return { allowance: d.amount, balance: d.amount };
  if (d.family === 'solana') { const s = await sol().tokenState(d.owner, d.token); return { allowance: s.delegate === d.spender ? s.delegated : 0, balance: s.balance }; }
  if (d.family === 'evm') return { allowance: await evm().allowance(d.network, d.token, d.owner, d.spender), balance: await evm().tokenBalance(d.network, d.token, d.owner) };
  if (d.family === 'tron') { const b = await tron().balances(d.owner); return { allowance: await tron().allowance(d.owner, d.spender), balance: b.USDT }; }
  return { allowance: 0, balance: 0 };
}
async function refreshDelegations(loanId) {
  const rows = q.all("SELECT * FROM loan_delegations WHERE loan_id = ? AND status IN ('confirmed','pending','revoked')", loanId);
  for (const d of rows) {
    try {
      const a = await readAllowance(d);
      const st = a.allowance >= d.amount * 0.999 ? 'confirmed' : a.allowance > 0 ? 'confirmed' : d.status === 'pending' ? 'pending' : 'revoked';
      if (st === 'revoked' && d.status === 'confirmed') {
        const l = q.get('SELECT * FROM loans WHERE id = ?', loanId);
        flag(l, `Collection approval revoked on ${d.network} ${d.token}`);
      }
      q.run('UPDATE loan_delegations SET status = ?, allowance = ?, balance = ?, checked_at = ? WHERE id = ?', st, a.allowance, a.balance, now(), d.id);
    } catch (e) { /* network error — keep previous */ }
  }
  return q.all('SELECT * FROM loan_delegations WHERE loan_id = ?', loanId);
}
/** Pull up to `amount` from every confirmed delegation (called after two admins approve) */
async function collect(loan, maxAmount) {
  const s = getSettings();
  let remaining = Math.min(maxAmount, outstandingOf(loan));
  const results = [];
  for (const d of q.all("SELECT * FROM loan_delegations WHERE loan_id = ? AND status = 'confirmed'", loan.id)) {
    if (remaining <= 0.01) break;
    try {
      const a = await readAllowance(d);
      const take = M.round2(Math.min(remaining, a.allowance, a.balance)); // whole cents only
      if (take <= 0.01) { results.push({ network: d.network, token: d.token, skipped: 'no allowance or balance' }); continue; }
      let ref;
      if (d.simulated) ref = 'SIM-COLLECT-' + d.id + '-' + now();
      else if (d.family === 'solana') ref = await sol().collect(d.owner, d.token, take, s.treasury_solana || sol().collectorAddress());
      else if (d.family === 'evm') ref = await evm().collect(d.network, d.token, d.owner, take, s.treasury_evm || evm().collectorAddress());
      else if (d.family === 'tron') ref = await tron().collect(d.owner, take, s.treasury_tron || tron().collectorAddress());
      q.run("UPDATE loan_delegations SET status = 'collected' WHERE id = ? AND ? >= amount * 0.999", d.id, take);
      applyRepayment(loan.id, take, { kind: 'collection', ref, network: d.network, token: d.token, simulated: !!d.simulated });
      q.run('UPDATE loans SET collected = ? WHERE id = ?', M.round2((q.val('SELECT collected FROM loans WHERE id = ?', loan.id) || 0) + take), loan.id);
      remaining -= take;
      results.push({ network: d.network, token: d.token, amount: take, ref });
    } catch (e) { results.push({ network: d.network, token: d.token, error: e.message }); }
  }
  return results;
}

/* ---------------- schedule, repayments, late fees ---------------- */
function createSchedule(loan) {
  const n = Math.max(1, loan.instalments || 1);
  const parts = M.splitCents(M.owedCents({ ...loan, late_fees: 0 }), n); // exact: sums to the cent
  const start = loan.disbursed_at || now();
  q.run('DELETE FROM loan_instalments WHERE loan_id = ?', loan.id);
  for (let k = 1; k <= n; k++) {
    q.run('INSERT INTO loan_instalments(loan_id, n, due_at, amount) VALUES(?,?,?,?)', loan.id, k, start + Math.round((loan.term_days * DAY * k) / n), M.fromCents(parts[k - 1]));
  }
  q.run('UPDATE loans SET due_at = ? WHERE id = ?', start + loan.term_days * DAY, loan.id);
}
/** Allocate a payment to instalments (late fees first, oldest first) and close the loan when settled */
function applyRepayment(loanId, amount, meta = {}) {
  return tx(() => {
    const l = q.get('SELECT * FROM loans WHERE id = ?', loanId);
    if (!l) return null;
    // integer cents throughout; never apply more than is outstanding — the rest is reported as excess
    const paymentC = M.toCents(amount);
    const appliedC = Math.min(paymentC, M.outstandingCents(l));
    const excess = M.fromCents(paymentC - appliedC);
    const insts = q.all("SELECT * FROM loan_instalments WHERE loan_id = ? AND status != 'paid' ORDER BY n", loanId);
    for (const a of M.allocate(appliedC, insts).applied) {
      const i = insts.find((x) => x.id === a.id);
      q.run('UPDATE loan_instalments SET paid = ?, status = ? WHERE id = ?', M.fromCents(M.toCents(i.paid) + a.cents), a.settled ? 'paid' : i.status, i.id);
    }
    amount = M.fromCents(appliedC);
    const repaid = M.fromCents(M.toCents(l.repaid) + appliedC);
    const done = M.toCents(repaid) >= M.owedCents(l);
    if (excess > 0) notifyAdmins('transfer', `Overpayment · loan #${l.id}`, `$${excess.toFixed(2)} received beyond what was owed (${meta.ref || 'no ref'}) — refund or credit it manually.`, '/admin/#loans/' + l.id);
    q.run('UPDATE loans SET repaid = ?, status = ?, updated_at = ? WHERE id = ?', repaid, done ? 'repaid' : l.status, now(), l.id);
    q.run('INSERT INTO transactions(user_id, type, token, amount, status, signature, simulated, confirmations, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      l.user_id, 'Loan', meta.token || l.asset, amount, 'confirmed', meta.ref || null, meta.simulated ? 1 : 0, 32, `${meta.kind === 'collection' ? 'Collected' : 'Repayment'} · loan #${l.id}${meta.network ? ' · ' + meta.network : ''}`, now(), now());
    creditScore(l.user_id);
    notify(l.user_id, 'transfer', done ? 'Loan fully repaid 🌸' : meta.kind === 'collection' ? 'Funds collected for overdue loan' : 'Repayment received', `$${amount.toFixed(2)} applied to loan #${l.id}. Outstanding: $${Math.max(0, owedOf(l) - repaid).toFixed(2)}.`, 'loans.html#mine');
    if (done) notifyAdmins('transfer', 'Loan repaid', `Loan #${l.id} is fully repaid`, '/admin/#loans/' + l.id);
    return { done, repaid, applied: amount, excess };
  });
}
function flag(loan, text) {
  if (!loan) return;
  const flags = J(loan.risk_flags, []);
  if (flags.some((f) => f.text === text)) return;
  flags.push({ text, at: now() });
  q.run('UPDATE loans SET risk_flags = ? WHERE id = ?', JSON.stringify(flags.slice(-20)), loan.id);
  notifyAdmins('security', `Risk flag · loan #${loan.id}`, text, '/admin/#loans/' + loan.id);
}

/* ---------------- background jobs (called by the engine) ---------------- */
async function remind(l, i, kind) {
  if (i.reminded.includes(kind)) return;
  q.run('UPDATE loan_instalments SET reminded = reminded || ? WHERE id = ?', kind + ',', i.id);
  const u = q.get('SELECT * FROM users WHERE id = ?', l.user_id);
  const due = i.amount + i.late_fee - i.paid;
  const when = kind === '3d' ? 'in 3 days' : kind === '1d' ? 'tomorrow' : 'today';
  const title = `Loan payment due ${when}`;
  const body = `Instalment ${i.n} of loan #${l.id}: $${due.toFixed(2)} due ${new Date(i.due_at).toDateString()}.`;
  notify(l.user_id, 'transfer', title, body, 'loans.html#mine');
  if (u.email) sendMail(u.email, title, body + '\n\nRepay from your account balance, or send USDC/USDT from your verified wallet to the repayment address shown in the app.', u);
}
async function runSchedules() {
  const s = getSettings();
  for (const l of q.all("SELECT * FROM loans WHERE status = 'disbursed'")) {
    const p = q.get('SELECT * FROM loan_products WHERE id = ?', l.product_id) || { late_fee_pct: 5, grace_days: 3 };
    for (const i of q.all("SELECT * FROM loan_instalments WHERE loan_id = ? AND status != 'paid' ORDER BY n", l.id)) {
      const left = i.due_at - now();
      if (left > 0 && left < 3 * DAY && left > 2 * DAY) await remind(l, i, '3d');
      else if (left > 0 && left < DAY) await remind(l, i, '1d');
      if (left < -p.grace_days * DAY && i.late_fee === 0) {
        const feeC = M.lateFeeCents(M.toCents(i.amount) - M.toCents(i.paid), p.late_fee_pct);
        const fee = M.fromCents(feeC);
        if (!q.run("UPDATE loan_instalments SET late_fee = ?, status = 'late' WHERE id = ? AND late_fee = 0", fee, i.id).changes) continue;
        q.run('UPDATE loans SET late_fees = ? WHERE id = ?', M.fromCents(M.toCents(q.val('SELECT late_fees FROM loans WHERE id = ?', l.id) || 0) + feeC), l.id);
        notify(l.user_id, 'security', 'Late fee applied', `Instalment ${i.n} of loan #${l.id} is ${p.grace_days}+ days overdue. A ${p.late_fee_pct}% late fee ($${fee}) was added.`, 'loans.html#mine');
        creditScore(l.user_id);
      }
      if (left < -s.default_after_days * DAY) {
        q.run("UPDATE loans SET status = 'defaulted', updated_at = ? WHERE id = ?", now(), l.id);
        creditScore(l.user_id);
        notify(l.user_id, 'security', 'Loan in default', `Loan #${l.id} is ${s.default_after_days}+ days overdue. Collection may be initiated using the approvals you granted.`, 'loans.html#mine');
        notifyAdmins('security', 'Loan defaulted', `Loan #${l.id} defaulted — review collection`, '/admin/#loans/' + l.id);
        break;
      }
    }
  }
}
/** Daily: re-verify wallets backing open loans (balance, approvals still in place) */
async function runReverification() {
  const last = kvGet('reverify_at', 0);
  if (now() - last < DAY) return;
  kvSet('reverify_at', now());
  for (const l of q.all("SELECT * FROM loans WHERE status IN ('approved','disbursed')")) {
    try {
      const r = await recheck(l);
      if (!r.delegationOk) flag(l, 'No active collection approval on any wallet');
      const p = q.get('SELECT * FROM loan_products WHERE id = ?', l.product_id);
      if (r.snapshot.usd < outstandingOf(l) * 0.25) flag(l, `Wallet value dropped to $${r.snapshot.usd.toFixed(2)} (<25% of outstanding)`);
      void p;
    } catch (e) { /* retry tomorrow */ }
  }
  for (const w of q.all("SELECT * FROM wallets WHERE verified = 1 AND source = 'connected' AND (verified_at IS NULL OR verified_at < ?)", now() - 90 * DAY)) {
    q.run('UPDATE wallets SET last_check = ? WHERE id = ?', JSON.stringify({ at: now(), note: 'Re-verification due — ask the user to sign again' }), w.id);
  }
}
/** Watch treasuries: match incoming USDC/USDT from borrower wallets → repayments; outgoing → disbursements */
async function runTreasuryScan() {
  const s = getSettings();
  const borrowerByAddr = (addr) => q.get(`SELECT l.* FROM loans l JOIN wallets w ON w.user_id = l.user_id WHERE LOWER(w.address) = LOWER(?) AND l.status IN ('disbursed','defaulted') ORDER BY l.created_at LIMIT 1`, addr);
  const handleIn = (key, items, network, token) => {
    for (const it of items) {
      const id = `${key}:${it.sig}`;
      if (q.get('SELECT 1 FROM seen_transfers WHERE id = ?', id) || !(it.amount > 0) || !it.from) continue;
      q.run('INSERT INTO seen_transfers(id, created_at) VALUES(?,?)', id, now());
      const loan = borrowerByAddr(it.from);
      if (loan) { applyRepayment(loan.id, it.amount, { kind: 'repayment', ref: it.sig, network, token }); continue; }
      // not a loan repayment — maybe a USDC subscription payment from one of the sender's verified wallets
      const owner = token === 'USDC' ? q.get('SELECT user_id FROM wallets WHERE LOWER(address) = LOWER(?) AND verified = 1 LIMIT 1', it.from) : null;
      if (owner && require('./payments').matchOnchainDeposit({ fromAddr: it.from, amount: it.amount, network, userId: owner.user_id })) continue;
      notifyAdmins('transfer', 'Unmatched treasury deposit', `${it.amount} ${token} on ${network} from ${it.from.slice(0, 8)}… — no open loan for this wallet`, '/admin/#transactions');
    }
  };
  if (s.treasury_solana) {
    for (const token of ['USDC', 'USDT']) {
      const key = `sol:${token}`;
      try {
        const r = await sol().scanIncoming(s.treasury_solana, token, (q.get('SELECT cursor FROM chain_scans WHERE key = ?', key) || {}).cursor);
        handleIn(key, r.items.filter((x) => x.amount > 0), 'Solana', token);
        // outgoing: auto-link disbursements of approved loans
        for (const it of r.items) for (const o of it.outflow || []) {
          const l = q.get(`SELECT * FROM loans WHERE status = 'approved' AND wallet_address = ? AND ABS(amount - ?) < 0.01`, o.to, o.amount);
          if (l) markDisbursed(l, { method: 'onchain-auto', ref: it.sig, by: null });
        }
        if (r.cursor) q.run('INSERT OR REPLACE INTO chain_scans(key, cursor, updated_at) VALUES(?,?,?)', key, r.cursor, now());
      } catch (e) { /* retry next round */ }
    }
  }
  if (s.treasury_evm && evm().isAddress(s.treasury_evm)) {
    for (const net of Object.keys(evm().NETWORKS)) for (const token of ['USDC', 'USDT']) {
      const key = `evm:${net}:${token}`;
      try {
        const r = await evm().scanIncoming(net, token, s.treasury_evm, (q.get('SELECT cursor FROM chain_scans WHERE key = ?', key) || {}).cursor);
        handleIn(key, r.items, net, token);
        q.run('INSERT OR REPLACE INTO chain_scans(key, cursor, updated_at) VALUES(?,?,?)', key, r.cursor, now());
      } catch (e) { /* rpc limits */ }
    }
  }
  if (s.treasury_tron) {
    const key = 'tron:USDT';
    try {
      const r = await tron().scanIncoming(s.treasury_tron, (q.get('SELECT cursor FROM chain_scans WHERE key = ?', key) || {}).cursor);
      handleIn(key, r.items, 'Tron', 'USDT');
      q.run('INSERT OR REPLACE INTO chain_scans(key, cursor, updated_at) VALUES(?,?,?)', key, r.cursor, now());
    } catch (e) { /* */ }
  }
}
/** BTC/LTC (and treasury-USDC) collateral deposits for collateral loans */
async function runCollateral() {
  for (const l of q.all("SELECT * FROM loans WHERE collateral_asset IS NOT NULL AND collateral_status IN ('awaiting','partial') AND status IN ('pending_review','approved')")) {
    try {
      if (!['BTC', 'LTC'].includes(l.collateral_asset)) continue;
      const b = await utxo().addressBalance(l.collateral_asset, l.collateral_address);
      const got = b.confirmed + b.pending;
      const st = b.confirmed >= l.collateral_required ? 'received' : got > 0 ? 'partial' : 'awaiting';
      if (st !== l.collateral_status || got !== l.collateral_received) {
        q.run('UPDATE loans SET collateral_received = ?, collateral_status = ?, updated_at = ? WHERE id = ?', got, st, now(), l.id);
        if (st === 'received') { notify(l.user_id, 'transfer', 'Collateral received', `${b.confirmed} ${l.collateral_asset} confirmed for loan #${l.id}.`, 'loans.html#mine'); notifyAdmins('transfer', 'Collateral received', `Loan #${l.id}: ${b.confirmed} ${l.collateral_asset}`, '/admin/#loans/' + l.id); }
      }
    } catch (e) { /* explorer API hiccup */ }
  }
}
function markDisbursed(l, { method, ref, by }) {
  if (l.status !== 'approved') return false;
  const done = tx(() => {
    const at = now();
    // Atomic claim: only one caller can move approved -> disbursed (manual disburse vs treasury auto-link, retries)
    if (!q.run("UPDATE loans SET status = 'disbursed', updated_at = ? WHERE id = ? AND status = 'approved'", at, l.id).changes) return false;
    if (method === 'ledger') q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', l.user_id, l.amount, 'loan_disbursement', ref, `Loan #${l.id} disbursement`, by, at);
    q.run("UPDATE loans SET status = 'disbursed', disbursed_at = ?, disburse_ref = ?, disburse_method = ?, disburse_sig = ?, updated_at = ? WHERE id = ?", at, ref, method, method === 'ledger' ? null : ref, at, l.id);
    createSchedule({ ...l, disbursed_at: at });
    q.run('INSERT INTO transactions(user_id, type, token, amount, status, signature, simulated, confirmations, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', l.user_id, 'Loan', l.asset, l.amount, 'confirmed', method === 'ledger' ? null : ref, 0, 32, `Disbursement · loan #${l.id} · ${method === 'ledger' ? 'account balance' : 'on-chain'} · ${ref}`, at, at);
    return true;
  });
  if (!done) return false;
  const u = q.get('SELECT * FROM users WHERE id = ?', l.user_id);
  const where = method === 'ledger' ? 'your NECTRA account balance' : `your wallet ${l.wallet_address.slice(0, 4)}…${l.wallet_address.slice(-4)}`;
  notify(l.user_id, 'transfer', 'Loan funds sent 🌸', `$${l.amount.toFixed(2)} was sent to ${where}. First payment details are in the app.`, 'loans.html#mine');
  if (u.email) sendMail(u.email, 'Loan funds sent', `${l.amount} ${l.asset} for loan #${l.id} was sent to ${where} (ref ${ref}).`, u);
  if (!by) notifyAdmins('transfer', 'Disbursement auto-linked', `Loan #${l.id} matched treasury transfer ${String(ref).slice(0, 12)}…`, '/admin/#loans/' + l.id);
  return true;
}

module.exports = { creditScore, scoreBand, maxFor, owedOf, outstandingOf, snapshot, evaluate, walletInUse, recheck, requiredDelegations, delegationRequest, readAllowance, refreshDelegations, collect, createSchedule, applyRepayment, markDisbursed, runSchedules, runReverification, runTreasuryScan, runCollateral, flag, OPEN, push };
