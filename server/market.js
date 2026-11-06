/* ==========================================================================
   Market data
   - Live prices: Pyth Network (Hermes API), polled every 3 s
   - History: real hourly candles (Binance public data API) interpolated onto
     a 5-minute grid for the last 30 days
   - Falls back to a simulated feed when offline or PRICE_FEED=sim
   The rest of the app only uses price(), tokens(), series(), closes().
   ========================================================================== */
'use strict';
const { broadcast } = require('./events');
const candles = require('./candles');

const TOKENS = [
  { sym: 'SOL', name: 'Solana', price: 96.4, color: '#9B5CFF', vol: 0.0035 },
  { sym: 'USDC', name: 'USD Coin', price: 1, color: '#2775CA', vol: 0 },
  { sym: 'USDT', name: 'Tether', price: 1, color: '#26A17B', vol: 0 },
  { sym: 'JUP', name: 'Jupiter', price: 0.8241, color: '#1FA37A', vol: 0.005 },
  { sym: 'BONK', name: 'Bonk', price: 0.00002134, color: '#E2A33A', vol: 0.008 },
  { sym: 'WIF', name: 'dogwifhat', price: 1.732, color: '#B07A56', vol: 0.007 },
  { sym: 'PYTH', name: 'Pyth Network', price: 0.3412, color: '#7A5BE0', vol: 0.005 },
  { sym: 'JTO', name: 'Jito', price: 2.118, color: '#5BB6A6', vol: 0.005 },
  { sym: 'RAY', name: 'Raydium', price: 1.894, color: '#3B6EE8', vol: 0.005 },
  { sym: 'ETH', name: 'Ether', price: 2648.1, color: '#6A7BE8', vol: 0.003 },
  { sym: 'BTC', name: 'Bitcoin', price: 68420, color: '#F2A33A', vol: 0.0025 },
  { sym: 'RENDER', name: 'Render', price: 4.21, color: '#D9474B', vol: 0.006 },
  { sym: 'LTC', name: 'Litecoin', price: 72.5, color: '#A6A9AA', vol: 0.003 },
  { sym: 'TRX', name: 'Tron', price: 0.16, color: '#EB0029', vol: 0.003 },
  { sym: 'BNB', name: 'BNB', price: 590, color: '#F3BA2F', vol: 0.003 },
  { sym: 'POL', name: 'Polygon', price: 0.38, color: '#8247E5', vol: 0.004 }
];
const STEP = 5 * 60 * 1000;
const POINTS = 30 * 288;
const state = new Map();
const HERMES = process.env.PYTH_HERMES || 'https://hermes.pyth.network';
const SIM_ONLY = process.env.PRICE_FEED === 'sim';
let feed = 'simulated', pythIds = {}, pythFailures = 0;

