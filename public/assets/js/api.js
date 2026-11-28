/* ==========================================================================
   NECTRA — API client, live event stream, and non-custodial wallet module
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});

  /* ---------------- REST client ---------------- */
  /* Money-moving POSTs carry an Idempotency-Key. The same request (path + body) repeated within
     2 minutes - a double click, a retry after a dropped connection - reuses the key, so the server
     replays the first result instead of paying twice. */
  const IDEM_PATHS = /\/api\/(withdrawals|loans\/\d+\/repay|bots\/\d+\/live-withdraw|admin\/(loans\/\d+\/disburse|payouts\/\d+\/paid|users\/\d+\/adjust))(\/|$)/;
  const idemKeys = new Map();
  const idemKeyFor = (path, payload) => {
    const sig = path + '|' + payload, t = Date.now();
    for (const [k, v] of idemKeys) if (v.t < t - 120000) idemKeys.delete(k);
    let e = idemKeys.get(sig);
    if (!e) { e = { key: (crypto.randomUUID ? crypto.randomUUID() : String(t) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, ''), t }; idemKeys.set(sig, e); }
    return e.key;
  };
  /** Double-submit CSRF token mirrored from the readable `nx_csrf` cookie. */
  const csrfToken = () => {
    const m = document.cookie.match(/(?:^|;\s*)nx_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  };
  NX.api = async (method, path, body) => {
    const payload = body === undefined || method === 'GET' ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'X-Nectra': '1' };
    const token = csrfToken();
    if (token) headers['X-CSRF'] = token;
    if (method === 'POST' && IDEM_PATHS.test(path)) headers['Idempotency-Key'] = idemKeyFor(path, payload || '');
    let r = await fetch(path, { method, credentials: 'same-origin', headers, body: payload });
    if (r.status === 403 && method !== 'GET') {
      // Stale/absent token: refresh it once and retry the same request.
      try {
        const cfg = await fetch('/api/public/config', { credentials: 'same-origin' });
        if (!cfg.ok) throw 0;
        const fresh = csrfToken();
        if (fresh) headers['X-CSRF'] = fresh;
        r = await fetch(path, { method, credentials: 'same-origin', headers, body: payload });
      } catch (e) { /* fall through to the original response */ }
    }
    let j = {};
    try { j = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) {
      const detail = j.detail && (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail));
      const err = new Error(j.error || detail || `Request failed (${r.status})`);
      err.status = r.status; err.data = j;
      const app = document.body && document.body.classList.contains('app');
      const admin = document.body && document.body.classList.contains('admin');
      if (r.status === 401) {
        if (admin) { location.href = '/admin/login.html'; }
        else if (app) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname.replace(/^\//, '') + location.search + location.hash); }
      }
      if (j.code === 'EMAIL_UNVERIFIED' && (app || admin)) location.href = '/register.html#verify';
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
  NX.isTron = (a) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a || '');
  NX.isBtc = (a) => /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a || '');
  NX.isLtc = (a) => /^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a || '');
  NX.detectChain = (a) => {
    const s = String(a || '').trim();
    if (NX.isEvm(s)) return 'evm';
    if (NX.isTron(s)) return 'tron';
    if (NX.isBtc(s)) return 'btc';
    if (NX.isLtc(s)) return 'ltc';
    if (NX.isSol(s)) return 'solana';
    return null;
  };
  NX.isValidAddress = (a) => !!NX.detectChain(a);

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
  const announcedEvmProviders = new Map();
  if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (e) => {
      if (e.detail && e.detail.info && e.detail.provider) {
        const info = e.detail.info;
        const key = (info.rdns || info.name || '').toLowerCase();
        announcedEvmProviders.set(key, e.detail.provider);
      }
    });
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
  }

  function getEvmWallet(id) {
    if (typeof window === 'undefined') return null;
    // Check EIP-6963 announcements first
    if (id === 'metamask') {
      const p = announcedEvmProviders.get('io.metamask') || announcedEvmProviders.get('metamask');
      if (p) return p;
    } else if (id === 'coinbase') {
      const p = announcedEvmProviders.get('com.coinbase.wallet') || window.coinbaseWalletExtension;
      if (p) return p;
    } else if (id === 'trust') {
      const p = announcedEvmProviders.get('com.trustwallet.app') || window.trustwallet;
      if (p) return p;
    } else if (id === 'okx') {
      const p = announcedEvmProviders.get('com.okex.wallet') || window.okxwallet;
      if (p) return p;
    } else if (id === 'bitget') {
      const p = announcedEvmProviders.get('com.bitget.web3') || (window.bitkeep && window.bitkeep.ethereum);
      if (p) return p;
    } else if (id === 'rainbow') {
      const p = announcedEvmProviders.get('me.rainbow') || window.rainbow;
      if (p) return p;
    } else if (id === 'binance') {
      const p = announcedEvmProviders.get('com.binance.wallet') || window.BinanceChain;
      if (p) return p;
    }

    if (id === 'okx' && window.okxwallet) return window.okxwallet;
    if (id === 'bitget' && window.bitkeep && window.bitkeep.ethereum) return window.bitkeep.ethereum;
    if (id === 'rainbow' && window.rainbow) return window.rainbow;
    if (id === 'coinbase' && window.coinbaseWalletExtension) return window.coinbaseWalletExtension;
    if (id === 'trust' && window.trustwallet) return window.trustwallet;
    if (id === 'binance' && window.BinanceChain) return window.BinanceChain;

    const e = window.ethereum;
    if (e) {
      if (e.providers && Array.isArray(e.providers) && e.providers.length) {
        if (id === 'metamask') {
          const match = e.providers.find((p) => p.isMetaMask && !p.isBraveWallet);
          if (match) return match;
        } else if (id === 'trust') {
          const match = e.providers.find((p) => p.isTrust || p.isTrustWallet);
          if (match) return match;
        } else if (id === 'coinbase') {
          const match = e.providers.find((p) => p.isCoinbaseWallet);
          if (match) return match;
        } else if (id === 'okx') {
          const match = e.providers.find((p) => p.isOkxWallet);
          if (match) return match;
        } else if (id === 'bitget') {
          const match = e.providers.find((p) => p.isBitKeep);
          if (match) return match;
        } else if (id === 'rainbow') {
          const match = e.providers.find((p) => p.isRainbow);
          if (match) return match;
        } else if (id === 'binance') {
          const match = e.providers.find((p) => p.isBinance);
          if (match) return match;
        }
        return e.providers[0];
      }
      if (id === 'metamask' && e.isMetaMask) return e;
      if (id === 'trust' && (e.isTrust || e.isTrustWallet)) return e;
      if (id === 'coinbase' && e.isCoinbaseWallet) return e;
      if (id === 'okx' && e.isOkxWallet) return e;
      if (id === 'bitget' && e.isBitKeep) return e;
      if (id === 'rainbow' && e.isRainbow) return e;
      if (id === 'binance' && (e.isBinance || window.BinanceChain)) return window.BinanceChain || e;
      // Injected window.ethereum fallback for EVM actions
      return e;
    }
    return null;
  }

  function getSolanaWallet(id) {
    if (typeof window === 'undefined') return null;
    if (id === 'phantom') {
      if (window.phantom && window.phantom.solana) return window.phantom.solana;
      if (window.solana && (window.solana.isPhantom || !window.solflare)) return window.solana;
    }
    if (id === 'solflare') {
      if (window.solflare) return window.solflare;
      if (window.solana && window.solana.isSolflare) return window.solana;
    }
    if (id === 'backpack') {
      if (window.backpack && (window.backpack.solana || window.backpack)) return window.backpack.solana || window.backpack;
    }
    if (id === 'okx' && window.okxwallet && window.okxwallet.solana) return window.okxwallet.solana;
    if (id === 'bitget' && window.bitkeep && window.bitkeep.solana) return window.bitkeep.solana;
    // General fallback: if any Solana wallet is injected, allow connection
    if (window.solana) return window.solana;
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.solflare) return window.solflare;
    return null;
  }

  function getTronWallet() {
    if (typeof window === 'undefined') return null;
    return window.tronLink || (window.tronWeb && (window.tronWeb.defaultAddress || window.tronWeb.trx) && window.tronWeb) || null;
  }

  const PROVIDERS = {
    phantom: { family: 'solana', get: () => getSolanaWallet('phantom') },
    solflare: { family: 'solana', get: () => getSolanaWallet('solflare') },
    backpack: { family: 'solana', get: () => getSolanaWallet('backpack') },
    metamask: { family: 'evm', get: () => getEvmWallet('metamask') },
    coinbase: { family: 'evm', get: () => getEvmWallet('coinbase') },
    trust: { family: 'evm', get: () => getEvmWallet('trust') },
    okx: { family: 'evm', get: () => getEvmWallet('okx') || getSolanaWallet('okx') },
    binance: { family: 'evm', get: () => getEvmWallet('binance') },
    bitget: { family: 'evm', get: () => getEvmWallet('bitget') || getSolanaWallet('bitget') },
    rainbow: { family: 'evm', get: () => getEvmWallet('rainbow') },
    evm: { family: 'evm', get: () => getEvmWallet('evm') },
    browser: { family: 'evm', get: () => getEvmWallet('evm') || getSolanaWallet('browser') || getTronWallet() },
    tronlink: { family: 'tron', get: () => getTronWallet() }
  };
  function evmProvider(flag) {
    return getEvmWallet('evm');
  }
  const INSTALL = {
    phantom: 'https://phantom.app',
    solflare: 'https://solflare.com',
    backpack: 'https://backpack.app',
    coinbase: 'https://www.coinbase.com/wallet',
    trust: 'https://trustwallet.com',
    binance: 'https://www.binance.com/en/web3wallet',
    metamask: 'https://metamask.io',
    okx: 'https://www.okx.com/web3',
    bitget: 'https://web3.bitget.com',
    rainbow: 'https://rainbow.me',
    evm: 'https://metamask.io',
    browser: 'https://metamask.io',
    tronlink: 'https://www.tronlink.org'
  };
  const DEEP_LINKS = {
    metamask: (u) => `https://metamask.app.link/dapp/${u.replace(/^https?:\/\//, '')}`,
    phantom: (u) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}`,
    trust: (u) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(u)}`,
    coinbase: (u) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(u)}`,
    solflare: (u) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}`,
    rainbow: (u) => `https://rnbwapp.com/dapp/${u.replace(/^https?:\/\//, '')}`,
    okx: (u) => `https://www.okx.com/download`,
    bitget: (u) => `https://web3.bitget.com`
  };
  const SCHEME_LINKS = {
    metamask: (u) => `metamask://dapp/${u.replace(/^https?:\/\//, '')}`,
    trust: (u) => `trust://open_url?coin_id=60&url=${encodeURIComponent(u)}`,
    phantom: (u) => `phantom://browse/${encodeURIComponent(u)}`,
    solflare: (u) => `solflare://browse/${encodeURIComponent(u)}`,
    coinbase: (u) => `cbwallet://dapp?cb_url=${encodeURIComponent(u)}`,
    okx: (u) => `okx://wallet/dapp/details?dappUrl=${encodeURIComponent(u)}`,
    bitget: (u) => `bitkeep://bkconnect?action=dapp&url=${encodeURIComponent(u)}`,
    rainbow: (u) => `rainbow://dapp/${u.replace(/^https?:\/\//, '')}`,
    binance: (u) => `binance://app?url=${encodeURIComponent(u)}`,
    backpack: (u) => `backpack://browse?url=${encodeURIComponent(u)}`,
    tronlink: (u) => `tronlinkoutside://pull.interface/v1?action=open&params=${encodeURIComponent(JSON.stringify({url: u}))}`
  };
  const NAMES = {
    phantom: 'Phantom',
    solflare: 'Solflare',
    backpack: 'Backpack',
    metamask: 'MetaMask',
    coinbase: 'Coinbase Wallet',
    trust: 'Trust Wallet',
    okx: 'OKX Wallet',
    binance: 'Binance Web3',
    bitget: 'Bitget Wallet',
    rainbow: 'Rainbow',
    evm: 'Browser wallet',
    browser: 'Browser wallet',
    tronlink: 'TronLink',
    demo: 'Demo wallet'
  };
  const toHex = (s) => '0x' + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const rejected = (e) => e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''));

  NX.wallet = {
    familyOf: (id) => (id === 'demo' ? 'solana' : (PROVIDERS[id] || {}).family),
    available: (id) => id === 'demo' ? !!(NX.data.settings && NX.data.settings.demo_mode) || !document.body.classList.contains('app') : !!(PROVIDERS[id] && PROVIDERS[id].get()),
    installUrl: (id) => INSTALL[id],
    deepLink: (id, targetUrl) => {
      const fn = DEEP_LINKS[id];
      const base = targetUrl || (typeof window !== 'undefined' ? window.location.href : '');
      return (fn && base) ? fn(base) : null;
    },
    schemeLink: (id, targetUrl) => {
      const fn = SCHEME_LINKS[id];
      const base = targetUrl || (typeof window !== 'undefined' ? window.location.href : '');
      return (fn && base) ? fn(base) : null;
    },
    /** Connect a wallet and return a signer { address, family, provider, sign(message) } */
    async connect(id) {
      if (id === 'demo') {
        let addr = NX.store.get('demo-wallet');
        if (!addr || !(await idbGet(addr))) { addr = await newLocalKey(); NX.store.set('demo-wallet', addr); }
        const s = await localSigner(addr); s.provider = 'Demo wallet'; s.family = 'solana'; return s;
      }
      if (id === 'browser') {
        const evm = getEvmWallet('evm');
        if (evm) {
          const [address] = await evm.request({ method: 'eth_requestAccounts' });
          return { address, family: 'evm', provider: 'Browser wallet', injected: evm, sign: (msg) => evm.request({ method: 'personal_sign', params: [toHex(msg), address] }) };
        }
        const sol = getSolanaWallet('phantom') || window.solana;
        if (sol) {
          const res = await sol.connect();
          const address = ((res && res.publicKey) || sol.publicKey).toString();
          return { address, family: 'solana', provider: 'Browser wallet', injected: sol, sign: async (msg) => { const out = await sol.signMessage(new TextEncoder().encode(msg), 'utf8'); return NX.b58(out.signature || out); } };
        }
        const tron = getTronWallet();
        if (tron) {
          if (window.tronLink && window.tronLink.request) await window.tronLink.request({ method: 'tron_requestAccounts' });
          const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
          if (!tw || !tw.defaultAddress || !tw.defaultAddress.base58) throw new Error('Unlock Tron wallet and try again');
          return { address: tw.defaultAddress.base58, family: 'tron', provider: 'Tron wallet', injected: tw, sign: (msg) => tw.trx.signMessageV2(msg) };
        }
        const e = new Error('No DeFi wallet detected in this browser. Please open inside a Web3 wallet app or install an extension.');
        e.install = INSTALL.metamask;
        e.walletId = id;
        throw e;
      }
      const P = PROVIDERS[id];
      const p = P && P.get();
      if (!p) {
        const e = new Error(`${NAMES[id] || id} isn’t detected in this browser or device`);
        e.install = INSTALL[id];
        e.walletId = id;
        throw e;
      }
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
      try {
        if (typeof p.signAndSendTransaction === 'function') {
          const out = await p.signAndSendTransaction(tx);
          return out.signature || out;
        }
        if (typeof p.signTransaction === 'function') {
          const signed = await p.signTransaction(tx);
          return NX.b58(signed.signature || (signed.signatures && signed.signatures[0] && signed.signatures[0].signature) || signed.serialize().slice(1, 65));
        }
        throw new Error('Wallet does not support transaction signing');
      } catch (e) {
        throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message);
      }
    },
    /** Sign + send a base64 *versioned* Solana transaction (e.g. a Jupiter swap) */
    async sendSolanaVersioned(b64, owner) {
      const p = await NX.wallet.solanaSigner(owner);
      if (!p) throw new Error(`Open the Solana wallet that owns ${NX.fmt.short(owner)}`);
      const w3 = await NX.wallet.loadWeb3();
      const tx = w3.VersionedTransaction.deserialize(b64ToBytes(b64));
      try {
        if (typeof p.signAndSendTransaction === 'function') {
          const out = await p.signAndSendTransaction(tx);
          return out.signature || out;
        }
        if (typeof p.signTransaction === 'function') {
          const signed = await p.signTransaction(tx);
          return NX.b58((signed.signatures && signed.signatures[0]) || signed.serialize().slice(1, 65));
        }
        throw new Error('Wallet does not support transaction signing');
      } catch (e) {
        throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message);
      }
    },
    /** Send an EVM transaction ({chainId, to, data?, value?}) from `from` via the connected EVM wallet */
    async sendEvmTx(call, from) {
      const p = getEvmWallet('evm') || window.ethereum;
      if (!p) throw new Error('Open your EVM wallet (MetaMask, Trust, Coinbase or Binance)');
      const [acct] = await p.request({ method: 'eth_requestAccounts' });
      if (acct.toLowerCase() !== from.toLowerCase()) throw new Error(`Switch your wallet to ${NX.fmt.short(from)}`);
      if (call.chainId) {
        const hexChainId = typeof call.chainId === 'number'
          ? '0x' + call.chainId.toString(16)
          : (String(call.chainId).startsWith('0x') ? call.chainId : '0x' + parseInt(call.chainId, 10).toString(16));
        try {
          const cur = await p.request({ method: 'eth_chainId' }).catch(() => null);
          if (cur && cur.toLowerCase() !== hexChainId.toLowerCase()) {
            await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
          }
        } catch (e) {
          if (rejected(e)) throw new Error('Network switch rejected');
        }
      }
      const txp = { from, to: call.to };
      if (call.data) txp.data = call.data;
      if (call.value) txp.value = typeof call.value === 'number' ? '0x' + call.value.toString(16) : call.value;
      try { return await p.request({ method: 'eth_sendTransaction', params: [txp] }); }
      catch (e) { throw new Error(rejected(e) ? 'You rejected the transaction in your wallet' : e.message); }
    },
    /** Send TRX or a TRC-20 token via TronLink */
    async tronSend(coin, to, amount, owner) {
      const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!tw || (tw.defaultAddress && tw.defaultAddress.base58 !== owner)) throw new Error(`Open TronLink on ${NX.fmt.short(owner)}`);
      if (coin === 'TRX') { const tx = await tw.trx.sendTransaction(to, Math.round(amount * 1e6)); return tx.txid || (tx.transaction && tx.transaction.txID); }
      const c = await tw.contract().at(NX.data.tronUsdt || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
      return c.transfer(to, Math.round(amount * 1e6)).send({ feeLimit: 60000000 });
    },
    /** TRC-20 approve via TronLink */
    async tronApprove(req, owner) {
      const tw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!tw || (tw.defaultAddress && tw.defaultAddress.base58 !== owner)) {
        if (window.tronLink && window.tronLink.request) await window.tronLink.request({ method: 'tron_requestAccounts' });
      }
      const activeTw = window.tronWeb || (window.tronLink && window.tronLink.tronWeb);
      if (!activeTw || !activeTw.defaultAddress || !activeTw.defaultAddress.base58) throw new Error(`Open TronLink on ${NX.fmt.short(owner)}`);
      const c = await activeTw.contract().at(req.contract);
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

  /* ---------------- PWA: service worker + web push + install prompt ---------------- */
  let deferredPrompt = null;
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (NX.pwa) {
        NX.pwa.deferredPrompt = e;
        NX.pwa.maybePromptInstall();
      }
    });
  }

  NX.pwa = {
    register() { if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {}); },
    isStandalone() {
      return (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone) ||
             (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
             (typeof document !== 'undefined' && document.referrer.includes('android-app://'));
    },
    isIos() {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      return /iPhone|iPad|iPod/i.test(ua);
    },
    isAndroid() {
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      return /Android/i.test(ua);
    },
    isMobile() {
      return NX.pwa.isAndroid() || NX.pwa.isIos();
    },
    isDismissed() {
      try { return sessionStorage.getItem('nx_pwa_dismissed') === '1'; } catch (_) { return false; }
    },
    dismiss() {
      try { sessionStorage.setItem('nx_pwa_dismissed', '1'); } catch (_) {}
      const el = document.getElementById('pwa-install-overlay');
      if (el) {
        el.classList.remove('is-active');
        setTimeout(() => el.remove(), 350);
      }
    },
    async promptInstall() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        NX.pwa.deferredPrompt = null;
        NX.pwa.dismiss();
        return choice && choice.outcome === 'accepted';
      }
      return false;
    },
    showInstallPrompt() {
      if (NX.pwa.isStandalone() || NX.pwa.isDismissed()) return;
      if (document.getElementById('pwa-install-overlay')) return;

      const brandName = (window.NX && NX.brandName) ? NX.brandName() : 'Ascendex';
      const isIos = NX.pwa.isIos();

      const overlay = document.createElement('div');
      overlay.className = 'pwa-overlay';
      overlay.id = 'pwa-install-overlay';

      if (isIos) {
        overlay.innerHTML = `
          <div class="pwa-sheet" role="dialog" aria-modal="true" aria-label="Install App">
            <div class="pwa-head">
              <div class="pwa-brand">
                <div class="pwa-icon-box"><span data-logo="32"></span></div>
                <div>
                  <h3 style="margin:0;font-size:16px;font-weight:700">Install ${NX.esc(brandName)} on iPhone</h3>
                  <span class="caption" style="color:var(--text-muted)">Apple iOS &middot; Native App Mode</span>
                </div>
              </div>
              <button class="icon-btn icon-btn--sm" onclick="NX.pwa.dismiss()" aria-label="Close">&times;</button>
            </div>
            <p class="small muted" style="margin:0">Add to your Home Screen for full-screen trading, sub-second bot updates, and push notifications.</p>
            <div class="pwa-steps">
              <div class="pwa-step-row">
                <span class="pwa-step-num">1</span>
                <span>Tap <b class="strong">Share</b> <span class="pwa-badge-btn" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></span> in Safari's bottom toolbar</span>
              </div>
              <div class="pwa-step-row">
                <span class="pwa-step-num">2</span>
                <span>Scroll down and select <b class="strong">Add to Home Screen</b> <span class="pwa-badge-btn" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span></span>
              </div>
              <div class="pwa-step-row">
                <span class="pwa-step-num">3</span>
                <span>Tap <b class="strong">Add</b> in the top right corner</span>
              </div>
            </div>
            <div class="pwa-actions">
              <button class="btn btn--primary" onclick="NX.pwa.dismiss()">Got it</button>
            </div>
          </div>
        `;
      } else {
        overlay.innerHTML = `
          <div class="pwa-sheet" role="dialog" aria-modal="true" aria-label="Install App">
            <div class="pwa-head">
              <div class="pwa-brand">
                <div class="pwa-icon-box"><span data-logo="32"></span></div>
                <div>
                  <h3 style="margin:0;font-size:16px;font-weight:700">Install ${NX.esc(brandName)} App</h3>
                  <span class="caption" style="color:var(--text-muted)">Android &middot; Native App Mode</span>
                </div>
              </div>
              <button class="icon-btn icon-btn--sm" onclick="NX.pwa.dismiss()" aria-label="Close">&times;</button>
            </div>
            <p class="small muted" style="margin:0">Install on your device for lightning-fast DEX trading, full-screen bot execution, and real-time alerts.</p>
            <div class="pwa-actions">
              <button class="btn btn--ghost" onclick="NX.pwa.dismiss()">Maybe Later</button>
              <button class="btn btn--primary" id="pwa-do-install-btn">Install App</button>
            </div>
          </div>
        `;
      }

      document.body.appendChild(overlay);
      if (window.NX && NX.hydrateLogos) NX.hydrateLogos(overlay);

      const installBtn = overlay.querySelector('#pwa-do-install-btn');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          if (deferredPrompt) {
            await NX.pwa.promptInstall();
          } else {
            NX.pwa.dismiss();
            NX.toast('Use your browser menu (⋮) -> Add to Home Screen', { type: 'info' });
          }
        });
      }

      requestAnimationFrame(() => overlay.classList.add('is-active'));
    },
    maybePromptInstall() {
      if (NX.pwa.isMobile() && !NX.pwa.isStandalone() && !NX.pwa.isDismissed()) {
        setTimeout(() => NX.pwa.showInstallPrompt(), 1400);
      }
    },
    async pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
    async pushState() {
      if (!(await NX.pwa.pushSupported())) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.ready;
      return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    },
    async enablePush() {
      const bName = (window.NX && NX.brandName) ? NX.brandName() : 'Ascendex';
      if (!(await NX.pwa.pushSupported())) throw new Error(`This browser doesn’t support push notifications (on iPhone: add ${bName} to your Home Screen first)`);
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
