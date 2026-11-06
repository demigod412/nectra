/* ==========================================================================
   Strategies — natural-language parser (Copilot), the per-tick strategy
   logic shared by the live paper engine AND the backtester.
   The Claude-powered parser lives in server/ai.js and produces the same intent.
   ========================================================================== */
'use strict';
const market = require('./market');
const candles = require('./candles');

const FEE = 0.001; // 0.1% simulated fee + slippage
const TOKENS = ['SOL', 'JUP', 'BONK', 'WIF', 'PYTH', 'JTO', 'RAY', 'ETH', 'BTC', 'RENDER', 'LTC', 'TRX', 'BNB'];
const fmt$ = (v) => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* ---------- Copilot: text → intent → strategy card ----------
   An *intent* is the small structured object both the rule-based parser and
   the Claude-powered parser (server/ai.js) produce. buildStrategy() turns it
   into the exact bot config + human-readable rows the user reviews. */
const INTENT_TYPES = ['DCA', 'Grid', 'Momentum', 'Scalp', 'Breakout', 'Dip-buy', 'Mean-reversion', 'Copy-trader', 'Arbitrage', 'Guardrail', 'unsupported'];

function intentFromText(text) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return null;
  const tokMatch = t.toUpperCase().match(new RegExp('\\b(' + TOKENS.join('|') + ')\\b'));
  const T = tokMatch ? tokMatch[1] : 'SOL';
  let m;
  if ((m = t.match(/dca\s*\$?(\d+(?:\.\d+)?)\s*(?:usd[ct]?)?\s*(?:into|in|of)\s*(\w+)(?:.*?every\s+(\w+))?/i))) {
    const every = (m[3] || 'monday').toLowerCase();
    return { strategy: 'DCA', token: TOKENS.includes(m[2].toUpperCase()) ? m[2].toUpperCase() : T, amount_usd: +m[1], interval: /day|daily/.test(every) ? 'daily' : /hour/.test(every) ? 'hourly' : 'weekly', weekday: /day|daily|hour/.test(every) ? null : every };
  }
  if ((m = t.match(/stop all bots? if (?:my )?(?:portfolio|balance)? ?(?:drops|falls|is down) (\d+(?:\.\d+)?)\s*%/i))) return { strategy: 'Guardrail', drop_pct: +m[1] };
  if ((m = t.match(/grid.*?(\w+)\s*\/\s*(\w+).*?\$?(\d+(?:\.\d+)?)\s*(?:and|-|to)\s*\$?(\d+(?:\.\d+)?)/i))) return { strategy: 'Grid', token: TOKENS.includes(m[1].toUpperCase()) ? m[1].toUpperCase() : T, range_low: +m[3], range_high: +m[4] };
  if ((m = t.match(/buy \$?(\d+(?:\.\d+)?)\s*(?:of\s*)?(\w+).*?(?:dips?|drops?|falls?)\s*(\d+(?:\.\d+)?)\s*%/i))) return { strategy: 'Dip-buy', token: TOKENS.includes(m[2].toUpperCase()) ? m[2].toUpperCase() : T, amount_usd: +m[1], dip_pct: +m[3] };
  if ((m = t.match(/mean.?rever\w*\s+(?:on\s+)?(\w+)/i))) return { strategy: 'Mean-reversion', token: TOKENS.includes(m[1].toUpperCase()) ? m[1].toUpperCase() : T };
  if ((m = t.match(/copy\s+@?([\w.]+)(?:.*?\$?(\d+))?/i))) return { strategy: 'Copy-trader', token: T, leader: m[1], max_position_usd: +(m[2] || 200) };
  if (/arbitrage/i.test(t)) return { strategy: 'Arbitrage', token: T, max_position_usd: +((t.match(/\$(\d+)/) || [])[1] || 300) };
  const stopPct = (t.match(/(\d+(?:\.\d+)?)\s*%\s*stop/i) || [])[1];
  const anyPct = (t.match(/(\d+(?:\.\d+)?)\s*%/) || [])[1];
  const trail = /trail/i.test(t);
  if (/scalp/i.test(t)) return { strategy: 'Scalp', token: T, take_profit_pct: anyPct ? +anyPct : null, stop_loss_pct: stopPct ? +stopPct : null, trail };
  if (/break\s?out/i.test(t)) return { strategy: 'Breakout', token: T, stop_loss_pct: stopPct ? +stopPct : null, trail };
  return { strategy: 'Momentum', token: T, stop_loss_pct: stopPct ? +stopPct : null, trail };
}

