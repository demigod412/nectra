/* ==========================================================================
   Background engine (runs every 5 s)
   - paper-trading bots (strategy.step) + risk limits / guardrails
   - price alerts · equity snapshots · deposit confirmations
   - on-chain confirmation polling for submitted transactions
   ========================================================================== */
'use strict';
const { q, tx, now, J, getSettings } = require('./db');
const market = require('./market');
const strategy = require('./strategy');
const chain = require('./chain');
const { notify, insight, toUser } = require('./events');
const { sendMail } = require('./mail');

/* ---------- portfolio valuation ---------- */
function holdingsValue(userId) {
  return q.all('SELECT token, amount FROM holdings WHERE user_id = ?', userId).reduce((a, h) => a + h.amount * market.price(h.token), 0);
}
function botsValue(userId) {
  return q.all('SELECT pair, cash, position FROM bots WHERE user_id = ?', userId).reduce((a, b) => a + b.cash + b.position * market.price(b.pair.split('/')[0]), 0);
}
const portfolioValue = (userId) => holdingsValue(userId) + botsValue(userId);
function addHolding(userId, token, delta) {
  q.run('INSERT INTO holdings(user_id, token, amount) VALUES(?,?,?) ON CONFLICT(user_id, token) DO UPDATE SET amount = amount + excluded.amount', userId, token, delta);
}
function accountBalance(userId) { return q.val('SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = ?', userId) || 0; }

