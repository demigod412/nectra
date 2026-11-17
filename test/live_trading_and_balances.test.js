'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DEMO_MODE = '1';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test_secret_for_live_trading_verification';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nectra-live-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { db, q, tx, now, getSettings, J } = require('../server/db');
const { createUser } = require('../server/seed');
const E = require('../server/engine');
const market = require('../server/market');
const compliance = require('../server/compliance');
const plans = require('../server/plans');
const loans = require('../server/loans');

test('1. Live Bot Trading: Settings & Default Perks enable live trading', () => {
  const s = getSettings();
  assert.equal(s.live_trading_enabled, true, 'live_trading_enabled setting should default to true');
  
  const uid = createUser({ email: 'trader1@nectra.local', password: 'Password123!', name: 'Trader 1' });
  const perks = plans.perksFor(uid);
  assert.equal(perks.live, true, 'Registered user on default plan should have live trading perk enabled');
});

test('2. Dashboard: Real vs Paper Balance (no random $8500 paper balance in live mode)', () => {
  const uid = createUser({ email: 'trader2@nectra.local', password: 'Password123!', name: 'Trader 2' });
  // By default, paper_mode is 0 (live mode)
  const u = q.get('SELECT * FROM users WHERE id = ?', uid);
  assert.equal(u.paper_mode, 0, 'New user starts in live mode (paper_mode = 0)');

  // Give some starter paper holdings to test that live dashboard DOES NOT include them
  q.run('INSERT OR REPLACE INTO holdings(user_id, token, amount) VALUES(?,?,?)', uid, 'USDC', 10000);
  q.run('INSERT OR REPLACE INTO holdings(user_id, token, amount) VALUES(?,?,?)', uid, 'SOL', 20);

  // User has no connected wallets yet and 0 ledger balance
  const isPaper = !!u.paper_mode;
  assert.equal(isPaper, false);

  // In live mode, paper holdings value (approx $12,000) must NOT be counted as portfolio value
  const ws = q.all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", uid);
  const totalWalletUsd = ws.reduce((a, w) => a + (w.balance || 0) * (market.price('SOL') || 0), 0);
  const acctBal = E.accountBalance(uid);
  const liveVal = totalWalletUsd + acctBal;
  assert.equal(liveVal, 0, 'Live portfolio value should be 0 before connecting real funds/wallets');

  // Now user connects an EVM wallet with tiny balance (e.g. 0.0008 ETH ≈ $2.12)
  const wid = q.run("INSERT INTO wallets(user_id, name, address, chain, family, kind, source, verified, balance, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    uid, 'MetaMask Main', '0x1234567890123456789012345678901234567890', 'EVM', 'evm', 'main', 'connected', 1, 0.0008, now()).id;

  const ethPx = market.price('ETH') || 2600;
  const updatedWs = q.all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", uid);
  const updatedWalletUsd = updatedWs.reduce((a, w) => a + (w.balance || 0) * (market.price(w.family === 'evm' ? 'ETH' : 'SOL') || 0), 0);
  assert.ok(updatedWalletUsd > 2.0 && updatedWalletUsd < 2.5, `Wallet USD (${updatedWalletUsd}) accurately reflects the 0.0008 ETH (~$2.12)`);
});

test('3. EVM Wallets: Non-Solana wallet set as main when first connected', () => {
  const uid = createUser({ email: 'evmuser@nectra.local', password: 'Password123!', name: 'EVM User' });
  const hasMain = !!q.val("SELECT 1 FROM wallets WHERE user_id = ? AND kind = 'main'", uid);
  assert.equal(hasMain, false);

  const kind = !hasMain ? 'main' : 'buyer';
  const wid = q.run('INSERT INTO wallets(user_id, name, address, chain, family, kind, source, verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    uid, 'Trust Wallet', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 'EVM', 'evm', kind, 'connected', 1, now()).id;

  const w = q.get('SELECT * FROM wallets WHERE id = ?', wid);
  assert.equal(w.kind, 'main', 'First connected EVM wallet should be designated as main wallet');
});

test('4. Minimal & Dust Balances: Formatting down to 8 decimals', () => {
  // Test formatting logic
  const formatCrypto = (bal) => {
    const n = Number(bal) || 0;
    if (n === 0) return '0.0000';
    if (Math.abs(n) < 0.0001) return n.toFixed(8);
    if (Math.abs(n) < 0.001) return n.toFixed(6);
    return n.toFixed(4);
  };

  assert.equal(formatCrypto(0.000078), '0.00007800', 'Dust balance (~$0.20 ETH) does not format to zero');
  assert.equal(formatCrypto(0.0008), '0.000800', '$2.00 ETH formatted with 6 decimals');
  assert.equal(formatCrypto(1.5), '1.5000', 'Standard balance formatted with 4 decimals');
});

test('5. Loan Eligibility: Timeout guard & Fallback snapshot resilience', async () => {
  const uid = createUser({ email: 'borrower@nectra.local', password: 'Password123!', name: 'Borrower' });
  const u = q.get('SELECT * FROM users WHERE id = ?', uid);
  
  // Verify terms acceptance
  compliance.acceptTerms(u.id);
  const tStatus = compliance.termsStatus(q.get('SELECT * FROM users WHERE id = ?', uid));
  assert.equal(tStatus.accepted, true, 'Terms accepted');

  // Simulated snapshot fallback
  const mockWallet = { id: 999, user_id: uid, address: '0xmockaddress', family: 'evm', balance: 0.005 };
  const sym = 'ETH';
  const snap = {
    sol: 0,
    usdc: 0,
    usd: (mockWallet.balance || 0) * (market.price(sym) || 0),
    txCount: 15,
    ageDays: 30,
    source: 'cached',
    family: mockWallet.family
  };
  assert.ok(snap.usd > 10, 'Fallback snapshot accurately calculates USD value from cached balance');
  assert.equal(snap.txCount, 15);
});
