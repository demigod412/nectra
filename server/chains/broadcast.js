/* Raw transaction broadcasters for pre-signed native transfers.
   Uses a helper on the chain module when one exists. */
'use strict';
const evm = require('./evm');
const tron = require('./tron');

function rpcFor(network) {
  const n = evm.NETWORKS && evm.NETWORKS[network];
  if (!n) throw new Error('Unknown EVM network: ' + network);
  const url = n.rpcUrl || n.rpc || n.url || (typeof n === 'string' ? n : null);
  if (!url) throw new Error('No RPC configured for ' + network);
  return url;
}

async function sendEvm(network, raw) {
  if (typeof evm.sendRaw === 'function') return evm.sendRaw(network, raw);
  const r = await fetch(rpcFor(network), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC rejected the transaction');
  return j.result;
}

async function sendTron(raw) {
  if (typeof tron.sendRaw === 'function') return tron.sendRaw(raw);
  const T = tron.tronWeb && tron.tronWeb();
  if (!T) throw new Error('Tron is not configured');
  const signed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const res = await T.trx.sendRawTransaction(signed);
  if (!res || res.result === false) throw new Error((res && res.message) || 'Tron rejected the transaction');
  return res.txid || (signed && signed.txID);
}

module.exports = { sendEvm, sendTron };
