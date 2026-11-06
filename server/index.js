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
const { getSettings } = require('./db');
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
let created = null;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
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
      let out;
      for (const h of m.route.handlers) out = await h(ctx);
      if (out !== STREAM) send(res, 200, out === undefined ? { ok: true } : out);
      if (process.env.LOG_REQUESTS === '1') console.log(req.method, url.pathname, res.statusCode, Date.now() - t0 + 'ms');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname === '/admin') { res.writeHead(301, { Location: '/admin/' + url.search }); res.end(); return; }
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
  await market.start();              // live prices first, so seeded values match the market
  created = seed(getSettings());
  require('./push').init();
  server.listen(PORT, HOST, onListen);
})();
function onListen() {
  engine.start();
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
  console.log(`     AI Copilot:       ${require('./ai').enabled() ? 'Claude (' + require('./ai').MODEL + ')' : 'rule-based (set ANTHROPIC_API_KEY to use Claude)'}`);
}

const shutdown = () => { server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
module.exports = { clientIp };
