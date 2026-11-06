/* ==========================================================================
   Solana helpers: base58, ed25519 signature verification, JSON-RPC,
   wallet snapshots (balance + history) used for loan eligibility
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');

const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const CLUSTER = process.env.SOLANA_CLUSTER || 'mainnet-beta';
const USDC_MINT = process.env.USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/* ---------- base58 ---------- */
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...A].map((c, i) => [c, i]));
function b58decode(s) {
  if (typeof s !== 'string' || !s.length) return null;
  let n = 0n;
  for (const c of s) { const v = MAP[c]; if (v === undefined) return null; n = n * 58n + BigInt(v); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
const isSolAddress = (a) => { const b = b58decode(a); return !!b && b.length === 32; };
const isEvmAddress = (a) => /^0x[a-fA-F0-9]{40}$/.test(a || '');
const randomAddress = () => b58encode(crypto.randomBytes(32));

/** Verify an ed25519 signature produced by a Solana wallet's signMessage() */
function verifySignature(address, message, signature) {
  try {
    const pub = b58decode(address);
    if (!pub || pub.length !== 32) return false;
    let sig = b58decode(signature);
    if (!sig || sig.length !== 64) sig = Buffer.from(String(signature), 'base64');
    if (sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch (e) { return false; }
}

/* ---------- JSON-RPC ---------- */
async function rpc(method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result;
  } finally { clearTimeout(t); }
}
async function getSolBalance(address) { const r = await rpc('getBalance', [address, { commitment: 'confirmed' }]); return r.value / 1e9; }
async function getUsdcBalance(address) {
  const r = await rpc('getTokenAccountsByOwner', [address, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]);
  return (r.value || []).reduce((a, acc) => a + (acc.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
}
async function getHistory(address) {
  const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1000 }]);
  const oldest = sigs.length ? sigs[sigs.length - 1].blockTime : null;
  return { txCount: sigs.length, ageDays: oldest ? (Date.now() / 1000 - oldest) / 86400 : 0 };
}
/** Real on-chain snapshot used for loan eligibility */
async function walletSnapshot(address, solPrice) {
  const [sol, usdc, hist] = await Promise.all([getSolBalance(address), getUsdcBalance(address).catch(() => 0), getHistory(address)]);
  return { sol, usdc, usd: sol * solPrice + usdc, txCount: hist.txCount, ageDays: hist.ageDays, source: 'rpc' };
}
/** Deterministic simulated snapshot — ONLY used in demo mode for demo wallets or when RPC is unreachable */
function simulatedSnapshot(address, solPrice) {
  const h = crypto.createHash('sha256').update(address).digest();
  const sol = 2 + (h[0] / 255) * 60;
  const usdc = Math.round((h[1] / 255) * 4000);
  return { sol: +sol.toFixed(4), usdc, usd: sol * solPrice + usdc, txCount: 20 + h[2] * 3, ageDays: 30 + h[3] * 2, source: 'simulated' };
}
async function signatureStatus(sig) {
  const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  return r.value[0]; // null | { confirmationStatus, err, confirmations }
}
const latestBlockhash = () => rpc('getLatestBlockhash', [{ commitment: 'finalized' }]).then((r) => r.value);
const sendRawTransaction = (b64) => rpc('sendTransaction', [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}${CLUSTER === 'mainnet-beta' ? '' : '?cluster=' + CLUSTER}`;

module.exports = { b58decode, b58encode, isSolAddress, isEvmAddress, randomAddress, verifySignature, rpc, getSolBalance, walletSnapshot, simulatedSnapshot, signatureStatus, latestBlockhash, sendRawTransaction, explorerTx, CLUSTER, RPC_URL };
