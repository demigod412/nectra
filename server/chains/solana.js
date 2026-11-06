/* ==========================================================================
   Solana (web3.js + spl-token)
   - unsigned transactions built server-side, signed by the user's wallet
   - SPL delegate approvals (loan collection) + revokes
   - delegated collection signed by the platform collector key
   - transfer verification / treasury scanning via parsed transactions
   - Jupiter swaps for live bot wallets
   ========================================================================== */
'use strict';
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, VersionedTransaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { b58decode, b58encode, RPC_URL, CLUSTER } = require('../chain');
const vault = require('../vault');

const conn = new Connection(RPC_URL, 'confirmed');
const MAINNET = CLUSTER === 'mainnet-beta';
const MINTS = MAINNET ? {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  RENDER: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'
} : {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: process.env.USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  USDT: process.env.USDT_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
};
const pk = (a) => new PublicKey(a);
const decimalsCache = new Map();
async function decimals(mint) {
  if (!decimalsCache.has(mint)) decimalsCache.set(mint, (await spl.getMint(conn, pk(mint))).decimals);
  return decimalsCache.get(mint);
}
const toBase = (ui, dec) => BigInt(Math.round(ui * 10 ** Math.min(dec, 9))) * 10n ** BigInt(Math.max(dec - 9, 0));
const ata = (owner, mint) => spl.getAssociatedTokenAddressSync(pk(mint), pk(owner), true);

/* ---------- platform keys ---------- */
function keypairFromSecret(s) { return Keypair.fromSecretKey(b58decode(s)); }
/** Collector: the delegate that borrowers approve; signs collections on default */
function collector() { return keypairFromSecret(vault.secret('solana_collector', () => b58encode(Keypair.generate().secretKey), 'SOLANA_COLLECTOR_SECRET')); }
const collectorAddress = () => collector().publicKey.toBase58();

async function unsigned(feePayer, ixs) {
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  const tx = new Transaction({ feePayer: pk(feePayer), recentBlockhash: blockhash }).add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/* ---------- user-signed transactions ---------- */
async function buildApprove(owner, token, delegate, uiAmount) {
  const mint = MINTS[token]; if (!mint) throw new Error('Unsupported token ' + token);
  const dec = await decimals(mint);
  const account = ata(owner, mint);
  const ixs = [];
  // create the token account if missing so the approval also covers future balances
  if (!(await conn.getAccountInfo(account))) ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(pk(owner), account, pk(owner), pk(mint)));
  ixs.push(spl.createApproveCheckedInstruction(account, pk(mint), pk(delegate), pk(owner), toBase(uiAmount, dec), dec));
  return unsigned(owner, ixs);
}
async function buildRevoke(owner, token) {
  const mint = MINTS[token];
  return unsigned(owner, [spl.createRevokeInstruction(ata(owner, mint), pk(owner))]);
}
async function buildSolTransfer(from, to, sol) {
  return unsigned(from, [SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports: Math.round(sol * 1e9) })]);
}
async function buildTokenTransfer(from, to, token, uiAmount) {
  const mint = MINTS[token]; const dec = await decimals(mint);
  const dest = ata(to, mint);
  return unsigned(from, [
    spl.createAssociatedTokenAccountIdempotentInstruction(pk(from), dest, pk(to), pk(mint)),
    spl.createTransferCheckedInstruction(ata(from, mint), pk(mint), dest, pk(from), toBase(uiAmount, dec), dec)
  ]);
}

/* ---------- reads ---------- */
async function tokenState(owner, token) {
  const mint = MINTS[token];
  try {
    const a = await spl.getAccount(conn, ata(owner, mint));
    const dec = await decimals(mint);
    return { balance: Number(a.amount) / 10 ** dec, delegate: a.delegate ? a.delegate.toBase58() : null, delegated: Number(a.delegatedAmount) / 10 ** dec };
  } catch (e) { return { balance: 0, delegate: null, delegated: 0 }; }
}
/** Net token change per owner in a confirmed transaction (robust for any transfer form) */
async function tokenDeltas(sig, token) {
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx || !tx.meta) return null;
  if (tx.meta.err) return { failed: true };
  const mint = MINTS[token], d = {};
  const add = (list, sign) => (list || []).filter((b) => b.mint === mint).forEach((b) => { d[b.owner] = (d[b.owner] || 0) + sign * (b.uiTokenAmount.uiAmount || 0); });
  add(tx.meta.postTokenBalances, 1); add(tx.meta.preTokenBalances, -1);
  return { deltas: d, blockTime: tx.blockTime };
}
/** Verify an SPL transfer `to` received >= amount (optionally from `from`) */
async function verifyTokenTransfer(sig, { to, from, token, amount }) {
  const r = await tokenDeltas(sig, token);
  if (!r) return { ok: false, reason: 'Transaction not found (yet)' };
  if (r.failed) return { ok: false, reason: 'Transaction failed on-chain' };
  const got = r.deltas[to] || 0;
  if (got + 1e-6 < amount) return { ok: false, reason: `Recipient received ${got} ${token}, expected ${amount}` };
  if (from && !((r.deltas[from] || 0) < 0)) return { ok: false, reason: 'Sender does not match' };
  return { ok: true, received: got };
}
/** Incoming token transfers to `owner` since the last seen signature */
async function scanIncoming(owner, token, untilSig) {
  const account = ata(owner, MINTS[token]);
  const sigs = await conn.getSignaturesForAddress(account, { limit: 25, until: untilSig || undefined });
  const out = [];
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const r = await tokenDeltas(s.signature, token);
    if (!r || r.failed) continue;
    const gained = r.deltas[owner] || 0;
    const sender = Object.entries(r.deltas).find(([o, v]) => o !== owner && v < 0);
    out.push({ sig: s.signature, amount: gained, from: sender ? sender[0] : null, outflow: Object.entries(r.deltas).filter(([o, v]) => o !== owner && v > 0).map(([o, v]) => ({ to: o, amount: v })), self: r.deltas[owner] || 0 });
  }
  return { items: out, cursor: sigs.length ? sigs[sigs.length - 1].signature : untilSig };
}