const clampNum = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);
/** Deterministic: intent → { type, name, pair, budget, config, rows } (validates & clamps every number) */
function buildStrategy(i) {
  if (!i || !INTENT_TYPES.includes(i.strategy) || i.strategy === 'unsupported') return null;
  const tok = TOKENS.includes(String(i.token || '').toUpperCase()) ? String(i.token).toUpperCase() : 'SOL';
  const p = market.price(tok);
  switch (i.strategy) {
    case 'DCA': {
      const amt = clampNum(i.amount_usd, 1, 100000, 50);
      const interval = i.interval === 'daily' ? 86400 : i.interval === 'hourly' ? 3600 : 604800;
      const day = i.weekday ? i.weekday[0].toUpperCase() + i.weekday.slice(1).toLowerCase() : 'Monday';
      const label = interval === 86400 ? 'every day' : interval === 3600 ? 'every hour' : `every ${day}`;
      const budget = Math.min(amt * 26, 50000);
      return { type: 'DCA', name: `${tok} DCA`, pair: `${tok}/USDC`, budget, config: { token: tok, amount: amt, intervalSec: interval },
        rows: [['Entry rule', `Buy ${fmt$(amt)} of ${tok} ${label}`], ['Exit', 'None — accumulate'], ['Stop-loss', 'Not applicable'], ['Max position', `${fmt$(budget)} (budget allocated)`]] };
    }
    case 'Guardrail': {
      const d = clampNum(i.drop_pct, 1, 90, 10);
      return { type: 'Guardrail', name: `Portfolio guard −${d}%`, pair: '—', budget: 0, config: { dropPct: d },
        rows: [['Trigger', `Portfolio value falls ${d}% from its 24h high`], ['Action', 'Pause all bots (no new orders)'], ['Open positions', 'Kept — not auto-sold'], ['Re-arm', 'Manual']] };
    }
    case 'Grid': {
      let lo = clampNum(i.range_low, 1e-9, 1e9, p * 0.92), hi = clampNum(i.range_high, 1e-9, 1e9, p * 1.08);
      if (lo > hi) [lo, hi] = [hi, lo];
      const levels = 20, budget = clampNum(i.max_position_usd, 50, 100000, 500);
      return { type: 'Grid', name: `${tok}/USDC grid`, pair: `${tok}/USDC`, budget, config: { token: tok, lo, hi, levels, perLevel: budget / levels },
        rows: [['Range', `${fmt$(lo)} – ${fmt$(hi)}`], ['Grid levels', `${levels} (step ${fmt$((hi - lo) / levels)})`], ['Entry rule', 'Buy each level crossed downward, sell each level crossed upward'], ['Stop-loss', `Close grid if price < ${fmt$(lo * 0.95)}`], ['Take-profit', `Close grid if price > ${fmt$(hi * 1.05)}`], ['Max position', fmt$(budget)]] };
    }
    case 'Dip-buy': {
      const amt = clampNum(i.amount_usd, 1, 100000, 100), dip = clampNum(i.dip_pct, 0.5, 90, 5);
      const sl = clampNum(i.stop_loss_pct, 0.5, 90, 8), tp = clampNum(i.take_profit_pct, 0.5, 500, 12);
      return { type: 'Dip-buy', name: `${tok} dip buy`, pair: `${tok}/USDC`, budget: amt, config: { token: tok, amount: amt, dipPct: dip, ref: p, sl, tp, trail: 3, expiresAt: Date.now() + 7 * 864e5 },
        rows: [['Entry rule', `Buy ${fmt$(amt)} of ${tok} if price falls ${dip}% (≤ ${fmt$(p * (1 - dip / 100))})`], ['Exit', 'Trailing take-profit (3%)'], ['Stop-loss', `−${sl}% from entry`], ['Take-profit', `+${tp}% then trail`], ['Expires', '7 days']] };
    }
    case 'Mean-reversion': {
      const max = clampNum(i.max_position_usd, 20, 100000, 300), sl = clampNum(i.stop_loss_pct, 0.5, 50, 6), dip = clampNum(i.dip_pct, 0.5, 30, 2);
      return { type: 'Mean-reversion', name: `${tok} mean reversion`, pair: `${tok}/USDC`, budget: max, config: { token: tok, dipPct: dip, window: 48, sl, maxPosition: max },
        rows: [['Entry rule', `Buy when ${tok} is ${dip}% below its 4h average`], ['Exit', 'Sell back at the average'], ['Stop-loss', `−${sl}% from entry`], ['Max position', fmt$(max)]] };
    }
    case 'Copy-trader': {
      const max = clampNum(i.max_position_usd, 20, 100000, 200);
      const leader = String(i.leader || 'lotus.sol').replace(/[^\w.]/g, '').slice(0, 30);
      return { type: 'Copy-trader', name: `Copy ${leader}`, pair: `${tok}/USDC`, budget: max, config: { token: tok, leader, maxPosition: max, sl: clampNum(i.stop_loss_pct, 1, 90, 15) },
        rows: [['Leader', leader], ['Entry rule', 'Mirror the leader’s spot buys, scaled to your budget'], ['Exit', 'Mirror the leader’s sells'], ['Stop-loss', `−${clampNum(i.stop_loss_pct, 1, 90, 15)}% per position`], ['Max position', fmt$(max)]] };
    }
    case 'Arbitrage': {
      const max = clampNum(i.max_position_usd, 20, 100000, 300);
      return { type: 'Arbitrage', name: `${tok} arbitrage`, pair: `${tok}/USDC`, budget: max, config: { token: tok, maxPosition: max },
        rows: [['Entry rule', 'Capture price gaps > 0.15% between venues'], ['Exit', 'Immediate (paired legs)'], ['Max position', fmt$(max)], ['Note', 'Paper simulation only']] };
    }
    case 'Scalp': {
      const tp = clampNum(i.take_profit_pct, 0.1, 10, 0.5), max = clampNum(i.max_position_usd, 20, 100000, 200);
      const sl = clampNum(i.stop_loss_pct, 0.1, 10, Math.max(0.3, +(tp * 0.7).toFixed(2))), trail = i.trail ? clampNum(i.trail_pct, 0.1, 10, 0.3) : 0;
      return { type: 'Scalp', name: `${tok} scalper`, pair: `${tok}/USDC`, budget: max, config: { token: tok, ema: 9, tp, sl, trail, maxPosition: max },
        rows: [['Entry rule', `Buy ${tok} when price ticks up through its fast (9) EMA`], ['Take-profit', `+${tp}%${trail ? ` then trail ${trail}%` : ''}`], ['Stop-loss', `−${sl}%`], ['Style', `High-frequency small moves. Round-trip fee ≈ ${(FEE * 200).toFixed(1)}% — keep targets above it`], ['Max position', fmt$(max)]] };
    }
    case 'Breakout': {
      const sl = clampNum(i.stop_loss_pct, 0.5, 30, 4), tp = clampNum(i.take_profit_pct, 0.5, 200, 10), max = clampNum(i.max_position_usd, 20, 100000, 250);
      const win = Math.round(clampNum(i.breakout_window, 6, 168, 24)), trail = i.trail ? clampNum(i.trail_pct, 0.5, 30, 3) : 0;
      return { type: 'Breakout', name: `${tok} breakout`, pair: `${tok}/USDC`, budget: max, config: { token: tok, window: win, buffer: 0.2, sl, tp, trail, maxPosition: max },
        rows: [['Entry rule', `Buy when ${tok} breaks above its ${win}-period high (+0.2%)`], ['Exit', trail ? `Trail ${trail}% after +${tp}%` : `Take-profit +${tp}%`], ['Stop-loss', `−${sl}% from entry`], ['Max position', fmt$(max)]] };
    }
    default: {
      const sl = clampNum(i.stop_loss_pct, 0.5, 50, 4), tp = clampNum(i.take_profit_pct, 0.5, 500, 9), max = clampNum(i.max_position_usd, 20, 100000, 250);
      const trail = i.trail ? clampNum(i.trail_pct, 0.5, 30, 3) : 0;
      return { type: 'Momentum', name: `${tok} momentum`, pair: `${tok}/USDC`, budget: max, config: { token: tok, sl, tp, maxPosition: max, ema: 20, trail },
        rows: [['Entry rule', `Buy ${tok} when price crosses above its 20-period EMA`], ['Exit', trail ? `Trailing stop ${trail}% (after +${tp}%), or close below EMA` : 'Take-profit, stop-loss, or close below the EMA'], ['Stop-loss', `−${sl}% from entry`], ['Take-profit', `+${tp}%`], ['Max position', fmt$(max)], ['Current price', fmt$(p)]] };
    }
  }
}
const parse = (text) => buildStrategy(intentFromText(text));

