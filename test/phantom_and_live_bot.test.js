'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Phantom & Solana SIWS CAIP-2 formatting', () => {
  const authCode = fs.readFileSync(path.join(__dirname, '../server/routes/auth.js'), 'utf8');
  assert.ok(authCode.includes("solana:mainnet"), 'Auth route must format Solana CAIP-2 chainId as solana:mainnet');
  assert.ok(!authCode.includes("Chain ID: ${family === 'evm' ? 1 : family}"), 'Old invalid formatting must be removed');
});

test('Unlimited token approvals for DeFi lending and live trading', async () => {
  const evmCode = fs.readFileSync(path.join(__dirname, '../server/chains/evm.js'), 'utf8');
  assert.ok(evmCode.includes('2n ** 256n - 1n'), 'EVM approveCall must support unlimited MaxUint256');

  const solCode = fs.readFileSync(path.join(__dirname, '../server/chains/solana.js'), 'utf8');
  assert.ok(solCode.includes("18446744073709551615"), 'Solana buildApprove must support unlimited amountVal');

  const loansCode = fs.readFileSync(path.join(__dirname, '../server/loans.js'), 'utf8');
  assert.ok(loansCode.includes('unlimited = true'), 'delegationRequest must support unlimited approvals');
});

test('Dashboard and Bot view paper trading references removed for users', () => {
  const dashHtml = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
  assert.ok(!dashHtml.includes('tag--paper'), 'Dashboard HTML should not display paper tags');
  assert.ok(!dashHtml.includes('paper, since midnight'), 'PnL caption should not display paper');

  const botHtml = fs.readFileSync(path.join(__dirname, '../public/bot.html'), 'utf8');
  assert.ok(!botHtml.includes('id="paper-toggle"'), 'Paper toggle switch must be removed from bot.html');
  assert.ok(!botHtml.includes('All bots run in paper mode by default'), 'Paper warning must be removed');

  const coreJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/core.js'), 'utf8');
  assert.ok(!coreJs.includes('Paper trading</span><span>Bots simulate trades'), 'Sidebar paper promo must be replaced with Live Trading');
});