/* ---------- bots ---------- */
function loadBot(row) { return { ...row, config: J(row.config), state: J(row.state) }; }
function saveBot(b) {
  q.run('UPDATE bots SET state = ?, cash = ?, position = ?, avg_price = ?, realized = ?, status = ?, paused_reason = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(b.state), b.cash, b.position, b.avg_price, b.realized, b.status, b.paused_reason || null, now(), b.id);
}
function botPayload(b) {
  const p = market.price(b.pair.split('/')[0]);
  const value = b.cash + b.position * p;
  return { id: b.id, name: b.name, strategy: b.strategy, pair: b.pair, status: b.status, mode: b.mode, pnl: value - b.budget, pnlPct: b.budget ? ((value - b.budget) / b.budget) * 100 : 0, value, position: b.position, paused_reason: b.paused_reason };
}
function pauseAll(userId, reason) {
  const n = q.run("UPDATE bots SET status = 'paused', paused_reason = ?, updated_at = ? WHERE user_id = ? AND status = 'running'", reason, now(), userId).changes;
  if (n) { toUser(userId, 'bots', { paused: true }); }
  return n;
}

function runBots() {
  const t = now();
  const rows = q.all("SELECT * FROM bots WHERE status = 'running' AND mode = 'paper'");
  for (const row of rows) {
    const b = loadBot(row);
    const sym = b.pair.split('/')[0];
    const p = market.price(sym);
    if (!p) continue;
    const res = strategy.step(b, p, t);
    tx(() => {
      for (const tr of res.trades) {
        q.run('INSERT INTO trades(user_id, bot_id, bot_name, pair, side, size, price, pnl, created_at) VALUES(?,?,?,?,?,?,?,?,?)', b.user_id, b.id, b.name, b.pair, tr.side, tr.size, tr.price, tr.pnl, t);
      }
      if (res.pause) { b.status = 'paused'; b.paused_reason = res.pause; }
      saveBot(b);
    });
    res.trades.forEach((tr) => toUser(b.user_id, 'trade', { bot: b.name, pair: b.pair, side: tr.side, size: tr.size, price: tr.price, pnl: tr.pnl, time: t }));
    res.events.forEach((e) => insight(b.user_id, e.icon, e.text));
    if (res.pause) notify(b.user_id, 'bot', `${b.name} paused`, res.pause, 'bot.html');
    if (res.trades.length) toUser(b.user_id, 'bot', botPayload(b));
  }
  runLiveBots(t);
}

/* ---------- live bots: same strategy logic, executed as real Jupiter swaps ----------
   Each live bot trades from its own dedicated wallet (key encrypted in the vault).
   The strategy decides on a scratch copy; only swaps that confirm on-chain are
   committed. Any failure pauses the bot with the reason. */
const liveBusy = new Set();
function runLiveBots(t) {
  if (!getSettings().live_trading_enabled) return;
  for (const row of q.all("SELECT b.*, w.secret FROM bots b JOIN bot_wallets w ON w.bot_id = b.id WHERE b.status = 'running' AND b.mode = 'live'")) {
    if (liveBusy.has(row.id)) continue;
    const b = loadBot(row);
    const sym = b.pair.split('/')[0];
    const p = market.price(sym);
    if (!p) continue;
    const scratch = JSON.parse(JSON.stringify(b));
    const res = strategy.step(scratch, p, t);
    if (!res.trades.length) { if (JSON.stringify(scratch.state) !== JSON.stringify(b.state)) { b.state = scratch.state; saveBot(b); } continue; }
    liveBusy.add(b.id);
    (async () => {
      const sol = require('./chains/solana');
      try {
        for (const tr of res.trades) {
          const swap = tr.side === 'buy' ? await sol.jupiterSwap(row.secret, 'USDC', sym, tr.size * tr.price / (1 - strategy.FEE)) : await sol.jupiterSwap(row.secret, sym, 'USDC', tr.size);
          const size = tr.side === 'buy' ? swap.out : swap.in, usd = tr.side === 'buy' ? swap.in : swap.out;
          const fill = usd / size;
          let pnl = null;
          if (tr.side === 'buy') { b.avg_price = (b.avg_price * b.position + fill * size) / (b.position + size); b.position += size; b.cash -= usd; }
          else { pnl = usd - size * b.avg_price; b.position = Math.max(0, b.position - size); b.cash += usd; b.realized += pnl; if (!b.position) b.avg_price = 0; }
          q.run('INSERT INTO trades(user_id, bot_id, bot_name, pair, side, size, price, pnl, created_at) VALUES(?,?,?,?,?,?,?,?,?)', b.user_id, b.id, b.name, b.pair, tr.side, size, fill, pnl, now());
          q.run('INSERT INTO transactions(user_id, type, token, amount, status, signature, simulated, confirmations, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', b.user_id, 'Bot trade', b.pair, size, 'confirmed', swap.sig, 0, 32, `LIVE ${tr.side.toUpperCase()} via Jupiter · ${b.name}`, now(), now());
          toUser(b.user_id, 'trade', { bot: b.name, pair: b.pair, side: tr.side, size, price: fill, pnl, time: now(), live: true });
        }
        b.state = scratch.state;
        if (res.pause) { b.status = 'paused'; b.paused_reason = res.pause; }
        saveBot(b);
        res.events.forEach((e) => insight(b.user_id, e.icon, e.text + ' <span class="tag tag--green">live</span>'));
      } catch (e) {
        b.status = 'paused'; b.paused_reason = 'Live trade failed: ' + e.message.slice(0, 120);
        saveBot(b);
        notify(b.user_id, 'bot', `${b.name} paused`, b.paused_reason, 'bot.html');
      } finally { liveBusy.delete(b.id); toUser(b.user_id, 'bot', botPayload(b)); }
    })();
  }
}
/** Every 5 minutes: reconcile live bots with their real wallet balances */
let lastLiveSync = 0;
async function syncLiveBots() {
  if (now() - lastLiveSync < 300000) return;
  lastLiveSync = now();
  const sol = require('./chains/solana');
  for (const b of q.all("SELECT * FROM bots WHERE mode = 'live' AND live_address IS NOT NULL")) {
    if (liveBusy.has(b.id)) continue;
    try { const sym = b.pair.split('/')[0]; const bal = await sol.walletBalances(b.live_address, ['USDC', sym]); q.run('UPDATE bots SET cash = ?, position = ?, updated_at = ? WHERE id = ?', bal.USDC || 0, bal[sym] || 0, now(), b.id); } catch (e) { /* rpc */ }
  }
}

/* ---------- risk: daily loss limit + portfolio guard ---------- */
function runRisk() {
  const users = q.all("SELECT DISTINCT u.id, u.risk FROM users u JOIN bots b ON b.user_id = u.id WHERE b.status = 'running'");
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  for (const u of users) {
    const risk = J(u.risk);
    const v = portfolioValue(u.id);
    const open = q.val('SELECT value FROM equity WHERE user_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1', u.id, dayStart.getTime());
    if (open && risk.maxDailyLoss && (v - open) / open * 100 <= -risk.maxDailyLoss) {
      if (pauseAll(u.id, 'Daily loss limit reached')) notify(u.id, 'bot', 'Daily loss limit reached', `All bots paused at −${risk.maxDailyLoss}% today. Open positions were kept.`, 'settings.html#risk');
    }
    const high = q.val('SELECT MAX(value) FROM equity WHERE user_id = ? AND ts >= ?', u.id, now() - 864e5);
    if (high && risk.guardDropPct && (v - high) / high * 100 <= -risk.guardDropPct) {
      if (pauseAll(u.id, `Portfolio guard −${risk.guardDropPct}% triggered`)) notify(u.id, 'bot', 'Portfolio guard triggered', `Portfolio fell ${risk.guardDropPct}% from its 24h high. All bots paused.`, 'bot.html');
    }
  }
}

/* ---------- price alerts ---------- */
function runAlerts() {
  const alerts = q.all('SELECT a.*, u.email, u.anti_phishing FROM price_alerts a JOIN users u ON u.id = a.user_id WHERE a.active = 1');
  for (const a of alerts) {
    const p = market.price(a.token);
    if ((a.direction === 'above' && p >= a.price) || (a.direction === 'below' && p <= a.price)) {
      q.run('UPDATE price_alerts SET active = 0, triggered_at = ? WHERE id = ?', now(), a.id);
      const title = `${a.token} ${a.direction === 'above' ? 'rose above' : 'fell below'} $${a.price}`;
      notify(a.user_id, 'price', title, `Now $${p.toPrecision(5)}. Your alert has been switched off.`, 'portfolio.html');
      if (a.email) sendMail(a.email, `Price alert: ${title}`, `${title}. Current price: $${p.toPrecision(5)}.`, a);
    }
  }
}

/* ---------- equity snapshots (5 min) ---------- */
let lastSnap = 0;
function runSnapshots() {
  const t = Math.floor(now() / 300000) * 300000;
  if (t === lastSnap) return;
  lastSnap = t;
  tx(() => q.all("SELECT id FROM users WHERE status = 'active'").forEach((u) => {
    q.run('INSERT OR REPLACE INTO equity(user_id, ts, value) VALUES(?,?,?)', u.id, t, portfolioValue(u.id));
  }));
  q.run('DELETE FROM equity WHERE ts < ?', now() - 400 * 864e5);
}

/* ---------- transactions: simulated confirmations + real RPC polling ---------- */
let pollN = 0;
async function runTransactions() {
  // simulated (demo) transactions advance 4 confirmations per tick
  for (const t of q.all("SELECT * FROM transactions WHERE status = 'confirming' AND simulated = 1")) {
    const c = Math.min(t.required_conf, t.confirmations + 4);
    if (c >= t.required_conf) finalizeTx(t, 'confirmed', c); else { q.run('UPDATE transactions SET confirmations = ?, updated_at = ? WHERE id = ?', c, now(), t.id); toUser(t.user_id, 'tx', { id: t.id, status: 'confirming', confirmations: c, required: t.required_conf }); }
  }
  // real transactions: poll every 3rd tick
  if (++pollN % 3) return;
  for (const t of q.all("SELECT * FROM transactions WHERE status = 'confirming' AND simulated = 0 AND signature IS NOT NULL LIMIT 20")) {
    try {
      const st = await chain.signatureStatus(t.signature);
      if (!st) { if (now() - t.created_at > 10 * 60000) finalizeTx(t, 'failed', 0, 'Not found on-chain after 10 minutes'); continue; }
      if (st.err) finalizeTx(t, 'failed', 0, 'Transaction failed on-chain');
      else if (st.confirmationStatus === 'finalized') finalizeTx(t, 'confirmed', t.required_conf);
      else { const c = st.confirmations || 1; q.run('UPDATE transactions SET confirmations = ?, updated_at = ? WHERE id = ?', c, now(), t.id); toUser(t.user_id, 'tx', { id: t.id, status: 'confirming', confirmations: c, required: t.required_conf }); }
    } catch (e) { /* RPC hiccup — retry next round */ }
  }
}
function finalizeTx(t, status, conf, note) {
  q.run('UPDATE transactions SET status = ?, confirmations = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?', status, conf, note || null, now(), t.id);
  q.run("UPDATE withdrawals SET status = ?, updated_at = ? WHERE tx_id = ? AND source = 'wallet'", status === 'confirmed' ? 'confirmed' : 'failed', now(), t.id);
  if (status === 'confirmed') {
    // keep cached wallet balances in sync for simulated flows
    if (t.simulated) {
      if (t.to_addr) q.run('UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND address = ?', t.amount, t.user_id, t.to_addr);
      if (t.from_addr) q.run('UPDATE wallets SET balance = MAX(0, balance - ?) WHERE user_id = ? AND address = ?', t.amount, t.user_id, t.from_addr);
    }
    const title = t.type === 'Deposit' ? 'Deposit confirmed' : `${t.type} confirmed`;
    notify(t.user_id, 'transfer', title, `${t.amount} ${t.token} · ${t.required_conf}/${t.required_conf} confirmations${t.simulated ? ' (simulated)' : ''}`, 'portfolio.html#history');
  } else notify(t.user_id, 'transfer', `${t.type} failed`, note || 'The transaction did not confirm.', 'portfolio.html#history');
  toUser(t.user_id, 'tx', { id: t.id, status, confirmations: conf, required: t.required_conf });
}

/* ---------- loans: schedules, reminders, late fees, defaults, chain watchers ---------- */
const every = {};
const due = (k, ms) => { if (now() - (every[k] || 0) < ms) return false; every[k] = now(); return true; };
async function runLoans() {
  const loans = require('./loans');
  if (due('schedules', 10 * 60000)) await loans.runSchedules();
  if (due('treasury', 30000)) await loans.runTreasuryScan();
  if (due('collateral', 60000)) await loans.runCollateral();
  await loans.runReverification();
  if (due('billing', 60 * 60000)) { try { require('./plans').runRenewals(); } catch (e) { console.error('[billing]', e); } }
}
/** Total owed incl. interest + late fees */
function loanOwed(l) { return require('./loans').owedOf(l); }

/* ---------- main loop ---------- */
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try { runBots(); runRisk(); runAlerts(); runSnapshots(); await runTransactions(); await runLoans(); await syncLiveBots(); }
  catch (e) { console.error('[engine]', e); }
  finally { busy = false; }
}
function start() { setInterval(tick, 5000).unref(); setTimeout(tick, 1500); }

module.exports = { start, portfolioValue, holdingsValue, addHolding, accountBalance, loadBot, botPayload, pauseAll, loanOwed, getSettings };
