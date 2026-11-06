/* ==========================================================================
   Hourly candles for history + backtests
   Source: Binance public market-data API (data-api.binance.vision, no key).
   Cached in SQLite so repeat backtests are instant. Falls back to a seeded
   synthetic series when the API is unreachable (labelled as such).
   ========================================================================== */
'use strict';
const { q, tx, now } = require('./db');

const API = process.env.CANDLES_API || 'https://data-api.binance.vision/api/v3/klines';
const H = 3600e3;
const PAIRS = { SOL: 'SOLUSDT', JUP: 'JUPUSDT', BONK: 'BONKUSDT', WIF: 'WIFUSDT', PYTH: 'PYTHUSDT', JTO: 'JTOUSDT', RAY: 'RAYUSDT', ETH: 'ETHUSDT', BTC: 'BTCUSDT', RENDER: 'RENDERUSDT', LTC: 'LTCUSDT', TRX: 'TRXUSDT', BNB: 'BNBUSDT', POL: 'POLUSDT' };

async function fetchRange(pair, startMs, endMs) {
  const out = [];
  let from = startMs;
  while (from < endMs) {
    const r = await fetch(`${API}?symbol=${pair}&interval=1h&startTime=${from}&endTime=${endMs}&limit=1000`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('candles ' + r.status);
    const rows = await r.json();
    if (!rows.length) break;
    rows.forEach((k) => out.push([k[0], Number(k[4])]));
    from = rows[rows.length - 1][0] + H;
    if (rows.length < 1000) break;
  }
  return out;
}

/* CoinGecko fallback (hourly for ≤90 days, daily beyond — resampled to hourly) */
const GECKO = { SOL: 'solana', JUP: 'jupiter-exchange-solana', BONK: 'bonk', WIF: 'dogwifcoin', PYTH: 'pyth-network', JTO: 'jito-governance-token', RAY: 'raydium', ETH: 'ethereum', BTC: 'bitcoin', RENDER: 'render-token', LTC: 'litecoin', TRX: 'tron', BNB: 'binancecoin', POL: 'polygon-ecosystem-token' };
async function fetchGecko(sym, hours) {
  const days = hours <= 2160 ? Math.ceil(hours / 24) + 1 : 365;
  const key = process.env.COINGECKO_API_KEY;
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${GECKO[sym]}/market_chart?vs_currency=usd&days=${days}`, { headers: key ? { 'x-cg-demo-api-key': key } : {}, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('coingecko ' + r.status);
  const pts = (await r.json()).prices || [];
  if (pts.length < 2) throw new Error('no data');
  // resample onto an hourly grid by linear interpolation
  const out = []; let j = 0;
  for (let t = Math.ceil(pts[0][0] / H) * H; t <= pts[pts.length - 1][0]; t += H) {
    while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
    const [t0, p0] = pts[j], [t1, p1] = pts[j + 1];
    out.push([t, p0 + (p1 - p0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)))]);
  }
  return out;
}
let lastGecko = 0;
const geckoGate = async () => { const wait = 2600 - (Date.now() - lastGecko); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastGecko = Date.now(); };

/** Last `hours` hourly closes for `sym` → { closes:[], source:'binance'|'coingecko'|'synthetic' } */
async function get(sym, hours) {
  const end = Math.floor(now() / H) * H;
  const start = end - (hours - 1) * H;
  if (!PAIRS[sym]) return { closes: null, source: 'synthetic' };
  const cached = () => q.all('SELECT close, ts FROM candles WHERE sym = ? AND ts >= ? ORDER BY ts', sym, start);
  let have = cached();
  const fresh = have.length >= hours * 0.9 && have[have.length - 1].ts >= end - 2 * H;
  if (!fresh) {
    let rows = null, src = null;
    try { rows = await fetchRange(PAIRS[sym], start, end + H); src = 'binance'; } catch (e) { /* blocked or offline */ }
    if (!rows || !rows.length) { try { await geckoGate(); rows = await fetchGecko(sym, hours); src = 'coingecko'; } catch (e) { rows = null; } }
    if (rows && rows.length) { tx(() => rows.forEach(([ts, c]) => q.run('INSERT OR REPLACE INTO candles(sym, ts, close) VALUES(?,?,?)', sym, ts, c))); q.run('INSERT OR REPLACE INTO kv(key, value) VALUES(?,?)', 'candles_src:' + sym, JSON.stringify(src)); }
    have = cached();
  }
  if (have.length >= Math.min(hours * 0.5, 24)) {
    const src = q.get('SELECT value FROM kv WHERE key = ?', 'candles_src:' + sym);
    return { closes: have.map((r) => r.close), source: src ? JSON.parse(src.value) : 'cache' };
  }
  return { closes: null, source: 'synthetic' };
}

module.exports = { get, PAIRS };