/* ---------- per-tick strategy logic (mutates the bot object) ---------- */
function buy(bot, usd, price) {
  usd = Math.min(usd, bot.cash);
  if (usd < 0.5) return null;
  const size = (usd / price) * (1 - FEE);
  bot.avg_price = (bot.avg_price * bot.position + price * size) / (bot.position + size);
  bot.position += size; bot.cash -= usd;
  return { side: 'buy', size, price, pnl: null };
}
function sell(bot, size, price) {
  size = Math.min(size, bot.position);
  if (size <= 1e-12) return null;
  const proceeds = size * price * (1 - FEE);
  const pnl = proceeds - size * bot.avg_price;
  bot.position -= size; bot.cash += proceeds; bot.realized += pnl;
  if (bot.position < 1e-12) { bot.position = 0; bot.avg_price = 0; }
  return { side: 'sell', size, price, pnl };
}

/** Shared exit manager: stop-loss, take-profit, and optional trailing stop (arms after +tp). */
function manageExit(bot, s, p, c) {
  if (bot.position <= 0) return null;
  s.peak = Math.max(s.peak || p, p);
  if (c.sl && p <= bot.avg_price * (1 - c.sl / 100)) return { tr: sell(bot, bot.position, p), reason: 'stop-loss' };
  if (c.trail) {
    if (!s.armed && (!c.tp || p >= bot.avg_price * (1 + c.tp / 100))) s.armed = true;
    if (s.armed && p <= s.peak * (1 - c.trail / 100)) return { tr: sell(bot, bot.position, p), reason: 'trailing take-profit' };
  } else if (c.tp && p >= bot.avg_price * (1 + c.tp / 100)) return { tr: sell(bot, bot.position, p), reason: 'take-profit' };
  return null;
}
const resetTrade = (s) => { s.peak = 0; s.armed = false; };

