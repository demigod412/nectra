/* ==========================================================================
   Tron (TronWeb): TronLink ownership proofs, TRX + USDT (TRC-20) balances,
   TRC-20 allowances for loan collection, collector transferFrom,
   incoming USDT detection (TronGrid)
   ========================================================================== */
'use strict';
const { TronWeb } = require('tronweb');
const vault = require('../vault');

const HOST = process.env.TRON_RPC || 'https://api.trongrid.io';
const headers = process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : undefined;
const USDT = process.env.TRON_USDT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const DEC = 6;
const base = new TronWeb({ fullHost: HOST, headers });

const collectorKey = () => vault.secret('tron_collector', () => base.utils.accounts.generateAccount().privateKey.replace(/^0x/, ''), 'TRON_COLLECTOR_KEY');
const collectorAddress = () => base.address.fromPrivateKey(collectorKey());
const signer = () => new TronWeb({ fullHost: HOST, headers, privateKey: collectorKey() });
const reader = () => { const t = new TronWeb({ fullHost: HOST, headers }); t.setAddress(collectorAddress()); return t; };
const isAddress = (a) => base.isAddress(a || '');

async function verifySignature(address, message, signature) {
  try { return (await base.trx.verifyMessageV2(message, signature)) === address; } catch (e) { return false; }
}
async function balances(address) {
  const t = reader();
  const trx = (await t.trx.getBalance(address)) / 1e6;
  const c = await t.contract().at(USDT);
  const usdt = Number((await c.balanceOf(address).call()).toString()) / 10 ** DEC;
  const acct = await t.trx.getAccount(address).catch(() => ({}));
  return { TRX: trx, USDT: usdt, createdAt: acct.create_time || null };
}
async function allowance(owner, spender) {
  const c = await reader().contract().at(USDT);
  return Number((await c.allowance(owner, spender).call()).toString()) / 10 ** DEC;
}
/** Parameters the client passes to TronLink to approve the collector */
const approveCall = (spender, uiAmount) => ({ contract: USDT, spender, amount: String(Math.round(uiAmount * 10 ** DEC)) });
async function txStatus(txid) {
  try { const i = await base.trx.getTransactionInfo(txid); if (!i || !i.id) return 'pending'; return i.receipt && i.receipt.result === 'SUCCESS' ? 'confirmed' : 'failed'; } catch (e) { return 'pending'; }
}
async function collect(owner, uiAmount, treasury) {
  const c = await signer().contract().at(USDT);
  return c.transferFrom(owner, treasury, Math.round(uiAmount * 10 ** DEC)).send({ feeLimit: 60_000_000 });
}
async function scanIncoming(to, sinceTs) {
  const url = `${HOST}/v1/accounts/${to}/transactions/trc20?only_to=true&contract_address=${USDT}&limit=50&order_by=block_timestamp,asc${sinceTs ? '&min_timestamp=' + (Number(sinceTs) + 1) : ''}`;
  const r = await (await fetch(url, { headers })).json();
  const items = (r.data || []).map((x) => ({ sig: x.transaction_id, from: x.from, amount: Number(x.value) / 10 ** DEC, ts: x.block_timestamp }));
  return { items, cursor: items.length ? String(items[items.length - 1].ts) : sinceTs || String(Date.now() - 3600e3) };
}

module.exports = { USDT, isAddress, verifySignature, balances, allowance, approveCall, txStatus, collect, collectorAddress, scanIncoming };
