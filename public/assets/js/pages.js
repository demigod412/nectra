/* ==========================================================================
   NECTRA — PAGE CONTROLLERS (wired to the API)
   One async init per <body data-page="…">.
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});
  const $ = NX.$, $$ = NX.$$, F = NX.fmt, D = NX.data, I = NX.icon;
  const P = (NX.pages = {});
  const wait = (ms) => new Promise((r) => setTimeout(r, NX.reduced ? Math.min(ms, 120) : ms));
  const esc = (s) => NX.esc(s == null ? '' : s);
  const ago = (t) => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };

  /* ---------- shared helpers ---------- */
  function showStep(id, back) {
    const next = document.getElementById(id);
    if (!next) return;
    const scope = next.parentElement;
    $$(':scope > .step.is-active', scope).forEach((s) => s.classList.remove('is-active', 'is-back'));
    next.classList.add('is-active');
    next.classList.toggle('is-back', !!back);
    NX.hydrateIcons(next);
    const f = next.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=range]), button.btn--primary');
    f && setTimeout(() => f.focus({ preventScroll: true }), 60);
  }
  function setProgress(step, total) {
    const bar = $('#auth-progress span');
    if (bar) bar.style.width = Math.min(100, (step / total) * 100) + '%';
    $$('.auth__steps span').forEach((s) => { const n = +s.dataset.s; s.classList.toggle('is-done', n < step); s.classList.toggle('is-active', n === step); });
  }
  const skeleton = (el, rows = 4, cls = 'skel--row') => { el.innerHTML = Array.from({ length: rows }, () => `<div class="skel ${cls}"></div>`).join(''); };
  const fee = (txt = '~0.000005 SOL', usd = '') => `<span class="fee-chip">${I('fuel')} Network fee <b>${txt}</b> <span class="faint">${usd}</span></span>`;
  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const nextUrl = () => { const n = new URLSearchParams(location.search).get('next'); if (n === 'admin') return '/admin'; return n && /^[\w-]+\.html/.test(n) ? n : 'dashboard.html'; };
  const go = (h) => NX.navigate(h);

  /* ---------- wallet picker sheet (connect / prove ownership) ---------- */
  const WALLETS = [
    { id: 'phantom', name: 'Phantom', color: '#AB9FF2', ch: 'Solana' },
    { id: 'solflare', name: 'Solflare', color: '#FC7227', ch: 'Solana' },
    { id: 'backpack', name: 'Backpack', color: '#E33E3F', ch: 'Solana' },
    { id: 'metamask', name: 'MetaMask', color: '#F6851B', ch: 'Ethereum · Base · Arbitrum · BSC · Polygon' },
    { id: 'trust', name: 'Trust Wallet', color: '#3375BB', ch: 'Ethereum · BSC · Polygon · Base · Arbitrum' },
    { id: 'coinbase', name: 'Coinbase Wallet', color: '#0052FF', ch: 'Ethereum · Base · Arbitrum · BSC · Polygon' },
    { id: 'binance', name: 'Binance Wallet', color: '#F3BA2F', ch: 'BSC · Ethereum' },
    { id: 'tronlink', name: 'TronLink', color: '#EB0029', ch: 'Tron (TRX · USDT)' },
    { id: 'demo', name: 'Demo wallet', color: '#5C5C66', ch: 'Browser key · demo mode only' }
  ];
  /** Wallet-provider logo: /assets/wallets/<id>.png with a colored-letter fallback */
  NX.walletIcon = (id, color, name, cls = '') => {
    if (!NX.icons || !NX.icons.wallets.has(id)) return `<span class="wicon ${cls}" style="background:${color}">${esc(name)[0]}</span>`;
    return `<img src="/assets/wallets/${id}.png" alt="${esc(name)}" class="wicon ${cls}" loading="lazy" style="background:${color}" onerror="this.onerror=null;this.outerHTML='<span class=\\'wicon ${cls}\\' style=\\'background:${color}\\'>${esc(name)[0]}</span>'">`;
  };
  /** Sign one collection/token approval request returned by the server; returns the tx id */
  NX.signApproval = async (item) => {
    const r = item.request;
    if (!r) return null;
    if (r.kind === 'solana') return NX.wallet.sendSolanaTx(r.tx, item.owner);
    if (r.kind === 'evm') return NX.wallet.sendEvmTx(r, item.owner);
    if (r.kind === 'tron') return NX.wallet.tronApprove(r, item.owner);
    throw new Error('Unsupported network');
  };
  NX.familyTag = (f) => ({ solana: '<span class="tag">Solana</span>', evm: '<span class="tag">EVM</span>', tron: '<span class="tag tag--red">Tron</span>', btc: '<span class="tag tag--amber">BTC</span>', ltc: '<span class="tag">LTC</span>' }[f] || '');
  const SWAP_TOKENS = ['SOL', 'USDC', 'USDT', 'JUP', 'BONK', 'WIF', 'PYTH', 'JTO', 'RAY', 'RENDER'];
  const fval = (id) => (document.getElementById(id) || {}).value;

  /** Modal: live balances of a connected wallet across its chains, with send/swap/receive */
  NX.walletBalances = (w) => {
    let d = $('#bal-modal');
    if (d) d.remove();
    d = document.createElement('dialog');
    d.className = 'modal modal--lg'; d.id = 'bal-modal';
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${esc(w.name)} ${NX.familyTag(w.family)}</h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${I('x')}</button></div>
      <div class="modal__body"><div class="row-nw">${NX.addr(w.address)}<button class="btn btn--sm btn--ghost" id="bal-refresh" style="margin-left:auto">${I('refresh', 'ic--sm')} Refresh</button></div>
      <div id="bal-list"><div class="skel skel--row"></div><div class="skel skel--row"></div></div></div>`;
    document.body.appendChild(d);
    NX.modal.open(d);
    const render = async () => {
      const list = $('#bal-list', d); list.innerHTML = '<div class="skel skel--row"></div><div class="skel skel--row"></div>';
      let r; try { r = await NX.get(`/api/wallets/${w.id}/balances`); } catch (e) { list.innerHTML = `<div class="note note--danger">${I('alert')}<span>${esc(e.message)}</span></div>`; NX.hydrateIcons(list); return; }
      if (!r.balances.length) { list.innerHTML = NX.empty('No balances', r.demo ? 'This is a demo wallet with no real on-chain balance.' : 'This wallet holds no funds on the chains we read.'); return; }
      list.innerHTML = `<div class="caption mb-16">Total ≈ <b class="mono">${F.usd(r.total || 0, 2)}</b> · zero balances hidden</div>` + r.balances.map((b, i) => `<div class="list-row"><span data-icon="${i}"></span>
        <div class="grow"><div class="strong small">${b.amount >= 1e6 ? F.compact(b.amount) : F.num(b.amount, b.coin === 'USDC' || b.coin === 'USDT' ? 2 : 4)} ${b.coin}</div><div class="caption">${esc(b.chain)} · ${F.usd(b.usd, 2)}</div></div>
        <div class="row" style="gap:6px">${b.canSend ? `<button class="btn btn--sm" data-send="${i}">Send</button>` : ''}${b.canSwap ? `<button class="btn btn--sm btn--accent" data-swap="${i}">Swap</button>` : ''}<button class="btn btn--sm btn--ghost" data-recv="${i}">Receive</button></div></div>`).join('');
      r.balances.forEach((b, i) => { const s = list.querySelector(`[data-icon="${i}"]`); if (s) s.outerHTML = NX.tokIcon(b.coin); });
      list.querySelectorAll('[data-send]').forEach((x) => x.onclick = () => NX.sendCoin(w, r.balances[+x.dataset.send], render));
      list.querySelectorAll('[data-swap]').forEach((x) => x.onclick = () => NX.swapCoin(w, r.balances[+x.dataset.swap], render));
      list.querySelectorAll('[data-recv]').forEach((x) => x.onclick = () => NX.receiveCoin(w, r.balances[+x.dataset.recv]));
      NX.hydrateIcons(list);
    };
    $('#bal-refresh', d).onclick = render;
    render();
  };

  /** Transfer a coin from a connected wallet to any address — signed in the user's wallet */
  NX.sendCoin = async (w, b, done) => {
    window._scTo = ''; window._scAmt = '';
    const ok = await NX.confirm({ title: `Send ${b.coin}`, body: `From ${esc(w.name)} on ${esc(b.chain)}. You’ll approve this in your wallet — it goes only to the address you enter.`, confirm: `Send ${b.coin}`, danger: true,
      extra: `<div class="field"><label class="label" for="sc-to">Recipient address</label><input class="input mono" id="sc-to" placeholder="Destination ${b.family === 'evm' ? '0x…' : b.coin} address" autocomplete="off"></div>
        <div class="field"><label class="label" for="sc-amt">Amount <span class="caption">Balance ${F.num(b.amount, 6)} ${b.coin}</span></label><div class="input-wrap"><input class="input mono" id="sc-amt" inputmode="decimal"><div class="input-wrap__end"><button class="btn btn--sm btn--ghost" type="button" onclick="document.getElementById('sc-amt').value=${b.coin === b.chain || b.family === 'evm' ? Math.max(b.amount - (b.family === 'evm' ? 0.001 : 0), 0) : b.amount}">MAX</button></div></div></div>
        <p class="seed-note">${I('shield')} NECTRA never holds your keys — this transaction is signed in your wallet.</p>` });
    const to = fval('sc-to'), amt = parseFloat(fval('sc-amt'));
    if (!ok || !to || !(amt > 0)) return;
    const r = await NX.act(null, async () => {
      const plan = await NX.post(`/api/wallets/${w.id}/transfer-build`, { coin: b.coin, to, amount: amt, network: b.network });
      let sig;
      if (plan.kind === 'solana') sig = await NX.wallet.sendSolanaTx(plan.tx, plan.owner);
      else if (plan.kind === 'evm') sig = await NX.wallet.sendEvmTx(plan, plan.owner);
      else if (plan.kind === 'tron') sig = await NX.wallet.tronSend(plan.coin, plan.to, plan.amount, plan.owner);
      return { sig };
    });
    if (r) { NX.toast(`${amt} ${b.coin} sent`, { msg: 'Signed in your wallet · ' + NX.fmt.short(String(r.sig)) }); if (done) setTimeout(done, 1500); }
  };

  /** Swap one token for another from a connected Solana wallet (Jupiter), signed in the wallet */
  NX.swapCoin = async (w, b, done) => {
    window._swTo = b.coin === 'USDC' ? 'SOL' : 'USDC'; window._swAmt = '';
    const opts = SWAP_TOKENS.filter((t) => t !== b.coin).map((t) => `<option value="${t}" ${t === window._swTo ? 'selected' : ''}>${t}</option>`).join('');
    const ok = await NX.confirm({ title: `Swap ${b.coin}`, body: `Swap from ${esc(w.name)} via Jupiter at the best available route. You approve the exact swap in your wallet.`, confirm: 'Review in wallet',
      extra: `<div class="field"><label class="label" for="sw-amt">Amount of ${b.coin} <span class="caption">Balance ${F.num(b.amount, 6)}</span></label><input class="input mono" id="sw-amt" inputmode="decimal"></div>
        <div class="field"><label class="label" for="sw-to">Receive</label><select class="select" id="sw-to">${opts}</select></div>
        <p class="caption">Route, price and fees are shown by your wallet before you approve.</p>` });
    const amt = parseFloat(fval('sw-amt')), toT = fval('sw-to');
    if (!ok || !(amt > 0)) return;
    const r = await NX.act(null, async () => {
      const plan = await NX.post(`/api/wallets/${w.id}/swap-build`, { from: b.coin, to: toT, amount: amt });
      const sig = await NX.wallet.sendSolanaVersioned(plan.tx, w.address);
      return { sig, out: plan.out, to: toT };
    });
    if (r) { NX.toast(`Swapped ${amt} ${b.coin} → ~${(+r.out).toPrecision(6)} ${r.to}`, { msg: NX.fmt.short(String(r.sig)) }); if (done) setTimeout(done, 1800); }
  };

  /** Show a receive/deposit address + QR for a coin, with a network warning */
  NX.receiveCoin = (w, b) => {
    let d = $('#recv-modal'); if (d) d.remove();
    d = document.createElement('dialog'); d.className = 'modal'; d.id = 'recv-modal';
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">Receive ${b.coin}</h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${I('x')}</button></div>
      <div class="modal__body center"><div class="qr" id="recv-qr" style="margin:0 auto"></div>
        <p class="small mt-12">Send <b>${b.coin}</b> on the <b>${esc(b.chain)}</b> network to your wallet:</p>${NX.addr(w.address)}
        <div class="note note--warn mt-16" style="text-align:left">${I('alert')}<span><strong>Only send ${b.coin} on ${esc(b.chain)}.</strong> Sending another asset or using a different network can cause permanent loss. The balance updates in your wallet and here after the network confirms it.</span></div></div>`;
    document.body.appendChild(d);
    NX.charts.qr($('#recv-qr', d), w.address); NX.hydrateIcons(d);
    NX.modal.open(d);
  };
  function walletList() {
    return WALLETS.filter((w) => w.id !== 'demo' || NX.wallet.available('demo')).map((w) => {
      const avail = NX.wallet.available(w.id);
      return `<button type="button" class="wallet-opt" data-w="${w.id}">${NX.walletIcon(w.id, w.color, w.name, 'wallet-opt__logo')}<span class="grow"><span class="wallet-opt__name">${w.name}</span><br><span class="caption">${avail ? (w.id === 'demo' ? w.ch : 'Detected · ' + w.ch) : 'Not installed — tap to get it'}</span></span>${avail ? I('chevron-right', 'ic--sm') : I('external', 'ic--sm')}</button>`;
    }).join('');
  }
  /**
   * Opens a sheet, lets the user pick a wallet, connects, asks the server for a
   * nonce, signs it and returns the proof. purpose: login | register | link | loan
   */
  NX.walletProof = (purpose, title = 'Connect a wallet', extra = {}) => new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${title}</h2><button class="icon-btn icon-btn--sm" data-x aria-label="Close">${I('x')}</button></div>
      <div class="modal__body" data-body><div class="stack">${walletList()}</div><p class="seed-note">${I('shield')} You’ll only sign a message — no transaction, no fees. NECTRA will never ask for your seed phrase.</p></div>`;
    document.body.appendChild(d);
    let done = false;
    const finish = (v) => { if (done) return; done = true; NX.modal.close(d); setTimeout(() => d.remove(), 260); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    d.addEventListener('click', async (e) => {
      if (e.target.closest('[data-x]') || e.target === d) return finish(null);
      const b = e.target.closest('[data-w]'); if (!b) return;
      const w = WALLETS.find((x) => x.id === b.dataset.w);
      if (!NX.wallet.available(w.id)) { window.open(NX.wallet.installUrl(w.id) || '#', '_blank', 'noopener'); return; }
      const body = d.querySelector('[data-body]');
      body.innerHTML = `<div class="connecting"><div class="orbit"><span class="wallet-opt__logo" style="background:${w.color};width:48px;height:48px;border-radius:14px;font-size:20px">${w.name[0]}</span></div><div><div class="strong">Waiting for ${w.name}…</div><div class="caption">Approve the connection, then sign the message</div></div></div>`;
      try {
        const proof = await NX.wallet.prove(w.id, purpose, extra);
        body.innerHTML = `<div class="connecting"><div class="success-mark">${I('check')}</div><div class="strong">Signature created</div><div class="caption">${w.name} · <span class="mono">${F.short(proof.address)}</span></div><pre class="sign-msg">${esc(proof.message)}</pre></div>`;
        await wait(700);
        finish(proof);
      } catch (err) {
        body.innerHTML = `<div class="note note--danger">${I('alert')}<span>${esc(err.message || 'Wallet request failed')}</span></div><div class="stack">${walletList()}</div>`;
        NX.hydrateIcons(body);
      }
    });
    NX.modal.open(d);
  });

  /* ======================================================================
     LANDING
     ====================================================================== */
  P.landing = async () => {
    const nav = $('.pubnav');
    const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    const el = $('#hero-chart'), val = $('#hero-value');
    const draw = async () => {
      try {
        const r = await NX.get('/api/market/series?sym=SOL&range=1D');
        const data = r.points.map((p) => (p.p / r.points[0].p) * 12000);
        if (!el._render) NX.charts.line(el, data, { height: 180, axis: false, label: 'Live SOL-based demo portfolio' }); else { el._data = data; NX.charts.line(el, data, { height: 180, axis: false }); }
        NX.countUp(val, data[data.length - 1], { flash: !!val._v });
      } catch (e) { /* server offline */ }
    };
    NX.whenVisible(el, () => { draw(); setInterval(() => !document.hidden && draw(), 15000); });
    try {
      const s = await NX.get('/api/public/stats');
      const set = (sel, v) => { const x = $(sel); if (x) x.dataset.count = v; };
      set('[data-stat="bots"]', s.bots); set('[data-stat="volume"]', s.volume / 1e3); set('[data-stat="users"]', s.users);
      $$('[data-stat]').forEach((x) => NX.whenVisible(x, () => NX.countUp(x, parseFloat(x.dataset.count))));
    } catch (e) { /* offline */ }
    const ev = $('#hero-events');
    const events = [['trending-up', 'Grid filled · <b>SOL/USDC</b> +$4.20', 'up'], ['sparkles', 'Momentum detected on <b>JUP</b>', 'pink'], ['shield', 'Risk check passed · exposure 38%', 'up'], ['bot', 'DCA bought <b>0.52 SOL</b>', 'pink'], ['activity', 'Volatility spike on <b>WIF</b> — bot paused', 'amber']];
    let k = 0;
    const push = () => { const [ic, txt, c] = events[k++ % events.length]; const row = document.createElement('div'); row.className = 'mock__event'; row.innerHTML = `<span class="${c}">${I(ic, 'ic--sm')}</span><span class="grow">${txt}</span><span class="faint tiny">now</span>`; ev.prepend(row); while (ev.children.length > 3) ev.lastElementChild.remove(); };
    if (ev) { push(); push(); push(); setInterval(() => !document.hidden && push(), 3200); }
  };

  /* ======================================================================
     REGISTER (invite-only) + waitlist
     ====================================================================== */
  P.register = async () => {
    const TOTAL = 4;
    let invite = '';
    const status = $('#invite-status'), next = $('#invite-next');
    const check = async (code) => {
      if (code.length < 6) { status.innerHTML = `<span class="hint--error">${I('alert', 'ic--sm')} Codes are 6–8 characters</span>`; otp.invalid(); return; }
      status.innerHTML = `<span class="muted">${I('refresh', 'ic--sm spin')} Checking code…</span>`;
      try { await NX.post('/api/auth/invite/validate', { code }); }
      catch (e) { otp.invalid(); status.innerHTML = `<span class="hint--error">${I('x', 'ic--sm')} ${esc(e.message)}</span>`; return; }
      invite = code; otp.valid();
      status.innerHTML = `<span class="hint--ok">${I('check', 'ic--sm')} Invite accepted — welcome to the beta</span>`;
      setTimeout(() => { showStep('step-account'); setProgress(2, TOTAL); }, 800);
    };
    const otp = NX.otp($('#invite-otp'), { length: 8, minLength: 6, alnum: true, onChange: (v) => { next.disabled = v.length < 6; if (v.length < 8) status.innerHTML = ''; }, onComplete: check, onEnter: check });
    next.addEventListener('click', () => check(otp.value()));
    $('#invite-demo').addEventListener('click', () => otp.fill('NECTRA26'));
    const preCode = new URLSearchParams(location.search).get('code'); if (preCode) setTimeout(() => otp.fill(preCode), 300);

    const pw = $('#reg-pw'), meter = $$('#pw-meter span'), pwHint = $('#pw-hint');
    pw.addEventListener('input', () => {
      const v = pw.value;
      const s = [v.length >= 10, /[A-Z]/.test(v) && /[a-z]/.test(v), /\d/.test(v), /[^A-Za-z0-9]/.test(v)].filter(Boolean).length;
      const cols = ['var(--red)', 'var(--amber)', 'var(--amber)', 'var(--green)'];
      meter.forEach((m, i) => (m.style.background = i < s ? cols[s - 1] : ''));
      pwHint.textContent = ['Use 10+ characters with a mix of cases, numbers & symbols', 'Weak', 'Okay', 'Good', 'Strong'][s];
    });
    $('#account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = $('#reg-email');
      em.classList.toggle('is-invalid', !emailOk(em.value)); $('#reg-email-hint').hidden = emailOk(em.value);
      if (!emailOk(em.value)) return;
      const r = await NX.act($('#account-form .btn--primary'), () => NX.post('/api/auth/register', { code: invite, email: em.value, password: pw.value, acceptTerms: $('#reg-terms').checked }));
      if (!r) return;
      $('#verify-email-label').textContent = em.value;
      showStep('step-verify'); setProgress(3, TOTAL); NX.devHint(r, $('#verify-dev')); vOtp.focus(); startResend();
    });
    $('#reg-wallet').addEventListener('click', async () => {
      const proof = await NX.walletProof('register', 'Create account with wallet');
      if (!proof) return;
      const r = await NX.act(null, () => NX.post('/api/auth/wallet/verify', { ...proof, code: invite }));
      if (!r) return;
      NX.toast('Account created', { msg: `${proof.provider} · ${F.short(proof.address)}` });
      showStep('step-wallets'); setProgress(4, TOTAL);
    });
    const vStatus = $('#verify-status');
    const vOtp = NX.otp($('#verify-otp'), {
      length: 6,
      onComplete: async (code) => {
        vStatus.innerHTML = '<span class="muted">Verifying…</span>';
        try { await NX.post('/api/auth/verify-email', { code }); }
        catch (e) { vOtp.invalid(); vStatus.innerHTML = `<span class="hint--error">${esc(e.message)}</span>`; return; }
        vOtp.valid(); vStatus.innerHTML = `<span class="hint--ok">${I('check', 'ic--sm')} Email verified</span>`;
        setTimeout(() => { showStep('step-wallets'); setProgress(4, TOTAL); }, 700);
      }
    });
    let timer;
    function startResend() { const b = $('#resend'); let s = 30; b.disabled = true; clearInterval(timer); timer = setInterval(() => { b.textContent = s > 0 ? `Resend in ${s--}s` : 'Resend code'; if (s < 0) { b.disabled = false; clearInterval(timer); } }, 1000); }
    $('#resend').addEventListener('click', async () => { const r = await NX.act($('#resend'), () => NX.post('/api/auth/resend-verify')); if (r) { NX.toast('New code sent'); NX.devHint(r, $('#verify-dev')); startResend(); } });
    $('#verify-back').addEventListener('click', () => { showStep('step-account', true); setProgress(2, TOTAL); });

    // Step 4 — link public wallets (watch-only) or a signed wallet
    const inp = $('#link-input'), hint = $('#link-hint');
    const linked = [];
    const renderLinked = () => {
      $('#link-list').innerHTML = linked.length ? linked.map((w) => `<div class="list-row is-new"><span class="wallet-opt__logo" style="background:var(--bg-raised);color:var(--pink)">${I('wallet', 'ic--sm')}</span><div class="grow"><div class="small strong">${esc(w.label)}</div>${NX.addr(w.address, 'addr--muted')}</div></div>`).join('') : `<p class="caption center" style="padding:12px">No wallets linked yet — you can add them later.</p>`;
    };
    renderLinked();
    inp.addEventListener('input', () => {
      const v = inp.value.trim(), ok = NX.isSol(v) || NX.isEvm(v);
      inp.classList.toggle('is-valid', ok); inp.classList.toggle('is-invalid', !!v && !ok);
      hint.className = 'hint ' + (v ? (ok ? 'hint--ok' : 'hint--error') : '');
      hint.innerHTML = !v ? 'Solana or EVM public address' : ok ? `${I('check', 'ic--sm')} Valid ${NX.isSol(v) ? 'Solana' : 'EVM'} address` : `${I('alert', 'ic--sm')} Not a valid public address`;
    });
    $('#link-add').addEventListener('click', async () => {
      const v = inp.value.trim();
      if (!(NX.isSol(v) || NX.isEvm(v))) { inp.classList.add('is-invalid'); return; }
      const r = await NX.act($('#link-add'), () => NX.post('/api/wallets', { source: 'watch', address: v, chain: NX.isSol(v) ? 'Solana' : 'Ethereum' }));
      if (!r) return;
      linked.push({ address: v, label: r.wallet.name + ' (watch-only)' }); inp.value = ''; inp.classList.remove('is-valid'); renderLinked();
    });
    $('#link-sample').textContent = 'Connect & sign with a wallet instead';
    $('#link-sample').addEventListener('click', async () => {
      const proof = await NX.walletProof('link', 'Link a wallet');
      if (!proof) return;
      const r = await NX.act(null, () => NX.post('/api/wallets', { ...proof, source: proof.provider === 'Demo wallet' ? 'demo' : 'connected' }));
      if (r) { linked.push({ address: proof.address, label: r.wallet.name + ' · verified' }); renderLinked(); }
    });
    const finish = () => { setProgress(5, TOTAL); showStep('step-done'); };
    $('#link-finish').addEventListener('click', finish);
    $('#link-skip').addEventListener('click', finish);

    $('#request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = $('#req-email');
      if (!emailOk(em.value)) { em.classList.add('is-invalid'); return; }
      const r = await NX.act($('#request-form .btn--primary'), () => NX.post('/api/waitlist', { email: em.value, referral: $('#req-ref').value }));
      if (!r) return;
      $('#wl-pos').textContent = '#' + r.position.toLocaleString();
      showStep('step-request-done');
    });
    const route = async () => {
      const h = location.hash;
      $('#auth-progress').hidden = h === '#request';
      $('.auth__steps').hidden = h === '#request';
      if (h === '#request') return showStep('step-request');
      if (h === '#verify') {
        try { const me = await NX.get('/api/auth/me'); if (me.user) { $('#verify-email-label').textContent = me.user.email; const r = await NX.post('/api/auth/resend-verify'); NX.devHint(r, $('#verify-dev')); startResend(); showStep('step-verify'); setProgress(3, TOTAL); return; } } catch (e) { /* fall through */ }
      }
      showStep('step-invite'); setProgress(1, TOTAL); otp.focus();
    };
    window.addEventListener('hashchange', route);
    route();
  };

  /* ======================================================================
     LOGIN (+2FA, forgot / reset password, wallet sign-in)
     ====================================================================== */
  P.login = async () => {
    try { const me = await NX.get('/api/auth/me'); if (me.user && !me.pending2fa) { go(nextUrl()); return; } } catch (e) { /* not signed in */ }
    document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showStep('step-' + g.dataset.goto, g.dataset.back != null); } });
    const done = (r) => { if (r.twoFA) { showStep('step-2fa'); tfa.focus(); return; } if (r.needsVerification) { NX.devHint(r); go('register.html#verify'); return; } go(r.user && r.user.role === 'admin' && !new URLSearchParams(location.search).get('next') ? '/admin' : nextUrl()); };
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = $('#login-email'), pw = $('#login-pw');
      const ok = emailOk(em.value) && pw.value.length > 0;
      em.classList.toggle('is-invalid', !emailOk(em.value)); pw.classList.toggle('is-invalid', !pw.value);
      $('#login-error').hidden = ok;
      if (!ok) return;
      try { $('#login-form .btn--primary').classList.add('is-loading'); done(await NX.post('/api/auth/login', { email: em.value, password: pw.value })); }
      catch (err) { $('#login-error').hidden = false; $('#login-error span').textContent = err.message; }
      finally { $('#login-form .btn--primary').classList.remove('is-loading'); }
    });
    $('#toggle-pw').addEventListener('click', (e) => { const p = $('#login-pw'); p.type = p.type === 'password' ? 'text' : 'password'; e.currentTarget.setAttribute('aria-pressed', p.type === 'text'); });
    const st = $('#tfa-status');
    const tfa = NX.otp($('#tfa-otp'), {
      length: 6,
      onComplete: async (code) => {
        st.innerHTML = '<span class="muted">Verifying…</span>';
        try { const r = await NX.post('/api/auth/login/2fa', { code }); tfa.valid(); st.innerHTML = `<span class="hint--ok">${I('check', 'ic--sm')} Verified — signing you in</span>`; setTimeout(() => done(r), 500); }
        catch (e) { tfa.invalid(); st.innerHTML = `<span class="hint--error">${esc(e.message)}</span>`; }
      }
    });
    $('#login-wallet').addEventListener('click', async () => {
      const proof = await NX.walletProof('login', 'Sign in with wallet');
      if (!proof) return;
      const r = await NX.act(null, () => NX.post('/api/auth/wallet/verify', proof));
      if (r) done(r);
    });
    let resetEmail = '';
    $('#forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const em = $('#forgot-email');
      if (!emailOk(em.value)) { em.classList.add('is-invalid'); return; }
      const r = await NX.act($('#forgot-form .btn--primary'), () => NX.post('/api/auth/forgot', { email: em.value }));
      if (!r) return;
      resetEmail = em.value;
      $('#forgot-sent-to').textContent = em.value;
      NX.devHint(r, $('#reset-dev'));
      showStep('step-forgot-sent');
    });
    $('#reset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await NX.act($('#reset-form .btn--primary'), () => NX.post('/api/auth/reset', { email: resetEmail, code: $('#reset-code').value.trim(), password: $('#reset-pw').value }));
      if (r) { NX.toast('Password updated — please log in'); showStep('step-login', true); $('#login-email').value = resetEmail; }
    });
    showStep('step-login');
  };

  /* ======================================================================
     DASHBOARD
     ====================================================================== */
  P.dashboard = async () => {
    const h = new Date().getHours();
    $('#greeting').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${D.user.name.split(' ')[0]}`;
    const chartEl = $('#pv-chart');
    skeleton(chartEl, 1, 'skel--chart');
    let range = '1D';
    async function drawRange(k) {
      range = k;
      const r = await NX.get('/api/portfolio/series?range=' + k);
      const pts = r.points;
      if (pts.length < 2) { chartEl.innerHTML = NX.empty('Building your history', 'Portfolio snapshots are taken every 5 minutes.'); return; }
      const first = pts[0].v, last = pts[pts.length - 1].v, ch = ((last - first) / first) * 100;
      const chip = $('#pv-change');
      chip.className = 'delta ' + (ch >= 0 ? 'delta--up' : 'delta--down');
      chip.innerHTML = `${I(ch >= 0 ? 'trending-up' : 'trending-down', 'ic--sm')} ${F.pct(ch)} <span style="opacity:.7">${k}</span>`;
      $('#pv-abs').textContent = F.signed(last - first);
      const lab = (t) => { const d = new Date(t); return k === '1D' ? F.time(d) : F.date(d); };
      NX.charts.line(chartEl, pts.map((p) => p.v), { height: 240, color: ch >= 0 ? 'pink' : 'red', labels: pts.map((p) => lab(p.t)), label: 'Portfolio value ' + k });
    }
    $('#pv-range').addEventListener('nx:tab', (e) => drawRange(e.detail.value));

    let dash;
    async function load() {
      dash = await NX.get('/api/dashboard');
      NX.countUp($('#pv-value'), dash.value, { flash: true });
      $('#kpi-pnl').textContent = (dash.todayPnl >= 0 ? '+$' : '-$') + Math.abs(dash.todayPnl).toFixed(2);
      $('#kpi-pnl').className = dash.todayPnl >= 0 ? 'up' : 'down';
      $('#bots-active').textContent = `${dash.kpis.activeBots} / ${dash.kpis.totalBots}`;
      $('#kpi-paused').textContent = dash.kpis.pausedByRisk ? `${dash.kpis.pausedByRisk} paused with a reason` : 'none paused';
      $('#kpi-win').textContent = dash.kpis.winRate.toFixed(1) + '%';
      $('#kpi-closed').textContent = `${dash.kpis.closed} closed trades`;
      $('#kpi-wsol').innerHTML = `${F.sol(dash.kpis.walletSol)} <span class="muted small">SOL</span>`;
      $('#kpi-wcount').textContent = `${dash.kpis.walletCount} wallets · $${dash.accountBalance.toFixed(2)} account →`;
      renderBots(dash.bots); renderInsights(dash.insights); renderTrades(); renderOnboarding(dash.onboarding); renderRisk(dash.risk);
      drawAlloc($('#alloc-tabs [aria-selected=true]').dataset.value);
    }

    const botsEl = $('#bots-list');
    skeleton(botsEl, 4);
    function renderBots(bots) {
      botsEl.innerHTML = bots.length ? bots.map((b) => `<div class="list-row" data-bot-row="${b.id}"><span class="tok" style="background:var(--bg-raised);color:var(--pink)">${I('bot', 'ic--sm')}</span>
          <div class="grow"><div class="strong small truncate">${esc(b.name)}</div><div class="caption truncate">${b.strategy} · ${b.pair}${b.status === 'paused' && b.paused_reason ? ' · ' + esc(b.paused_reason) : ''}</div></div>
          <div style="text-align:right;min-width:80px"><div class="mono small ${b.pnl >= 0 ? 'up' : 'down'}">${F.signed(b.pnl)}</div><div class="caption mono">${F.pct(b.pnlPct, 1)}</div></div>
          <label class="switch switch--green" aria-label="${b.status === 'running' ? 'Pause' : 'Resume'} ${esc(b.name)}"><input type="checkbox" data-bot="${b.id}" ${b.status === 'running' ? 'checked' : ''}><span class="switch__track"></span></label></div>`).join('')
        : NX.empty('No bots yet', 'Describe a strategy to the Copilot and deploy it in paper mode.', '<a class="btn btn--primary" href="bot.html#new">Create a bot</a>');
    }
    botsEl.addEventListener('change', async (e) => {
      const id = e.target.dataset.bot; if (!id) return;
      const r = await NX.act(null, () => NX.post(`/api/bots/${id}/toggle`, { on: e.target.checked }));
      if (!r) { e.target.checked = !e.target.checked; return; }
      NX.toast(`${r.bot.name} ${r.bot.status === 'running' ? 'resumed' : 'paused'}`, { type: r.bot.status === 'running' ? 'success' : 'warn', msg: 'Paper trading' });
      load();
    });

    const ins = $('#insights');
    skeleton(ins, 3);
    const insight = (x, isNew) => `<div class="insight ${isNew ? 'is-new' : ''}"><span class="insight__ic">${I(x.icon)}</span><div class="grow"><p>${x.text}</p><time>${ago(x.created_at)}</time></div></div>`;
    function renderInsights(list) { ins.innerHTML = list.length ? list.map((x) => insight(x)).join('') : '<p class="caption">Insights appear as your bots trade.</p>'; }
    document.addEventListener('nx:insight', (e) => { ins.insertAdjacentHTML('afterbegin', insight(e.detail, true)); while (ins.children.length > 5) ins.lastElementChild.remove(); });

    let side = 'all', pair = 'all';
    const tb = $('#trades-body');
    function renderTrades() {
      const pairs = [...new Set(dash.trades.map((t) => t.pair))];
      const sel = $('#trade-pair');
      if (sel.options.length !== pairs.length + 1) sel.innerHTML = '<option value="all">All pairs</option>' + pairs.map((p) => `<option ${p === pair ? 'selected' : ''}>${p}</option>`).join('');
      const rows = dash.trades.filter((t) => (side === 'all' || t.side === side) && (pair === 'all' || t.pair === pair)).slice(0, 8);
      tb.innerHTML = rows.length ? rows.map((t) => `<tr><td data-label="Pair"><div class="pair">${NX.tokIcon(t.pair.split('/')[0], 'tok--sm')}<span><b class="small">${t.pair}</b><br class="hide-mobile"><span class="caption hide-mobile">${esc(t.bot_name || '')}</span></span></div></td>
        <td data-label="Time" class="mono small muted">${F.date(new Date(t.created_at))} ${F.time(new Date(t.created_at))}</td>
        <td data-label="Side"><span class="side side--${t.side}">${t.side}</span></td>
        <td data-label="Size" class="r num">${(+t.size).toPrecision(5)}</td>
        <td data-label="Price" class="r num">${F.usd(t.price)}</td>
        <td data-label="PnL" class="r num ${t.pnl == null ? 'faint' : t.pnl >= 0 ? 'up' : 'down'}">${t.pnl == null ? '—' : F.signed(t.pnl)}</td></tr>`).join('')
        : `<tr><td colspan="6">${NX.empty('No trades match', 'Try a different filter — or wait for your bots to trade.')}</td></tr>`;
    }
    $('#trade-filter').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (!c) return; $$('#trade-filter [data-f]').forEach((x) => x.setAttribute('aria-pressed', x === c)); side = c.dataset.f; renderTrades(); });
    $('#trade-pair').addEventListener('change', (e) => { pair = e.target.value; renderTrades(); });
    document.addEventListener('nx:trade', (e) => { const t = e.detail; dash.trades.unshift({ ...t, bot_name: t.bot, created_at: t.time }); renderTrades(); const r = tb.querySelector('tr'); r && r.classList.add('is-new'); });

    const alloc = $('#alloc');
    function drawAlloc(k) { const items = k === 'wallets' ? dash.allocation.bots : dash.allocation.tokens; const tot = items.reduce((a, b) => a + b.value, 0); NX.charts.donut(alloc, items, { center: '$' + F.compact(tot), sub: k === 'wallets' ? 'by bot' : 'by token' }); }
    $('#alloc-tabs').addEventListener('nx:tab', (e) => dash && drawAlloc(e.detail.value));

    const movers = () => D.tokens.filter((t) => !['USDC', 'USDT'].includes(t.sym)).sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch));
    $('#movers').innerHTML = movers().slice(0, 5).map((t) => `<div class="list-row">${NX.tokIcon(t.sym)}<div class="grow"><div class="strong small">${t.sym}</div><div class="caption">${t.name}</div></div><div style="text-align:right"><div class="mono small" data-px="${t.sym}">${F.usd(t.price)}</div><div class="mono tiny ${t.ch >= 0 ? 'up' : 'down'}" data-ch="${t.sym}">${F.pct(t.ch)}</div></div><button class="icon-btn icon-btn--sm" data-alert="${t.sym}" aria-label="Set price alert for ${t.sym}" data-tip="Price alert" data-tip-pos="left">${I('bell-plus')}</button></div>`).join('');
    NX.whenVisible($('#heat'), (el) => NX.charts.heat(el, movers()));
    $('#movers').addEventListener('click', (e) => { const b = e.target.closest('[data-alert]'); if (b) NX.priceAlert(b.dataset.alert); });

    let gauge;
    function renderRisk(r) {
      if (!gauge) gauge = NX.charts.gauge($('#risk-gauge'), { value: 0, text: '0%', label: 'Exposure vs limit' });
      const p = r.limit ? r.exposure / r.limit : 0;
      gauge.set(p, Math.round(p * 100) + '%');
      $('#risk-exp').textContent = F.usd(r.exposure, 0); $('#risk-limit').textContent = F.usd(r.limit, 0);
      $('#risk-daily').innerHTML = `Daily loss used: <b class="mono">${r.dailyUsed.toFixed(2)}%</b> of your ${r.maxDailyLoss}% limit.`;
    }

    const steps = [{ id: 'connect', label: 'Connect a wallet', href: 'wallets.html#connect' }, { id: 'deposit', label: 'Make your first deposit', href: 'deposit.html' }, { id: 'bot', label: 'Deploy your first bot', href: 'bot.html#new' }, { id: '2fa', label: 'Enable 2FA', href: 'settings.html#security' }];
    function renderOnboarding(ob) {
      const n = steps.filter((s) => ob[s.id]).length;
      $('#onboard').innerHTML = steps.map((s) => `<a class="checklist__item ${ob[s.id] ? 'is-done' : ''}" href="${s.href}"><span class="checklist__mark">${I('check')}</span><span class="checklist__label grow small">${s.label}</span>${ob[s.id] ? '' : I('chevron-right', 'ic--sm faint')}</a>`).join('');
      NX.charts.ring($('#onboard-ring'), n / steps.length, { size: 64, stroke: 7, center: `<b class="mono small">${n}/${steps.length}</b>`, color: n === steps.length ? 'var(--green)' : undefined });
    }

    await load();
    NX.whenVisible(chartEl, () => drawRange('1D'));
    setInterval(() => !document.hidden && load().catch(() => {}), 20000);
    ['nx:bots-paused', 'nx:refresh'].forEach((ev) => document.addEventListener(ev, () => load()));
  };

  /* Price alert sheet (any token row) */
  NX.priceAlert = (sym) => {
    let d = $('#alert-modal');
    if (!d) {
      d = document.createElement('dialog');
      d.className = 'modal'; d.id = 'alert-modal';
      d.innerHTML = `<div class="modal__head"><h2 class="modal__title">Price alert</h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${I('x')}</button></div>
      <div class="modal__body"><div class="row-nw" id="al-tok"></div>
        <div class="seg" role="tablist" aria-label="Direction" id="al-dir"><button class="seg__btn" role="tab" aria-selected="true" data-value="above">Goes above</button><button class="seg__btn" role="tab" aria-selected="false" data-value="below">Goes below</button></div>
        <div class="field"><label class="label" for="al-price">Target price</label><div class="input-wrap"><input class="input mono" id="al-price" inputmode="decimal"><div class="input-wrap__end"><span class="input-unit">USD</span></div></div></div>
        <div class="chips" id="al-quick"><button class="chip" data-q="-10">−10%</button><button class="chip" data-q="-5">−5%</button><button class="chip" data-q="5">+5%</button><button class="chip" data-q="10">+10%</button></div>
        <label class="switch"><input type="checkbox" checked id="al-email"><span class="switch__track"></span><span class="small">Also email me (includes your anti-phishing code)</span></label>
      </div><div class="modal__foot"><button class="btn" data-close>Cancel</button><button class="btn btn--primary" id="al-save">${I('bell')} Create alert</button></div>`;
      document.body.appendChild(d);
      NX.initTabs(d);
      d.querySelector('#al-quick').addEventListener('click', (e) => {
        const c = e.target.closest('[data-q]'); if (!c) return;
        const t = D.token(d.dataset.sym); d.querySelector('#al-price').value = (t.price * (1 + c.dataset.q / 100)).toPrecision(4);
        d.querySelector('#al-dir')._select(d.querySelector(`#al-dir [data-value="${c.dataset.q > 0 ? 'above' : 'below'}"]`));
      });
      d.querySelector('#al-save').addEventListener('click', async (e) => {
        const p = d.querySelector('#al-price').value;
        const dir = d.querySelector('#al-dir [aria-selected=true]').dataset.value;
        const r = await NX.act(e.currentTarget, () => NX.post('/api/alerts', { token: d.dataset.sym, direction: dir, price: parseFloat(p), email: d.querySelector('#al-email').checked }));
        if (r) { NX.modal.close(d); NX.toast(`Alert set for ${d.dataset.sym}`, { msg: `Notify when price goes ${dir} $${p}` }); document.dispatchEvent(new CustomEvent('nx:alerts')); }
      });
    }
    const t = D.token(sym);
    if (!t) return;
    d.dataset.sym = sym;
    d.querySelector('#al-tok').innerHTML = `${NX.tokIcon(sym, 'tok--lg')}<div class="grow"><div class="strong">${sym} <span class="muted small">${t.name}</span></div><div class="mono small">Now ${F.usd(t.price)} <span class="${t.ch >= 0 ? 'up' : 'down'}">${F.pct(t.ch)}</span></div></div>`;
    d.querySelector('#al-price').value = (t.price * 1.05).toPrecision(4);
    NX.modal.open(d);
  };

  /* ======================================================================
     AI BOTS
     ====================================================================== */
  P.bot = async () => {
    const chat = NX.mountChat($('#chat-main'));
    let data = await NX.get('/api/bots');
    const paper = $('#paper-toggle');
    paper.checked = true;
    paper.disabled = true;
    paper.closest('label').dataset.tip = data.liveEnabled ? 'New bots start in paper mode. Use “Go live” on a bot to trade real funds from its own wallet.' : 'Live trading is not enabled on this platform yet — all bots run in paper mode.';
    const askCode = async (title, body) => {
      if (!D.user.twoFA) { NX.toast('Enable 2FA first', { type: 'warn', msg: 'Settings → Security → authenticator app' }); return null; }
      window._code2fa = '';
      const ok = await NX.confirm({ title, body, confirm: 'Confirm', danger: true, extra: '<input class="input mono" id="code-2fa" inputmode="numeric" maxlength="6" placeholder="123456" aria-label="Authenticator code" autocomplete="one-time-code">' });
      return ok ? window._code2fa : null;
    };
    document.addEventListener('input', (e) => { if (e.target.id === 'code-2fa') window._code2fa = e.target.value; });
    $('#kill-btn').addEventListener('click', async () => { if (await NX.killSwitch()) refresh(); });

    async function refresh() { data = await NX.get('/api/bots'); renderActive(); }
    function renderActive() {
      const sel = $('#bt-strategy');
      sel.innerHTML = data.bots.length ? data.bots.map((b) => `<option value="${b.id}">${esc(b.name)} · ${b.pair}</option>`).join('') : '<option value="">Deploy a bot to backtest it</option>';
      $('#active-body').innerHTML = data.bots.length ? data.bots.map((b) => `<tr><td data-label="Bot"><div class="pair"><span class="tok tok--sm" style="background:var(--bg-raised);color:var(--pink)">${I('bot', 'ic--sm')}</span><b class="small">${esc(b.name)}</b></div></td><td data-label="Strategy" class="small">${b.strategy}</td><td data-label="Pair" class="small mono">${b.pair}</td><td data-label="Mode">${b.mode === 'paper' ? `<span class="tag tag--paper">Paper</span>${data.liveEnabled && ['Grid', 'DCA', 'Momentum', 'Scalp', 'Breakout', 'Dip-buy', 'Mean-reversion'].includes(b.strategy) ? ` <button class="link small" data-golive="${b.id}">Go live</button>` : ''}` : `<span class="tag tag--green">LIVE</span> <button class="link small" data-wallet="${b.id}">Wallet</button>`}</td><td data-label="PnL" class="r num ${b.pnl >= 0 ? 'up' : 'down'}">${F.signed(b.pnl)}</td>
        <td data-label="Status"><button class="tag ${b.status === 'running' ? 'tag--green' : ''}" data-toggle="${b.id}" data-on="${b.status !== 'running'}" title="${esc(b.paused_reason || '')}"><span class="dot ${b.status === 'running' ? 'dot--pulse' : 'dot--muted'}"></span>${b.status === 'running' ? 'Running' : 'Paused'}</button></td>
        <td data-label="" class="r"><button class="icon-btn icon-btn--sm" data-stats="${b.id}" aria-label="Performance of ${esc(b.name)}">${I('bar-chart')}</button> <button class="icon-btn icon-btn--sm" data-delete="${b.id}" aria-label="Stop and remove ${esc(b.name)}">${I('trash')}</button></td></tr>`).join('')
        : `<tr><td colspan="7">${NX.empty('No bots yet', 'Use the Copilot or a template below.')}</td></tr>`;
    }
    renderActive();
    $('#active-body').addEventListener('click', async (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) { const r = await NX.act(null, () => NX.post(`/api/bots/${t.dataset.toggle}/toggle`, { on: t.dataset.on === 'true' })); if (r) refresh(); return; }
      const d = e.target.closest('[data-delete]');
      if (d && await NX.confirm({ title: 'Stop & remove bot?', body: 'Its cash and any open position return to your paper account.', confirm: 'Remove', danger: true })) { const r = await NX.act(null, () => NX.del('/api/bots/' + d.dataset.delete)); if (r) { NX.toast('Bot removed'); refresh(); } }
      const gl = e.target.closest('[data-golive]');
      if (gl) {
        const code = await askCode('Switch this bot to LIVE?', 'The bot gets its own Solana wallet (key encrypted on NECTRA’s server). It trades real funds via Jupiter — losses are possible. Fund it only with what you can afford to lose. Its paper balance returns to your paper account. Enter your authenticator code:');
        if (!code) return;
        const r = await NX.act(null, () => NX.post(`/api/bots/${gl.dataset.golive}/go-live`, { code }));
        if (r) { NX.toast('Bot is live — fund its wallet', { msg: `${F.short(r.address)} · max $${r.maxUsd}` }); refresh(); openWallet(+gl.dataset.golive); }
      }
      const wb = e.target.closest('[data-wallet]');
      if (wb) openWallet(+wb.dataset.wallet);
      const st = e.target.closest('[data-stats]');
      if (st) openStats(+st.dataset.stats);
    });
    async function openStats(id) {
      const s = await NX.act(null, () => NX.get(`/api/bots/${id}/stats`));
      if (!s) return;
      const pf = s.profitFactor == null || !isFinite(s.profitFactor) ? (s.wins ? '∞' : '—') : s.profitFactor.toFixed(2);
      const cell = (label, val, cls = '') => `<div class="metric"><div class="kpi__label">${label}</div><div class="kpi__value ${cls}" style="font-size:16px">${val}</div></div>`;
      const d = document.createElement('dialog'); d.className = 'modal';
      d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${esc(s.bot.name)} · performance</h2><button class="icon-btn icon-btn--sm" data-x aria-label="Close">${I('x')}</button></div>
        <div class="modal__body">
          <div class="row small muted" style="gap:8px;flex-wrap:wrap"><span class="tag">${esc(s.bot.strategy)}</span><span class="tag ${s.bot.mode === 'paper' ? 'tag--paper' : 'tag--green'}">${s.bot.mode === 'paper' ? 'Paper' : 'Live'}</span><span>Since ${new Date(s.bot.createdAt).toLocaleDateString()}</span></div>
          <div class="bt-mini mt-12" id="stats-eq" style="height:90px"></div>
          <div class="grid-3 mt-12" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
            ${cell('Total return', F.pct(s.totalReturnPct, 1), s.totalReturnPct >= 0 ? 'up' : 'down')}
            ${cell('Realized PnL', F.usd(s.realized), s.realized >= 0 ? 'up' : 'down')}
            ${cell('Unrealized', F.usd(s.unrealized), s.unrealized >= 0 ? 'up' : 'down')}
            ${cell('Win rate', s.winRate.toFixed(0) + '%')}
            ${cell('Closed trades', s.closed + ' / ' + s.trades)}
            ${cell('Profit factor', pf)}
            ${cell('Avg win', F.usd(s.avgWin), 'up')}
            ${cell('Avg loss', F.usd(-s.avgLoss), 'down')}
            ${cell('Max drawdown', s.maxDrawdown.toFixed(1) + '%', 'down')}
            ${cell('Best trade', F.usd(s.bestTrade), 'up')}
            ${cell('Worst trade', F.usd(s.worstTrade), 'down')}
            ${cell('Fees paid', F.usd(s.fees))}
          </div>
          <p class="caption mt-12">Equity reconstructed from closed-trade PnL plus the current open position. Paper or live as tagged. Past performance doesn’t predict future results.</p>
        </div>`;
      document.body.appendChild(d); NX.hydrateIcons(d); NX.modal.open(d);
      try { NX.charts.line(d.querySelector('#stats-eq'), s.equity, { height: 90, axis: false, color: s.totalReturnPct >= 0 ? 'green' : 'red', label: 'Bot equity' }); } catch (x) {}
      const close = () => { NX.modal.close(d); setTimeout(() => d.remove(), 260); };
      d.addEventListener('click', (e) => { if (e.target.closest('[data-x]') || e.target === d) close(); });
      d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    }
    async function openWallet(id) {
      const w = await NX.act(null, () => NX.get(`/api/bots/${id}/wallet`));
      if (!w) return;
      const b = data.bots.find((x) => x.id === id) || {};
      const ok = await NX.confirm({ title: `${esc(b.name || 'Bot')} · live wallet`, body: `Send USDC (max $${w.maxUsd}) and ~0.02 SOL for network fees to this address, then resume the bot. Only this bot can trade from it.`, confirm: 'Withdraw everything to my main wallet', danger: true,
        extra: `<div class="row" style="gap:14px;align-items:flex-start"><div class="qr" id="bw-qr" style="width:140px;height:140px;padding:8px"></div><div class="stack-sm grow">${NX.addr(w.address)}${Object.entries(w.balances).map(([k, v]) => `<div class="row between small"><span class="muted">${k}</span><b class="mono">${(+v).toFixed(k === 'USDC' ? 2 : 6)}</b></div>`).join('')}</div></div>` });
      setTimeout(() => {}, 0);
      if (!ok) return;
      const code = await askCode('Withdraw bot funds?', 'The bot is paused and its USDC, tokens and spare SOL are sent to your verified main wallet. Enter your authenticator code:');
      if (!code) return;
      const r = await NX.act(null, () => NX.post(`/api/bots/${id}/live-withdraw`, { code }));
      if (r) { NX.toast('Withdrawal sent', { msg: r.transfers.map((t) => t.error ? `${t.token}: ${t.error}` : `${t.amount.toFixed(4)} ${t.token}`).join(' · ') || 'Nothing to withdraw' }); refresh(); }
    }
    new MutationObserver(() => { const qr = document.getElementById('bw-qr'); if (qr && !qr.firstChild) { const a = qr.parentElement.querySelector('[data-copy]'); if (a) NX.charts.qr(qr, a.dataset.copy); } }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('nx:refresh', refresh);
    document.addEventListener('nx:bot', refresh);

    const TPL = [
      { k: 'Grid', icon: 'grid', d: 'Buy low / sell high inside a price range. Best in sideways markets.', p: () => { const s = D.token('SOL').price; return `Grid trade SOL/USDC between $${Math.floor(s * 0.92)} and $${Math.ceil(s * 1.08)}`; }, tip: 'Places a ladder of buy and sell orders at fixed price steps.' },
      { k: 'DCA', icon: 'calendar', d: 'Invest a fixed amount on a schedule to smooth out volatility.', p: () => 'DCA $50 into SOL every Monday', tip: 'Dollar-cost averaging: buying a fixed $ amount at regular intervals.' },
      { k: 'Momentum', icon: 'trending-up', d: 'Ride trends when price breaks above its moving average.', p: () => 'Momentum on JUP with 4% stop-loss and trailing stop', tip: 'Buys assets that are rising, exits when the trend fades.' },
      { k: 'Scalp', icon: 'zap', d: 'Many small, fast trades taking quick profits off a short EMA.', p: () => 'Scalp SOL with a 0.5% take-profit and 0.3% stop', tip: 'High-frequency: small targets, tight stops. Fees matter — keep targets above the round-trip fee.' },
      { k: 'Breakout', icon: 'bar-chart', d: 'Buy when price breaks above its recent high, trail the gains.', p: () => 'Breakout buy ETH above its 24h high, trail 3%', tip: 'Enters on a new high over a lookback window; a trailing stop locks in the move.' },
      { k: 'Mean-reversion', icon: 'activity', d: 'Buy dips that stretch too far from the average, sell the bounce.', p: () => 'Mean revert on WIF', tip: 'Assumes price tends to return to its recent average.' },
      { k: 'Arbitrage', icon: 'swap', d: 'Capture price gaps between venues. Low risk, low return.', p: () => 'Arbitrage SOL with max $300', tip: 'Buying low on one venue and selling higher on another.' },
      { k: 'Copy-trader', icon: 'copytrade', d: 'Mirror a verified trader’s moves, scaled to your budget.', p: () => 'Copy lotus.sol with max $200', tip: 'Automatically replicates another trader’s positions.' }
    ];
    $('#tpl-grid').innerHTML = TPL.map((t, i) => `<button class="card card--hover tpl" data-tpl="${i}"><span class="row between" style="width:100%"><span class="tpl__ic">${I(t.icon)}</span><span class="help" data-tip="${t.tip}" data-tip-pos="left" tabindex="0" role="note">?</span></span><b>${t.k}</b><p>${t.d}</p><span class="small pink row" style="gap:4px">Use template ${I('arrow-right', 'ic--sm')}</span></button>`).join('');
    $('#tpl-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-tpl]'); if (!b || e.target.closest('.help')) return; $('#chat-main').scrollIntoView({ behavior: 'smooth', block: 'center' }); chat.send(TPL[b.dataset.tpl].p()); });

    const run = async () => {
      const id = $('#bt-strategy').value;
      const el = $('#bt-chart');
      if (!id) { el.innerHTML = NX.empty('Nothing to backtest yet', 'Deploy a bot, or use “Quick backtest” on a Copilot strategy card.'); return; }
      skeleton(el, 1, 'skel--chart');
      $$('#bt-metrics .kpi__value').forEach((m) => (m.innerHTML = '<span class="skel" style="display:block;width:70%;height:20px"></span>'));
      const range = ($('#bt-range [aria-selected=true]') || {}).textContent || '90D';
      const r = await NX.act($('#bt-run'), () => NX.post('/api/backtest', { botId: +id, range }));
      if (!r) return;
      NX.charts.line(el, r.equity, { height: 220, label: 'Backtest equity curve', color: r.totalReturn >= 0 ? 'pink' : 'red' });
      const m = $$('#bt-metrics .kpi__value');
      [[r.winRate, 1, '', '%'], [r.maxDrawdown, 1, '', '%'], [r.sharpe, 2, '', ''], [r.totalReturn, 1, r.totalReturn >= 0 ? '+' : '', '%']].forEach((v, i) => { m[i].innerHTML = '<span></span>'; NX.countUp(m[i].firstChild, v[0], { dec: v[1], prefix: v[2], suffix: v[3], from: 0 }); });
      m[3].className = 'kpi__value ' + (r.totalReturn >= 0 ? 'up' : 'down'); m[1].className = 'kpi__value down';
      $('#bt-source').innerHTML = `${r.points} hourly points from <b>${r.source === 'synthetic' ? 'synthetic data (market data unavailable)' : r.source === 'coingecko' ? 'CoinGecko' : r.source === 'binance' ? 'Binance' : 'cached market data'}</b> · buy &amp; hold: <b class="mono ${r.buyAndHold >= 0 ? 'up' : 'down'}">${F.pct(r.buyAndHold, 1)}</b> · ${r.trades} closed trades · 0.1% fees. Past performance ≠ future results.`;
    };
    $('#bt-run').addEventListener('click', run);
    $('#bt-range').addEventListener('nx:tab', run);
    NX.whenVisible($('#bt-chart'), run);

    $('#leaders').innerHTML = data.leaders.map((l, i) => `<tr><td data-label="Trader"><div class="pair"><span class="leader-rank ${i < 3 ? 'is-top' : ''}">${i + 1}</span><b class="small">${l.handle}</b>${l.verified ? `<span class="tag tag--green" data-tip="Track record verified on-chain for ${l.days} days">${I('shield')} Verified</span>` : '<span class="tag">Unverified</span>'}</div></td>
      <td data-label="90d return" class="r num up">+${l.ret}%</td><td data-label="Max drawdown" class="r num down">${l.dd}%</td><td data-label="Win rate" class="r num">${l.win}%</td><td data-label="Trend" class="r">${NX.charts.spark(NX.util.series(30, 100, 0.06, l.seed, 0.09), 'green', 80, 28)}</td><td data-label="Followers" class="r num">${l.followers.toLocaleString()}</td>
      <td data-label="" class="r"><button class="btn btn--sm btn--accent" data-copytrader="${l.handle}">Copy</button></td></tr>`).join('');
    NX.charts.drawIn($('#leaders'));
    $('#leaders').addEventListener('click', (e) => { const b = e.target.closest('[data-copytrader]'); if (b) { $('#chat-main').scrollIntoView({ behavior: 'smooth', block: 'center' }); chat.send(`Copy ${b.dataset.copytrader} with max $200`); } });
    if (location.hash === '#new') setTimeout(() => $('#chat-main textarea').focus(), 400);
  };

  /* ======================================================================
     WALLETS
     ====================================================================== */
  P.wallets = async () => {
    let data, folder = 'All';
    const sel = new Set();
    const list = $('#buyer-list');
    skeleton(list, 5);
    async function load() {
      data = await NX.get('/api/wallets');
      const mw = data.main;
      NX.countUp($('#w-total-sol'), data.totals.sol, { dec: 4 });
      NX.countUp($('#w-total-usd'), data.totals.usd, { dec: 2, prefix: '$' });
      $('#w-count').textContent = data.totals.count;
      $('#buyer-count').textContent = data.wallets.length;
      NX.countUp($('#acct-bal'), data.accountBalance, { dec: 2, prefix: '$' });
      if (mw) {
        $('#mw-empty').hidden = true; $('#mw-body').hidden = false;
        $('#main-addr').innerHTML = NX.addr(mw.address) + ` <span class="tag ${mw.source === 'demo' ? 'tag--amber' : 'tag--green'}">${mw.source === 'demo' ? 'Demo' : 'Verified'}</span>`;
        NX.countUp($('#main-bal'), mw.sol, { dec: 4 });
        $('#main-usd').textContent = '≈ ' + F.usd(mw.sol * data.solPrice, 2) + (mw.balanceAt ? ` · updated ${ago(mw.balanceAt)}` : '');
        $$('[data-main-sol]').forEach((b) => (b.textContent = mw.sol.toFixed(mw.sol < 0.01 && mw.sol > 0 ? 4 : 2)));
      } else { $('#mw-empty').hidden = false; $('#mw-body').hidden = true; }
      renderFolders(); renderList(); NX.hydrateIcons();
    }
    $('#refresh-btn').addEventListener('click', async (e) => {
      const b = e.currentTarget, ic = b.querySelector('.ic');
      ic.classList.add('spin');
      const r = await NX.act(b, () => NX.post(`/api/wallets/${data.main.id}/refresh`));
      ic.classList.remove('spin');
      if (r) { NX.toast(r.source === 'rpc' ? 'Balance refreshed from Solana' : 'Demo wallet — balance is simulated', { msg: F.sol(r.wallet.sol) + ' SOL' }); load(); }
    });
    $('#change-main').addEventListener('click', async () => {
      const opts = data.wallets.filter((w) => w.verified);
      if (!opts.length) { NX.toast('Connect or generate a wallet first', { type: 'warn', msg: 'Only wallets you’ve proven you own can be the main wallet.' }); return; }
      let pick = null;
      const p = NX.confirm({ title: 'Change main wallet', body: 'Your main wallet receives deposits and sweeps.', confirm: 'Set as main', extra: `<div class="stack" id="pick-main">${opts.map((w) => `<button class="option-card" data-pick="${w.id}">${I('wallet')}<span class="grow"><b class="small">${esc(w.name)}</b><br><span class="mono caption">${F.short(w.address)}</span></span><span class="mono small">${F.sol(w.sol)}</span></button>`).join('')}</div>` });
      setTimeout(() => { const pm = $('#pick-main'); pm && pm.addEventListener('click', (e) => { const c = e.target.closest('[data-pick]'); if (!c) return; pick = c.dataset.pick; $$('#pick-main .option-card').forEach((x) => x.setAttribute('aria-pressed', x === c)); }); }, 50);
      if (await p && pick) { const r = await NX.act(null, () => NX.post(`/api/wallets/${pick}/main`)); if (r) { NX.toast('Main wallet updated'); load(); } }
    });

    const visible = () => data.wallets.filter((w) => folder === 'All' || w.folder === folder);
    function renderFolders() {
      const count = (f) => (f === 'All' ? data.wallets.length : data.wallets.filter((w) => w.folder === f).length);
      $('#folder-chips').innerHTML = ['All'].concat(data.folders).map((f) => `<button class="chip" aria-pressed="${f === folder}" data-folder="${esc(f)}">${f === 'All' ? '' : I('folder', 'ic--sm')}${esc(f)}<span class="chip__count">${count(f)}</span></button>`).join('') + `<button class="chip chip--dashed" id="new-folder">${I('plus', 'ic--sm')} New folder</button>`;
    }
    function renderList() {
      const v = visible();
      list.innerHTML = v.length ? v.map((w) => `<div class="list-row ${sel.has(w.id) ? 'is-selected' : ''}" data-id="${w.id}">
        <label class="check" aria-label="Select ${esc(w.name)}"><input type="checkbox" data-sel="${w.id}" ${sel.has(w.id) ? 'checked' : ''}><span class="check__box"></span></label>
        <div class="grow"><div class="strong small">${esc(w.name)} <span class="caption hide-mobile">· ${esc(w.folder)} · ${w.source === 'watch' ? 'watch-only' : w.source}</span></div>${NX.addr(w.address, 'addr--muted')}</div>
        <div style="text-align:right"><div class="mono small">${F.sol(w.sol)} <span class="faint">SOL</span></div><div class="caption mono">${F.usd(w.sol * data.solPrice, 2)}</div></div>
        <div class="menu-anchor"><button class="icon-btn icon-btn--sm" data-menu-btn aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(w.name)}">${I('more')}</button>
          <div class="menu" role="menu">
            <button class="menu__item" role="menuitem" data-wact="rename">${I('edit')} Rename</button>
            <button class="menu__item" role="menuitem" data-wact="move">${I('folder')} Move to folder</button>
            <button class="menu__item" role="menuitem" data-wact="balances">${I('wallet')} View balances · send · swap</button>
            <button class="menu__item" role="menuitem" data-wact="refresh">${I('refresh')} Refresh balance</button>
            <button class="menu__item" role="menuitem" data-wact="fund">${I('deposit')} Fund from main</button>
            <button class="menu__item" role="menuitem" data-wact="sweep" ${w.source === 'watch' ? 'disabled' : ''}>${I('withdraw')} Sweep to main</button>
            <div class="menu__sep"></div>
            <button class="menu__item menu__item--danger" role="menuitem" data-wact="remove">${I('trash')} Remove</button>
          </div></div></div>`).join('') : NX.empty('This folder is empty', 'Move wallets here from the ⋯ menu, or add a new one.', `<button class="btn btn--accent" data-gen>${I('plus')} Generate wallet</button>`);
      const tot = v.reduce((a, b) => a + b.sol, 0);
      $('#buyer-total').innerHTML = `<b class="mono">${F.sol(tot)}</b> SOL <span class="faint">· ${F.usd(tot * data.solPrice, 2)}</span>`;
      syncSel();
    }
    function syncSel() {
      const v = visible(), all = $('#select-all');
      const n = v.filter((w) => sel.has(w.id)).length;
      all.checked = n > 0 && n === v.length; all.indeterminate = n > 0 && n < v.length;
      $('#bulkbar').classList.toggle('is-open', sel.size > 0);
      $('#bulk-count').textContent = `${sel.size} selected`;
      $$('.list-row[data-id]', list).forEach((r) => r.classList.toggle('is-selected', sel.has(+r.dataset.id)));
    }
    $('#folder-chips').addEventListener('click', async (e) => {
      const c = e.target.closest('[data-folder]');
      if (c) { folder = c.dataset.folder; renderFolders(); renderList(); return; }
      if (e.target.closest('#new-folder')) { const name = await promptText('New folder', 'Folder name', 'e.g. Snipers'); if (name && await NX.act(null, () => NX.post('/api/folders', { name }))) { folder = name; await load(); } }
    });
    list.addEventListener('change', (e) => { const id = +e.target.dataset.sel; if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); syncSel(); });
    $('#select-all').addEventListener('change', (e) => { visible().forEach((w) => (e.target.checked ? sel.add(w.id) : sel.delete(w.id))); renderList(); });
    list.addEventListener('click', async (e) => {
      if (e.target.closest('[data-gen]')) return generate();
      const a = e.target.closest('[data-wact]'); if (!a) return;
      const w = data.wallets.find((x) => x.id === +a.closest('[data-id]').dataset.id);
      a.closest('.menu').classList.remove('is-open');
      const act = a.dataset.wact;
      if (act === 'rename') { const n = await promptText('Rename wallet', 'Wallet name', w.name, w.name); if (n && await NX.act(null, () => NX.patch('/api/wallets/' + w.id, { name: n }))) load(); }
      if (act === 'move') { const f = await pickFolder(w.folder); if (f && await NX.act(null, () => NX.patch('/api/wallets/' + w.id, { folder: f }))) { NX.toast('Moved to ' + f); load(); } }
      if (act === 'balances') NX.walletBalances(w);
      if (act === 'refresh') { const r = await NX.act(null, () => NX.post(`/api/wallets/${w.id}/refresh`)); if (r) { NX.toast('Balance updated', { msg: F.sol(r.wallet.sol) + ' SOL' }); load(); } }
      if (act === 'fund') transfer('Fund', [w]);
      if (act === 'sweep') transfer('Sweep', [w]);
      if (act === 'remove' && await NX.confirm({ title: `Remove ${esc(w.name)}?`, body: 'The wallet is only removed from NECTRA. Funds stay on-chain at this address.', confirm: 'Remove', danger: true })) {
        if (await NX.act(null, () => NX.del('/api/wallets/' + w.id))) { sel.delete(w.id); load(); }
      }
    });
    function promptText(title, label, ph, val = '') {
      return new Promise((res) => {
        let v = val;
        NX.confirm({ title, body: '', confirm: 'Save', extra: `<div class="field"><label class="label" for="pt-in">${label}</label><input class="input" id="pt-in" placeholder="${ph}" value="${esc(val)}" maxlength="32"></div>` }).then((ok) => res(ok ? v.trim() : null));
        setTimeout(() => { const i = $('#pt-in'); if (i) { i.focus(); i.select(); i.addEventListener('input', () => (v = i.value)); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.closest('dialog').querySelector('[data-ok]').click(); }); } }, 60);
      });
    }
    function pickFolder(cur) {
      return new Promise((res) => {
        let pick = cur;
        NX.confirm({ title: 'Move to folder', body: '', confirm: 'Move', extra: `<div class="stack" id="pf-list">${data.folders.map((f) => `<button class="option-card" data-f="${esc(f)}" aria-pressed="${f === cur}">${I('folder')}<span class="strong small">${esc(f)}</span></button>`).join('')}</div>` }).then((ok) => res(ok ? pick : null));
        setTimeout(() => { const l = $('#pf-list'); l && l.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; pick = b.dataset.f; $$('#pf-list .option-card').forEach((x) => x.setAttribute('aria-pressed', x === b)); }); }, 50);
      });
    }
    /** Fund (main → wallets) or Sweep (wallets → main), each signed by the wallet that owns the source */
    async function transfer(type, ws) {
      if (!data.main) return NX.toast('Set a main wallet first', { type: 'warn' });
      const isFund = type === 'Fund';
      const amt = isFund ? 0.001 : null;
      const ok = await NX.confirm({ title: `${type} ${ws.length} wallet${ws.length > 1 ? 's' : ''}`, body: isFund ? `Send SOL from your main wallet ${F.short(data.main.address)} to each selected wallet. You sign in your own wallet.` : `Move each wallet’s SOL (minus fees) back to your main wallet ${F.short(data.main.address)}.`, confirm: 'Review & sign', extra: `${isFund ? `<div class="field"><label class="label" for="fund-amt">Amount per wallet</label><div class="input-wrap"><input class="input mono" id="fund-amt" value="${amt}" inputmode="decimal"><div class="input-wrap__end"><span class="input-unit">SOL</span></div></div></div>` : ''}${fee('~0.000005 SOL × ' + ws.length)}<p class="seed-note">${I('shield')} Signed in your wallet. NECTRA never holds keys.</p>` });
      if (!ok) return;
      const per = isFund ? parseFloat((window._fa = ($('#fund-amt') || {}).value || amt)) : null;
      const items = [];
      for (const w of ws) {
        const from = isFund ? data.main.address : w.address, to = isFund ? w.address : data.main.address;
        const sol = isFund ? per : Math.max(0, w.sol - 0.000005);
        if (!sol) continue;
        try { items.push({ from, to, amount: sol, ...(await NX.wallet.transfer({ from, to, sol })) }); }
        catch (e) { NX.toast(e.message, { type: 'error' }); return; }
      }
      if (!items.length) return NX.toast('Nothing to move — balances are zero', { type: 'warn' });
      const r = await NX.act(null, () => NX.post('/api/transfers', { type, items }));
      if (r) NX.toast(`${type} submitted`, { type: 'info', msg: `${r.transactions.length} transaction(s)${r.transactions[0].simulated ? ' · simulated (demo mode)' : ' · confirming on-chain'}` });
    }
    $('#bulkbar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-bulk]'); if (!b) return;
      const ws = data.wallets.filter((w) => sel.has(w.id));
      if (b.dataset.bulk === 'fund') transfer('Fund', ws);
      if (b.dataset.bulk === 'sweep') transfer('Sweep', ws.filter((w) => w.source !== 'watch'));
      if (b.dataset.bulk === 'move') { const f = await pickFolder(); if (f && await NX.act(null, () => NX.post('/api/wallets/bulk-move', { ids: [...sel], folder: f }))) { NX.toast(`Moved ${ws.length} wallets to ${f}`); load(); } }
      if (b.dataset.bulk === 'clear') { sel.clear(); renderList(); }
    });
    async function generate() {
      try {
        const proof = await NX.wallet.generate();
        const r = await NX.post('/api/wallets', { ...proof, source: 'generated', folder: folder === 'All' ? 'Unsorted' : folder });
        NX.toast('New trading wallet created', { msg: `${r.wallet.name} · key stays in this browser` });
        load();
      } catch (e) { NX.toast(e.message, { type: 'error' }); }
    }
    $('#add-gen').addEventListener('click', generate);
    $('#add-connect').addEventListener('click', connect);
    $('#mw-connect').addEventListener('click', connect);
    $('#add-watch').addEventListener('click', () => NX.modal.open('watch-modal'));
    async function connect() {
      const proof = await NX.walletProof('link', 'Connect a wallet');
      if (!proof) return;
      const r = await NX.act(null, () => NX.post('/api/wallets', { ...proof, source: proof.provider === 'Demo wallet' ? 'demo' : 'connected' }));
      if (r) { NX.toast(`${proof.provider} connected`, { msg: r.wallet.kind === 'main' ? 'Set as your main wallet' : r.wallet.name }); load(); if (r.wallet.source !== 'watch') setTimeout(() => NX.walletBalances(r.wallet), 400); }
    }
    const wi = $('#watch-input'), wh = $('#watch-hint');
    wi.addEventListener('input', () => {
      const v = wi.value.trim(), ok = NX.isSol(v) || NX.isEvm(v);
      wi.classList.toggle('is-valid', ok); wi.classList.toggle('is-invalid', !!v && !ok);
      wh.className = 'hint ' + (v ? (ok ? 'hint--ok' : 'hint--error') : '');
      wh.innerHTML = !v ? 'Paste a public address. Watch-only wallets can’t trade.' : ok ? `${I('check', 'ic--sm')} Valid ${NX.isSol(v) ? 'Solana' : 'EVM'} address` : `${I('alert', 'ic--sm')} That doesn’t look like a public address`;
    });
    $('#watch-add').addEventListener('click', async (e) => {
      const v = wi.value.trim();
      if (!(NX.isSol(v) || NX.isEvm(v))) { wi.classList.add('is-invalid'); return; }
      const r = await NX.act(e.currentTarget, () => NX.post('/api/wallets', { source: 'watch', address: v, name: $('#watch-name').value, chain: NX.isSol(v) ? 'Solana' : 'Ethereum' }));
      if (r) { NX.modal.close('watch-modal'); NX.toast('Watch-only address added'); wi.value = ''; $('#watch-name').value = ''; load(); }
    });
    document.addEventListener('nx:tx', () => load());
    await load();
    if (location.hash === '#connect') setTimeout(connect, 300);
  };

  /* ======================================================================
     DEPOSIT
     ====================================================================== */
  P.deposit = async () => {
    const data = await NX.get('/api/deposit');
    const main = data.main;
    if (!main) {
      $('#main').querySelector('.grid').innerHTML = `<section class="card">${NX.empty('Connect a wallet first', 'Deposits go straight to your own main wallet — connect one to get its address.', '<a class="btn btn--primary" href="wallets.html#connect">Connect wallet</a>')}</section>`;
      return;
    }
    const TOK = { Solana: ['SOL', 'USDC', 'JUP', 'BONK'] };
    let token = 'SOL', txId = null;
    $('#dep-chain').innerHTML = '<button class="chip" data-c="Solana" aria-pressed="true">Solana</button><span class="caption" style="align-self:center">EVM deposits: connect an EVM wallet (coming soon)</span>';
    const render = () => {
      $('#dep-token').innerHTML = TOK.Solana.map((t) => `<button class="chip" aria-pressed="${t === token}" data-t="${t}">${D.token(t) ? NX.tokIcon(t, 'tok--sm') : ''}${t}</button>`).join('');
      $('#dep-addr').innerHTML = `<span class="mono" style="overflow-wrap:anywhere;font-size:14px">${main.address}</span>`;
      $('#dep-copy').dataset.copy = main.address;
      $('#dep-warning').innerHTML = `${I('alert')}<span><strong>Only send ${token} on the Solana network.</strong> Sending other assets or using another network may result in permanent loss.</span>`;
      $('#dep-token-label').textContent = token;
      NX.charts.qr($('#dep-qr'), main.address);
    };
    $('#dep-token').addEventListener('click', (e) => { const c = e.target.closest('[data-t]'); if (c) { token = c.dataset.t; render(); } });
    const setWait = (html, done) => { $('#dep-wait-text').innerHTML = html; $('#dep-wait').classList.toggle('is-done', !!done); };
    setWait(`<b>Waiting for deposit…</b><br><span class="caption">Send funds, then tap “Check for deposit”. We read your balance straight from Solana.</span>`);
    $('#dep-check').addEventListener('click', async (e) => {
      const r = await NX.act(e.currentTarget, () => NX.post(`/api/wallets/${main.id}/refresh`));
      if (!r) return;
      if (r.source !== 'rpc') { NX.toast('Demo wallet', { type: 'info', msg: 'Demo wallets have no on-chain balance — use “Simulate” instead.' }); return; }
      setWait(`<b>Balance: ${F.sol(r.wallet.sol)} SOL</b><br><span class="caption">If you just sent funds, check again in a few seconds.</span>`, r.wallet.sol > main.sol);
    });
    const sim = $('#dep-simulate');
    sim.hidden = !data.demo;
    sim.addEventListener('click', async () => {
      const r = await NX.act(sim, () => NX.post('/api/deposits/simulate', { amount: 0.001, token }));
      if (!r) return;
      txId = r.tx.id;
      $('#dep-conf').hidden = false;
      setWait(`<b>Deposit detected · 0.001 ${token}</b><br><span class="caption">Simulated (demo mode) — waiting for confirmations</span>`);
    });
    document.addEventListener('nx:tx', (e) => {
      const t = e.detail; if (t.id !== txId) return;
      $('#dep-conf-text').textContent = `${t.confirmations}/${t.required} confirmations`;
      $('#dep-conf-bar').style.width = (t.confirmations / t.required) * 100 + '%';
      if (t.status === 'confirmed') setWait(`<b>Deposit confirmed</b><br><span class="caption">0.001 ${token} is now in your main wallet.</span>`, true);
    });
    $('#dep-recent').innerHTML = data.recent.length ? data.recent.map((t) => `<div class="list-row"><span class="notif__ic">${I('deposit')}</span><div class="grow"><div class="small strong">${t.amount} ${t.token}</div><div class="caption">${F.date(new Date(t.date))} · ${t.status}${t.simulated ? ' · simulated' : ''}</div></div></div>`).join('') : '<p class="caption">No deposits yet.</p>';
    render();
  };

  /* ======================================================================
     WITHDRAW
     ====================================================================== */
  P.withdraw = async () => {
    const [wd, book] = await Promise.all([NX.get('/api/wallets'), NX.get('/api/address-book')]);
    const wallets = [wd.main].concat(wd.wallets).filter((w) => w && w.verified);
    const fromSel = $('#wd-from');
    fromSel.innerHTML = `<option value="account">NECTRA account balance — $${wd.accountBalance.toFixed(2)} USDC (paid out by our team)</option>` + wallets.map((w) => `<option value="${w.id}">${esc(w.name)} — ${F.sol(w.sol)} SOL (${F.short(w.address)})</option>`).join('');
    if (wallets.length) fromSel.value = wallets[0].id;
    const FEE = 0.000005;
    const to = $('#wd-to'), toHint = $('#wd-to-hint'), amt = $('#wd-amount'), range = $('#wd-range');
    const isAcct = () => fromSel.value === 'account';
    const cur = () => wallets.find((w) => String(w.id) === fromSel.value);
    const unit = () => (isAcct() ? 'USDC' : 'SOL');
    const max = () => (isAcct() ? wd.accountBalance : Math.max((cur() ? cur().sol : 0) - FEE, 0));
    const syncAvail = () => {
      $('#wd-avail').textContent = isAcct() ? '$' + wd.accountBalance.toFixed(2) : F.sol(cur() ? cur().sol : 0) + ' SOL';
      $$('.wd-unit').forEach((u) => (u.textContent = unit()));
      $('#wd-fee').innerHTML = isAcct() ? `${I('clock')} Processed manually by NECTRA <b>within 24h</b>` : `${I('fuel')} Network fee <b>0.000005 SOL</b>`;
      $('#wd-token').innerHTML = `<option>${isAcct() ? 'USDC — Solana (account payout)' : 'SOL — Solana'}</option>`;
      validate();
    };
    let whitelisted = false;
    const checkTo = () => {
      const v = to.value.trim(), ok = NX.isSol(v);
      const b = book.rows.find((x) => x.address === v);
      whitelisted = !!(b && b.whitelisted);
      to.classList.toggle('is-valid', ok); to.classList.toggle('is-invalid', !!v && !ok);
      toHint.className = 'hint ' + (v ? (ok ? 'hint--ok' : 'hint--error') : '');
      toHint.innerHTML = !v ? 'Solana address (base58, 32–44 characters)' : ok ? `${I('check', 'ic--sm')} Valid Solana address${b ? ' · ' + esc(b.label) : ''}${whitelisted ? (b.unlock_at > Date.now() ? ' · unlocks ' + new Date(b.unlock_at).toLocaleString() : ' · whitelisted') : book.whitelistOnly ? ' · NOT whitelisted (blocked)' : ''}` : v.startsWith('0x') ? `${I('alert', 'ic--sm')} This is an EVM address — it can’t receive SOL on Solana` : `${I('alert', 'ic--sm')} Invalid address format`;
      return ok;
    };
    const validate = () => {
      const a = parseFloat(amt.value) || 0;
      const okAmt = a > 0 && a <= max() + 1e-12;
      amt.classList.toggle('is-invalid', !!amt.value && !okAmt);
      $('#wd-amt-hint').className = 'hint ' + (amt.value && !okAmt ? 'hint--error' : '');
      $('#wd-amt-hint').textContent = amt.value && !okAmt ? (a > max() ? 'Amount exceeds available balance' : 'Enter an amount above 0') : isAcct() ? '' : '≈ ' + F.usd(a * D.solPrice, 2);
      $('#wd-continue').disabled = !(okAmt && NX.isSol(to.value.trim()));
      return okAmt;
    };
    to.addEventListener('input', () => { checkTo(); validate(); });
    amt.addEventListener('input', () => { const p = max() ? Math.min(100, ((parseFloat(amt.value) || 0) / max()) * 100) : 0; range.value = p; NX.syncRange(range); validate(); });
    const setPct = (p) => { amt.value = ((max() * p) / 100).toFixed(isAcct() ? 2 : 6).replace(/\.?0+$/, ''); range.value = p; NX.syncRange(range); $$('#wd-marks button').forEach((b) => b.classList.toggle('is-active', +b.dataset.p === p)); validate(); };
    range.addEventListener('input', () => setPct(+range.value));
    $('#wd-marks').addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) setPct(+b.dataset.p); });
    $('#wd-max').addEventListener('click', () => setPct(100));
    fromSel.addEventListener('change', () => { amt.value = ''; syncAvail(); });
    $('#wd-book-menu').innerHTML = (book.rows.length ? book.rows.map((b) => `<button class="menu__item" data-book="${b.address}">${I(b.whitelisted ? 'shield' : 'book')}<span class="grow"><span class="small">${esc(b.label)}</span><small class="mono">${F.short(b.address, 6)}</small></span>${b.whitelisted ? '<span class="tag tag--green">WL</span>' : ''}</button>`).join('') : '<p class="caption" style="padding:10px">No saved addresses yet.</p>') + `<div class="menu__sep"></div><a class="menu__item" href="settings.html#security">${I('settings')} Manage whitelist</a>`;
    $('#wd-book-menu').addEventListener('click', (e) => { const b = e.target.closest('[data-book]'); if (!b) return; to.value = b.dataset.book; checkTo(); validate(); $('#wd-book-menu').classList.remove('is-open'); });
    $('#wd-paste').addEventListener('click', async () => { try { to.value = (await navigator.clipboard.readText()).trim(); checkTo(); validate(); } catch (e) { to.focus(); NX.toast('Paste with Ctrl/⌘+V', { type: 'info' }); } });
    syncAvail();

    let req = null;
    const stepTo = (id, n, back) => { showStep(id, back); $$('#wd-steps span').forEach((s, i) => s.classList.toggle('is-done', i < n)); };
    $('#wd-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!checkTo() || !validate()) return;
      const a = parseFloat(amt.value);
      $('#wd-review-list').innerHTML = [
        ['From', isAcct() ? 'NECTRA account balance' : `${esc(cur().name)} <span class="mono faint">${F.short(cur().address)}</span>`],
        ['To', `<span class="mono">${esc(to.value.trim())}</span>`], ['Network', 'Solana'],
        ['Amount', `<span class="mono">${isAcct() ? a.toFixed(2) + ' USDC' : F.sol(a) + ' SOL'}</span>`],
        ['Fee', isAcct() ? 'None' : `<span class="mono">${FEE.toFixed(6)} SOL</span>`],
        ['Processing', isAcct() ? 'Reviewed & sent by the NECTRA team' : 'You sign in your wallet'],
        ['Whitelist', whitelisted ? '<span class="tag tag--green">Whitelisted</span>' : '<span class="tag tag--amber">Not whitelisted</span>']
      ].map(([k, v]) => `<div class="review__row"><span>${k}</span><span>${v}</span></div>`).join('') + `<div class="review__row review__row--total"><span>Total debited</span><span class="mono">${isAcct() ? '$' + a.toFixed(2) : (a + FEE).toFixed(6) + ' SOL'}</span></div>`;
      stepTo('wd-review', 1);
    });
    $('#wd-back').addEventListener('click', () => stepTo('wd-edit', 0, true));
    $('#wd-confirm').addEventListener('click', async (e) => {
      req = await NX.act(e.currentTarget, () => NX.post('/api/withdrawals', { source: isAcct() ? 'account' : 'wallet', walletId: isAcct() ? null : cur().id, to: to.value.trim(), amount: parseFloat(amt.value) }));
      if (!req) return;
      $('#wd-code-help').textContent = req.method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'We emailed you a 6-digit code (it shows your anti-phishing code).';
      NX.devHint(req, $('#wd-otp-status'));
      stepTo('wd-code', 2); otp.focus();
    });
    const otp = NX.otp($('#wd-otp'), {
      length: 6,
      onComplete: async (code) => {
        $('#wd-otp-status').innerHTML = '<span class="muted">Verifying…</span>';
        let v;
        try { v = await NX.post(`/api/withdrawals/${req.id}/verify`, { code }); }
        catch (e) { otp.invalid(); $('#wd-otp-status').innerHTML = `<span class="hint--error">${esc(e.message)}</span>`; return; }
        otp.valid();
        if (v.status === 'pending_admin') {
          $('#wd-success-title').textContent = 'Payout requested';
          $('#wd-success-amt').textContent = '$' + parseFloat(amt.value).toFixed(2);
          $('#wd-success-msg').textContent = 'Our team will send it within 24 hours. You’ll get a notification with the transaction reference.';
          $('#wd-sig-row').hidden = true; $('#wd-explorer').hidden = true;
          stepTo('wd-success', 4); return;
        }
        stepTo('wd-sign', 3);
        let signed;
        try { signed = await NX.wallet.transfer({ from: v.from, to: v.to, sol: v.amount }); }
        catch (e) { NX.toast(e.message, { type: 'error' }); stepTo('wd-review', 1, true); return; }
        const s = await NX.act(null, () => NX.post(`/api/withdrawals/${req.id}/submit`, signed));
        if (!s) return;
        $('#wd-sig').innerHTML = NX.addr(s.tx.sig);
        $('#wd-explorer').hidden = !s.tx.explorer; if (s.tx.explorer) $('#wd-explorer').href = s.tx.explorer;
        $('#wd-success-amt').textContent = F.sol(v.amount) + ' SOL';
        $('#wd-success-msg').textContent = s.tx.simulated ? 'Simulated in demo mode — no real funds moved.' : 'Confirming on Solana — you’ll be notified when it finalizes.';
        stepTo('wd-success', 4);
      }
    });
    showStep('wd-edit');
  };

  /* ======================================================================
     APPROVALS
     ====================================================================== */
  P.approvals = async () => {
    let rows = [], wallet = 'All';
    const load = async () => { rows = (await NX.get('/api/approvals')).rows; renderChips(); render(); };
    const wallets = () => ['All'].concat([...new Set(rows.map((a) => a.wallet_name || 'Main wallet'))]);
    const renderChips = () => ($('#ap-wallets').innerHTML = wallets().map((w) => `<button class="chip" aria-pressed="${w === wallet}" data-w="${esc(w)}">${esc(w)}<span class="chip__count">${w === 'All' ? rows.length : rows.filter((a) => a.wallet_name === w).length}</span></button>`).join(''));
    const risk = (a) => [a.verified ? `<span class="tag tag--green">${I('shield')} Verified</span>` : `<span class="tag tag--red">${I('shield-alert')} Unverified</span>`, a.unlimited ? `<span class="tag tag--amber">${I('alert')} Unlimited allowance</span>` : ''].join(' ');
    function render() {
      const v = rows.filter((a) => wallet === 'All' || a.wallet_name === wallet);
      $('#ap-body').innerHTML = v.length ? v.map((a) => `<tr><td data-label="Token"><div class="pair">${NX.tokIcon(a.token, 'tok--sm')}<span><b class="small">${a.token}</b><br><span class="caption">${esc(a.wallet_name)}</span></span></div></td>
        <td data-label="Spender"><div class="small strong">${esc(a.spender)}</div>${NX.addr(a.spender_address, 'addr--muted')}</td>
        <td data-label="Allowance" class="num small ${a.unlimited ? 'amber' : ''}">${a.unlimited ? 'Unlimited ' + a.token : (+a.amount).toLocaleString() + ' ' + a.token}</td>
        <td data-label="Risk"><div class="row" style="gap:6px">${risk(a)}</div></td>
        <td data-label="Last used" class="small muted">${a.last_used_at ? ago(a.last_used_at) : 'never'}</td>
        <td data-label="" class="r"><button class="btn btn--sm btn--danger-outline" data-revoke="${a.id}">${I('ban', 'ic--sm')} Revoke</button></td></tr>`).join('')
        : `<tr><td colspan="6">${NX.empty('No active approvals', 'No contract can move your tokens. Nice and tidy.')}</td></tr>`;
      $('#ap-count').textContent = rows.length; $('#ap-unl').textContent = rows.filter((a) => a.unlimited).length; $('#ap-unv').textContent = rows.filter((a) => !a.verified).length;
    }
    $('#ap-wallets').addEventListener('click', (e) => { const c = e.target.closest('[data-w]'); if (c) { wallet = c.dataset.w; renderChips(); render(); } });
    $('#ap-body').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-revoke]'); if (!b) return;
      const a = rows.find((x) => x.id === +b.dataset.revoke);
      const loanBound = /loan collection/i.test(a.spender);
      if (!await NX.confirm({ title: `Revoke ${a.token} approval?`, body: `${esc(a.spender)} will no longer be able to move ${a.token} from ${esc(a.wallet_name)}.${loanBound ? ' <b class="amber">This approval secures an open loan — revoking it is flagged to our team and may count against your credit score.</b>' : ''}`, confirm: 'Revoke', danger: true, extra: fee() })) return;
      const r = await NX.act(b, async () => {
        const plan = await NX.post(`/api/approvals/${a.id}/revoke-build`);
        let signature;
        if (plan.tx) signature = await NX.wallet.sendSolanaTx(plan.tx, a.owner);
        else if (plan.request) signature = await NX.wallet.sendEvmTx(plan.request, a.owner);
        return NX.post(`/api/approvals/${a.id}/revoke`, signature ? { signature } : {});
      });
      if (r) { b.closest('tr').classList.add('is-removing'); setTimeout(load, 340); NX.toast('Approval revoked', { msg: `${a.spender} · ${a.token}` }); }
    });
    const need = 25, amtI = $('#ar-amount'), unl = $('#ar-unlimited');
    const sync = () => {
      const u = unl.checked; amtI.disabled = u; $('#ar-unl-warn').hidden = !u;
      $('#ar-summary').innerHTML = u ? `Can move <b class="amber">any amount</b> of your USDC, now and in the future, until you revoke it.` : `Can move up to <b class="mono">${(parseFloat(amtI.value) || 0).toFixed(2)} USDC</b> from your main wallet. Nothing more.`;
      $('#ar-approve').className = 'btn ' + (u ? 'btn--danger' : 'btn--primary');
    };
    amtI.addEventListener('input', sync); unl.addEventListener('change', sync);
    $('#ar-exact').addEventListener('click', () => { amtI.value = need.toFixed(2); unl.checked = false; sync(); });
    $('#ar-contract').innerHTML = '<span class="mono small">Nectra DCA Executor</span>';
    $('#ap-review').addEventListener('click', () => { amtI.value = need.toFixed(2); unl.checked = false; sync(); NX.modal.open('approve-modal'); });
    $('#ar-approve').addEventListener('click', async (e) => {
      let onchain = false;
      const r = await NX.act(e.currentTarget, async () => {
        const body = { token: 'USDC', amount: parseFloat(amtI.value), unlimited: unl.checked, spender: 'Nectra DCA Executor' };
        const plan = await NX.post('/api/approvals/build', body);
        if (plan.tx) { body.signature = await NX.wallet.sendSolanaTx(plan.tx, plan.owner); body.spenderAddress = plan.spender; onchain = true; }
        return NX.post('/api/approvals', body);
      });
      if (!r) return;
      NX.modal.close('approve-modal');
      NX.toast('Approval granted', { msg: (onchain ? 'Signed in your wallet and recorded on-chain. ' : 'Simulated (demo wallet). ') + 'You can revoke it any time here.' });
      load();
    });
    await load();
  };

  /* ======================================================================
     LOANS v2 — credit score · wallet verification · collection approvals on
     every network · collateral escrow · instalments · on-chain repayments
     ====================================================================== */
  P.loans = async () => {
    let data, product = null, check = null, delegs = [];
    const tabs = $('#loan-tabs');
    const usd = (v) => F.usd(+v || 0, 2);
    async function load() {
      data = await NX.get('/api/loans');
      NX.countUp($('#loan-acct'), data.accountBalance, { dec: 2, prefix: '$' });
      const c = data.credit;
      NX.charts.ring($('#credit-ring'), (c.score - 300) / 550, { size: 96, stroke: 9, center: `<b class="mono">${c.score}</b><div class="tiny muted">${c.band}</div>`, color: c.score < 500 ? 'var(--red)' : c.score < 600 ? 'var(--amber)' : 'var(--green)' });
      $('#credit-text').innerHTML = `Your limits are <b>${Math.round(c.multiplier * 100)}%</b> of each product’s maximum. On-time repayments raise your score; late payments and defaults lower it.`;
      renderProducts(); renderMine();
    }
    function renderProducts() {
      $('#products').innerHTML = data.products.map((p) => `<article class="card card--hover stack">
        <div class="row between"><h3 class="card__title">${I(p.kind === 'collateral' ? 'lock' : 'landmark')} ${esc(p.name)}</h3><span class="tag tag--pink">${p.apr}% APR</span></div>
        <div class="review">
          <div class="review__row"><span>Your limit</span><span class="mono"><b>$${p.max_for_you.toLocaleString()}</b> <span class="faint">(min $${p.min_amount.toLocaleString()})</span></span></div>
          <div class="review__row"><span>Term</span><span>${p.term_days} days · ${p.instalments} instalment${p.instalments > 1 ? 's' : ''}</span></div>
          <div class="review__row"><span>Late fee</span><span>${p.late_fee_pct}% after ${p.grace_days}-day grace</span></div>
          ${p.kind === 'collateral' ? `<div class="review__row"><span>Collateral</span><span>${p.collateral_ratio}% in ${p.collateral_assets.join(' or ')}</span></div>`
            : `<div class="review__row"><span>Wallet balance <span class="help" tabindex="0" data-tip="Your verified wallet must hold at least this share of the requested amount.">?</span></span><span>${p.min_balance_pct}% of loan</span></div>
          <div class="review__row"><span>History</span><span>${p.min_tx_count}+ txs · ${p.min_wallet_age_days}+ days</span></div>`}
          <div class="review__row"><span>Collection approval</span><span>${p.require_delegation ? 'Required (USDC/USDT, capped at what you owe)' : 'Not required'}</span></div>
        </div>
        <button class="btn btn--accent" data-apply="${p.id}" ${p.max_for_you < p.min_amount ? 'disabled' : ''}>${p.max_for_you < p.min_amount ? 'Score too low for this product' : 'Check eligibility & apply'}</button></article>`).join('') || NX.empty('No loan products right now', 'Check back soon.');
      NX.hydrateIcons($('#products'));
    }
    const STATUS = { pending_review: ['tag--amber', 'Under review'], approved: ['tag--pink', 'Approved · funds on the way'], disbursed: ['tag--green', 'Active'], repaid: ['', 'Repaid'], rejected: ['tag--red', 'Declined'], cancelled: ['', 'Cancelled'], defaulted: ['tag--red', 'Defaulted'] };
    function repayAddresses() {
      const t = data.repaymentAddresses;
      const rows = [['Solana (USDC/USDT)', t.solana], ['EVM — Ethereum, Base, Arbitrum, BSC, Polygon (USDC/USDT)', t.evm], ['Tron (USDT TRC-20)', t.tron]].filter((x) => x[1]);
      return rows.length ? rows.map(([k, v]) => `<div class="review__row"><span class="small">${k}</span><span>${NX.addr(v)}</span></div>`).join('') : '<p class="caption">On-chain repayment addresses are not configured yet — repay from your account balance.</p>';
    }
    function renderMine() {
      const el = $('#my-loans');
      el.innerHTML = data.loans.length ? data.loans.map((l) => {
        const [cls, label] = STATUS[l.status] || ['', l.status];
        const pct = l.owed ? Math.min(100, (l.repaid / l.owed) * 100) : 0;
        const active = ['disbursed', 'defaulted'].includes(l.status);
        return `<div class="card stack-lg">
          <div class="row between"><div><div class="strong">${usd(l.amount)} ${l.asset} · ${esc(l.product)}</div><div class="caption">#${l.id} · ${l.apr}% APR · ${l.termDays} days · ${l.instalmentsCount} instalment${l.instalmentsCount > 1 ? 's' : ''}</div></div><span class="tag ${cls}">${label}${l.overdue ? ' · overdue' : ''}</span></div>
          ${l.note ? `<div class="note ${l.status === 'rejected' ? 'note--danger' : 'note--pink'}">${I('info')}<span><strong>NECTRA team:</strong> ${esc(l.note)}</span></div>` : ''}
          ${l.collateral ? `<div class="stack-sm"><div class="row between small"><span class="muted">Collateral (${l.collateral.asset})</span><span class="mono">${l.collateral.received} / ${l.collateral.required} ${l.collateral.asset}</span></div>
            ${l.collateral.status !== 'received' && ['pending_review', 'approved'].includes(l.status) ? `<div class="row" style="align-items:flex-start;gap:14px"><div class="qr" data-qr="${l.collateral.address}" style="width:132px;height:132px;padding:8px"></div><div class="stack-sm grow"><span class="caption">Send exactly <b class="mono">${l.collateral.required} ${l.collateral.asset}</b> to:</span>${NX.addr(l.collateral.address)}<span class="caption">Detected automatically. Returned after full repayment.</span></div></div>` : `<span class="tag tag--green">${I('check')} Collateral ${l.collateral.status}</span>`}</div>` : ''}
          ${l.instalments.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Due</th><th class="r">Amount</th><th class="r">Paid</th><th>Status</th></tr></thead><tbody>${l.instalments.map((i) => `<tr><td class="mono">${i.n}</td><td class="small">${new Date(i.due_at).toLocaleDateString()}</td><td class="r num">${usd(i.amount + i.late_fee)}${i.late_fee ? ` <span class="tag tag--red">+${usd(i.late_fee)} late</span>` : ''}</td><td class="r num">${usd(i.paid)}</td><td>${i.status === 'paid' ? '<span class="tag tag--green">Paid</span>' : i.due_at < Date.now() ? '<span class="tag tag--red">Overdue</span>' : '<span class="tag">Due</span>'}</td></tr>`).join('')}</tbody></table></div>
            <div class="stack-sm"><div class="row between small"><span class="muted">Repaid</span><span class="mono">${usd(l.repaid)} / ${usd(l.owed)}</span></div><div class="progress"><div class="progress__bar progress__bar--green" style="width:${pct}%"></div></div></div>` : ''}
          ${l.delegations.length ? `<details><summary class="small muted" style="cursor:pointer">Collection approvals (${l.delegations.length})</summary><div class="stack-sm mt-8">${l.delegations.map((d) => `<div class="row between small"><span>${d.token} on ${d.network} · <span class="mono">${F.short(d.owner)}</span></span><span class="tag ${d.status === 'confirmed' ? 'tag--green' : d.status === 'revoked' ? 'tag--red' : ''}">${d.status}${d.simulated ? ' · demo' : ''}</span></div>`).join('')}</div></details>` : ''}
          ${active ? `<div class="row"><button class="btn btn--primary grow" data-repay="${l.id}">Repay from account balance</button><button class="btn grow" data-repay-chain="${l.id}">Repay on-chain</button></div>` : ''}
          ${['pending_review', 'approved'].includes(l.status) ? `<button class="btn btn--danger-outline" data-cancel="${l.id}">Cancel application</button>` : ''}
        </div>`;
      }).join('') : NX.empty('No loans yet', 'Verify a wallet and apply — our team reviews every application.', '<button class="btn btn--primary" data-goapply>Apply for a loan</button>');
      NX.hydrateIcons(el);
      $$('[data-qr]', el).forEach((q2) => NX.charts.qr(q2, q2.dataset.qr));
    }
    $('#my-loans').addEventListener('click', async (e) => {
      if (e.target.closest('[data-goapply]')) return tabs._select($('[aria-controls="tab-apply"]', tabs));
      const rp = e.target.closest('[data-repay]');
      if (rp) {
        const l = data.loans.find((x) => x.id === +rp.dataset.repay);
        window._rpv = Math.min(l.outstanding, data.accountBalance).toFixed(2);
        const ok = await NX.confirm({ title: 'Repay from account balance', body: `Outstanding: ${usd(l.outstanding)}. Your account balance: ${usd(data.accountBalance)}.`, confirm: 'Repay', extra: `<div class="field"><label class="label" for="rp-amt">Amount</label><div class="input-wrap"><input class="input mono" id="rp-amt" value="${window._rpv}" inputmode="decimal"><div class="input-wrap__end"><span class="input-unit">USDC</span></div></div></div>` });
        if (!ok) return;
        const r = await NX.act(rp, () => NX.post(`/api/loans/${l.id}/repay`, { amount: parseFloat(window._rpv) }));
        if (r) { NX.toast('Repayment received', { msg: r.loan.status === 'repaid' ? 'Loan fully repaid 🌸' : `Outstanding ${usd(r.loan.outstanding)}` }); load(); }
      }
      const rc = e.target.closest('[data-repay-chain]');
      if (rc) {
        const l = data.loans.find((x) => x.id === +rc.dataset.repayChain);
        NX.confirm({ title: 'Repay on-chain', body: `Send USDC or USDT <b>from your verified loan wallet</b> <span class="mono">${F.short(l.wallet)}</span> to an address below. Payments are detected automatically within a minute and applied to your oldest instalment.`, confirm: 'Done', extra: `<div class="review">${repayAddresses()}</div><p class="seed-note">${I('shield')} Only send from a wallet linked to your account, or we can’t match the payment.</p>` });
        setTimeout(() => NX.hydrateIcons(), 50);
      }
      const cc = e.target.closest('[data-cancel]');
      if (cc && await NX.confirm({ title: 'Cancel application?', body: 'You can apply again later.', confirm: 'Cancel application', danger: true })) { if (await NX.act(cc, () => NX.post(`/api/loans/${cc.dataset.cancel}/cancel`))) load(); }
    });
    document.addEventListener('input', (e) => { if (e.target.id === 'rp-amt') window._rpv = e.target.value; });

    /* ---- application wizard ---- */
    const amtI = $('#la-amount'), amtR = $('#la-range');
    const gauge = NX.charts.gauge($('#elig-gauge'), { value: 0, text: '—', label: 'Eligibility' });
    const goStep = (n, back) => { $$('#lw-steps span').forEach((s, i) => s.classList.toggle('is-done', i < n)); showStep('lw-' + n, back); };
    const owedFor = (a) => a * (1 + product.apr / 100 * product.term_days / 365);
    function startApply(id) {
      product = data.products.find((p) => p.id === +id) || data.products.find((p) => p.max_for_you >= p.min_amount) || data.products[0];
      if (!product) return;
      check = null; delegs = [];
      $('#la-product').innerHTML = data.products.map((p) => `<option value="${p.id}" ${p.id === product.id ? 'selected' : ''}>${esc(p.name)} — ${p.apr}% APR, ${p.term_days}d, up to $${p.max_for_you.toLocaleString()}</option>`).join('');
      const max = Math.max(product.min_amount, product.max_for_you);
      amtR.min = product.min_amount; amtR.max = max; amtR.step = Math.max(1, Math.round((max - product.min_amount) / 100));
      amtI.value = product.min_amount; amtR.value = product.min_amount; NX.syncRange(amtR);
      $('#la-collateral').hidden = product.kind !== 'collateral';
      $('#la-collateral').innerHTML = product.kind === 'collateral' ? `<label class="label">Collateral asset</label><div class="chips" id="la-col">${product.collateral_assets.map((a, i) => `<button class="chip" data-col="${a}" aria-pressed="${i === 0}">${NX.tokIcon(a, 'tok--sm')}${a}</button>`).join('')}</div><span class="hint" id="la-col-hint"></span>` : '';
      calc(); renderCriteria(); gauge.set(0, '—', 'var(--border-strong)');
      $('#la-verify-status').innerHTML = ''; $('#la-next2').disabled = true;
      goStep(1);
    }
    const colAsset = () => { const c = $('#la-col [aria-pressed="true"]'); return c ? c.dataset.col : null; };
    function calc() {
      const a = parseFloat(amtI.value) || 0;
      const owed = owedFor(a), per = owed / product.instalments;
      const rows = [['Interest', `${product.apr}% APR (simple)`], ['Term', `${product.term_days} days`], ['Repayments', `${product.instalments} × <b class="mono">${usd(per)}</b> (every ${Math.round(product.term_days / product.instalments)} days)`], ['Total to repay', `<b class="mono">${usd(owed)}</b>`], ['Late fee', `${product.late_fee_pct}% of the overdue instalment after ${product.grace_days} days`]];
      if (product.kind === 'collateral' && colAsset()) { const px = data.prices[colAsset()]; rows.push(['Collateral', `<b class="mono">${((a * product.collateral_ratio / 100) / px).toFixed(6)} ${colAsset()}</b> (${product.collateral_ratio}% of the loan)`]); }
      else rows.push(['Wallet needs', `≥ ${usd(a * product.min_balance_pct / 100)} · ${product.min_tx_count}+ txs · ${product.min_wallet_age_days}+ days`]);
      $('#la-terms').innerHTML = rows.map(([k, v]) => `<div class="review__row"><span>${k}</span><span>${v}</span></div>`).join('');
      const ok = a >= product.min_amount && a <= Math.max(product.min_amount, product.max_for_you);
      amtI.classList.toggle('is-invalid', !ok);
      $('#la-amt-hint').textContent = ok ? `Your limit: $${product.max_for_you.toLocaleString()} (credit score ${data.credit.score})` : `Choose between $${product.min_amount} and $${product.max_for_you}`;
      $('#la-next').disabled = !ok;
    }
    function renderCriteria(results) {
      const def = [{ label: 'Wallet ownership (signature)', pass: null }, { label: 'Balance & history criteria', pass: null }, { label: 'No defaulted loans', pass: null }];
      $('#criteria').innerHTML = (results || def).map((r) => `<div class="checklist__item ${r.pass ? 'is-done' : ''}"><span class="checklist__mark" style="${r.pass === false ? 'border-color:var(--red);background:var(--red-tint);color:var(--red)' : ''}">${I(r.pass === false ? 'x' : r.pass === null && results ? 'clock' : 'check')}</span><span class="grow small">${esc(r.label)}${r.value != null ? `<br><span class="caption mono">${esc(r.value)}</span>` : ''}</span></div>`).join('');
      if (results) $$('#criteria .checklist__mark .ic').forEach((ic, i) => { if (results[i].pass !== true) { ic.style.opacity = 1; ic.style.transform = 'none'; } });
    }
    $('#la-product').addEventListener('change', (e) => startApply(e.target.value));
    amtI.addEventListener('input', () => { amtR.value = amtI.value; NX.syncRange(amtR); calc(); });
    amtR.addEventListener('input', () => { amtI.value = amtR.value; calc(); });
    $('#la-collateral').addEventListener('click', (e) => { const c = e.target.closest('[data-col]'); if (!c) return; $$('#la-col .chip').forEach((x) => x.setAttribute('aria-pressed', x === c)); calc(); });
    $('#la-next').addEventListener('click', () => goStep(2));
    $$('[data-lw-back]').forEach((b) => b.addEventListener('click', () => goStep(+b.dataset.lwBack, true)));

    $('#la-verify').addEventListener('click', async () => {
      const proof = await NX.walletProof('loan', 'Verify your DeFi wallet');
      if (!proof) return;
      $('#la-verify-status').innerHTML = `<div class="connecting" style="padding:8px 0"><div class="orbit" style="width:64px;height:64px">${NX.logo(28, 'logo--spin')}</div><div class="caption">Reading balance & transaction history from the ${proof.family === 'evm' ? 'EVM networks' : proof.family === 'tron' ? 'Tron network' : 'Solana network'}…</div></div>`;
      const r = await NX.act(null, () => NX.post('/api/loans/check', { productId: product.id, amount: parseFloat(amtI.value), nonce: proof.nonce, signature: proof.signature, provider: proof.provider }));
      if (!r) { $('#la-verify-status').innerHTML = ''; return; }
      check = r; delegs = r.delegations || [];
      renderCriteria(r.results);
      const passed = r.results.filter((x) => x.pass).length;
      gauge.set(passed / r.results.length, `${passed}/${r.results.length}`, r.eligible ? 'var(--green)' : passed >= 2 ? 'var(--amber)' : 'var(--red)');
      $('#la-verify-status').innerHTML = `<div class="note ${r.eligible ? 'note--ok' : 'note--danger'}">${I(r.eligible ? 'check' : 'alert')}<span>${r.eligible ? `<strong>You meet the criteria.</strong> ${NX.familyTag(r.family)} wallet ${F.short(r.address)} verified. Credit score ${r.credit.score} (${r.credit.band}).` : '<strong>Not eligible yet.</strong> Try a smaller amount, another wallet, or a product with lower requirements.'} ${/simulated/.test(r.snapshot.source) ? '<span class="tag tag--amber">Simulated data (demo)</span>' : '<span class="tag tag--green">Live on-chain data</span>'}</span></div>`;
      NX.hydrateIcons($('#la-verify-status'));
      $('#la-next2').disabled = !r.eligible;
    });
    $('#la-next2').addEventListener('click', () => { renderDelegations(); goStep(3); });

    /* step 3: collection approvals on every wallet/network that holds stablecoins */
    function renderDelegations() {
      const box = $('#la-deleg');
      if (!check.delegationsRequired) { box.innerHTML = `<div class="note note--ok">${I('check')}<span>This product doesn’t require a collection approval.</span></div>`; $('#la-next3').disabled = false; return; }
      const owed = usd(check.owed);
      box.innerHTML = `<div class="note note--warn">${I('alert')}<span><strong>Collection approval.</strong> You’ll approve NECTRA to collect up to <b>${owed}</b> (what you’ll owe) from each wallet below <b>only if you default</b>. Every collection needs two NECTRA admins to sign off and is shown in your history. You keep full control of your funds otherwise.</span></div>
        <div class="stack" id="deleg-list">${delegs.length ? delegs.map((d, i) => `<div class="option-card" style="cursor:default" data-d="${i}">${NX.tokIcon(d.token, 'tok--sm')}<span class="grow"><b class="small">${d.token} on ${d.network}</b><br><span class="caption mono">${F.short(d.owner)}${d.balance != null ? ` · balance ${(+d.balance).toFixed(2)}` : ''}</span></span><span data-dstate="${i}">${d.status === 'confirmed' ? '<span class="tag tag--green">Approved</span>' : `<button class="btn btn--sm btn--accent" data-approve="${i}">${d.demo ? 'Approve (demo)' : 'Approve in wallet'}</button>`}</span></div>`).join('')
          : `<div class="note">${I('info')}<span>No signable stablecoin wallet found. Connect your loan wallet’s network and try again.</span></div>`}</div>
        <p class="caption">BTC and LTC can’t grant approvals — for those, use the collateral loan product. Native coins (SOL, ETH, TRX) can’t be approved either; approvals cover USDC/USDT.</p>`;
      NX.hydrateIcons(box);
      syncDeleg();
    }
    const syncDeleg = () => { $('#la-next3').disabled = !delegs.length || !delegs.every((d) => d.status === 'confirmed'); };
    $('#la-deleg').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-approve]'); if (!b) return;
      const d = delegs[+b.dataset.approve];
      const r = await NX.act(b, async () => {
        const req = await NX.post('/api/loans/delegations/request', { checkId: check.checkId, owner: d.owner, network: d.network, token: d.token });
        const txId = req.simulated ? null : await NX.signApproval({ ...req, owner: d.owner });
        return NX.post('/api/loans/delegations/confirm', { checkId: check.checkId, owner: d.owner, network: d.network, token: d.token, tx: txId });
      });
      if (!r) return;
      d.status = r.status;
      $(`[data-dstate="${b.dataset.approve}"]`).innerHTML = r.status === 'confirmed' ? '<span class="tag tag--green">Approved</span>' : `<span class="tag tag--amber">Waiting for confirmation…</span> <button class="btn btn--sm" data-approve="${b.dataset.approve}">Check again</button>`;
      NX.toast(r.status === 'confirmed' ? 'Approval confirmed on-chain' : 'Approval sent — waiting for the network', { type: r.status === 'confirmed' ? 'success' : 'info' });
      syncDeleg();
    });
    $('#la-next3').addEventListener('click', () => {
      $('#la-review').innerHTML = [['Product', esc(check.product.name)], ['Amount', `<b class="mono">${usd(check.amount)} ${check.product.asset}</b>`], ['APR', check.product.apr + '% (simple interest)'], ['Repayments', `${check.product.instalments} instalment${check.product.instalments > 1 ? 's' : ''} over ${check.product.term_days} days`], ['Total to repay', `<b class="mono">${usd(check.owed)}</b>`], ['Verified wallet', `<span class="mono">${F.short(check.address, 6)}</span>`],
        ['Collection approvals', check.delegationsRequired ? `${delegs.length} signed (capped at ${usd(check.owed)} each)` : 'Not required'], ...(product.kind === 'collateral' ? [['Collateral', `${colAsset()} — deposit address shown after you submit`]] : []), ['Funds go to', 'Your NECTRA account balance or your verified wallet, after approval']].map(([k, v]) => `<div class="review__row"><span>${k}</span><span>${v}</span></div>`).join('');
      goStep(4);
    });
    $('#la-submit').addEventListener('click', async (e) => {
      if (!$('#la-accept').checked) { NX.toast('Please accept the loan terms, including the collection approval', { type: 'warn' }); return; }
      const r = await NX.act(e.currentTarget, () => NX.post('/api/loans', { checkId: check.checkId, accept: true, purpose: $('#la-purpose').value, collateralAsset: colAsset() }));
      if (!r) return;
      $('#lw-done-extra').innerHTML = r.loan.collateral ? `<div class="note note--pink mt-16">${I('lock')}<span>Send <b class="mono">${r.loan.collateral.required} ${r.loan.collateral.asset}</b> to <span class="mono">${r.loan.collateral.address}</span>. We’ll detect it automatically; review starts once it confirms.</span></div>` : '';
      NX.hydrateIcons($('#lw-done-extra'));
      goStep(5);
      load();
    });
    $('#lw-view').addEventListener('click', () => tabs._select($('[aria-controls="tab-mine"]', tabs)));
    $('#products').addEventListener('click', (e) => { const b = e.target.closest('[data-apply]'); if (!b) return; tabs._select($('[aria-controls="tab-apply"]', tabs)); startApply(b.dataset.apply); });
    tabs.addEventListener('nx:tab', (e) => { if (e.detail.tab.getAttribute('aria-controls') === 'tab-apply' && !product) startApply(); });
    document.addEventListener('nx:notification', () => load());
    await load();
    if (location.hash === '#apply') { tabs._select($('[aria-controls="tab-apply"]', tabs)); startApply(); }
    if (location.hash === '#mine') tabs._select($('[aria-controls="tab-mine"]', tabs));
  };

  /* ======================================================================
     PORTFOLIO & HISTORY
     ====================================================================== */
  P.portfolio = async () => {
    const tb = $('#tok-body');
    async function loadTokens() {
      const r = await NX.get('/api/portfolio');
      NX.countUp($('#pf-value'), r.value);
      tb.innerHTML = r.tokens.map((t) => `<tr><td data-label="Token"><div class="pair">${NX.tokIcon(t.sym)}<span><b class="small">${t.sym}</b><br><span class="caption">${t.name}</span></span></div></td>
        <td data-label="Price" class="r num" data-px="${t.sym}">${F.usd(t.price)}</td>
        <td data-label="24h" class="r num ${t.ch >= 0 ? 'up' : 'down'}" data-ch="${t.sym}">${F.pct(t.ch)}</td>
        <td data-label="Holdings" class="r num">${t.hold >= 1e6 ? F.compact(t.hold) : F.num(t.hold, t.sym === 'USDC' ? 2 : 4)}</td>
        <td data-label="Value" class="r num">${F.usd(t.value, 2)}</td>
        <td data-label="" class="r"><button class="icon-btn icon-btn--sm" data-alert="${t.sym}" aria-label="Price alert for ${t.sym}" data-tip="Price alert" data-tip-pos="left">${I('bell-plus')}</button></td></tr>`).join('') || `<tr><td colspan="6">${NX.empty('No holdings', 'Your paper account is empty.')}</td></tr>`;
    }
    tb.addEventListener('click', (e) => { const b = e.target.closest('[data-alert]'); if (b) NX.priceAlert(b.dataset.alert); });
    async function loadAlerts() {
      const r = await NX.get('/api/alerts');
      $('#alerts-list').innerHTML = r.rows.length ? r.rows.map((a) => `<div class="list-row">${NX.tokIcon(a.token, 'tok--sm')}<div class="grow"><div class="small strong">${a.token} ${a.direction} $${a.price}</div><div class="caption">${a.active ? 'Active' : 'Triggered ' + (a.triggered_at ? ago(a.triggered_at) : '')}${a.email ? ' · email' : ''}</div></div><button class="icon-btn icon-btn--sm" data-del-alert="${a.id}" aria-label="Delete alert">${I('trash')}</button></div>`).join('') : '<p class="caption">No alerts yet — tap the bell on any token.</p>';
    }
    $('#alerts-list').addEventListener('click', async (e) => { const b = e.target.closest('[data-del-alert]'); if (b && await NX.act(null, () => NX.del('/api/alerts/' + b.dataset.delAlert))) loadAlerts(); });
    document.addEventListener('nx:alerts', loadAlerts);
    document.addEventListener('nx:refresh', loadTokens);
    const cal = await NX.get('/api/portfolio/calendar');
    const days = cal.days.map((d) => ({ date: new Date(d.date), v: d.v }));
    NX.whenVisible($('#pnl-cal'), (el) => NX.charts.calendar(el, days));
    $('#cal-summary').textContent = `${days.filter((d) => d.v > 0).length} green days · ${days.filter((d) => d.v < 0).length} red days · net ${F.signed(days.reduce((a, d) => a + d.v, 0))}`;

    let type = 'All', q = '', range = 30, tmr;
    const types = ['All', 'Deposit', 'Withdraw', 'Fund', 'Sweep', 'Swap', 'Bot trade', 'Approval', 'Loan'];
    $('#hist-type').innerHTML = types.map((t) => `<button class="chip" aria-pressed="${t === type}" data-t="${t}">${t}</button>`).join('');
    const qs = () => `type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&days=${range}`;
    async function render() {
      const r = await NX.get('/api/history?' + qs());
      $('#hist-body').innerHTML = r.rows.length ? r.rows.slice(0, 100).map((h) => `<tr><td data-label="Date" class="small">${F.date(new Date(h.date))} <span class="faint mono tiny">${F.time(new Date(h.date))}</span></td><td data-label="Type"><span class="tag">${h.type}</span></td><td data-label="Asset" class="small">${esc(h.token)}</td><td data-label="Amount" class="r num">${h.type === 'Withdraw' ? '−' : ''}${h.amount}</td>
        <td data-label="Status">${h.status === 'confirmed' ? `<span class="tag tag--green">${I('check')} Confirmed</span>` : h.status === 'confirming' ? `<span class="tag tag--amber">Confirming</span>` : `<span class="tag tag--red">${I('x')} ${esc(h.status)}</span>`}${h.simulated && h.type !== 'Bot trade' ? ' <span class="tag">sim</span>' : ''}</td>
        <td data-label="Details" class="r small muted">${h.sig ? (h.explorer ? `<a class="link mono" href="${h.explorer}" target="_blank" rel="noopener">${F.short(h.sig)}</a>` : `<span class="mono">${F.short(h.sig)}</span>`) : esc(h.note || '')}</td></tr>`).join('')
        : `<tr><td colspan="6">${NX.empty('Nothing here yet', 'No transactions match these filters.', '<button class="btn" data-reset>Reset filters</button>')}</td></tr>`;
      $('#hist-count').textContent = r.rows.length;
    }
    $('#hist-type').addEventListener('click', (e) => { const c = e.target.closest('[data-t]'); if (!c) return; type = c.dataset.t; $$('#hist-type .chip').forEach((x) => x.setAttribute('aria-pressed', x === c)); render(); });
    $('#hist-search').addEventListener('input', (e) => { q = e.target.value; clearTimeout(tmr); tmr = setTimeout(render, 250); });
    $('#hist-range').addEventListener('change', (e) => { range = +e.target.value; render(); });
    $('#hist-body').addEventListener('click', (e) => { if (e.target.closest('[data-reset]')) { type = 'All'; q = ''; range = 365; $('#hist-search').value = ''; $('#hist-range').value = '365'; $$('#hist-type .chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.t === 'All')); render(); } });
    $('#export-btn').addEventListener('click', () => { location.href = '/api/history.csv?' + qs(); NX.toast('CSV export started'); });
    await Promise.all([loadTokens(), loadAlerts(), render()]);
    const tokQ = new URLSearchParams(location.search).get('token');
    if (tokQ && D.token(tokQ)) setTimeout(() => NX.priceAlert(tokQ), 300);
    if (location.hash === '#export' || location.hash === '#history') $('#history').scrollIntoView();
  };

  /* ======================================================================
     REFERRALS
     ====================================================================== */
  P.referrals = async () => {
    async function load() {
      const r = await NX.get('/api/referrals');
      $('#ref-codes').innerHTML = r.codes.length ? r.codes.map((c) => `<div class="list-row"><span class="tok" style="background:var(--pink-tint);color:var(--pink)">${I('gift', 'ic--sm')}</span><div class="grow"><div class="mono strong">${c.code}</div><div class="caption">Created ${F.date(new Date(c.created_at))}${c.active ? '' : ' · disabled'}</div></div><div style="min-width:110px" class="hide-mobile"><div class="caption mono">${c.uses}/${c.max_uses} used</div><div class="progress"><div class="progress__bar" style="width:${(c.uses / c.max_uses) * 100}%"></div></div></div><span class="mono small hide-desktop">${c.uses}/${c.max_uses}</span>${NX.copyBtn(location.origin + '/register.html?code=' + c.code, 'Invite link copied')}</div>`).join('') : '<p class="caption">No codes yet — generate one.</p>';
      $('#ref-total').textContent = r.total;
      $('#tiers').innerHTML = r.tiers.map((t) => `<div class="tier ${t.current ? 'is-current' : t.reached ? '' : 'is-locked'}"><span class="tok" style="background:${{ Bronze: '#8B5A3C', Silver: '#9AA0AA', Gold: '#D9A93A', Petal: 'var(--pink)' }[t.name]}">${t.name[0]}</span><div class="grow"><b class="small">${t.name}</b><div class="caption">${t.at} invite${t.at > 1 ? 's' : ''} · ${t.perk} fee discount</div></div>${t.current ? '<span class="tag tag--pink">Current</span>' : t.reached ? I('check', 'up') : I('lock', 'faint')}</div>`).join('');
      const nx = r.next;
      NX.charts.ring($('#ref-ring'), nx ? r.total / nx.at : 1, { size: 168, stroke: 12, center: `<div class="mono" style="font-size:30px;font-weight:600">${r.total}<span class="muted" style="font-size:16px">/${nx ? nx.at : r.total}</span></div><div class="caption">${nx ? 'to ' + nx.name : 'Top tier!'}</div>` });
      NX.hydrateIcons();
    }
    $('#gen-code').addEventListener('click', async (e) => { const r = await NX.act(e.currentTarget, () => NX.post('/api/referrals/codes')); if (r) { NX.toast('New invite code', { msg: r.code }); load(); } });
    await load();
  };

  /* ======================================================================
     PLANS / SUBSCRIPTION
     ====================================================================== */
  P.plans = async () => {
    const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const money0 = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    let methods = [], billing = 'monthly';
    // applicable interval for a plan given the chosen billing (annual only if the plan has an annual price)
    const planInterval = (p) => (billing === 'yearly' && p.price_yearly > 0 ? 'yearly' : 'monthly');
    async function load() {
      const r = await NX.get('/api/plans');
      if (r.enabled === false) {
        const bt = $('#pl-billing'); if (bt) bt.hidden = true;
        const cc = $('#pl-current-card'); if (cc) cc.hidden = true;
        $('#pl-balance').textContent = money(r.balance);
        $('#pl-grid').innerHTML = NX.empty('Plans aren’t available', 'Subscription plans are turned off on this platform right now. All features are available to everyone.');
        NX.hydrateIcons();
        return;
      }
      methods = r.methods || methods;
      $('#pl-balance').textContent = money(r.balance);
      const curId = r.current ? r.current.planId : null;
      const curInterval = r.current ? r.current.interval : null;
      const freeId = (r.plans.find((p) => p.price_usd === 0) || {}).id;
      const onFree = !r.current || r.current.price === 0;
      $('#pl-grid').innerHTML = r.plans.map((p) => {
        const iv = planInterval(p);
        const yearly = iv === 'yearly';
        const isCurrent = (p.id === curId && (p.price_usd === 0 || curInterval === iv)) || (onFree && p.id === freeId);
        const sameplanOtherIv = p.id === curId && !isCurrent;
        const popular = p.slug === 'pro';
        const feats = (p.perks.features && p.perks.features.length ? p.perks.features : [`${p.perks.maxBots} bots`, `Up to ${money(p.perks.maxBudget)} per bot`]).map((f) => `<li>${I('check', 'ic--sm')}<span>${esc(f)}</span></li>`).join('');
        const annualSave = p.price_usd > 0 && p.price_yearly > 0 ? p.price_usd * 12 - p.price_yearly : 0;
        let priceHtml;
        if (p.price_usd === 0) priceHtml = 'Free';
        else if (yearly) priceHtml = `${money(p.price_yearly)}<span>/yr</span>${annualSave > 0 ? `<span class="plan-save">Save ${money0(annualSave)} vs monthly</span>` : ''}`;
        else priceHtml = `${money(p.price_usd)}<span>/mo</span>${billing === 'yearly' ? '<span class="plan-save" style="color:var(--text-faint)">Monthly only</span>' : ''}`;
        let btn;
        if (isCurrent) btn = `<button class="btn" disabled>Current plan</button>`;
        else if (p.price_usd === 0) btn = `<button class="btn btn--ghost" data-sub="${p.id}" data-name="${esc(p.name)}" data-price="0" data-interval="monthly">Switch to Free</button>`;
        else btn = `<button class="btn btn--primary" data-sub="${p.id}" data-name="${esc(p.name)}" data-price="${p.price_usd}" data-interval="${iv}">${sameplanOtherIv ? (yearly ? 'Switch to annual' : 'Switch to monthly') : 'Choose ' + esc(p.name)}</button>`;
        return `<div class="plan-card ${isCurrent ? 'is-current' : ''} ${popular ? 'is-popular' : ''}">${popular ? '<span class="plan-card__ribbon">Popular</span>' : ''}${isCurrent ? '<span class="plan-card__ribbon">Your plan</span>' : ''}
          <h3>${esc(p.name)}</h3><div class="plan-tag">${esc(p.tagline || '')}</div>
          <div class="plan-price">${priceHtml}</div>
          <ul class="plan-feats">${feats}</ul>${btn}</div>`;
      }).join('');
      const card = $('#pl-current-card'), box = $('#pl-current');
      if (r.current && r.current.price > 0) {
        card.hidden = false;
        box.innerHTML = `<div class="row between wrap" style="gap:12px">
          <div><b>${esc(r.current.planName)}</b> · <span class="tag ${r.current.status === 'active' ? 'tag--green' : 'tag--pink'}">${r.current.status}</span>
            <div class="caption mt-4">${money(r.current.price)}/${r.current.interval === 'yearly' ? 'yr' : 'mo'} · ${r.current.autoRenew && r.current.status === 'active' ? 'Renews' : 'Access until'} ${r.current.renewsAt ? F.date(new Date(r.current.renewsAt)) : '—'}</div></div>
          ${r.current.status === 'active' ? `<button class="btn btn--sm btn--ghost" id="pl-cancel">Cancel subscription</button>` : ''}</div>`;
        const cx = $('#pl-cancel');
        if (cx) cx.addEventListener('click', async () => {
          if (!(await NX.confirm({ title: 'Cancel subscription?', body: 'You’ll keep your current perks until the period ends, then move to the Free plan. No refund for the current period.', confirm: 'Cancel subscription', danger: true }))) return;
          await NX.act(cx, () => NX.post('/api/subscription/cancel')); NX.toast('Subscription cancelled'); load();
        });
      } else { card.hidden = true; }
      NX.hydrateIcons();
    }
    const bill = $('#pl-billing');
    if (bill) bill.addEventListener('click', (e) => { const b = e.target.closest('[data-bill]'); if (!b || b.dataset.bill === billing) return; billing = b.dataset.bill; bill.querySelectorAll('[data-bill]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.bill === billing)); load(); });

    $('#pl-grid').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sub]'); if (!b) return;
      const price = +b.dataset.price, planId = b.dataset.sub, name = b.dataset.name, interval = b.dataset.interval;
      if (price === 0) {
        if (!(await NX.confirm({ title: 'Switch to Free?', body: 'You’ll move to the Free plan. Any paid perks end immediately.', confirm: 'Switch to Free' }))) return;
        const r = await NX.act(b, () => NX.post(`/api/plans/${planId}/subscribe`, { interval: 'monthly' }));
        if (r) { NX.toast('Now on Free'); load(); document.dispatchEvent(new CustomEvent('nx:refresh')); }
        return;
      }
      openCheckout(planId, name, interval);
    });

    async function openCheckout(planId, name, interval) {
      let qt; try { qt = await NX.get(`/api/plans/${planId}/quote?interval=${interval}`); } catch (x) { NX.toast(x.message || 'Could not price this plan', { type: 'error' }); return; }
      const per = qt.interval === 'yearly' ? 'year' : 'month';
      const d = document.createElement('dialog'); d.className = 'modal';
      const mBtns = methods.map((m) => `<button class="list-row card--hover" data-m="${m.id}" style="width:100%;text-align:left;cursor:pointer"><span class="tok" style="background:var(--pink-tint);color:var(--pink)">${I(m.id === 'balance' ? 'wallet' : m.id === 'onchain' ? 'deposit' : 'sparkles', 'ic--sm')}</span><div class="grow"><b class="small">${esc(m.label)}</b><div class="caption">${esc(m.note)}</div></div>${I('arrow-right', 'ic--sm')}</button>`).join('');
      const creditLine = qt.credit > 0 ? `<div class="note note--pink small">${I('check')}<span>Includes a <b>${money(qt.credit)}</b> credit for the unused time on your current plan — you pay <b>${money(qt.charge)}</b> now.</span></div>` : '';
      d.innerHTML = `<div class="modal__head"><h2 class="modal__title">Subscribe to ${esc(name)}</h2><button class="icon-btn icon-btn--sm" data-x aria-label="Close">${I('x')}</button></div>
        <div class="modal__body"><p class="muted small">${money(qt.price)}/${per}${qt.credit > 0 ? ` · you pay ${money(qt.charge)} today` : ''}. Plans unlock features — they don’t guarantee any profit.</p>${creditLine}<div class="stack" id="co-methods" style="gap:8px">${mBtns}</div><div id="co-stage"></div></div>`;
      document.body.appendChild(d);
      NX.hydrateIcons(d); NX.modal.open(d);
      const close = () => { NX.modal.close(d); setTimeout(() => d.remove(), 260); };
      let poll;
      d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) { clearInterval(poll); close(); } });
      d.addEventListener('cancel', (e) => { e.preventDefault(); clearInterval(poll); close(); });
      const stage = d.querySelector('#co-stage'); const methodsBox = d.querySelector('#co-methods');
      const done = () => { clearInterval(poll); close(); NX.toast(`Subscribed to ${name}`); load(); document.dispatchEvent(new CustomEvent('nx:refresh')); };
      const pollPayment = (id) => { poll = setInterval(async () => { try { const s = await NX.get('/api/payments/' + id); if (s.payment.status === 'confirmed') done(); else if (s.payment.status !== 'pending') { clearInterval(poll); stage.innerHTML = `<p class="note note--danger small">${I('alert')} Payment ${esc(s.payment.status)}. Please try again.</p>`; } } catch (x) { /* keep trying */ } }, 3500); };
      methodsBox.addEventListener('click', async (e) => {
        const mb = e.target.closest('[data-m]'); if (!mb) return;
        const method = mb.dataset.m;
        methodsBox.style.display = 'none';
        stage.innerHTML = `<p class="muted small"><span class="thinking"><span class="thinking__petals"><i></i><i></i><i></i></span> Setting up…</span></p>`;
        let r; try { r = await NX.post(`/api/plans/${planId}/checkout`, { method, interval }); } catch (x) { stage.innerHTML = `<p class="note note--danger small">${I('alert')} ${esc(x.message)}</p>`; NX.hydrateIcons(stage); methodsBox.style.display = ''; return; }
        if (r.done) return done();
        if (method === 'nowpayments') {
          if (r.invoiceUrl) { window.open(r.invoiceUrl, '_blank', 'noopener'); stage.innerHTML = `<p class="small">A crypto checkout opened in a new tab (ref <b class="mono">${esc(r.reference || '')}</b>). This updates automatically once your payment confirms.</p>`; pollPayment(r.paymentId); }
          else { stage.innerHTML = `<p class="small">Demo mode — no live gateway configured. Simulate a confirmed crypto payment of <b>${money(r.amount)}</b>:</p><button class="btn btn--primary btn--sm" id="co-sim">${I('check', 'ic--sm')} Simulate payment</button>`; NX.hydrateIcons(stage); stage.querySelector('#co-sim').addEventListener('click', async (ev) => { const s = await NX.act(ev.currentTarget, () => NX.post(`/api/payments/${r.paymentId}/simulate`)); if (s) done(); }); }
        } else if (method === 'onchain') {
          stage.innerHTML = `<div class="stack"><p class="small">Send exactly <b class="mono">${money(r.amount)}</b> <b>${esc(r.token)}</b> on <b>${esc(r.network)}</b> from a <b>verified wallet</b> to:</p>
            <div class="list-row"><code class="mono small grow" style="word-break:break-all">${esc(r.address)}</code>${NX.copyBtn(r.address, 'Address copied')}</div>
            <div id="co-qr" style="margin:6px auto"></div>
            <p class="caption">Reference ${esc(r.reference)}. We detect the transfer automatically and activate your plan — this can take a minute.</p>
            ${r.simulated ? `<button class="btn btn--primary btn--sm" id="co-sim">${I('check', 'ic--sm')} Simulate payment (demo)</button>` : ''}</div>`;
          NX.hydrateIcons(stage);
          try { if (NX.charts && NX.charts.qr) NX.charts.qr(stage.querySelector('#co-qr'), r.address); } catch (x) {}
          const sim = stage.querySelector('#co-sim'); if (sim) sim.addEventListener('click', async (ev) => { const s = await NX.act(ev.currentTarget, () => NX.post(`/api/payments/${r.paymentId}/simulate`)); if (s) done(); });
          pollPayment(r.paymentId);
        }
      });
    }
    await load();
  };

  /* ======================================================================
     NOTIFICATIONS
     ====================================================================== */
  P.notifications = async () => {
    let f = 'all', rows = [];
    const ICON = { security: ['shield-alert', 'var(--red)'], bot: ['bot', 'var(--pink)'], price: ['bell', 'var(--amber)'], transfer: ['deposit', 'var(--green)'] };
    const tabs = [['all', 'All'], ['price', 'Price alerts'], ['bot', 'Bot events'], ['transfer', 'Money & loans'], ['security', 'Security']];
    const load = async () => { rows = (await NX.get('/api/notifications')).rows; renderChips(); render(); };
    const renderChips = () => ($('#notif-filter').innerHTML = tabs.map(([k, l]) => `<button class="chip" aria-pressed="${k === f}" data-f="${k}">${l}<span class="chip__count">${rows.filter((n) => (k === 'all' || n.type === k) && n.unread).length}</span></button>`).join(''));
    function render() {
      const rs = rows.filter((n) => f === 'all' || n.type === f);
      $('#notif-list').innerHTML = rs.length ? rs.map((n) => `<div class="notif ${n.unread ? 'is-unread' : ''}" data-id="${n.id}"><span class="notif__ic" style="color:${(ICON[n.type] || ICON.bot)[1]}">${I((ICON[n.type] || ICON.bot)[0])}</span><div class="grow"><div class="row between"><span class="notif__title">${esc(n.title)}</span><span class="caption">${ago(n.created_at)}</span></div><p class="notif__body">${esc(n.body)}</p>${n.link ? `<a class="link small" href="${esc(n.link)}">Open →</a>` : ''}</div></div>`).join('')
        : NX.empty('You’re all caught up', 'No notifications in this category yet.', '<a class="btn btn--accent" href="portfolio.html">Set a price alert</a>');
      D.unread = rows.filter((n) => n.unread).length;
      $$('[data-unread]').forEach((b) => { b.textContent = D.unread; b.hidden = !D.unread; });
    }
    $('#notif-filter').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (c) { f = c.dataset.f; renderChips(); render(); } });
    $('#notif-list').addEventListener('click', async (e) => {
      const r = e.target.closest('.notif'); if (!r) return;
      const n = rows.find((x) => x.id === +r.dataset.id);
      if (n.unread) { n.unread = 0; NX.post(`/api/notifications/${n.id}/read`).catch(() => {}); renderChips(); render(); }
    });
    $('#mark-all').addEventListener('click', async (e) => { if (await NX.act(e.currentTarget, () => NX.post('/api/notifications/read-all'))) { NX.toast('All marked as read'); load(); } });
    document.addEventListener('nx:notification', load);
    await load();
  };

  /* ======================================================================
     SETTINGS & SECURITY
     ====================================================================== */
  P.settings = async () => {
    const nav = $('#set-nav');
    const hash = location.hash.slice(1);
    if (hash) { const t = $(`[aria-controls="set-${hash}"]`, nav); t && nav._select(t); }
    nav.addEventListener('nx:tab', (e) => history.replaceState(null, '', '#' + e.detail.tab.getAttribute('aria-controls').slice(4)));
    let u = D.user;

    // identity / KYC (manual government-ID upload → admin approval)
    (async function kycInit() {
      const tabBtn = $('[aria-controls="set-kyc"]', nav);
      const badge = $('#kyc-badge'), view = $('#kyc-view'), form = $('#kyc-form');
      const TAG = { none: ['', 'Not started'], submitted: ['tag--amber', 'Under review'], verified: ['tag--green', 'Verified'], rejected: ['tag--red', 'Needs attention'] };
      let docs = { front: null, back: null };   // downscaled data URLs
      // downscale an image file to a JPEG data URL (keeps uploads small)
      const toDataUrl = (file) => new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        if (!/^image\//.test(file.type)) return reject(new Error('Please choose an image file'));
        const img = new Image(), fr = new FileReader();
        fr.onload = () => { img.onload = () => { const max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); resolve(cv.toDataURL('image/jpeg', 0.82)); }; img.onerror = () => reject(new Error('Could not read that image')); img.src = fr.result; };
        fr.onerror = () => reject(new Error('Could not read that file')); fr.readAsDataURL(file);
      });
      const render = (k) => {
        if (k.enabled === false) { if (tabBtn) tabBtn.hidden = true; const sec = $('#set-kyc'); if (sec) sec.hidden = true; return; }
        const [cls, label] = TAG[k.status] || TAG.none;
        badge.innerHTML = `<span class="tag ${cls}">${label}</span>`;
        if (k.status === 'verified') { view.innerHTML = `<div class="note note--pink">${I('check')}<span>Your identity is verified${k.fields ? ' — ' + esc(k.fields.fullName) + ' · ' + esc(k.fields.country) : ''}. You can apply for loans.</span></div>`; form.hidden = true; NX.hydrateIcons(view); return; }
        if (k.status === 'submitted') { view.innerHTML = `<div class="note">${I('clock')}<span>Your ID is under review. We’ll notify you when it’s done.</span></div>`; form.hidden = true; NX.hydrateIcons(view); return; }
        view.innerHTML = k.status === 'rejected' ? `<div class="note note--danger">${I('alert')}<span>Your previous submission wasn’t approved${k.note ? ': ' + esc(k.note) : ''}. Please check your details, re-upload your ID and resubmit.</span></div>` : '';
        form.hidden = false; NX.hydrateIcons(view);
      };
      try { const r = await NX.get('/api/compliance'); render(r.kyc); } catch (e) {}
      const wireFile = (inputId, prevId, key) => { const inp = $('#' + inputId), prev = $('#' + prevId); if (!inp) return; inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; if (!f) { docs[key] = null; prev.hidden = true; return; } try { docs[key] = await toDataUrl(f); prev.innerHTML = `<img alt="ID preview" src="${docs[key]}">`; prev.hidden = false; } catch (x) { NX.toast(x.message, { type: 'error' }); inp.value = ''; } }); };
      wireFile('kyc-front', 'kyc-front-prev', 'front'); wireFile('kyc-back', 'kyc-back-prev', 'back');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!docs.front) { NX.toast('Please upload a photo of your government ID (front)', { type: 'error' }); return; }
        const body = { fullName: $('#kyc-name').value, country: $('#kyc-country').value, dob: $('#kyc-dob').value, idType: $('#kyc-idtype').value, idNumber: $('#kyc-idnum').value, address: $('#kyc-address').value, idFront: docs.front, idBack: docs.back };
        const r = await NX.act($('#kyc-submit'), () => NX.post('/api/kyc', body));
        if (r) { NX.toast('ID submitted for review'); $('#kyc-idnum').value = ''; docs = { front: null, back: null }; $('#kyc-front').value = ''; $('#kyc-back').value = ''; $('#kyc-front-prev').hidden = true; $('#kyc-back-prev').hidden = true; render(r.kyc); }
      });
    })();

    // profile
    $('#pf-name').value = u.name; $('#pf-email').value = u.email || '';
    $('#pf-avatar').textContent = u.initials; $('#pf-display').textContent = u.name;
    $('#pf-sub').textContent = (u.role === 'admin' ? 'Administrator · ' : '') + 'Member since ' + new Date(u.createdAt).toLocaleDateString();
    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await NX.act($('#profile-form .btn--primary'), () => NX.patch('/api/me/profile', { name: $('#pf-name').value, email: $('#pf-email').value }));
      if (!r) return;
      D.user = u = r.user;
      NX.toast('Profile saved', { msg: r.reverify ? 'Check your new email for a verification code.' : '' });
      if (r.reverify) { NX.devHint(r); setTimeout(() => go('register.html#verify'), 1500); }
    });
    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await NX.act($('#pw-form .btn'), () => NX.post('/api/me/password', { current: $('#pw-cur').value, password: $('#pw-new').value }));
      if (r) { NX.toast('Password changed', { msg: 'Other sessions were signed out.' }); e.target.reset(); }
    });

    // 2FA
    const tfaState = () => {
      $('#tfa-state').innerHTML = u.twoFA ? `<span class="tag tag--green">${I('check')} Enabled</span>` : `<span class="tag tag--amber">${I('alert')} Off</span>`;
      $('#tfa-btn').textContent = u.twoFA ? 'Disable' : 'Set up 2FA';
      $('#tfa-btn').className = 'btn ' + (u.twoFA ? 'btn--danger-outline' : 'btn--primary');
    };
    tfaState();
    const otp = NX.otp($('#tfa-otp2'), {
      length: 6,
      onComplete: async (code) => {
        try { await NX.post('/api/me/2fa/enable', { code }); }
        catch (e) { otp.invalid(); $('#tfa-err').textContent = e.message; return; }
        otp.valid(); u.twoFA = true; tfaState();
        setTimeout(() => { NX.modal.close('tfa-modal'); NX.toast('Two-factor authentication enabled'); }, 600);
      }
    });
    $('#tfa-btn').addEventListener('click', async () => {
      if (u.twoFA) {
        let code = '';
        const ok = await NX.confirm({ title: 'Disable 2FA?', body: 'Enter a code from your authenticator app to confirm. Withdrawals and sign-ins will be less protected.', confirm: 'Disable', danger: true, extra: '<input class="input mono" id="tfa-off" inputmode="numeric" maxlength="6" placeholder="123456" aria-label="Authenticator code">' });
        code = ($('#tfa-off') || {}).value || window._tfaoff || '';
        if (ok && await NX.act(null, () => NX.post('/api/me/2fa/disable', { code }))) { u.twoFA = false; tfaState(); NX.toast('2FA disabled', { type: 'warn' }); }
        return;
      }
      const s = await NX.act(null, () => NX.post('/api/me/2fa/setup'));
      if (!s) return;
      NX.charts.qr($('#tfa-qr'), s.otpauth);
      $('#tfa-secret').textContent = s.secret.replace(/(.{4})/g, '$1 ').trim();
      $('#tfa-copy').dataset.copy = s.secret;
      $('#tfa-err').textContent = '';
      NX.modal.open('tfa-modal'); setTimeout(() => otp.clear(), 100);
    });
    document.addEventListener('input', (e) => { if (e.target.id === 'tfa-off') window._tfaoff = e.target.value; if (e.target.id === 'phish-in') window._phish = e.target.value; });

    // anti-phishing
    $('#phish-code').textContent = u.antiPhishing;
    $('#phish-edit').addEventListener('click', async () => {
      window._phish = u.antiPhishing;
      const ok = await NX.confirm({ title: 'Change anti-phishing code', body: 'This code appears in every email we send. If an email doesn’t show it, it isn’t from us.', confirm: 'Save', extra: `<input class="input mono" id="phish-in" maxlength="16" value="${esc(u.antiPhishing)}" aria-label="Anti-phishing code">` });
      if (!ok) return;
      const r = await NX.act(null, () => NX.patch('/api/me/anti-phishing', { code: window._phish }));
      if (r) { u.antiPhishing = r.code; $('#phish-code').textContent = r.code; NX.toast('Anti-phishing code updated'); }
    });

    // sessions
    const ua = (s) => { const b = /Edg/.test(s) ? 'Edge' : /Chrome/.test(s) ? 'Chrome' : /Firefox/.test(s) ? 'Firefox' : /Safari/.test(s) ? 'Safari' : 'Browser'; const o = /Windows/.test(s) ? 'Windows' : /Mac/.test(s) ? 'macOS' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Linux/.test(s) ? 'Linux' : ''; return `${b}${o ? ' · ' + o : ''}`; };
    async function loadSessions() {
      const r = await NX.get('/api/me/sessions');
      $('#sessions').innerHTML = r.rows.map((s) => `<div class="list-row"><span class="notif__ic">${I(/Mobile|iPhone|Android/.test(s.user_agent || '') ? 'smartphone' : 'monitor')}</span><div class="grow"><div class="small strong">${esc(ua(s.user_agent || ''))} ${s.current ? '<span class="tag tag--green">This device</span>' : ''}</div><div class="caption">${esc(s.ip || '')} · active ${ago(s.last_seen_at)}</div></div>${s.current ? '' : `<button class="btn btn--sm btn--danger-outline" data-sess="${s.id}">Revoke</button>`}</div>`).join('');
    }
    $('#sessions').addEventListener('click', async (e) => { const b = e.target.closest('[data-sess]'); if (b && await NX.confirm({ title: 'Revoke session?', body: 'That device will be signed out immediately.', confirm: 'Revoke', danger: true })) { if (await NX.act(b, () => NX.del('/api/me/sessions/' + b.dataset.sess))) { NX.toast('Session revoked'); loadSessions(); } } });
    $('#revoke-all').addEventListener('click', async () => { if (await NX.confirm({ title: 'Sign out all other sessions?', body: 'Every device except this one will be signed out.', confirm: 'Sign out others', danger: true })) { const r = await NX.act(null, () => NX.post('/api/me/sessions/revoke-others')); if (r) { NX.toast(`${r.revoked} session(s) signed out`); loadSessions(); } } });

    // whitelist
    async function loadWl() {
      const r = await NX.get('/api/address-book');
      $('#wl-only').checked = r.whitelistOnly;
      $('#whitelist').innerHTML = r.rows.length ? r.rows.map((b) => `<div class="list-row"><span class="notif__ic">${I(b.whitelisted ? 'shield' : 'book')}</span><div class="grow"><div class="small strong">${esc(b.label)} ${b.unlock_at > Date.now() ? `<span class="tag tag--amber">Unlocks ${new Date(b.unlock_at).toLocaleString()}</span>` : '<span class="tag tag--green">Whitelisted</span>'}</div>${NX.addr(b.address, 'addr--muted')}</div><button class="icon-btn icon-btn--sm" data-wl="${b.id}" aria-label="Remove ${esc(b.label)}">${I('trash')}</button></div>`).join('') : '<p class="caption">No saved addresses.</p>';
    }
    $('#whitelist').addEventListener('click', async (e) => { const b = e.target.closest('[data-wl]'); if (b && await NX.act(null, () => NX.del('/api/address-book/' + b.dataset.wl))) { NX.toast('Address removed'); loadWl(); } });
    $('#wl-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = $('#wl-addr');
      if (!NX.isSol(a.value.trim())) { a.classList.add('is-invalid'); $('#wl-hint').hidden = false; return; }
      a.classList.remove('is-invalid'); $('#wl-hint').hidden = true;
      const r = await NX.act($('#wl-form .btn'), () => NX.post('/api/address-book', { label: $('#wl-label').value, address: a.value.trim() }));
      if (r) { e.target.reset(); NX.toast('Address whitelisted', { msg: 'Withdrawals to it unlock after the security hold.' }); loadWl(); }
    });
    $('#wl-only').addEventListener('change', async (e) => { const r = await NX.act(null, () => NX.patch('/api/me/whitelist-only', { on: e.target.checked })); if (r) NX.toast(r.on ? 'Whitelist-only withdrawals on' : 'Whitelist-only withdrawals off', { type: r.on ? 'success' : 'warn' }); else e.target.checked = !e.target.checked; });

    // risk
    const risk = u.risk || {};
    $('#risk-loss').value = risk.maxDailyLoss || 5; $('#risk-pos').value = risk.maxPosition || 12500; $('#risk-bots').value = risk.maxBots || 6;
    $('#risk-live').checked = risk.requireLiveConfirm !== false;
    $('#risk-guard').innerHTML = risk.guardDropPct ? `Portfolio guard active: pause all bots at <b>−${risk.guardDropPct}%</b> from the 24h high. <button class="link" id="guard-off" type="button">Remove</button>` : 'No portfolio guard. Ask the Copilot: “Stop all bots if portfolio drops 10%”.';
    const link = (r, o, f) => { const s = () => { o.textContent = f(+r.value); NX.syncRange(r); }; r.addEventListener('input', s); s(); };
    link($('#risk-loss'), $('#risk-loss-v'), (v) => v + '%');
    link($('#risk-pos'), $('#risk-pos-v'), (v) => '$' + v.toLocaleString());
    link($('#risk-bots'), $('#risk-bots-v'), (v) => v);
    const saveRisk = async (extra = {}) => NX.act($('#risk-save'), () => NX.patch('/api/me/risk', { maxDailyLoss: +$('#risk-loss').value, maxPosition: +$('#risk-pos').value, maxBots: +$('#risk-bots').value, requireLiveConfirm: $('#risk-live').checked, ...extra }));
    $('#risk-save').addEventListener('click', async () => { const r = await saveRisk(); if (r) { u.risk = r.risk; NX.toast('Risk limits saved', { msg: 'Enforced by the engine immediately.' }); } });
    $('#risk-guard').addEventListener('click', async (e) => { if (e.target.id === 'guard-off') { const r = await saveRisk({ guardDropPct: null }); if (r) { u.risk = r.risk; $('#risk-guard').textContent = 'Portfolio guard removed.'; } } });

    // prefs
    const prefs = u.prefs || {};
    const th = document.documentElement.dataset.theme || 'dark';
    $$('[data-theme-set]').forEach((b) => { b.setAttribute('aria-pressed', b.dataset.themeSet === th); b.addEventListener('click', () => { NX.setTheme(b.dataset.themeSet); NX.patch('/api/me/prefs', { theme: b.dataset.themeSet }).catch(() => {}); $$('[data-theme-set]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }); });
    $$('#ccy .chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.ccy === (prefs.ccy || 'USD')));
    $('#ccy').addEventListener('click', async (e) => { const c = e.target.closest('[data-ccy]'); if (!c) return; $$('#ccy .chip').forEach((x) => x.setAttribute('aria-pressed', x === c)); if (await NX.act(null, () => NX.patch('/api/me/prefs', { ccy: c.dataset.ccy }))) NX.toast('Display currency: ' + c.dataset.ccy); });
    if (prefs.lang) $('#lang').value = prefs.lang;
    $('#lang').addEventListener('change', (e) => NX.act(null, () => NX.patch('/api/me/prefs', { lang: e.target.value })).then((r) => r && NX.toast('Language saved')));
    $('#pref-email').checked = prefs.emailNotif !== false; $('#pref-push').checked = prefs.pushNotif !== false;
    $('#pref-email').addEventListener('change', (e) => NX.patch('/api/me/prefs', { emailNotif: e.target.checked }));
    $('#pref-push').addEventListener('change', (e) => NX.patch('/api/me/prefs', { pushNotif: e.target.checked }));
    const pushUi = async () => {
      const st = await NX.pwa.pushState().catch(() => 'unsupported');
      $('#push-state').innerHTML = { on: '<span class="tag tag--green">On</span>', off: '<span class="tag">Off</span>', denied: '<span class="tag tag--red">Blocked</span>', unsupported: '<span class="tag">Not supported</span>' }[st];
      $('#push-btn').textContent = st === 'on' ? 'Disable' : 'Enable';
      $('#push-btn').disabled = st === 'unsupported' || st === 'denied';
      $('#push-btn').dataset.st = st;
    };
    $('#push-btn').addEventListener('click', async (e) => {
      const on = e.currentTarget.dataset.st === 'on';
      const r = await NX.act(e.currentTarget, () => (on ? NX.pwa.disablePush() : NX.pwa.enablePush()).then(() => true));
      if (r) NX.toast(on ? 'Push notifications off on this device' : 'Push notifications on — check for a test alert');
      pushUi();
    });
    pushUi();
    await Promise.all([loadSessions(), loadWl()]);
  };

  /* ======================================================================
     SYSTEM STATUS
     ====================================================================== */
  P.status = async () => {
    const render = (st) => {
      const lab = { green: 'Operational', amber: 'Degraded', red: 'Outage' };
      $('#status-head').innerHTML = `<span class="dot dot--${st.level} dot--pulse" style="width:12px;height:12px"></span><div><div class="strong">${st.label}</div><div class="caption">Live — updates instantly when our team changes a component</div></div>`;
      $('#status-list').innerHTML = st.components.map((c, k) => {
        const r = NX.util.rng(k + 50);
        const bars = Array.from({ length: 60 }, (_, i) => { const x = r(); const cls = i === 59 && c.state !== 'green' ? 'is-' + c.state : x > 0.99 ? 'is-amber' : ''; return `<span class="${cls}"></span>`; }).join('');
        return `<div class="card stack"><div class="row between"><div class="row-nw"><span class="dot dot--${c.state}"></span><b class="small">${esc(c.name)}</b></div><span class="tag ${c.state === 'green' ? 'tag--green' : c.state === 'amber' ? 'tag--amber' : 'tag--red'}">${lab[c.state]}</span></div>${c.note ? `<p class="caption">${esc(c.note)}</p>` : ''}<div class="uptime" aria-label="60-day uptime">${bars}</div><div class="row between tiny faint"><span>60 days ago</span><span>Today</span></div></div>`;
      }).join('');
    };
    render(D.status);
    document.addEventListener('nx:status', (e) => render(e.detail));
  };
})();

/* Boot after all modules are loaded */
document.addEventListener('DOMContentLoaded', () => window.NX.boot());