/**
 * Advance one bot by one price observation.
 * Returns { trades: [], events: [{type, text}], pause: reason|null }
 */
function step(bot, p, t, rnd = Math.random) {
  const c = bot.config, s = bot.state;
  const out = { trades: [], events: [], pause: null };
  const push = (tr) => tr && out.trades.push(tr);
  switch (bot.strategy) {
    case 'DCA': {
      if (!s.nextRun) s.nextRun = t;
      if (t >= s.nextRun) {
        const tr = buy(bot, c.amount, p);
        push(tr);
        s.nextRun = t + c.intervalSec * 1000;
        if (!tr) out.pause = 'Budget fully invested';
      }
      break;
    }
    case 'Grid': {
      const stepSize = (c.hi - c.lo) / c.levels;
      const idx = Math.floor((p - c.lo) / stepSize);
      if (s.lastIdx == null) s.lastIdx = idx;
      if (p < c.lo * 0.95 || p > c.hi * 1.05) {
        push(sell(bot, bot.position, p));
        out.pause = p < c.lo ? 'Price left grid range (stop-loss)' : 'Price left grid range (take-profit)';
        break;
      }
      if (idx < s.lastIdx && p <= c.hi) push(buy(bot, c.perLevel * (s.lastIdx - idx), p));
      else if (idx > s.lastIdx && bot.position > 0) push(sell(bot, (c.perLevel / p) * (idx - s.lastIdx), p));
      s.lastIdx = idx;
      break;
    }
    case 'Momentum': {
      const k = 2 / ((c.ema || 20) + 1);
      s.ema = s.ema == null ? p : s.ema + k * (p - s.ema);
      const above = p > s.ema * 1.002;
      if (bot.position === 0 && above && s.prevAbove === false) { const tr = buy(bot, c.maxPosition, p); if (tr) { push(tr); resetTrade(s); s.peak = p; out.events.push({ icon: 'trending-up', text: `Momentum entry on <b>${bot.pair}</b> at ${p.toPrecision(5)}` }); } }
      else if (bot.position > 0) {
        if (c.trail) { const ex = manageExit(bot, s, p, c); if (ex) { push(ex.tr); resetTrade(s); } else if (p < s.ema * 0.997) { push(sell(bot, bot.position, p)); resetTrade(s); } }
        else if (p <= bot.avg_price * (1 - c.sl / 100) || p >= bot.avg_price * (1 + c.tp / 100) || p < s.ema * 0.997) { push(sell(bot, bot.position, p)); resetTrade(s); }
      }
      s.prevAbove = above;
      break;
    }
    case 'Scalp': {
      s.ema = s.ema == null ? p : s.ema + (2 / ((c.ema || 9) + 1)) * (p - s.ema);
      if (bot.position > 0) { const ex = manageExit(bot, s, p, c); if (ex) { push(ex.tr); resetTrade(s); } }
      else if (p > s.ema && s.prev != null && p > s.prev) { const tr = buy(bot, c.maxPosition, p); if (tr) { push(tr); resetTrade(s); s.peak = p; } }
      s.prev = p;
      break;
    }
    case 'Breakout': {
      s.win = (s.win || []).concat(p).slice(-((c.window || 24) + 1));
      if (bot.position > 0) { const ex = manageExit(bot, s, p, c); if (ex) { push(ex.tr); resetTrade(s); if (ex.reason !== 'stop-loss') out.events.push({ icon: 'trending-up', text: `${bot.pair} breakout ${ex.reason} at ${p.toPrecision(5)}` }); } break; }
      if (s.win.length <= (c.window || 24)) break;
      const hi = Math.max(...s.win.slice(0, -1));
      if (p > hi * (1 + (c.buffer || 0.2) / 100)) { const tr = buy(bot, c.maxPosition, p); if (tr) { push(tr); resetTrade(s); s.peak = p; out.events.push({ icon: 'zap', text: `Breakout entry on <b>${bot.pair}</b> above ${hi.toPrecision(5)}` }); } }
      break;
    }
    case 'Dip-buy': {
      if (s.done) break;
      if (bot.position === 0) {
        if (p <= c.ref * (1 - c.dipPct / 100)) { push(buy(bot, c.amount, p)); s.peak = p; out.events.push({ icon: 'zap', text: `Dip target hit — bought <b>${c.token}</b> at ${p.toPrecision(5)}` }); }
        else if (t > c.expiresAt) { s.done = true; out.pause = 'Dip order expired'; }
      } else {
        s.peak = Math.max(s.peak || p, p);
        if (p <= bot.avg_price * (1 - c.sl / 100)) { push(sell(bot, bot.position, p)); s.done = true; out.pause = 'Stop-loss hit'; }
        else if (p >= bot.avg_price * (1 + c.tp / 100) && p <= s.peak * (1 - c.trail / 100)) { push(sell(bot, bot.position, p)); s.done = true; out.pause = 'Take-profit hit'; }
      }
      break;
    }
    case 'Mean-reversion': {
      s.win = (s.win || []).concat(p).slice(-(c.window || 48));
      const avg = s.win.reduce((a, b) => a + b, 0) / s.win.length;
      if (s.win.length < 8) break;
      if (bot.position === 0 && p < avg * (1 - c.dipPct / 100)) push(buy(bot, c.maxPosition, p));
      else if (bot.position > 0 && (p >= avg || p <= bot.avg_price * (1 - c.sl / 100))) push(sell(bot, bot.position, p));
      break;
    }
    case 'Copy-trader': {
      if (rnd() < 0.02) {
        if (bot.position === 0) { push(buy(bot, c.maxPosition * 0.6, p)); out.events.push({ icon: 'users', text: `<b>${c.leader}</b> opened a position — mirrored on ${bot.pair}` }); }
        else push(sell(bot, bot.position, p));
      } else if (bot.position > 0 && p <= bot.avg_price * (1 - c.sl / 100)) push(sell(bot, bot.position, p));
      break;
    }
    case 'Arbitrage': {
      if (rnd() < 0.04) {
        const usd = Math.min(c.maxPosition * 0.5, bot.cash);
        const b = buy(bot, usd, p);
        if (b) { push(b); push(sell(bot, b.size, p * (1.0015 + rnd() * 0.002))); }
      }
      break;
    }
  }
  return out;
}

