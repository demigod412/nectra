/* ==========================================================================
   NECTRA — API client, live event stream, and non-custodial wallet module
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});

  /* ---------------- REST client ---------------- */
  NX.api = async (method, path, body) => {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Nectra': '1' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) {
      const err = new Error(j.error || `Request failed (${r.status})`);
      err.status = r.status; err.data = j;
      const app = document.body && document.body.classList.contains('app');
      if (r.status === 401 && app) location.href = 'login.html?next=' + encodeURIComponent(location.pathname.replace(/^\//, '') + location.search + location.hash);
      if (j.code === 'EMAIL_UNVERIFIED' && app) location.href = 'register.html#verify';
      throw err;
    }
    return j;
  };
  NX.get = (p) => NX.api('GET', p);
  NX.post = (p, b) => NX.api('POST', p, b || {});
  NX.patch = (p, b) => NX.api('PATCH', p, b || {});
  NX.del = (p) => NX.api('DELETE', p, {});
  /** Run an async action with a loading button + error toast. Returns result or null. */
  NX.act = async (btn, fn) => {
    if (btn) { btn.classList.add('is-loading'); btn.disabled = true; }
    try { return await fn(); }
    catch (e) { if (e.status !== 401) NX.toast(e.message, { type: 'error' }); return null; }
    finally { if (btn) { btn.classList.remove('is-loading'); btn.disabled = false; } }
  };
  /** Show a dev-mode code hint (only present when the server runs in demo mode) */
  NX.devHint = (res, el) => {
    if (!res || !res.devCode) return;
    NX.toast('Demo mode: your code is ' + res.devCode, { type: 'info', msg: 'Real deployments email it instead (see Admin → Mailbox).', duration: 9000 });
    if (el) el.innerHTML = `<span class="tag tag--paper">Demo code: <b class="mono">${res.devCode}</b></span>`;
  };

  /* ---------------- live stream (SSE) ---------------- */
  NX.stream = () => {
    if (NX._es || !window.EventSource) return;
    const es = (NX._es = new EventSource('/api/stream'));
    const on = (ev, fn) => es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
    const fire = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
    on('prices', (list) => {
      list.forEach((p) => { const t = NX.data.token && NX.data.token(p.sym); if (t) { t.price = p.price; t.ch = p.ch; } NX.updatePrice(p.sym, p.price, p.ch); });
      if (NX.data.token && NX.data.token('SOL')) NX.data.solPrice = NX.data.token('SOL').price;
      fire('nx:price', list);
    });
    on('notification', (n) => {
      NX.data.unread = (NX.data.unread || 0) + 1;
      NX.$$('[data-unread]').forEach((b) => { b.textContent = NX.data.unread; b.hidden = false; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); });
      NX.toast(n.title, { type: n.type === 'security' ? 'warn' : 'info', msg: n.body });
      fire('nx:notification', n);
    });
    on('insight', (x) => fire('nx:insight', x));
    on('trade', (x) => fire('nx:trade', x));
    on('bot', (x) => fire('nx:bot', x));
    on('bots', () => fire('nx:bots-paused'));
    on('tx', (x) => fire('nx:tx', x));
    on('status', (s) => { NX.data.status = s; NX.renderStatus && NX.renderStatus(); fire('nx:status', s); });
  };

  /* ---------------- base58 ---------------- */
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  NX.b58 = (bytes) => {
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
  };
  NX.isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || '');
  NX.isEvm = (a) => /^0x[a-fA-F0-9]{40}$/.test(a || '');

  /* ---------------- local keys (IndexedDB, non-extractable) ---------------- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('nectra-keys', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbGet = async (k) => { const d = await idb(); return new Promise((res) => { const r = d.transaction('keys').objectStore('keys').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); };
  const idbPut = async (k, v) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('keys', 'readwrite'); t.objectStore('keys').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
  async function newLocalKey() {
    if (!crypto.subtle) throw new Error('Secure context required (use https or localhost)');
    let kp;
    try { kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); }
    catch (e) { throw new Error('This browser can’t create Ed25519 keys. Use a recent Chrome/Edge/Firefox/Safari, or connect Phantom.'); }
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const address = NX.b58(raw);
    await idbPut(address, kp);
    return address;
  }
  async function localSigner(address) {
    const kp = await idbGet(address);
    if (!kp) return null;
    return { address, provider: 'Local key', local: true, sign: async (msg) => NX.b58(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(msg)))) };
  }

  /* ---------------- injected wallet providers (Solana · EVM · Tron) ---------------- */
  const PROVIDERS = {
    phantom: { family: 'solana', get: () => (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom && window.solana) },
    solflare: { family: 'solana', get: () => window.solflare },
    backpack: { family: 'solana', get: () => (window.backpack && (window.backpack.solana || window.backpack)) || null },
    metamask: { family: 'evm', get: () => evmProvider('isMetaMask') },
    coinbase: { family: 'evm', get: () => window.coinbaseWalletExtension || evmProvider('isCoinbaseWallet') },
    trust: { family: 'evm', get: () => window.trustwallet || evmProvider('isTrust') || evmProvider('isTrustWallet') },
    binance: { family: 'evm', get: () => window.BinanceChain || evmProvider('isBinance') },
    evm: { family: 'evm', get: () => window.ethereum || null },
    tronlink: { family: 'tron', get: () => window.tronLink || (window.tronWeb && window.tronWeb.defaultAddress && window) || null }
  };
  function evmProvider(flag) {
    const e = window.ethereum;
    if (!e) return null;
    if (e.providers && e.providers.length) return e.providers.find((p) => p[flag]) || null;
    return e[flag] ? e : null;
  }
  const INSTALL = { phantom: 'https://phantom.app', solflare: 'https://solflare.com', backpack: 'https://backpack.app', coinbase: 'https://www.coinbase.com/wallet', trust: 'https://trustwallet.com', binance: 'https://www.binance.com/en/web3wallet', metamask: 'https://metamask.io', evm: 'https://metamask.io', tronlink: 'https://www.tronlink.org' };
  const NAMES = { phantom: 'Phantom', solflare: 'Solflare', backpack: 'Backpack', metamask: 'MetaMask', coinbase: 'Coinbase Wallet', trust: 'Trust Wallet', binance: 'Binance Wallet', evm: 'Browser wallet', tronlink: 'TronLink', demo: 'Demo wallet' };
  const toHex = (s) => '0x' + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const rejected = (e) => e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''));

  NX.wallet = {
    familyOf: (id) => (id === 'demo' ? 'solana' : (PROVIDERS[id] || {}).family),
    available: (id) => id === 'demo' ? !!(NX.data.settings && NX.data.settings.demo_mode) || !document.body.classList.contains('app') : !!(PROVIDERS[id] && PROVIDERS[id].get()),
    installUrl: (id) => INSTALL[id],
    /** Connect a wallet and return a signer { address, family, provider, sign(message) } */
    async connect(id) {
      if (id === 'demo') {
        let addr = NX.store.get('demo-wallet');
        if (!addr || !(await idbGet(addr))) { addr = await newLocalKey(); NX.store.set('demo-wallet', addr); }
        const s = await localSigner(addr); s.provider = 'Demo wallet'; s.family = 'solana'; return s;
      }
      const P = PROVIDERS[id];
      const p = P && P.get();
      if (!p) { const e = new Error(`${NAMES[id] || id} isn’t installed in this browser`); e.install = INSTALL[id]; throw e; }
      if (P.family === 'evm') {
        const [address] = await p.request({ method: 'eth_requestAccounts' });
        return { address, family: 'evm', provider: NAMES[id], injected: p, sign: (msg) => p.request({ method: 'personal_sign', params: [toHex(msg), address] }) };
      }
      if (P.family === 'tron') {
        if (window.tronLink && window.tronLink.request) await window.tronLink.request({ method: 'tron_requestAccounts' });
        const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
        if (!tw || !tw.defaultAddress || !tw.defaultAddress.base58) throw new Error('Unlock TronLink and try again');
        return { address: tw.defaultAddress.base58, family: 'tron', provider: 'TronLink', injected: tw, sign: (msg) => tw.trx.signMessageV2(msg) };
      }
      const res = await p.connect();
      const address = ((res && res.publicKey) || p.publicKey).toString();
      return { address, family: 'solana', provider: NAMES[id], injected: p, sign: async (msg) => { const out = await p.signMessage(new TextEncoder().encode(msg), 'utf8'); return NX.b58(out.signature || out); } };
    },
    /** Sign a server nonce for a purpose: login | register | link | loan */
    async prove(id, purpose, extra = {}) {
      const s = await NX.wallet.connect(id);
      const n = await NX.post('/api/auth/wallet/nonce', { address: s.address, purpose, family: s.family });
      const signature = await s.sign(n.message);
      return { address: n.address || s.address, family: s.family, provider: s.provider, nonce: n.nonce, signature, message: n.message, ...extra };
    },
    /** Create a brand-new trading wallet whose key never leaves this browser */
    async generate() {
      const address = await newLocalKey();
      const s = await localSigner(address);
      const n = await NX.post('/api/auth/wallet/nonce', { address, purpose: 'link' });
      return { address, provider: 'Generated (this browser)', nonce: n.nonce, signature: await s.sign(n.message) };
    },
    loadWeb3() {
      if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
      return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js'; s.onload = () => res(window.solanaWeb3); s.onerror = () => rej(new Error('Couldn’t load Solana tools')); document.head.appendChild(s); });
    },
    /** Find the injected Solana wallet that controls `owner` */
    async solanaSigner(owner) {
      for (const id of ['phantom', 'solflare', 'backpack']) {
        const p = PROVIDERS[id].get();
        if (!p) continue;
        try {
          const res = await p.connect({ onlyIfTrusted: true }).catch(() => p.connect());
          if (((res && res.publicKey) || p.publicKey).toString() === owner) return p;
        } catch (e) { if (rejected(e)) throw new Error('You rejected the request in your wallet'); }
      }
      return null;
    },
    /** Sign + send a server-built (unsigned, base64) Solana transaction with the owner's wallet */
    async sendSolanaTx(b64, owner) {
      const p = await NX.wallet.solanaSigner(owner);
      if (!p) throw new Error(`Open the Solana wallet that owns ${NX.fmt.short(owner)} (Phantom, Solflare or Backpack)`);
      const w3 = await NX.wallet.loadWeb3();
      const tx = w3.Transaction.from(b64ToBytes(b64));
      try { const out = await p.signAndSendTransaction(tx); return out.signature || out; }
      catch (e) { throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message); }
    },
    /** Sign + send a base64 *versioned* Solana transaction (e.g. a Jupiter swap) */
    async sendSolanaVersioned(b64, owner) {
      const p = await NX.wallet.solanaSigner(owner);
      if (!p) throw new Error(`Open the Solana wallet that owns ${NX.fmt.short(owner)}`);
      const w3 = await NX.wallet.loadWeb3();
      const tx = w3.VersionedTransaction.deserialize(b64ToBytes(b64));
      try { const out = await p.signAndSendTransaction(tx); return out.signature || out; }
      catch (e) { throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message); }
    },
    /** Send an EVM transaction ({chainId, to, data?, value?}) from `from` via the connected EVM wallet */
    async sendEvmTx(call, from) {
      const p = window.ethereum;
      if (!p) throw new Error('Open your EVM wallet (MetaMask, Trust, Coinbase or Binance)');
      const [acct] = await p.request({ method: 'eth_requestAccounts' });
      if (acct.toLowerCase() !== from.toLowerCase()) throw new Error(`Switch your wallet to ${NX.fmt.short(from)}`);
      try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: call.chainId }] }); }
      catch (e) { throw new Error(rejected(e) ? 'Network switch rejected' : 'Add this network to your wallet first'); }
      const txp = { from, to: call.to }; if (call.data) txp.data = call.data; if (call.value) txp.value = call.value;
      try { return await p.request({ method: 'eth_sendTransaction', params: [txp] }); }
      catch (e) { throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message); }
    },
    /** Send TRX or a TRC-20 token via TronLink */
    async tronSend(coin, to, amount, owner) {
      const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!tw || tw.defaultAddress.base58 !== owner) throw new Error(`Open TronLink on ${NX.fmt.short(owner)}`);
      if (coin === 'TRX') { const tx = await tw.trx.sendTransaction(to, Math.round(amount * 1e6)); return tx.txid || (tx.transaction && tx.transaction.txID); }
      const c = await tw.contract().at(NX.data.tronUsdt || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
      return c.transfer(to, Math.round(amount * 1e6)).send({ feeLimit: 60000000 });
    },
    /** TRC-20 approve via TronLink */
    async tronApprove(req, owner) {
      const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!tw || tw.defaultAddress.base58 !== owner) throw new Error(`Open TronLink on ${NX.fmt.short(owner)}`);
      const c = await tw.contract().at(req.contract);
      return c.approve(req.spender, req.amount).send({ feeLimit: 60000000 });
    },
    /** TRC-20 approve via TronLink */
    async tronApprove(req, owner) {
      const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!tw || tw.defaultAddress.base58 !== owner) throw new Error(`Open TronLink on ${NX.fmt.short(owner)}`);
      const c = await tw.contract().at(req.contract);
      return c.approve(req.spender, req.amount).send({ feeLimit: 60000000 });
    },
    /**
     * Send SOL between the user's wallets (fund / sweep / withdraw). Server builds
     * the transaction; the owning wallet signs. In demo mode, wallets without a
     * connected signer fall back to a clearly-labelled simulation.
     */
    async transfer({ from, to, sol }) {
      const p = await NX.wallet.solanaSigner(from).catch((e) => { throw e; });
      if (p) { const { tx } = await NX.post('/api/chain/build-transfer', { from, to, amount: sol, token: 'SOL' }); return { signature: await NX.wallet.sendSolanaTx(tx, from) }; }
      if (NX.data.settings && NX.data.settings.demo_mode) return { simulated: true };
      throw new Error('Open the wallet that owns ' + NX.fmt.short(from) + ' (Phantom, Solflare or Backpack) to sign this transfer');
    },
    NAMES
  };

  /* ---------------- PWA: service worker + web push ---------------- */
  NX.pwa = {
    register() { if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {}); },
    async pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
    async pushState() {
      if (!(await NX.pwa.pushSupported())) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.ready;
      return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    },
    async enablePush() {
      if (!(await NX.pwa.pushSupported())) throw new Error('This browser doesn’t support push notifications (on iPhone: add NECTRA to your Home Screen first)');
      const { key } = await NX.get('/api/push/key');
      if (!key) throw new Error('Push is not configured on the server');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were blocked for this site');
      const reg = await navigator.serviceWorker.ready;
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      await NX.post('/api/push/subscribe', { subscription: sub.toJSON() });
      await NX.post('/api/push/test');
    },
    async disablePush() {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await NX.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    }
  };
  NX.pwa.register();
})();
