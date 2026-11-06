/* ==========================================================================
   EVM chains (viem): Ethereum, Base, Arbitrum, BSC, Polygon
   - personal_sign ownership proofs
   - native + USDC/USDT balances, outgoing tx count
   - ERC-20 allowances (loan collection) and collector transferFrom on default
   - incoming ERC-20 transfers to the treasury (repayment detection)
   ========================================================================== */
'use strict';
const { createPublicClient, createWalletClient, http, verifyMessage, erc20Abi, parseUnits, formatUnits, parseAbiItem, isAddress, getAddress, encodeFunctionData } = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const chains = require('viem/chains');
const vault = require('../vault');

const NETWORKS = {
  Ethereum: { chain: chains.mainnet, rpc: process.env.RPC_ETHEREUM, native: 'ETH', tokens: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7' } },
  Base: { chain: chains.base, rpc: process.env.RPC_BASE, native: 'ETH', tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' } },
  Arbitrum: { chain: chains.arbitrum, rpc: process.env.RPC_ARBITRUM, native: 'ETH', tokens: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' } },
  BSC: { chain: chains.bsc, rpc: process.env.RPC_BSC, native: 'BNB', tokens: { USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', USDT: '0x55d398326f99059fF775485246999027B3197955' } },
  Polygon: { chain: chains.polygon, rpc: process.env.RPC_POLYGON, native: 'POL', tokens: { USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' } }
};
const clients = {};
const client = (net) => clients[net] || (clients[net] = createPublicClient({ chain: NETWORKS[net].chain, transport: http(NETWORKS[net].rpc || undefined, { timeout: 12000 }) }));
const decCache = new Map();
async function decimals(net, token) {
  const k = net + token;
  if (!decCache.has(k)) decCache.set(k, await client(net).readContract({ address: NETWORKS[net].tokens[token], abi: erc20Abi, functionName: 'decimals' }));
  return decCache.get(k);
}

/* ---------- collector (spender on ERC-20 approvals) ---------- */
const collectorAccount = () => privateKeyToAccount(vault.secret('evm_collector', () => generatePrivateKey(), 'EVM_COLLECTOR_KEY'));
const collectorAddress = () => collectorAccount().address;

const verifySignature = (address, message, signature) => verifyMessage({ address: getAddress(address), message, signature }).catch(() => false);
const chainIdOf = (net) => NETWORKS[net].chain.id;

async function balances(address) {
  const out = {};
  await Promise.all(Object.keys(NETWORKS).map(async (net) => {
    const c = client(net);
    try {
      const [native, nonce] = await Promise.all([c.getBalance({ address }), c.getTransactionCount({ address })]);
      const row = { native: Number(formatUnits(native, 18)), nativeSym: NETWORKS[net].native, txCount: nonce };
      for (const t of ['USDC', 'USDT']) {
        try { row[t] = Number(formatUnits(await c.readContract({ address: NETWORKS[net].tokens[t], abi: erc20Abi, functionName: 'balanceOf', args: [address] }), await decimals(net, t))); } catch (e) { row[t] = 0; }
      }
      out[net] = row;
    } catch (e) { out[net] = { error: 'unreachable' }; }
  }));
  return out;
}
async function allowance(net, token, owner, spender) {
  const v = await client(net).readContract({ address: NETWORKS[net].tokens[token], abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
  return Number(formatUnits(v, await decimals(net, token)));
}
async function tokenBalance(net, token, owner) {
  return Number(formatUnits(await client(net).readContract({ address: NETWORKS[net].tokens[token], abi: erc20Abi, functionName: 'balanceOf', args: [owner] }), await decimals(net, token)));
}
/** Calldata the user's wallet sends to approve the collector (client posts via eth_sendTransaction) */
/** Calldata/value for a native or ERC-20 transfer the user's wallet signs */
async function buildTransfer(net, coin, from, to, uiAmount) {
  const N = NETWORKS[net]; if (!N) throw new Error('Unsupported network ' + net);
  const chainId = '0x' + chainIdOf(net).toString(16);
  if (coin === N.native || coin === 'ETH' || coin === 'BNB' || coin === 'POL') return { chainId, to: getAddress(to), value: '0x' + parseUnits(String(uiAmount), 18).toString(16), network: net, coin };
  if (!N.tokens[coin]) throw new Error(`${coin} isn’t supported on ${net}`);
  return { chainId, to: N.tokens[coin], data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), parseUnits(String(uiAmount), await decimals(net, coin))] }), network: net, coin };
}
async function approveCall(net, token, spender, uiAmount) {
  return { chainId: '0x' + chainIdOf(net).toString(16), to: NETWORKS[net].tokens[token], data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, parseUnits(String(uiAmount), await decimals(net, token))] }) };
}
async function revokeCall(net, token, spender) {
  return { chainId: '0x' + chainIdOf(net).toString(16), to: NETWORKS[net].tokens[token], data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }) };
}
async function txStatus(net, hash) {
  try { const r = await client(net).getTransactionReceipt({ hash }); return r.status === 'success' ? 'confirmed' : 'failed'; } catch (e) { return 'pending'; }
}
/** On default: collector pulls approved tokens to the treasury */
async function collect(net, token, owner, uiAmount, treasury) {
  const account = collectorAccount();
  const w = createWalletClient({ account, chain: NETWORKS[net].chain, transport: http(NETWORKS[net].rpc || undefined) });
  const hash = await w.writeContract({ address: NETWORKS[net].tokens[token], abi: erc20Abi, functionName: 'transferFrom', args: [owner, treasury, parseUnits(String(uiAmount.toFixed(6)), await decimals(net, token))] });
  await client(net).waitForTransactionReceipt({ hash, timeout: 120000 });
  return hash;
}
/** Incoming ERC-20 transfers to `to` since the stored block cursor */
async function scanIncoming(net, token, to, fromBlock) {
  const c = client(net);
  const head = await c.getBlockNumber();
  const start = fromBlock ? BigInt(fromBlock) + 1n : head - 500n;
  const end = start + 1500n < head ? start + 1500n : head;
  if (end < start) return { items: [], cursor: String(head) };
  const logs = await c.getLogs({ address: NETWORKS[net].tokens[token], event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), args: { to }, fromBlock: start, toBlock: end });
  const dec = await decimals(net, token);
  return { items: logs.map((l) => ({ sig: l.transactionHash, from: l.args.from, amount: Number(formatUnits(l.args.value, dec)) })), cursor: String(end) };
}

module.exports = { NETWORKS, isAddress, getAddress, verifySignature, balances, allowance, tokenBalance, buildTransfer, approveCall, revokeCall, txStatus, collect, collectorAddress, scanIncoming, chainIdOf };
