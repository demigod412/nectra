/* ==========================================================================
   BTC / LTC collateral escrow (watch-only)
   UTXO chains have no "approval" mechanism, so collateral loans use a unique
   deposit address per loan derived from an admin-held extended PUBLIC key
   (BTC_COLLATERAL_XPUB / LTC_COLLATERAL_XPUB, BIP84 account level, native
   segwit). The server can watch deposits but can never spend them — the
   admin holds the private keys and releases collateral after repayment.
   ========================================================================== */
'use strict';
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const ecc = require('@bitcoinerlab/secp256k1');
const crypto = require('node:crypto');
const vault = require('../vault');

const bip32 = BIP32Factory(ecc);
const LTC = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const NET = {
  BTC: { network: bitcoin.networks.bitcoin, api: process.env.BTC_ESPLORA || 'https://blockstream.info/api', env: 'BTC_COLLATERAL_XPUB' },
  LTC: { network: LTC, api: process.env.LTC_ESPLORA || 'https://litecoinspace.org/api', env: 'LTC_COLLATERAL_XPUB' }
};

/** Convert zpub/Ltub/etc. to a plain xpub version so bip32 can parse it */
function normalizeXpub(x) {
  const bs58check = require('bs58').default;
  const decoded = Buffer.from(bs58check.decode(x));
  const payload = decoded.subarray(0, decoded.length - 4);
  payload.writeUInt32BE(0x0488b21e, 0);
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  return bs58check.encode(Buffer.concat([payload, sum]));
}
/** Account xpub: env (admin-held) or, in development only, a generated test key flagged as such */
function accountNode(asset) {
  const n = NET[asset];
  const configured = process.env[n.env];
  if (configured) return { node: bip32.fromBase58(normalizeXpub(configured), { ...n.network, bip32: { public: 0x0488b21e, private: 0x0488ade4 } }), dev: false };
  const seedHex = vault.secret(`dev_${asset.toLowerCase()}_seed`, () => crypto.randomBytes(32).toString('hex'));
  return { node: bip32.fromSeed(Buffer.from(seedHex, 'hex'), n.network).derivePath(asset === 'BTC' ? "m/84'/0'/0'" : "m/84'/2'/0'").neutered(), dev: true };
}
function depositAddress(asset, index) {
  const { node, dev } = accountNode(asset);
  const child = node.derive(0).derive(index);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: NET[asset].network });
  return { address, dev };
}
/** Confirmed + mempool balance from an Esplora API */
async function addressBalance(asset, address) {
  const r = await (await fetch(`${NET[asset].api}/address/${address}`)).json();
  const conf = (r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum) / 1e8;
  const pending = (r.mempool_stats.funded_txo_sum - r.mempool_stats.spent_txo_sum) / 1e8;
  return { confirmed: conf, pending, txCount: r.chain_stats.tx_count };
}
const isAddress = (asset, a) => { try { bitcoin.address.toOutputScript(a, NET[asset].network); return true; } catch (e) { return false; } };

module.exports = { depositAddress, addressBalance, isAddress };
