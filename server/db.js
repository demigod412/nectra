/* ==========================================================================
   Database — SQLite via Node's built-in node:sqlite (Node >= 22.5)
   ========================================================================== */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nectra.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  pw_hash TEXT,
  name TEXT NOT NULL DEFAULT 'Trader',
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  status TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  email_verified INTEGER NOT NULL DEFAULT 0,
  wallet_login TEXT UNIQUE,                   -- Solana address used for wallet sign-in
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_pending TEXT,
  anti_phishing TEXT NOT NULL DEFAULT 'PETAL',
  invite_code TEXT, referred_by INTEGER,
  prefs TEXT NOT NULL DEFAULT '{}', risk TEXT NOT NULL DEFAULT '{}',
  whitelist_only INTEGER NOT NULL DEFAULT 0,
  paper_mode INTEGER NOT NULL DEFAULT 1,
  onboarding TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, pending_2fa INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT, ip TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL, ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY, address TEXT NOT NULL, purpose TEXT NOT NULL, message TEXT NOT NULL,
  user_id INTEGER, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'admin', created_by INTEGER,
  max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  note TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, referral TEXT,
  status TEXT NOT NULL DEFAULT 'pending', invite_code TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, UNIQUE(user_id, name));

CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT NOT NULL, chain TEXT NOT NULL DEFAULT 'Solana',
  kind TEXT NOT NULL DEFAULT 'buyer',      -- main | buyer
  source TEXT NOT NULL DEFAULT 'watch',    -- connected | generated | watch | demo
  provider TEXT, folder TEXT NOT NULL DEFAULT 'Unsorted', verified INTEGER NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0, balance_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(user_id, address)
);

CREATE TABLE IF NOT EXISTS holdings (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, PRIMARY KEY(user_id, token));

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, strategy TEXT NOT NULL, pair TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}', mode TEXT NOT NULL DEFAULT 'paper', status TEXT NOT NULL DEFAULT 'running',
  budget REAL NOT NULL DEFAULT 0, cash REAL NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, avg_price REAL NOT NULL DEFAULT 0,
  realized REAL NOT NULL DEFAULT 0, paused_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, bot_id INTEGER,
  bot_name TEXT, pair TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, pnl REAL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trades_user ON trades(user_id, created_at);

CREATE TABLE IF NOT EXISTS equity (user_id INTEGER NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(user_id, ts));

