/* ==========================================================================
   First-run seed: admin account, demo trader with realistic data,
   loan products, status components, invite codes.
   ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, tx, now } = require('./db');
const { hashPassword } = require('./security');
const { randomAddress, simulatedSnapshot } = require('./chain');
const market = require('./market');

const DAY = 864e5;

function createUser({ email, password, name, role = 'user', verified = 1, invite = null }) {
  const id = q.run(`INSERT INTO users(email, pw_hash, name, role, email_verified, invite_code, anti_phishing, prefs, risk, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, email, password ? hashPassword(password) : null, name, role, verified, invite,
    'PETAL-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
    JSON.stringify({ theme: 'dark', lang: 'English', ccy: 'USD', emailNotif: true, pushNotif: true }),
    JSON.stringify({ maxDailyLoss: 5, maxPosition: 12500, maxBots: 6, requireLiveConfirm: true }), now()).id;
  return id;
}

function giveStarterPaper(userId, settings) {
  q.run('INSERT OR REPLACE INTO holdings(user_id, token, amount) VALUES(?,?,?)', userId, 'USDC', settings.paper_start_usdc);
  q.run('INSERT OR REPLACE INTO holdings(user_id, token, amount) VALUES(?,?,?)', userId, 'SOL', settings.paper_start_sol);
  q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?, ?)', userId, 'Unsorted');
}

function seed(settings) {
  if (q.val('SELECT COUNT(*) FROM users')) return null;
  const creds = {};
  tx(() => {
    /* ---- admin ---- */
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@nectra.local';
    const adminPw = process.env.ADMIN_PASSWORD || 'Adm-' + crypto.randomBytes(6).toString('base64url') + '9';
    const adminId = createUser({ email: adminEmail, password: adminPw, name: 'Platform Admin', role: 'super_admin' });
    giveStarterPaper(adminId, settings);
    creds.admin = { email: adminEmail, password: adminPw };
    // extra staff so role separation and two-admin approvals can be tried immediately
    const admin2Pw = process.env.ADMIN2_PASSWORD || 'Adm2-' + crypto.randomBytes(5).toString('base64url') + '7';
    giveStarterPaper(createUser({ email: 'ops@nectra.local', password: admin2Pw, name: 'Ops Admin', role: 'admin' }), settings);
    creds.admin2 = { email: 'ops@nectra.local', password: admin2Pw };
    const offPw = process.env.OFFICER_PASSWORD || 'Off-' + crypto.randomBytes(5).toString('base64url') + '3';
    giveStarterPaper(createUser({ email: 'officer@nectra.local', password: offPw, name: 'Loan Officer', role: 'loan_officer' }), settings);
    creds.officer = { email: 'officer@nectra.local', password: offPw };

    /* ---- invites ---- */
    ['NECTRA26', 'BLOSSOM', 'PETAL7Q'].forEach((c) => q.run('INSERT INTO invites(code, kind, created_by, max_uses, note, created_at) VALUES(?,?,?,?,?,?)', c, 'admin', adminId, 50, 'Launch codes', now()));

    /* ---- loan products (eligibility rules editable in Admin → Loan products) ---- */
    [
      ['Starter Credit', 'USDC', 12, 100, 1000, 30, 50, 10, 30, 'history', 1, 5, 3, 1],
      ['Growth Line', 'USDC', 9.5, 1000, 10000, 90, 75, 50, 90, 'history', 3, 5, 3, 1],
      ['Trader Advance', 'USDC', 15, 250, 5000, 60, 100, 25, 60, 'history', 2, 7, 2, 1],
      ['BTC/LTC Collateral Loan', 'USDC', 8, 100, 20000, 90, 0, 0, 0, 'collateral', 3, 5, 3, 0]
    ].forEach((p) => q.run('INSERT INTO loan_products(name, asset, apr, min_amount, max_amount, term_days, min_balance_pct, min_tx_count, min_wallet_age_days, kind, instalments, late_fee_pct, grace_days, require_delegation, collateral_assets, collateral_ratio, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...p, 'BTC,LTC', 150, now()));

    /* ---- status ---- */
    [['Web app', 'green'], ['Trading engine', 'green'], ['Solana RPC', 'green'], ['Price feeds', 'green'], ['Notifications & email', 'green']]
      .forEach(([n, s], i) => q.run('INSERT INTO status_components(name, state, sort, updated_at) VALUES(?,?,?,?)', n, s, i, now()));

    /* ---- demo trader ---- */
    const demoPw = process.env.DEMO_PASSWORD || 'Demo-Trader-2026';
    const uid = createUser({ email: 'demo@nectra.local', password: demoPw, name: 'Demo Trader', invite: 'NECTRA26' });
    q.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', 'NECTRA26');
    creds.demo = { email: 'demo@nectra.local', password: demoPw };
    giveStarterPaper(uid, settings);
    q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_at) VALUES(?,?,?,?,?,?)', uid, 500, 'bonus', 'welcome', 'Welcome bonus (demo)', now());
    q.run("UPDATE users SET onboarding = ? WHERE id = ?", JSON.stringify({ connect: true }), uid);

    ['Snipers', 'DCA'].forEach((f) => q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?,?)', uid, f));
    const main = randomAddress();
    q.run("INSERT INTO wallets(user_id, name, address, kind, source, provider, verified, balance, created_at) VALUES(?,?,?,?,?,?,?,?,?)", uid, 'Main wallet', main, 'main', 'demo', 'Demo wallet', 1, 0.0021, now());
    const bal = [0.0002, 0.0001, 0, 0.0003, 0, 0, 0.0001, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    bal.forEach((b, i) => q.run('INSERT INTO wallets(user_id, name, address, kind, source, folder, verified, balance, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      uid, 'Buyer ' + (i + 1), randomAddress(), 'buyer', 'watch', i < 6 ? 'Snipers' : i < 11 ? 'DCA' : 'Unsorted', 0, b, now() + i));

    const bots = [
      ['Petal Grid', 'Grid', 'SOL/USDC', { token: 'SOL', lo: 90, hi: 103, levels: 20, perLevel: 25 }, 500, 'running'],
      ['Monday DCA', 'DCA', 'SOL/USDC', { token: 'SOL', amount: 50, intervalSec: 604800 }, 1300, 'running'],
      ['Momentum Scout', 'Momentum', 'JUP/USDC', { token: 'JUP', sl: 4, tp: 9, maxPosition: 250, ema: 20 }, 250, 'running'],
      ['Mean Revert', 'Mean-reversion', 'WIF/USDC', { token: 'WIF', dipPct: 2, window: 48, sl: 6, maxPosition: 300 }, 300, 'paused']
    ];
    let allocated = 0;
    bots.forEach(([name, st, pair, cfg, budget, status], k) => {
      const p = market.price(pair.split('/')[0]);
      const pos = st === 'DCA' ? 3 * 50 / p : st === 'Grid' ? 4 * 25 / p : 0;
      const cash = budget - pos * p * 1.001 + (k === 3 ? -23.4 : k * 18);
      q.run('INSERT INTO bots(user_id, name, strategy, pair, config, state, status, budget, cash, position, avg_price, paused_reason, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        uid, name, st, pair, JSON.stringify(cfg), JSON.stringify(st === 'DCA' ? { nextRun: now() + 3 * DAY } : {}), status, budget, cash, pos, pos ? p * 0.97 : 0, status === 'paused' ? 'WIF volatility above risk band' : null, now() - (30 - k) * DAY, now());
      allocated += budget;
    });
    q.run("UPDATE holdings SET amount = amount - ? WHERE user_id = ? AND token = 'USDC'", allocated, uid);

    /* 140 days of trades → PnL calendar, plus 30 days of equity history */
    const r = market.seeded(909);
    const pairs = ['SOL/USDC', 'JUP/USDC', 'SOL/USDC', 'WIF/USDC'];
    const names = ['Petal Grid', 'Momentum Scout', 'Monday DCA', 'Mean Revert'];
    for (let d = 140; d >= 0; d--) {
      if (r() < 0.15) continue;
      const n = 1 + Math.floor(r() * 3);
      for (let j = 0; j < n; j++) {
        const k = Math.floor(r() * 4), pair = pairs[k], p = market.price(pair.split('/')[0]) * (1 + (r() - 0.5) * 0.1);
        const side = r() > 0.45 ? 'sell' : 'buy';
        q.run('INSERT INTO trades(user_id, bot_name, pair, side, size, price, pnl, created_at) VALUES(?,?,?,?,?,?,?,?)', uid, names[k], pair, side, +(r() * 3 + 0.1).toFixed(3), p, side === 'sell' ? +((r() - 0.42) * 40).toFixed(2) : null, now() - d * DAY - Math.floor(r() * DAY));
      }
    }
    // equity history scaled so it ends exactly at today's real paper value (keeps risk checks sane)
    const hist = []; let v = 11200;
    for (let h = 30 * 24; h >= 0; h--) { v *= 1 + (r() - 0.47) * 0.006; hist.push([Math.floor((now() - h * 3600e3) / 300000) * 300000, v]); }
    const holdV = q.all('SELECT token, amount FROM holdings WHERE user_id = ?', uid).reduce((a, x) => a + x.amount * market.price(x.token), 0);
    const botV = q.all('SELECT pair, cash, position FROM bots WHERE user_id = ?', uid).reduce((a, b) => a + b.cash + b.position * market.price(b.pair.split('/')[0]), 0);
    const k = (holdV + botV) / v;
    hist.forEach(([ts, val], i) => q.run('INSERT OR REPLACE INTO equity(user_id, ts, value) VALUES(?,?,?)', uid, ts, i >= hist.length - 30 ? holdV + botV : val * k));

    /* notifications, insights, approvals, address book, referrals, alerts, history */
    [['security', 'New sign-in from Chrome on macOS', 'If this wasn’t you, revoke the session in Settings.', 'settings.html#security'],
      ['bot', 'Petal Grid filled 6 orders', 'Net +$12.40 (paper) on SOL/USDC in the last hour.', 'bot.html'],
      ['price', 'JUP crossed $0.82', 'Your alert “JUP above $0.80” triggered.', 'portfolio.html'],
      ['transfer', 'Deposit confirmed', '0.0021 SOL received on Main wallet · 32/32 confirmations.', 'portfolio.html#history']]
      .forEach(([t, ti, b, l], i) => q.run('INSERT INTO notifications(user_id, type, title, body, link, unread, created_at) VALUES(?,?,?,?,?,?,?)', uid, t, ti, b, l, i < 3 ? 1 : 0, now() - (i + 1) * 1800e3));
    [['trending-up', 'Momentum building on <b>SOL/USDC</b> — Petal Grid raised position 4%.'], ['shield', 'Volatility on <b>WIF</b> above your risk band. Mean Revert stays paused.'], ['sparkles', '<b>JUP</b> broke its 7-day range with 2.3× volume.']]
      .forEach(([ic, t], i) => q.run('INSERT INTO insights(user_id, icon, text, created_at) VALUES(?,?,?,?)', uid, ic, t, now() - (i + 1) * 1500e3));
    [['Main wallet', 'USDC', 'Nectra Router v2', 250, 0, 1], ['Main wallet', 'SOL', 'Nectra Grid Vault', 1.5, 0, 1], ['Buyer 1', 'JUP', 'Aggregator Swap Program', null, 1, 1], ['Buyer 4', 'BONK', 'Unknown program', 5000000, 0, 0]]
      .forEach(([w, t, s, a, u, ver], i) => q.run('INSERT INTO approvals(user_id, wallet_name, token, spender, spender_address, amount, unlimited, verified, last_used_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', uid, w, t, s, randomAddress(), a, u, ver, now() - (i * 9 + 1) * 3600e3, now() - 20 * DAY));
    q.run('INSERT INTO address_book(user_id, label, address, whitelisted, unlock_at, created_at) VALUES(?,?,?,?,?,?)', uid, 'Cold storage', randomAddress(), 1, 0, now() - 10 * DAY);
    q.run('INSERT INTO address_book(user_id, label, address, whitelisted, unlock_at, created_at) VALUES(?,?,?,?,?,?)', uid, 'Exchange deposit', randomAddress(), 1, 0, now() - 9 * DAY);
    q.run('INSERT INTO invites(code, kind, created_by, max_uses, uses, created_at) VALUES(?,?,?,?,?,?)', 'NECTRA-7QX2', 'referral', uid, 5, 4, now() - 25 * DAY);
    q.run('INSERT INTO price_alerts(user_id, token, direction, price, created_at) VALUES(?,?,?,?,?)', uid, 'SOL', 'above', 110, now());
    const types = ['Deposit', 'Withdraw', 'Swap', 'Bot trade', 'Approval'];
    for (let i = 0; i < 24; i++) {
      const ty = types[Math.floor(r() * types.length)], tok = ['SOL', 'USDC', 'JUP'][Math.floor(r() * 3)];
      q.run('INSERT INTO transactions(user_id, type, token, amount, status, signature, simulated, confirmations, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', uid, ty, tok, tok === 'SOL' ? +(r() * 2).toFixed(4) : +(r() * 300).toFixed(2), r() > 0.92 ? 'failed' : 'confirmed', crypto.randomBytes(48).toString('base64url').slice(0, 64), 1, 32, now() - i * DAY * (0.5 + r()), now());
    }

    /* a pending loan application so the admin queue has something to review */
    const loanAddr = main;
    const snap = simulatedSnapshot(loanAddr, market.price('SOL'));
    const results = [{ key: 'balance', label: 'Wallet value ≥ 50% of request', pass: snap.usd >= 250, value: `$${snap.usd.toFixed(2)}` }, { key: 'txs', label: '≥ 10 on-chain transactions', pass: true, value: snap.txCount }, { key: 'age', label: 'Wallet active ≥ 30 days', pass: true, value: Math.round(snap.ageDays) + ' days' }];
    const checkId = q.run('INSERT INTO loan_checks(user_id, product_id, amount, address, provider, source, sol, usdc, usd, tx_count, age_days, results, eligible, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', uid, 1, 500, loanAddr, 'Demo wallet', 'simulated', snap.sol, snap.usdc, snap.usd, snap.txCount, snap.ageDays, JSON.stringify(results), 1, now() - 3600e3).id;
    const seededLoan = q.run('INSERT INTO loans(user_id, product_id, check_id, amount, asset, apr, term_days, wallet_address, purpose, status, instalments, credit_score, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', uid, 1, checkId, 500, 'USDC', 12, 30, loanAddr, 'Increase grid budget', 'pending_review', 1, 640, now() - 3600e3, now() - 3600e3).id;
    q.run("INSERT INTO loan_delegations(loan_id, check_id, user_id, family, network, token, owner, spender, amount, simulated, status, allowance, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", seededLoan, checkId, uid, 'solana', 'Solana', 'USDC', loanAddr, 'SIMULATED', 504.93, 1, 'confirmed', 504.93, now() - 3600e3);
  });
  const file = process.env.CREDENTIALS_FILE || path.join(__dirname, '..', 'data', 'first-run-credentials.txt');
  fs.writeFileSync(file, `NECTRA first-run accounts (change these!)\n\nAdmin: ${creds.admin.email} / ${creds.admin.password}   (super admin)\nAdmin2: ${creds.admin2.email} / ${creds.admin2.password}   (admin — second approver)\nOfficer: ${creds.officer.email} / ${creds.officer.password}   (loan officer)\nDemo trader: ${creds.demo.email} / ${creds.demo.password}\n`);
  return { ...creds, file };
}

module.exports = { seed, createUser, giveStarterPaper };