/* ---------- backtest + auto-tune (same step() logic, on real hourly candles) ---------- */
/** Fetch a price series for a token, falling back to a seeded synthetic walk. */
async function priceSeries(tok, range) {
  const hours = { '30D': 720, '90D': 2160, '1Y': 8760 }[range] || 2160;
  const real = await candles.get(tok, hours);
  if (real.closes && real.closes.length >= 48) return { prices: real.closes, source: real.source };
  const r = market.seeded(hours + tok.length * 31); const prices = new Array(hours); let p = market.price(tok);
  for (let i = hours - 1; i >= 0; i--) { prices[i] = p; p = p / (1 + (r() - 0.5) * 0.03); }
  return { prices, source: 'synthetic' };
}
/** Run one strategy config over a price array. Returns metrics (+ equity curve). */
function simulate(prices, type, pair, config, budget) {
  const cfg = JSON.parse(JSON.stringify(config || {}));
  if (type === 'Dip-buy') { cfg.ref = prices[0]; cfg.expiresAt = Infinity; }
  if (type === 'Grid' && (prices[0] < cfg.lo * 0.9 || prices[0] > cfg.hi * 1.1)) { const k = prices[0] / (market.price(cfg.token || pair.split('/')[0]) || prices[0]); cfg.lo *= k; cfg.hi *= k; }
  const bot = { strategy: type, pair, config: cfg, state: {}, cash: budget, position: 0, avg_price: 0, realized: 0 };
  const rnd = market.seeded(42); const equity = []; let wins = 0, closed = 0; const start = Date.now() - prices.length * 3600e3;
  for (let i = 0; i < prices.length; i++) { const r = step(bot, prices[i], start + i * 3600e3, rnd); for (const tr of r.trades) if (tr.side === 'sell') { closed++; if (tr.pnl > 0) wins++; } equity.push(bot.cash + bot.position * prices[i]); }
  let peak = equity[0], maxDD = 0; const rets = [];
  equity.forEach((v, i) => { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); if (i) rets.push((v - equity[i - 1]) / equity[i - 1]); });
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  return { equity, winRate: closed ? (wins / closed) * 100 : 0, maxDrawdown: maxDD * 100, sharpe: sd ? (mean / sd) * Math.sqrt(24 * 365) : 0, totalReturn: ((equity[equity.length - 1] - budget) / budget) * 100, trades: closed };
}
async function backtest(strategyData, range = '90D') {
  const tok = (strategyData.config && strategyData.config.token) || 'SOL';
  const { prices, source } = await priceSeries(tok, range);
  const budget = strategyData.budget || 500;
  const m = simulate(prices, strategyData.type, strategyData.pair, strategyData.config, budget);
  const st = Math.max(1, Math.floor(m.equity.length / 90));
  const hodl = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  return { equity: m.equity.filter((_, i) => i % st === 0).map((v) => +v.toFixed(2)), source, points: prices.length, winRate: m.winRate, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe, totalReturn: m.totalReturn, buyAndHold: hodl, trades: m.trades };
}