function seeded(seed) { let s = seed | 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

function initSynthetic() {
  const t0 = Math.floor(Date.now() / STEP) * STEP - (POINTS - 1) * STEP;
  TOKENS.forEach((t, k) => {
    const r = seeded(1000 + k * 97);
    const hist = new Float64Array(POINTS);
    let p = t.price;
    for (let i = POINTS - 1; i >= 0; i--) { hist[i] = p; p = p / (1 + (r() - 0.5) * t.vol * 4.2); }
    state.set(t.sym, { ...t, hist, histStart: t0, price: t.price, live: false });
  });
}

/** Replace synthetic history with real hourly candles (interpolated to 5-minute steps) */
async function loadRealHistory() {
  for (const s of state.values()) {
    if (!s.vol) continue;
    try {
      const c = await candles.get(s.sym, 721);
      if (!c.closes || c.closes.length < 600) continue;
      const hist = new Float64Array(POINTS);
      const hourly = c.closes.slice(-721);
      while (hourly.length < 721) hourly.unshift(hourly[0]);
      for (let i = 0; i < POINTS; i++) {
        const h = (i / 12), lo = Math.floor(h), f = h - lo;
        const a = hourly[Math.min(lo, hourly.length - 1)], b = hourly[Math.min(lo + 1, hourly.length - 1)];
        hist[i] = a + (b - a) * f;
      }
      s.hist = hist; s.histStart = Math.floor(Date.now() / STEP) * STEP - (POINTS - 1) * STEP;
      if (!s.live) s.price = hist[POINTS - 1];
      s.hist[POINTS - 1] = s.price; s.realHistory = true;
    } catch (e) { /* keep synthetic */ }
  }
}

/* ---- Live price providers (first that works wins):
   1. Pyth Hermes — when PYTH_API_KEY is set (public Hermes now requires a key)
   2. Jupiter Price API v3 (Solana tokens, free) + CoinGecko simple price (BTC, ETH, LTC, TRX, BNB, POL)
   3. simulated */
const PYTH_KEY = process.env.PYTH_API_KEY;
const pythHeaders = PYTH_KEY ? { 'x-api-key': PYTH_KEY, Authorization: 'Bearer ' + PYTH_KEY } : {};
async function discoverPyth() {
  if (!PYTH_KEY) return 0;
  for (const t of TOKENS) {
    try {
      const r = await (await fetch(`${HERMES}/v2/price_feeds?query=${t.sym}&asset_type=crypto`, { headers: pythHeaders, signal: AbortSignal.timeout(8000) })).json();
      const hit = (r || []).find((f) => f.attributes && f.attributes.symbol === `Crypto.${t.sym}/USD`);
      if (hit) pythIds[t.sym] = hit.id.replace(/^0x/, '');
    } catch (e) { /* offline */ }
  }
  return Object.keys(pythIds).length;
}
async function pollPyth() {
  const ids = Object.entries(pythIds);
  if (!ids.length) return false;
  try {
    const qs = ids.map(([, id]) => 'ids[]=' + id).join('&');
    const r = await (await fetch(`${HERMES}/v2/updates/price/latest?${qs}&parsed=true`, { headers: pythHeaders, signal: AbortSignal.timeout(6000) })).json();
    const byId = Object.fromEntries(ids.map(([sym, id]) => [id, sym]));
    (r.parsed || []).forEach((p) => { const s = state.get(byId[p.id.replace(/^0x/, '')]); if (s) { s.price = Number(p.price.price) * 10 ** p.price.expo; s.live = true; } });
    pythFailures = 0;
    return true;
  } catch (e) { if (++pythFailures > 5) feed = 'simulated'; return false; }
}
const JUP_PRICE = process.env.JUPITER_PRICE_API || 'https://lite-api.jup.ag/price/v3';
const SOL_MINTS = { SOL: 'So11111111111111111111111111111111111111112', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', RENDER: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' };
const GECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin', TRX: 'tron', BNB: 'binancecoin', POL: 'polygon-ecosystem-token' };
let jupFailures = 0, lastGecko = 0;
async function pollJupiter() {
  try {
    const r = await (await fetch(`${JUP_PRICE}?ids=${Object.values(SOL_MINTS).join(',')}`, { signal: AbortSignal.timeout(6000) })).json();
    let n = 0;
    for (const [sym, mint] of Object.entries(SOL_MINTS)) { const d = r[mint]; const s = state.get(sym); if (d && s && d.usdPrice > 0) { s.price = d.usdPrice; s.live = true; n++; } }
    jupFailures = 0;
    return n > 0;
  } catch (e) { jupFailures++; return false; }
}
async function pollGecko(force) {
  if (!force && Date.now() - lastGecko < 60000) return true;
  lastGecko = Date.now();
  try {
    const key = process.env.COINGECKO_API_KEY;
    const r = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(GECKO_IDS).join(',')}&vs_currencies=usd`, { headers: key ? { 'x-cg-demo-api-key': key } : {}, signal: AbortSignal.timeout(8000) })).json();
    for (const [sym, id] of Object.entries(GECKO_IDS)) { const s = state.get(sym); if (r[id] && r[id].usd && s) { s.price = r[id].usd; s.live = true; } }
    return true;
  } catch (e) { return false; }
}
async function pollLive() {
  if (feed === 'pyth') { if (await pollPyth()) return; }
  const ok = await pollJupiter();
  await pollGecko();
  feed = ok ? 'jupiter+coingecko' : jupFailures > 5 ? 'simulated' : feed;
}

function simulate() {
  for (const s of state.values()) {
    if (!s.vol || (feed !== 'simulated' && s.live)) continue;
    const anchor = s.hist[POINTS - 288] || s.price;
    s.price = Math.max(s.price * (1 + (Math.random() - 0.5) * s.vol + ((anchor - s.price) / anchor) * 0.002), 1e-9);
  }
}
function roll() {
  const nowStep = Math.floor(Date.now() / STEP);
  for (const s of state.values()) {
    const lastStep = Math.floor((s.histStart + (POINTS - 1) * STEP) / STEP);
    if (nowStep > lastStep) { s.hist.copyWithin(0, 1); s.histStart += STEP; }
    s.hist[POINTS - 1] = s.price;
  }
  broadcast('prices', [...state.values()].map((s) => ({ sym: s.sym, price: s.price, ch: change24h(s.sym) })));
}

function change24h(sym) { const s = state.get(sym); const ref = s.hist[POINTS - 1 - 288]; return ref ? ((s.price - ref) / ref) * 100 : 0; }
const price = (sym) => (state.get(sym) ? state.get(sym).price : sym === 'USD' ? 1 : 0);
const tokens = () => [...state.values()].map((s) => ({ sym: s.sym, name: s.name, color: s.color, price: s.price, ch: change24h(s.sym), live: !!s.live }));
const exists = (sym) => state.has(sym);
const source = () => ({ feed, realHistory: [...state.values()].some((s) => s.realHistory) });

function series(sym, range = '1D', n = 96) {
  const s = state.get(sym);
  if (!s) return [];
  const span = { '1D': 288, '1W': 288 * 7, '1M': POINTS }[range] || 288;
  const start = POINTS - span, step = Math.max(1, Math.floor(span / n)), pts = [];
  for (let i = start; i < POINTS; i += step) pts.push({ t: s.histStart + i * STEP, p: s.hist[i] });
  pts.push({ t: Date.now(), p: s.price });
  return pts;
}
function closes(sym, count) { const s = state.get(sym); return s ? Array.from(s.hist.slice(Math.max(0, POINTS - count))) : []; }

/** Starts the feed; resolves once live prices are in (or after a timeout, falling back to simulation) */
function start() {
  initSynthetic();
  let ticking = false;
  setInterval(async () => {
    if (ticking) return; ticking = true;
    try { if (!SIM_ONLY && feed !== 'simulated-forced') await pollLive(); simulate(); roll(); } finally { ticking = false; }
  }, 4000).unref();
  if (SIM_ONLY) { feed = 'simulated-forced'; console.log('  📈 Prices: simulated (PRICE_FEED=sim)'); return Promise.resolve(); }
  const boot = (async () => {
    const n = await discoverPyth();
    if (n && (await pollPyth())) feed = 'pyth';
    else { await pollJupiter(); await pollGecko(true); feed = [...state.values()].some((s) => s.live) ? 'jupiter+coingecko' : 'simulated'; }
    // align synthetic history to live prices until real candles arrive
    for (const s of state.values()) if (s.live && s.vol) { const k = s.price / s.hist[POINTS - 1]; for (let i = 0; i < POINTS; i++) s.hist[i] *= k; }
    console.log(feed === 'simulated' ? '  📈 Prices: simulated (price APIs unreachable)' : `  📈 Live prices: ${feed === 'pyth' ? `Pyth Network (${n} feeds)` : 'Jupiter (Solana tokens) + CoinGecko (BTC, ETH, LTC, TRX, BNB, POL)'}`);
    loadRealHistory().then(() => source().realHistory && console.log('  🕯  Real hourly candle history loaded'));
  })();
  return Promise.race([boot, new Promise((r) => setTimeout(r, 15000))]);
}

module.exports = { start, price, tokens, series, closes, exists, change24h, source, TOKENS, seeded };