CREATE TABLE IF NOT EXISTS insights (id INTEGER PRIMARY KEY, user_id INTEGER, icon TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT, unread INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, wallet_id INTEGER,
  wallet_name TEXT, token TEXT NOT NULL, spender TEXT NOT NULL, spender_address TEXT NOT NULL,
  amount REAL, unlimited INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 1,
  signature TEXT, last_used_at INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, token TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'Solana', from_addr TEXT, to_addr TEXT, signature TEXT, simulated INTEGER NOT NULL DEFAULT 0,
  confirmations INTEGER NOT NULL DEFAULT 0, required_conf INTEGER NOT NULL DEFAULT 32, note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tx_user ON transactions(user_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,           -- wallet | account
  wallet_id INTEGER, from_addr TEXT, to_addr TEXT NOT NULL, token TEXT NOT NULL, amount REAL NOT NULL, fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,           -- awaiting_code | ready_to_sign | submitted | confirmed | pending_admin | paid | rejected | failed | cancelled
  verify_method TEXT, tx_id INTEGER, admin_ref TEXT, admin_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS address_book (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, address TEXT NOT NULL, whitelisted INTEGER NOT NULL DEFAULT 1, unlock_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_alerts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL, direction TEXT NOT NULL, price REAL NOT NULL, email INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, triggered_at INTEGER, created_at INTEGER NOT NULL
);

/* Account balance ledger (platform-held USD balance — loans are credited here by admins) */
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL, kind TEXT NOT NULL, ref TEXT, note TEXT, created_by INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset TEXT NOT NULL DEFAULT 'USDC',
  apr REAL NOT NULL, min_amount REAL NOT NULL, max_amount REAL NOT NULL, term_days INTEGER NOT NULL,
  min_balance_pct REAL NOT NULL,   -- verified wallet value must be >= this % of the requested amount
  min_tx_count INTEGER NOT NULL,   -- on-chain transaction history required
  min_wallet_age_days INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_checks (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id INTEGER NOT NULL,
  amount REAL NOT NULL, address TEXT NOT NULL, signature TEXT, provider TEXT, source TEXT NOT NULL,
  sol REAL, usdc REAL, usd REAL, tx_count INTEGER, age_days REAL, results TEXT NOT NULL, eligible INTEGER NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id INTEGER NOT NULL,
  check_id INTEGER, amount REAL NOT NULL, asset TEXT NOT NULL, apr REAL NOT NULL, term_days INTEGER NOT NULL,
  wallet_address TEXT NOT NULL, purpose TEXT,
  status TEXT NOT NULL,   -- pending_review | approved | rejected | disbursed | repaid | defaulted | cancelled
  repaid REAL NOT NULL DEFAULT 0, admin_note TEXT, reviewed_by INTEGER, reviewed_at INTEGER,
  disbursed_at INTEGER, disburse_ref TEXT, due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_components (name TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'green', note TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL, target TEXT, meta TEXT, ip TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit(created_at);
`;
db.exec(SCHEMA);

/* ---- v2 schema: added tables + additive column migrations (safe to re-run) ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, target TEXT, payload TEXT NOT NULL DEFAULT '{}', amount REAL NOT NULL DEFAULT 0,
  requested_by INTEGER NOT NULL, approvals TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', result TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loan_instalments (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  due_at INTEGER NOT NULL, amount REAL NOT NULL, paid REAL NOT NULL DEFAULT 0, late_fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'due', reminded TEXT NOT NULL DEFAULT '', UNIQUE(loan_id, n)
);
CREATE TABLE IF NOT EXISTS loan_delegations (
  id INTEGER PRIMARY KEY, loan_id INTEGER, check_id INTEGER, user_id INTEGER NOT NULL, family TEXT NOT NULL, network TEXT NOT NULL,
  token TEXT NOT NULL, owner TEXT NOT NULL, spender TEXT NOT NULL, amount REAL NOT NULL, tx TEXT, simulated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', allowance REAL, balance REAL, checked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_wallets (bot_id INTEGER PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, address TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, ua TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS candles (sym TEXT NOT NULL, ts INTEGER NOT NULL, close REAL NOT NULL, PRIMARY KEY(sym, ts));
CREATE TABLE IF NOT EXISTS chain_scans (key TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS seen_transfers (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

/* Subscription plans (admin-managed) + user subscriptions. Plans gate real,
   deliverable perks (bot/budget limits, live trading, advanced strategies) — they
   never promise profit. Paid plans are charged from the paper account balance. */
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, tagline TEXT,
  price_usd REAL NOT NULL DEFAULT 0, interval TEXT NOT NULL DEFAULT 'monthly',  -- monthly | yearly | free
  perks TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',  -- active | cancelled | expired
  price_usd REAL NOT NULL DEFAULT 0, interval TEXT NOT NULL DEFAULT 'monthly',
  started_at INTEGER NOT NULL, renews_at INTEGER, cancelled_at INTEGER, auto_renew INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_subs_user ON subscriptions(user_id, status);

/* Subscription payments (crypto): NOWPayments-hosted or direct on-chain USDC.
   A confirmed payment activates the matching plan. No card/PII is stored here. */
CREATE TABLE IF NOT EXISTS plan_payments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id INTEGER NOT NULL,
  provider TEXT NOT NULL,            -- balance | nowpayments | onchain
  method_label TEXT, amount_usd REAL NOT NULL, pay_currency TEXT, pay_amount REAL, pay_address TEXT, network TEXT,
  reference TEXT, external_id TEXT, invoice_url TEXT, status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed | expired
  expires_at INTEGER, confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_payments_user ON plan_payments(user_id, status);

/* KYC submissions (identity verification for lending). PII minimized; documents
   are referenced, not stored in full. */
CREATE TABLE IF NOT EXISTS kyc (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'none',   -- none | submitted | verified | rejected
  level TEXT NOT NULL DEFAULT 'basic', provider TEXT,
  full_name TEXT, country TEXT, dob TEXT, id_type TEXT, id_last4 TEXT, address TEXT,
  note TEXT, reviewed_by INTEGER, submitted_at INTEGER, reviewed_at INTEGER, updated_at INTEGER NOT NULL
);
`);
const addCol = (table, col, def) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addCol('users', 'credit_score', 'INTEGER NOT NULL DEFAULT 600');
addCol('nonces', 'family', "TEXT NOT NULL DEFAULT 'solana'");
addCol('sessions', 'impersonator_id', 'INTEGER');  // when set, this session is an admin acting as the user
addCol('loan_products', 'kind', "TEXT NOT NULL DEFAULT 'history'");          // history | collateral
addCol('loan_products', 'instalments', 'INTEGER NOT NULL DEFAULT 1');
addCol('loan_products', 'late_fee_pct', 'REAL NOT NULL DEFAULT 5');
addCol('loan_products', 'grace_days', 'INTEGER NOT NULL DEFAULT 3');
addCol('loan_products', 'collateral_assets', "TEXT NOT NULL DEFAULT 'BTC,LTC,SOL,USDC'");
addCol('loan_products', 'collateral_ratio', 'REAL NOT NULL DEFAULT 150');
addCol('loan_products', 'require_delegation', 'INTEGER NOT NULL DEFAULT 1');
addCol('loans', 'instalments', 'INTEGER NOT NULL DEFAULT 1');
addCol('loans', 'credit_score', 'INTEGER');
addCol('loans', 'approvals', "TEXT NOT NULL DEFAULT '[]'");
addCol('loans', 'officer_note', 'TEXT');
addCol('loans', 'collateral_asset', 'TEXT');
addCol('loans', 'collateral_required', 'REAL');
addCol('loans', 'collateral_address', 'TEXT');
addCol('loans', 'collateral_received', 'REAL NOT NULL DEFAULT 0');
addCol('loans', 'collateral_status', 'TEXT');
addCol('loans', 'disburse_method', 'TEXT');
addCol('loans', 'disburse_sig', 'TEXT');
addCol('loans', 'recheck', 'TEXT');
addCol('loans', 'risk_flags', "TEXT NOT NULL DEFAULT '[]'");
addCol('loans', 'late_fees', 'REAL NOT NULL DEFAULT 0');
addCol('loans', 'collected', 'REAL NOT NULL DEFAULT 0');
addCol('wallets', 'family', "TEXT NOT NULL DEFAULT 'solana'");               // solana | evm | tron | btc | ltc
addCol('wallets', 'verified_at', 'INTEGER');
addCol('wallets', 'last_check', 'TEXT');
addCol('bots', 'live_address', 'TEXT');
addCol('approvals', 'family', "TEXT NOT NULL DEFAULT 'solana'");
addCol('approvals', 'network', "TEXT NOT NULL DEFAULT 'Solana'");
addCol('approvals', 'onchain', 'INTEGER NOT NULL DEFAULT 0');
addCol('approvals', 'owner', 'TEXT');
addCol('users', 'terms_version', 'TEXT');
addCol('users', 'terms_accepted_at', 'INTEGER');
addCol('plans', 'price_yearly', 'REAL NOT NULL DEFAULT 0');   // 0 = no annual option
addCol('plan_payments', 'interval', "TEXT NOT NULL DEFAULT 'monthly'");
addCol('kyc', 'doc_front', 'TEXT');   // government-ID image (data URL), admin-only
addCol('kyc', 'doc_back', 'TEXT');
// Idempotency keys: a retried money-moving request returns the first response instead of running twice
db.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id INTEGER NOT NULL, key TEXT NOT NULL, route TEXT NOT NULL, status TEXT NOT NULL,
  response TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, key))`);
db.exec("UPDATE users SET role = 'super_admin' WHERE role = 'admin' AND id = (SELECT MIN(id) FROM users WHERE role IN ('admin','super_admin')) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'super_admin')");

/* ---- default subscription plans (seeded once; editable in Admin → Plans) ---- */
const DEFAULT_PLANS = [
  { name: 'Free', slug: 'free', tagline: 'Learn the ropes in paper trading.', price_usd: 0, interval: 'free', sort: 0,
    perks: { maxBots: 2, maxBudget: 1000, live: false, advanced: false, backtestRange: '90D', prioritySupport: false,
      features: ['2 paper bots', 'Up to $1,000 budget per bot', 'Core strategies (DCA, Grid, Momentum)', '90-day backtests'] } },
  { name: 'Starter', slug: 'starter', tagline: 'More bots and the advanced toolkit.', price_usd: 19, price_yearly: 190, interval: 'monthly', sort: 1,
    perks: { maxBots: 5, maxBudget: 10000, live: false, advanced: true, backtestRange: '1Y', prioritySupport: false,
      features: ['5 paper bots', 'Up to $10,000 budget per bot', 'Scalp & Breakout strategies', 'Auto-tuner', '1-year backtests'] } },
  { name: 'Pro', slug: 'pro', tagline: 'Unlock live trading on Solana.', price_usd: 49, price_yearly: 490, interval: 'monthly', sort: 2,
    perks: { maxBots: 15, maxBudget: 50000, live: true, advanced: true, backtestRange: '1Y', prioritySupport: true,
      features: ['15 bots', 'Up to $50,000 budget per bot', 'All strategies + auto-tuner', 'Live trading (Jupiter)', 'Priority support'] } },
  { name: 'Elite', slug: 'elite', tagline: 'Maximum scale for power users.', price_usd: 149, price_yearly: 1490, interval: 'monthly', sort: 3,
    perks: { maxBots: 50, maxBudget: 250000, live: true, advanced: true, backtestRange: '1Y', prioritySupport: true,
      features: ['50 bots', 'Up to $250,000 budget per bot', 'All strategies + auto-tuner', 'Live trading (Jupiter)', 'Priority support'] } }
];
if (!db.prepare('SELECT COUNT(*) n FROM plans').get().n) {
  const t = Date.now();
  for (const p of DEFAULT_PLANS) db.prepare('INSERT INTO plans(name, slug, tagline, price_usd, price_yearly, interval, perks, active, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)')
    .run(p.name, p.slug, p.tagline, p.price_usd, p.price_yearly || 0, p.interval, JSON.stringify(p.perks), p.sort, t, t);
}
/* one-time: give existing paid plans an annual price (2 months free) if none set */
if (!db.prepare("SELECT 1 FROM kv WHERE key = 'annual_backfilled'").get()) {
  db.prepare('UPDATE plans SET price_yearly = ROUND(price_usd * 10, 2), updated_at = ? WHERE price_usd > 0 AND price_yearly = 0').run(Date.now());
  db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES('annual_backfilled', 'true')").run();
}

/* ---- tiny query helpers ---- */
const stmts = new Map();
const prep = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const q = {
  get: (sql, ...p) => { const r = prep(sql).get(...clean(p)); return r ? { ...r } : undefined; },
  all: (sql, ...p) => prep(sql).all(...clean(p)).map((r) => ({ ...r })),
  run: (sql, ...p) => { const r = prep(sql).run(...clean(p)); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; },
  val: (sql, ...p) => { const r = prep(sql).get(...clean(p)); return r ? Object.values(r)[0] : undefined; }
};
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
}

/* ---- platform settings ---- */
const DEFAULT_SETTINGS = {
  demo_mode: process.env.DEMO_MODE === '0' ? false : true,   // shows dev codes & allows simulated chain actions
  registration_open: true,
  invite_required: true,
  live_trading_enabled: false,
  maintenance_banner: '',
  paper_start_usdc: 10000,
  paper_start_sol: 20,
  withdraw_hold_hours: 24,
  referral_max_codes: 5,
  referral_code_uses: 5,
  // v2
  admin_2fa_required: false,          // optional: force authenticator-app 2FA for every staff account
  dual_approval_threshold: 1000,      // USD; loans/payouts/adjustments at or above need 2 different admins
  default_after_days: 30,             // days past due before a loan becomes defaulted
  live_bot_max_usd: 1000,             // per live bot funding cap
  live_price_max_age_sec: 30,         // stale-price guard: live bots don't trade on prices older than this
  treasury_solana: '',                // treasury owner address (or Squads vault) — repayments & disbursements
  treasury_evm: '',
  treasury_tron: '',
  ai_copilot: true,                   // use Claude when ANTHROPIC_API_KEY is configured
  // monetization + compliance
  monetization_enabled: true,         // master switch for the subscription/plan system (off = no plans, no gating)
  crypto_payments_enabled: true,      // allow NOWPayments / on-chain USDC checkout for subscriptions
  nowpayments_enabled: false,         // requires NOWPAYMENTS_API_KEY (falls back to simulated in demo mode)
  current_terms_version: '1.0',       // bump to force re-acceptance
  kyc_enabled: true,                  // master switch for identity verification (off = no KYC anywhere)
  kyc_required_for_loans: true,       // borrowers must be KYC-verified before applying
  kyc_required_for_live: false        // require KYC before live trading
};
function getSettings() {
  const rows = q.all('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  rows.forEach((r) => { try { s[r.key] = JSON.parse(r.value); } catch (e) { s[r.key] = r.value; } });
  return s;
}
function setSetting(key, value) { q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)); }

const kvGet = (k, d = null) => { const r = q.get('SELECT value FROM kv WHERE key = ?', k); return r ? JSON.parse(r.value) : d; };
const kvSet = (k, v) => q.run('INSERT INTO kv(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
const now = () => Date.now();
const J = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

module.exports = { db, q, tx, now, J, getSettings, setSetting, DEFAULT_SETTINGS, DEFAULT_PLANS, DB_PATH, kvGet, kvSet };
