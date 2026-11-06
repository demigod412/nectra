/* End-to-end API smoke test against a running server.
   Usage: npm test   (BASE=http://127.0.0.1:3000, ADMIN_EMAIL/ADMIN_PASSWORD from data/first-run-credentials.txt) */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { b58encode } = require('../server/chain');

const { spawn } = require('node:child_process');
const os = require('node:os');
// Default: start a private server on a throwaway database (set BASE=… to test a running server instead)
const OWN = !process.env.BASE;
const TMP = OWN ? fs.mkdtempSync(path.join(os.tmpdir(), 'nectra-test-')) : null;
const TEST_PW = { ADMIN_PASSWORD: 'Test-Admin-2026', ADMIN2_PASSWORD: 'Test-Admin2-2026', OFFICER_PASSWORD: 'Test-Officer-2026' };
const BASE = process.env.BASE || 'http://127.0.0.1:3987';
const credFile = OWN ? path.join(TMP, 'creds.txt') : path.join(__dirname, '..', 'data', 'first-run-credentials.txt');
let creds = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : '';
const ADMIN = OWN ? { email: 'admin@nectra.local', password: TEST_PW.ADMIN_PASSWORD } : { email: process.env.ADMIN_EMAIL || (creds.match(/Admin: (\S+)/) || [])[1], password: process.env.ADMIN_PASSWORD || (creds.match(/Admin: \S+ \/ (\S+)/) || [])[1] };
const DEMO = { email: 'demo@nectra.local', password: process.env.DEMO_PASSWORD || 'Demo-Trader-2026' };
const ADMIN2 = { email: 'ops@nectra.local', password: OWN ? TEST_PW.ADMIN2_PASSWORD : (creds.match(/Admin2: \S+ \/ (\S+)/) || [])[1] };
const OFFICER = { email: 'officer@nectra.local', password: OWN ? TEST_PW.OFFICER_PASSWORD : (creds.match(/Officer: \S+ \/ (\S+)/) || [])[1] };

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', 'X-Nectra': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch (e) { j = text; }
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j && j.error}`);
    return j;
  };
}
let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); passed++; console.log('  ✓', msg); };

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = b58encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
  return { address, sign: (msg) => b58encode(crypto.sign(null, Buffer.from(msg), privateKey)) };
}

let child;
async function startServer() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, ...TEST_PW, PORT: '3987', DB_PATH: path.join(TMP, 'test.db'), CREDENTIALS_FILE: credFile, LOG_REQUESTS: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(BASE + '/api/status')).ok) return; } catch (e) { /* not yet */ }
  }
  throw new Error('server did not start:\n' + out);
}
process.on('exit', () => { if (child) child.kill(); if (TMP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* locked */ } });

(async () => {
  if (OWN) { process.stdout.write('Starting a private test server on a throwaway database… '); await startServer(); console.log('ready'); }
  console.log('NECTRA smoke test →', BASE);
  const u = client(), a = client(), n = client();

  // --- public
  ok((await n('GET', '/api/status')).components.length > 0, 'status endpoint');
  ok((await n('GET', '/api/market/tokens')).tokens.length > 5, 'market tokens');

  // --- registration with invite + email verify
  const email = `user${Date.now()}@test.local`;
  await n('POST', '/api/auth/invite/validate', { code: 'NECTRA26' });
  const reg = await n('POST', '/api/auth/register', { code: 'NECTRA26', email, password: 'Str0ng-Passw0rd', acceptTerms: true });
  ok(reg.devCode, 'register returns dev verification code (demo mode)');
  await n('POST', '/api/auth/verify-email', { code: reg.devCode });
  const nb = await n('GET', '/api/bootstrap');
  ok(nb.user.email === email && nb.user.emailVerified, 'new user verified + bootstrapped');

  // --- wallet register + login (real ed25519 signatures)
  const w = wallet();
  const wc = client();
  let nn = await wc('POST', '/api/auth/wallet/nonce', { address: w.address, purpose: 'register' });
  await wc('POST', '/api/auth/wallet/verify', { nonce: nn.nonce, signature: w.sign(nn.message), code: 'NECTRA26', provider: 'Test' });
  const wc2 = client();
  nn = await wc2('POST', '/api/auth/wallet/nonce', { address: w.address, purpose: 'login' });
  ok((await wc2('POST', '/api/auth/wallet/verify', { nonce: nn.nonce, signature: w.sign(nn.message) })).user, 'wallet sign-in with signed message');

  // --- demo trader
  await u('POST', '/api/auth/login', DEMO);
  const dash = await u('GET', '/api/dashboard');
  ok(dash.value > 0 && dash.bots.length >= 3, 'dashboard with portfolio + bots');
  ok((await u('GET', '/api/portfolio/series?range=1W')).points.length > 10, 'portfolio series');

  const parsed = await u('POST', '/api/copilot/parse', { text: 'DCA $50 into SOL every Monday' });
  ok(parsed.strategy.type === 'DCA', 'copilot parses DCA');
  const bt = await u('POST', '/api/backtest', { strategyId: parsed.id, range: '30D' });
  ok(Array.isArray(bt.equity) && bt.equity.length > 10, 'backtest returns equity curve');
  const scalp = await u('POST', '/api/copilot/parse', { text: 'Scalp SOL with a 0.5% take-profit and 0.3% stop' });
  ok(scalp.strategy.type === 'Scalp' && scalp.strategy.config.tp === 0.5, 'copilot parses Scalp');
  const brk = await u('POST', '/api/copilot/parse', { text: 'Breakout buy ETH above its 24h high, trail 3%' });
  ok(brk.strategy.type === 'Breakout' && brk.strategy.config.trail === 3, 'copilot parses Breakout with trailing stop');
  // --- subscription plans + gating
  const plans = await u('GET', '/api/plans');
  ok(plans.plans.length >= 2 && plans.plans.some((p) => p.slug === 'free') && plans.perks, 'plans list + current perks');
  let gated = false; try { await u('POST', '/api/copilot/tune', { strategyId: scalp.id, range: '30D' }); } catch (e) { gated = /Starter|upgrade|plan/i.test(e.message); }
  ok(gated, 'auto-tuner gated behind a paid plan on Free');
  const pro = plans.plans.find((p) => p.perks.advanced && p.price_usd > 0);
  const sub = await u('POST', `/api/plans/${pro.id}/subscribe`);
  ok(sub.charged === pro.price_usd && sub.perks.advanced === true, 'subscribe to a paid plan (charged from balance, perks unlocked)');
  const tune = await u('POST', '/api/copilot/tune', { strategyId: scalp.id, range: '30D' });
  ok(tune.tunable === true && tune.after && typeof tune.after.totalReturn === 'number' && tune.tried > 0, 'auto-tune grid-searches params (paid plan)');
  const canceled = await u('POST', '/api/subscription/cancel');
  ok(canceled.current && canceled.current.status === 'cancelled', 'cancel subscription (perks kept until period end)');

  // --- annual plans + proration
  const proPlan = plans.plans.find((p) => p.perks.live && p.price_usd > 0);
  const elitePlan = plans.plans.find((p) => p.slug === 'elite') || plans.plans.slice().sort((a, b) => b.price_usd - a.price_usd)[0];
  ok(proPlan.price_yearly > 0, 'paid plans expose an annual price');
  const qy = await u('GET', `/api/plans/${proPlan.id}/quote?interval=yearly`);
  ok(qy.interval === 'yearly' && qy.price === proPlan.price_yearly, 'annual quote returns the yearly price');
  const qp = await u('GET', `/api/plans/${proPlan.id}/quote?interval=monthly`);
  ok(qp.credit > 0 && qp.charge < qp.price, 'upgrade is prorated (credit for unused time on current plan)');

  // --- crypto subscription payments (demo-simulated) + per-bot analytics
  const co = await u('POST', `/api/plans/${proPlan.id}/checkout`, { method: 'nowpayments' });
  ok(co.paymentId && (co.simulated || co.invoiceUrl) && co.amount < proPlan.price_usd, 'crypto checkout creates a prorated payment (NOWPayments)');
  const paid = await u('POST', `/api/payments/${co.paymentId}/simulate`);
  ok(paid.current && paid.perks.live === true, 'simulated crypto payment activates Pro (live unlocked, no balance charge)');
  const oc = await u('POST', `/api/plans/${elitePlan.id}/checkout`, { method: 'onchain' });
  ok(oc.address && oc.amount > 0 && oc.network, 'on-chain USDC checkout returns treasury address + prorated amount');
  const annual = await u('POST', `/api/plans/${proPlan.id}/subscribe`, { interval: 'yearly' });
  ok(annual.current && annual.current.interval === 'yearly', 'switch Pro to annual billing');
  const bstats = await u('GET', `/api/bots/${dash.bots[0].id}/stats`);
  ok(typeof bstats.totalReturnPct === 'number' && Array.isArray(bstats.equity) && 'winRate' in bstats, 'per-bot performance analytics');

  // --- compliance: terms + KYC gating (before loans)
  ok((await u('GET', '/api/compliance')).terms.accepted === false, 'new account: terms not yet accepted');
  let termsBlock = false; try { await u('POST', '/api/loans/check', {}); } catch (e) { termsBlock = /terms/i.test(e.message); }
  ok(termsBlock, 'loan check blocked until terms accepted');
  await u('POST', '/api/terms/accept');
  ok((await u('GET', '/api/compliance')).terms.accepted, 'terms accepted');
  let kycBlock = false; try { await u('POST', '/api/loans/check', {}); } catch (e) { kycBlock = /identity|KYC/i.test(e.message); }
  ok(kycBlock, 'loan check blocked until KYC verified');
  const idImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let noDoc = false; try { await u('POST', '/api/kyc', { fullName: 'Demo Trader', country: 'United States', dob: '1990-05-01', idType: 'Passport', idNumber: 'X1234567' }); } catch (e) { noDoc = /government ID|upload/i.test(e.message); }
  ok(noDoc, 'KYC requires a government-ID image');
  ok((await u('POST', '/api/kyc', { fullName: 'Demo Trader', country: 'United States', dob: '1990-05-01', idType: 'Passport', idNumber: 'X1234567', idFront: idImg })).kyc.status === 'submitted', 'KYC submitted with ID upload');
  await a('POST', '/api/auth/login', ADMIN);
  const kq = await a('GET', '/api/admin/kyc?status=submitted');
  const demoKyc = kq.rows.find((r) => r.email === 'demo@nectra.local');
  ok(demoKyc && demoKyc.has_front, 'admin KYC queue flags the uploaded ID (list omits the image)');
  const doc = await a('GET', `/api/admin/kyc/${demoKyc.user_id}/doc?side=front`);
  ok(/^data:image\//.test(doc.dataUrl), 'admin can view the uploaded ID document');
  await a('POST', `/api/admin/kyc/${demoKyc.user_id}/decide`, { decision: 'verified' });
  ok((await u('GET', '/api/compliance')).kyc.status === 'verified', 'admin verifies KYC → user can borrow');
  // KYC master toggle: off → not required, submission blocked
  await a('PATCH', '/api/admin/settings', { kyc_enabled: false });
  ok((await u('GET', '/api/compliance')).kyc.enabled === false, 'KYC off reflected to users');
  let kycOffBlock = false; try { await u('POST', '/api/kyc', { fullName: 'x', country: 'US', dob: '1990-01-01', idType: 'Passport', idNumber: '12345', idFront: idImg }); } catch (e) { kycOffBlock = /not required/i.test(e.message); }
  ok(kycOffBlock, 'KYC submission blocked when KYC is off');
  await a('PATCH', '/api/admin/settings', { kyc_enabled: true });

  // --- billing emails + monetization master toggle
  const mbx = await a('GET', '/api/admin/mailbox');
  ok(mbx.rows.some((m) => m.to_email === 'demo@nectra.local' && /subscription/i.test(m.subject)), 'billing email queued on subscription');
  await a('PATCH', '/api/admin/settings', { monetization_enabled: false });
  const offp = await u('GET', '/api/plans');
  ok(offp.enabled === false && (offp.methods || []).length === 0, 'monetization off → plans + payment methods hidden');
  let subBlocked = false; try { await u('POST', `/api/plans/${proPlan.id}/subscribe`, {}); } catch (e) { subBlocked = /not available/i.test(e.message); }
  ok(subBlocked, 'subscribe blocked while monetization is off');
  let quoteBlocked = false; try { await u('GET', `/api/plans/${proPlan.id}/quote?interval=monthly`); } catch (e) { quoteBlocked = /not available/i.test(e.message); }
  ok(quoteBlocked, 'quote blocked while monetization is off');
  await a('PATCH', '/api/admin/settings', { monetization_enabled: true });
  ok((await u('GET', '/api/plans')).enabled === true, 'monetization re-enabled');
  const dep = await u('POST', '/api/copilot/deploy', { id: parsed.id });
  ok(dep.bot && dep.bot.status === 'running', 'deploy bot (paper)');
  await u('POST', `/api/bots/${dep.bot.id}/toggle`, { on: false });
  await u('DELETE', `/api/bots/${dep.bot.id}`);
  ok(true, 'pause + delete bot');

  const ws = await u('GET', '/api/wallets');
  ok(ws.main && ws.wallets.length >= 17, 'wallets list');
  await u('PATCH', `/api/wallets/${ws.wallets[0].id}`, { name: 'Sniper One' });
  const ln = wallet();
  nn = await u('POST', '/api/auth/wallet/nonce', { address: ln.address, purpose: 'link' });
  await u('POST', '/api/wallets', { source: 'connected', provider: 'Test', nonce: nn.nonce, signature: ln.sign(nn.message) });
  ok(true, 'link wallet with ownership proof');
  ok('tokens' in (await n('GET', '/api/icons')), 'icon manifest endpoint');
  const bals = await u('GET', `/api/wallets/${ws.main.id}/balances`);
  ok(Array.isArray(bals.balances), 'connected-wallet balances endpoint');
  const watchId = (await u('GET', '/api/wallets')).wallets.find((w) => w.source === 'watch');
  if (watchId) { let blocked = false; try { await u('POST', `/api/wallets/${watchId.id}/transfer-build`, { coin: 'SOL', to: ws.main.address, amount: 0.1 }); } catch (e) { blocked = /watch-only/.test(e.message); } ok(blocked, 'transfer-build blocks watch-only wallets'); } else ok(true, 'transfer-build (no watch-only wallet to test)');

  const simDep = await u('POST', '/api/deposits/simulate', { amount: 0.5 });
  ok(simDep.tx.status === 'confirming', 'simulated deposit confirming');

  const book = await u('GET', '/api/address-book');
  const wd = await u('POST', '/api/withdrawals', { source: 'wallet', walletId: ws.main.id, to: book.rows[0].address, amount: 0.001 });
  ok(wd.devCode, 'withdrawal requires code');
  const v = await u('POST', `/api/withdrawals/${wd.id}/verify`, { code: wd.devCode });
  ok(v.status === 'ready_to_sign', 'withdrawal verified → ready to sign');
  ok((await u('POST', `/api/withdrawals/${wd.id}/submit`, {})).tx.simulated, 'withdrawal submitted (simulated)');

  const aps = await u('GET', '/api/approvals');
  await u('POST', `/api/approvals/${aps.rows[0].id}/revoke`, {});
  await u('POST', '/api/approvals', { token: 'USDC', amount: 25, spender: 'Nectra DCA Executor' });
  ok(true, 'approval revoke + grant');

  await u('POST', '/api/alerts', { token: 'SOL', direction: 'above', price: 500 });
  await u('POST', '/api/paper/swap', { from: 'USDC', to: 'SOL', amount: 100 });
  ok((await u('GET', '/api/portfolio')).tokens.length > 1, 'paper swap + portfolio');
  ok((await u('GET', '/api/history?days=200')).rows.length > 5, 'history');
  await u('POST', '/api/referrals/codes', {});
  ok((await u('GET', '/api/referrals')).codes.length >= 2, 'referral codes');

  // --- loans: cancel seeded app, verify wallet eligibility, apply
  let loans = await u('GET', '/api/loans');
  for (const l of loans.loans.filter((x) => x.status === 'pending_review')) await u('POST', `/api/loans/${l.id}/cancel`, {});
  ok(loans.credit && loans.credit.score >= 300, `credit score ${loans.credit.score} (${loans.credit.band})`);
  const lw = wallet();
  nn = await u('POST', '/api/auth/wallet/nonce', { address: lw.address, purpose: 'loan' });
  const check = await u('POST', '/api/loans/check', { productId: loans.products.find((p) => p.kind === 'history').id, amount: 200, nonce: nn.nonce, signature: lw.sign(nn.message), provider: 'Demo wallet' });
  ok(check.results.length === 4, `eligibility check ran (eligible=${check.eligible}, source=${check.snapshot.source})`);
  ok(check.eligible, 'demo wallet meets criteria');
  let blockedSubmit = false; try { await u('POST', '/api/loans', { checkId: check.checkId, accept: true }); } catch (e) { blockedSubmit = /collection approval/.test(e.message); }
  ok(blockedSubmit, 'submit blocked until a collection approval is signed');
  const dc = await u('POST', '/api/loans/delegations/confirm', { checkId: check.checkId, owner: lw.address, network: 'Solana', token: 'USDC' });
  ok(dc.status === 'confirmed', 'collection approval recorded (simulated for demo wallet)');
  const app = await u('POST', '/api/loans', { checkId: check.checkId, accept: true, purpose: 'Test' });
  ok(app.loan.status === 'pending_review', 'loan application pending admin review');
  // one wallet per open loan, across users
  const u2 = client();
  const e2 = `second${Date.now()}@test.local`;
  const r2 = await u2('POST', '/api/auth/register', { code: 'NECTRA26', email: e2, password: 'Str0ng-Passw0rd', acceptTerms: true });
  await u2('POST', '/api/auth/verify-email', { code: r2.devCode });
  await u2('POST', '/api/terms/accept');
  await u2('POST', '/api/kyc', { fullName: 'Second User', country: 'United States', dob: '1992-02-02', idType: 'National ID', idNumber: 'Y7654321', idFront: idImg });
  const k2 = await a('GET', '/api/admin/kyc?status=submitted'); const u2k = k2.rows.find((r) => r.email === e2);
  await a('POST', `/api/admin/kyc/${u2k.user_id}/decide`, { decision: 'verified' });
  nn = await u2('POST', '/api/auth/wallet/nonce', { address: lw.address, purpose: 'loan' });
  let walletBlocked = false; try { await u2('POST', '/api/loans/check', { productId: loans.products.find((p) => p.kind === 'history').id, amount: 150, nonce: nn.nonce, signature: lw.sign(nn.message), provider: 'Demo wallet' }); } catch (e) { walletBlocked = /already backs/.test(e.message); }
  ok(walletBlocked, 'same wallet rejected for a second open loan (other account)');

  // --- staff roles
  const off = client();
  await off('POST', '/api/auth/login', OFFICER);
  await off('POST', `/api/admin/loans/${app.loan.id}/recommend`, { recommendation: 'approve', note: 'History looks fine' });
  let officerBlocked = false; try { await off('POST', `/api/admin/loans/${app.loan.id}/approve`, {}); } catch (e) { officerBlocked = /403/.test(e.message); }
  ok(officerBlocked, 'loan officer can recommend but not approve');

  // --- admin
  await a('POST', '/api/auth/login', ADMIN);
  const ov = await a('GET', '/api/admin/overview');
  ok(ov.users >= 3 && ov.pendingLoans >= 1, 'admin overview');
  const detail = await a('GET', `/api/admin/loans/${app.loan.id}`);
  ok(detail.check && detail.check.results.length && /Recommend/.test(detail.officerNote), 'admin sees eligibility evidence + officer recommendation');
  await a('POST', `/api/admin/loans/${app.loan.id}/approve`, { note: 'Looks good' });
  const disb = await a('POST', `/api/admin/loans/${app.loan.id}/disburse`, { ref: 'MANUAL-TEST-001' });
  ok(disb.recheck && disb.recheck.ok, 'wallet re-checked at disbursement');
  loans = await u('GET', '/api/loans');
  const myLoan = loans.loans.find((l) => l.id === app.loan.id);
  ok(loans.accountBalance >= 200 && myLoan.status === 'disbursed' && myLoan.instalments.length >= 1, 'disbursed → balance credited + instalment schedule created');
  const rp = await u('POST', `/api/loans/${app.loan.id}/repay`, { amount: 50 });
  ok(Math.abs(rp.loan.repaid - 50) < 1e-6, 'user partial repayment from account balance');

  // --- two-admin approvals
  const adj = await a('POST', '/api/admin/users/2/adjust', { amount: 2500, note: 'Large test credit' });
  ok(adj.pending && adj.actionId, 'large balance adjustment waits for a second admin');
  let selfApprove = false; try { await a('POST', `/api/admin/actions/${adj.actionId}/approve`, {}); } catch (e) { selfApprove = /different admin/.test(e.message); }
  ok(selfApprove, 'requester cannot give the second approval');
  const a2 = client(); await a2('POST', '/api/auth/login', ADMIN2);
  let opsBlocked = false; try { await a2('POST', `/api/admin/actions/${adj.actionId}/approve`, {}); } catch (e) { opsBlocked = /super admins/.test(e.message); }
  ok(opsBlocked, 'only super admins can approve balance adjustments');
  await a('POST', `/api/admin/actions/${adj.actionId}/reject`, { reason: 'test' });
  const lb = await a('GET', '/api/admin/loanbook');
  ok(lb.totals.active >= 1, 'loan book dashboard');

  // --- default → collection from approvals (two admins)
  await a('POST', `/api/admin/loans/${app.loan.id}/status`, { status: 'defaulted', note: 'Test default' });
  const col = await a('POST', `/api/admin/loans/${app.loan.id}/collect`, {});
  ok(col.pending, 'collection request waits for a second admin');
  const exec = await a2('POST', `/api/admin/actions/${col.actionId}/approve`, {});
  const collected = (exec.result.results || []).reduce((s, x) => s + (x.amount || 0), 0);
  ok(collected > 0, `second admin approved → collected $${collected.toFixed(2)} via the signed approval`);
  const after = (await u('GET', '/api/loans')).loans.find((l) => l.id === app.loan.id);
  ok(after.status === 'repaid' || after.repaid > 50, 'collection applied to the loan');

  // --- optional admin 2FA policy
  let lockout = false; try { await a('PATCH', '/api/admin/settings', { admin_2fa_required: true }); } catch (e) { lockout = /own account first/.test(e.message); }
  ok(lockout, 'admin 2FA policy cannot be enabled by an admin without 2FA (no lock-out)');
  const { hotp } = require('../server/security');
  const setup = await a('POST', '/api/me/2fa/setup', {});
  await a('POST', '/api/me/2fa/enable', { code: hotp(setup.secret, Math.floor(Date.now() / 30000)) });
  await a('PATCH', '/api/admin/settings', { admin_2fa_required: true });
  let needs2fa = false; try { await a2('GET', '/api/admin/overview'); } catch (e) { needs2fa = /two-factor/.test(e.message); }
  ok(needs2fa, 'admin 2FA policy (optional, authenticator app) blocks staff without 2FA');
  ok((await a('GET', '/api/admin/overview')).users > 0, 'staff with 2FA keep access');
  await a('PATCH', '/api/admin/settings', { admin_2fa_required: false });

  // payout of account balance → admin processes
  const po = await u('POST', '/api/withdrawals', { source: 'account', to: book.rows[0].address, amount: 20 });
  await u('POST', `/api/withdrawals/${po.id}/verify`, { code: po.devCode });
  const pays = await a('GET', '/api/admin/payouts');
  ok(pays.rows.some((x) => x.id === po.id && x.status === 'pending_admin'), 'payout queued for admin');
  await a('POST', `/api/admin/payouts/${po.id}/paid`, { ref: 'SIGTEST123' });

  const inv = await a('POST', '/api/admin/invites', { count: 2, maxUses: 1 });
  ok(inv.codes.length === 2, 'admin creates invites');
  await n('POST', '/api/waitlist', { email: `wait${Date.now()}@test.local` });
  const wl = await a('GET', '/api/admin/waitlist');
  await a('POST', `/api/admin/waitlist/${wl.rows.find((x) => x.status === 'pending').id}/invite`, {});
  ok(true, 'waitlist → invite');
  await a('PATCH', '/api/admin/status/Solana%20RPC', { state: 'amber', note: 'Test' });
  await a('PATCH', '/api/admin/status/Solana%20RPC', { state: 'green' });
  ok((await a('GET', '/api/admin/audit')).rows.length > 5, 'audit log');
  let blocked = false; try { await u('GET', '/api/admin/overview'); } catch (e) { blocked = /403/.test(e.message); }
  ok(blocked, 'non-admin blocked from admin API');
  let csrf = false; try { await fetch(BASE + '/api/auth/logout', { method: 'POST' }).then((r) => { csrf = r.status === 403; }); } catch (e) { /* */ }
  ok(csrf, 'CSRF header enforced');

  console.log(`\n  ${passed} checks passed ✔`);
  process.exit(0);
})().catch((e) => { console.error('\n  ✗', e.message); process.exit(1); });