/* Parameter grids per strategy. Keys map into config; the product is capped for speed. */
const cartesian = (obj) => { const keys = Object.keys(obj); let out = [{}]; for (const k of keys) { const next = []; for (const base of out) for (const v of obj[k]) next.push({ ...base, [k]: v }); out = next; } return out; };
function tuneGrid(type) {
  switch (type) {
    case 'Momentum': return { ema: [10, 20, 30], tp: [6, 9, 15], sl: [3, 4, 6], trail: [0, 3] };
    case 'Scalp': return { ema: [7, 9, 14], tp: [0.3, 0.5, 0.8], sl: [0.2, 0.3, 0.5], trail: [0, 0.3] };
    case 'Breakout': return { window: [12, 24, 48], tp: [6, 10, 20], sl: [3, 4, 6], trail: [0, 3] };
    case 'Dip-buy': return { dipPct: [3, 5, 8], tp: [8, 12, 20], sl: [5, 8], trail: [3] };
    case 'Mean-reversion': return { dipPct: [1, 2, 3], window: [24, 48, 72], sl: [4, 6] };
    case 'Grid': return { levels: [10, 20, 40] };
    default: return null;
  }
}
/**
 * Grid-search parameters against real history and return the best by a
 * drawdown-penalized score. OPTIMISES ON PAST DATA — overfitting is possible,
 * so the result is shown with its drawdown and a buy-and-hold baseline.
 */