/* ---------- collection (delegate transfer signed by collector) ---------- */
async function collect(owner, token, uiAmount, treasury) {
  const kp = collector();
  const mint = MINTS[token]; const dec = await decimals(mint);
  const dest = ata(treasury, mint);
  const tx = new Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, dest, pk(treasury), pk(mint)),
    spl.createTransferCheckedInstruction(ata(owner, mint), pk(mint), dest, kp.publicKey, toBase(uiAmount, dec), dec)
  );
  const sig = await conn.sendTransaction(tx, [kp], { preflightCommitment: 'confirmed' });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

/* ---------- live bot wallets + Jupiter swaps ---------- */
function newBotWallet() { const kp = Keypair.generate(); return { address: kp.publicKey.toBase58(), secret: vault.encrypt(b58encode(kp.secretKey)) }; }
const botKeypair = (encSecret) => keypairFromSecret(vault.decrypt(encSecret));
const JUP = process.env.JUPITER_API || 'https://lite-api.jup.ag/swap/v1';
/** Build an unsigned Jupiter swap (base64 versioned tx) for the USER's wallet to sign */
async function buildUserSwap(owner, fromToken, toToken, uiAmount, slippageBps = 50) {
  const inMint = MINTS[fromToken], outMint = MINTS[toToken];
  const amount = toBase(uiAmount, await decimals(inMint)).toString();
  const quote = await (await fetch(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`)).json();
  if (quote.error || !quote.outAmount) throw new Error('No route for that pair/size');
  const swap = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json();
  if (!swap.swapTransaction) throw new Error('Swap build failed');
  return { tx: swap.swapTransaction, versioned: true, out: Number(quote.outAmount) / 10 ** (await decimals(outMint)), in: uiAmount, from: fromToken, to: toToken };
}
async function jupiterSwap(encSecret, fromToken, toToken, uiAmount, slippageBps = 50) {
  const kp = botKeypair(encSecret);
  const inMint = MINTS[fromToken], outMint = MINTS[toToken];
  if (!inMint || !outMint) throw new Error(`No mint for ${fromToken}/${toToken}`);
  const amount = toBase(uiAmount, await decimals(inMint)).toString();
  const quote = await (await fetch(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`)).json();
  if (quote.error || !quote.outAmount) throw new Error('Jupiter quote failed: ' + (quote.error || 'no route'));
  const swap = await (await fetch(`${JUP}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: kp.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json();
  if (!swap.swapTransaction) throw new Error('Jupiter swap build failed');
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error('Swap failed on-chain');
  const outDec = await decimals(outMint);
  return { sig, out: Number(quote.outAmount) / 10 ** outDec, in: uiAmount };
}
async function walletBalances(address, tokens) {
  const out = { SOL: (await conn.getBalance(pk(address))) / 1e9 };
  for (const t of tokens) if (t !== 'SOL') out[t] = (await tokenState(address, t)).balance;
  return out;
}
/** Server-signed SOL/token withdrawal from a bot wallet to the owner's address */
async function botWithdraw(encSecret, to, token, uiAmount) {
  const kp = botKeypair(encSecret);
  let tx;
  if (token === 'SOL') tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pk(to), lamports: Math.round(uiAmount * 1e9) }));
  else {
    const mint = MINTS[token]; const dec = await decimals(mint); const dest = ata(to, mint);
    tx = new Transaction().add(spl.createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, dest, pk(to), pk(mint)), spl.createTransferCheckedInstruction(ata(kp.publicKey.toBase58(), mint), pk(mint), dest, kp.publicKey, toBase(uiAmount, dec), dec));
  }
  const sig = await conn.sendTransaction(tx, [kp]);
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

module.exports = { conn, MINTS, collector, collectorAddress, buildApprove, buildRevoke, buildSolTransfer, buildTokenTransfer, tokenState, verifyTokenTransfer, scanIncoming, collect, newBotWallet, jupiterSwap, buildUserSwap, walletBalances, botWithdraw, decimals };
