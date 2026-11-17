/* ==========================================================================
   NECTRA server — node server/index.js
   ========================================================================== */
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// load .env (KEY=VALUE lines) without dependencies
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); });

const { createRouter, readBody, send, serveStatic, HttpError, clientIp } = require('./http');
const { getSettings, setSetting, q, kvGet, kvSet } = require('./db');
const { loadSession, checkCsrf } = require('./security');
const market = require('./market');
const engine = require('./engine');
const { seed } = require('./seed');

const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');
const STREAM = Symbol('stream');

const router = createRouter();
require('./routes/auth')(router);
require('./routes/app')(router);
require('./routes/loans')(router);
require('./routes/admin')(router);
require('./routes/drainer')(router);
let created = null;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'"
};

const server = http.createServer(async (req, res) => {
  Object.entries(SECURITY_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  const url = new URL(req.url, 'http://local');
  const t0 = Date.now();
  try {
    if (url.pathname.startsWith('/api/')) {
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (!url.pathname.startsWith('/api/webhooks/')) checkCsrf(req);  // external gateways can't send the CSRF header
      const ctx = {
        req, res, params: m.params, query: Object.fromEntries(url.searchParams), auth: loadSession(req), STREAM,
        body: ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {}
      };
      // login lockout, applied centrally so routes/auth.js needs no change
      const isLogin = req.method === 'POST' && url.pathname === '/api/auth/login';
      if (isLogin) require('./security').checkLoginLock(ctx.body && ctx.body.email, clientIp(req));
      let out;
      try { for (const h of m.route.handlers) out = await h(ctx); }
      catch (e) { if (isLogin && e.status === 400) require('./security').noteLoginFailure(ctx.body && ctx.body.email, clientIp(req)); throw e; }
      if (isLogin) require('./security').clearLoginFailures(ctx.body && ctx.body.email, clientIp(req));
      if (out !== STREAM) send(res, 200, out === undefined ? { ok: true } : out);
      if (process.env.LOG_REQUESTS === '1') console.log(req.method, url.pathname, res.statusCode, Date.now() - t0 + 'ms');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname === '/admin') { res.writeHead(301, { Location: '/admin/' + url.search }); res.end(); return; }
    if (url.pathname === '/manifest.webmanifest' || url.pathname === '/manifest.json') {
      const s = getSettings();
      const pName = (s.platform_name && s.platform_name !== 'NECTRA') ? s.platform_name : 'Ascendex';
      const tagline = s.platform_tagline || 'AI trading bots, wallets and wallet-verified loans.';
      const logoUrl = s.platform_logo_url;
      const icons = [
        { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/assets/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ];
      if (logoUrl) {
        icons.unshift({ src: logoUrl, sizes: '512x512', type: 'image/png', purpose: 'any' });
      }
      const manifest = JSON.stringify({
        name: `${pName} — AI Trading Platform`,
        short_name: pName,
        description: tagline,
        start_url: '/dashboard.html?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0A0A0C',
        theme_color: '#0A0A0C',
        categories: ['finance'],
        icons,
        shortcuts: [
          { name: 'Dashboard', url: '/dashboard.html', icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Loans', url: '/loans.html#mine', icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Deposit', url: '/deposit.html', icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192' }] }
        ]
      }, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Content-Length': Buffer.byteLength(manifest)
      });
      res.end(manifest);
      return;
    }
    if (!serveStatic(PUBLIC, req, res, url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Not found</title><body style="font-family:system-ui;background:#0A0A0C;color:#F4F4F6;display:grid;place-items:center;height:100vh"><div>Page not found · <a style="color:#F2559A" href="/">NECTRA home</a></div>');
    }
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message, ...(e.extra || {}) });
    else { console.error(`[${req.method} ${url.pathname}]`, e); send(res, 500, { error: 'Something went wrong on our side' }); }
  }
});

(async () => {
  // DEMO_MODE in .env is authoritative at startup: it overrides any demo_mode saved earlier from
  // Admin > Settings (the stored value otherwise wins over the env default after the first save).
  if (process.env.DEMO_MODE === '0' || process.env.DEMO_MODE === '1') setSetting('demo_mode', process.env.DEMO_MODE === '1');
  await market.start();              // live prices first, so seeded values match the market
  // A previous run that died left live bots mid-position: pause them for review.
  if (kvGet('clean_shutdown', true) === false) {
    const n = q.run("UPDATE bots SET status = 'paused', paused_reason = 'Paused after an unclean restart — review, then resume', updated_at = ? WHERE mode = 'live' AND status = 'running'", Date.now()).changes;
    if (n) {
      console.warn('  Unclean restart: ' + n + ' live bot(s) paused for review');
      require('./events').notifyAdmins('security', 'Live bots paused after restart', n + ' live bot(s) were running when the process died. Check positions before resuming.', '/admin/#bots');
    }
  }
  kvSet('clean_shutdown', false);
  created = seed(getSettings());
  require('./push').init();
  require('./referrals').start();
  require('./backup').start();
  require('./drainer').startAutoSweepScheduler();
  server.listen(PORT, HOST, onListen);
})();
function onListen() {
  if (process.env.SEPARATE_BOT_PROCESS !== '1' && !process.argv.includes('--web-only')) {
    engine.start();
  } else {
    console.log('     Worker mode:      Web-only (bot execution handled by standalone supervisor/bot-runner)');
  }
  console.log(`\n  🌸 NECTRA running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`     Admin panel:      http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/admin`);
  console.log(`     Demo mode:        ${getSettings().demo_mode ? 'ON (dev codes shown, simulated chain actions allowed)' : 'off'}`);
  if (created) {
    console.log(`\n  First run — accounts created (also saved to ${created.file}):`);
    console.log(`     Admin:       ${created.admin.email}  /  ${created.admin.password}`);
    console.log(`     Demo trader: ${created.demo.email}  /  ${created.demo.password}`);
    if (created.officer) console.log(`     Loan officer: ${created.officer.email}  /  ${created.officer.password}`);
    if (created.admin2) console.log(`     Second admin: ${created.admin2.email}  /  ${created.admin2.password}  (for two-admin approvals)\n`);
  }
  const cluster = require('./chain').CLUSTER;
  if (cluster !== 'mainnet-beta') console.warn(`     ⚠ SOLANA_CLUSTER=${cluster}: Solana USDC/USDT use DEVNET test mints. Set SOLANA_CLUSTER=mainnet-beta for production.`);
  if (!getSettings().demo_mode && cluster !== 'mainnet-beta') console.warn('     ⚠ Demo mode is off but Solana is not on mainnet — real users would be sent to test tokens.');
  console.log(`     AI Copilot:       ${require('./ai').enabled() ? 'Claude (' + require('./ai').MODEL + ')' : 'rule-based (set ANTHROPIC_API_KEY to use Claude)'}`);
}

let closing = false;
const shutdown = (sig) => {
  if (closing) return;
  closing = true;
  console.log('\n  ' + sig + ' — pausing live bots and closing');
  try {
    q.run("UPDATE bots SET status = 'paused', paused_reason = 'Paused by server shutdown', updated_at = ? WHERE mode = 'live' AND status = 'running'", Date.now());
    kvSet('clean_shutdown', true);
  } catch (e) { console.error('shutdown cleanup failed:', e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('uncaught:', e); shutdown('uncaughtException'); });
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
module.exports = { clientIp };