async function autotune(strategyData, range = '90D') {
  const grid = tuneGrid(strategyData.type);
  if (!grid) return { tunable: false };
  const tok = (strategyData.config && strategyData.config.token) || 'SOL';
  const { prices, source } = await priceSeries(tok, range);
  const budget = strategyData.budget || 500;
  const hodl = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const base = simulate(prices, strategyData.type, strategyData.pair, strategyData.config, budget);
  const score = (m) => m.totalReturn - 0.35 * Math.abs(m.maxDrawdown) - (m.trades === 0 ? 1e6 : 0);
  let combos = cartesian(grid);
  if (combos.length > 48) combos = combos.filter((_, i) => i % Math.ceil(combos.length / 48) === 0);
  let best = { cfg: strategyData.config, m: base, sc: score(base) };
  for (const combo of combos) {
    const cfg = { ...JSON.parse(JSON.stringify(strategyData.config)), ...combo };
    if ('levels' in combo && strategyData.type === 'Grid') cfg.perLevel = budget / combo.levels;
    const m = simulate(prices, strategyData.type, strategyData.pair, cfg, budget);
    const sc = score(m);
    if (sc > best.sc) best = { cfg, m, sc };
  }
  const changed = JSON.stringify(best.cfg) !== JSON.stringify(strategyData.config);
  return {
    tunable: true, changed, source, points: prices.length, tried: combos.length, range, buyAndHold: hodl,
    params: Object.fromEntries(Object.keys(grid).map((k) => [k, best.cfg[k]])),
    config: best.cfg,
    before: { totalReturn: base.totalReturn, maxDrawdown: base.maxDrawdown, sharpe: base.sharpe, winRate: base.winRate, trades: base.trades },
    after: { totalReturn: best.m.totalReturn, maxDrawdown: best.m.maxDrawdown, sharpe: best.m.sharpe, winRate: best.m.winRate, trades: best.m.trades }
  };
}

module.exports = { parse, intentFromText, buildStrategy, step, backtest, autotune, simulate, FEE, TOKENS, INTENT_TYPES };
