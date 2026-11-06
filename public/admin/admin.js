/* ==========================================================================
   NECTRA Admin console — hash-routed single page on top of /api/admin/*
   ========================================================================== */
(function () {
  'use strict';
  const NX = window.NX, $ = NX.$, $$ = NX.$$, I = NX.icon, F = NX.fmt;
  const esc = (s) => NX.esc(s == null ? '' : s);
  const when = (t) => (t ? new Date(t).toLocaleString() : '—');
  const ago = (t) => { if (!t) return '—'; const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
  const main = () => $('#main');
  const usd = (v) => F.usd(+v || 0, 2);
  const tag = (cls, txt) => `<span class="tag ${cls}">${txt}</span>`;
  const LOAN_TAG = { pending_review: ['tag--amber', 'Pending review'], approved: ['tag--pink', 'Approved · fund it'], disbursed: ['tag--green', 'Active'], repaid: ['', 'Repaid'], rejected: ['tag--red', 'Rejected'], cancelled: ['', 'Cancelled'], defaulted: ['tag--red', 'Defaulted'] };
  const loanTag = (l) => { const [c, t] = LOAN_TAG[l.status] || ['', l.status]; return tag(c, t + (l.overdue ? ' · overdue' : '')); };

  const SECTIONS = [
    { id: 'overview', label: 'Overview', icon: 'dashboard' },
    { id: 'actions', label: 'Approvals queue', icon: 'users', badge: 'pendingActions' },
    { g: 'Lending' },
    { id: 'loans', label: 'Loan applications', icon: 'landmark', badge: 'pendingLoans' },
    { id: 'loanbook', label: 'Loan book', icon: 'bar-chart', badge: 'overdueLoans' },
    { id: 'treasury', label: 'Treasury & keys', icon: 'lock' },
    { id: 'products', label: 'Loan products', icon: 'layers' },
    { id: 'payouts', label: 'Payouts', icon: 'withdraw', badge: 'pendingPayouts' },
    { id: 'ledger', label: 'Account ledger', icon: 'book' },
    { g: 'People' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'kyc', label: 'KYC review', icon: 'shield', badge: 'pendingKyc' },
    { id: 'invites', label: 'Invites', icon: 'gift' },
    { id: 'waitlist', label: 'Waitlist', icon: 'clock', badge: 'waitlist' },
    { g: 'Trading' },
    { id: 'bots', label: 'Bots', icon: 'bot' },
    { id: 'transactions', label: 'Transactions', icon: 'swap' },
    { id: 'plans', label: 'Plans & subscriptions', icon: 'sparkles' },
    { g: 'Platform' },
    { id: 'broadcast', label: 'Broadcast', icon: 'bell' },
    { id: 'status', label: 'System status', icon: 'activity' },
    { id: 'mailbox', label: 'Mailbox', icon: 'mail' },
    { id: 'audit', label: 'Audit log', icon: 'shield' },
    { id: 'settings', label: 'Settings', icon: 'settings' }
  ];
  let counts = {};

  /* ---------------- generic dialogs ---------------- */
  /** Form dialog → resolves with values or null */
  function formDialog({ title, intro = '', fields, confirm = 'Save', danger = false, wide = false }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'modal' + (wide ? ' modal--lg' : '');
      const field = (f) => {
        const id = 'fd-' + f.name;
        if (f.type === 'checkbox') return `<label class="switch"><input type="checkbox" name="${f.name}" id="${id}" ${f.value ? 'checked' : ''}><span class="switch__track"></span><span class="small">${f.label}</span></label>`;
        if (f.type === 'select') return `<div class="field"><label class="label" for="${id}">${f.label}</label><select class="select" name="${f.name}" id="${id}">${f.options.map((o) => `<option value="${esc(o[0])}" ${String(o[0]) === String(f.value) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</div>`;
        if (f.type === 'textarea') return `<div class="field"><label class="label" for="${id}">${f.label}</label><textarea class="textarea" name="${f.name}" id="${id}" maxlength="${f.max || 500}">${esc(f.value || '')}</textarea></div>`;
        return `<div class="field"><label class="label" for="${id}">${f.label}</label><input class="input ${f.mono ? 'mono' : ''}" name="${f.name}" id="${id}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.ph || '')}" ${f.required ? 'required' : ''}>${f.hint ? `<span class="hint">${f.hint}</span>` : ''}</div>`;
      };
      d.innerHTML = `<form method="dialog" novalidate style="display:contents"><div class="modal__head"><h2 class="modal__title">${title}</h2><button type="button" class="icon-btn icon-btn--sm" data-x aria-label="Close">${I('x')}</button></div>
        <div class="modal__body">${intro ? `<p class="small muted">${intro}</p>` : ''}<div class="form-grid ${fields.length > 3 ? 'form-grid--2' : ''}">${fields.map(field).join('')}</div></div>
        <div class="modal__foot"><button type="button" class="btn" data-x>Cancel</button><button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}">${confirm}</button></div></form>`;
      document.body.appendChild(d);
      let done = false;
      const finish = (v) => { if (done) return; done = true; NX.modal.close(d); setTimeout(() => d.remove(), 260); resolve(v); };
      d.addEventListener('click', (e) => { if (e.target.closest('[data-x]') || e.target === d) finish(null); });
      d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
      d.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const out = {};
        fields.forEach((f) => { const el = d.querySelector(`[name="${f.name}"]`); out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? null : +el.value) : el.value; });
        const miss = fields.find((f) => f.required && (out[f.name] === '' || out[f.name] == null));
        if (miss) { d.querySelector(`[name="${miss.name}"]`).classList.add('is-invalid'); return; }
        finish(out);
      });
      NX.modal.open(d);
      setTimeout(() => { const f = d.querySelector('input,select,textarea'); f && f.focus(); }, 60);
    });
  }
  /** Read-only wide panel */
  function panel(title, html) {
    const d = document.createElement('dialog');
    d.className = 'modal modal--lg';
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${title}</h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${I('x')}</button></div><div class="modal__body">${html}</div>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => setTimeout(() => d.remove(), 300));
    NX.modal.open(d);
    return d;
  }
  const table = (cols, rows, opts = {}) => `<div class="table-wrap"><table class="table table--stack ${opts.clickable ? 'clickable' : ''}"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr ${opts.rowAttr ? opts.rowAttr(r) : ''}>${cols.map((c) => `<td data-label="${c.h}" class="${c.r ? 'r' : ''} ${c.cls || ''}">${c.v(r)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}">${NX.empty(opts.emptyTitle || 'Nothing here', opts.emptyText || 'No records yet.')}</td></tr>`}</tbody></table></div>`;
  const card = (title, body, actions = '') => `<section class="card"><div class="card__head"><h2 class="card__title">${title}</h2><div class="row" style="gap:8px">${actions}</div></div>${body}</section>`;
  const mono = (s, n = 4) => (s ? `<span class="mono small" title="${esc(s)}">${esc(F.short(String(s), n))}</span>` : '—');
  const userCell = (r) => `<a class="link small" href="#users/${r.userId || r.user_id}">${esc(r.email || 'User #' + (r.userId || r.user_id))}</a>`;
  const act = (btn, fn, ok) => NX.act(btn, fn).then((r) => { if (r) { if (r.pending) NX.toast('Waiting for a second admin', { type: 'info', msg: 'It’s in the Approvals queue.' }); else if (ok) NX.toast(ok); refreshCounts(); route(); } return r; });

  /* ---------------- views ---------------- */
  const V = {};

  V.overview = async () => {
    const o = await NX.get('/api/admin/overview');
    const k = (label, value, icon, href, cls = '') => `<a class="card card--hover" href="${href || '#overview'}"><div class="kpi"><span class="kpi__label">${I(icon, 'ic--sm')} ${label}</span><span class="kpi__value ${cls}">${value}</span></div></a>`;
    main().innerHTML = `
      <div class="kpis stagger mb-16">
        ${k('Users', o.users.toLocaleString(), 'users', '#users')}
        ${k('Active today', o.activeToday, 'activity', '#users')}
        ${k('Online now', o.online, 'zap', '#users')}
        ${k('Bots running', `${o.botsRunning} / ${o.botsTotal}`, 'bot', '#bots')}
        ${k('Paper volume 24h', usd(o.volume24h), 'bar-chart', '#transactions')}
        ${k('Loans to review', o.pendingLoans, 'landmark', '#loans', o.pendingLoans ? 'amber' : '')}
        ${k('Approved · unfunded', o.approvedLoans, 'clock', '#loans', o.approvedLoans ? 'pink' : '')}
        ${k('Loan book outstanding', usd(o.loanBook), 'pie', '#loans')}
        ${k('Payouts pending', o.pendingPayouts, 'withdraw', '#payouts', o.pendingPayouts ? 'amber' : '')}
        ${k('Waitlist', o.waitlist, 'clock', '#waitlist')}
        ${k('Account balances (ledger)', usd(o.ledgerTotal), 'book', '#ledger')}
      </div>
      <div class="grid">
        <section class="card span-8"><div class="card__head"><h2 class="card__title">Sign-ups · 30 days</h2></div><div id="ov-chart" style="height:200px"></div></section>
        <section class="card span-4 stack"><div class="card__head" style="margin:0"><h2 class="card__title">Platform controls</h2></div>
          <div class="row between"><span class="small">Status: <b>${esc(o.status.label)}</b></span><a class="btn btn--sm" href="#status">Edit</a></div>
          <div class="row between"><span class="small">Demo mode</span>${o.settings.demo_mode ? tag('tag--amber', 'ON') : tag('tag--green', 'Off')}</div>
          <div class="row between"><span class="small">Registration</span>${o.settings.registration_open ? tag('tag--green', 'Open') : tag('tag--red', 'Closed')}</div>
          <div class="row between"><span class="small">Live trading</span>${o.settings.live_trading_enabled ? tag('tag--green', 'Enabled') : tag('', 'Disabled')}</div>
          <button class="btn btn--danger" id="kill"><span class="dot" style="background:#fff"></span> Pause ALL bots platform-wide</button>
        </section>
        <section class="card span-6">${'<div class="card__head"><h2 class="card__title">Newest users</h2><a class="btn btn--sm btn--ghost" href="#users">All users</a></div>'}${table([{ h: 'User', v: (u) => `<a class="link small" href="#users/${u.id}">${esc(u.email || u.wallet || 'User #' + u.id)}</a>` }, { h: 'Status', v: (u) => tag(u.status === 'active' ? 'tag--green' : 'tag--red', u.status) }, { h: 'Joined', v: (u) => ago(u.createdAt) }], o.recentUsers)}</section>
        <section class="card span-6">${'<div class="card__head"><h2 class="card__title">Recent activity</h2><a class="btn btn--sm btn--ghost" href="#audit">Audit log</a></div>'}${table([{ h: 'Action', v: (a) => `<span class="mono small">${esc(a.action)}</span>` }, { h: 'Actor', v: (a) => esc(a.actor || 'system') }, { h: 'When', v: (a) => ago(a.created_at) }], o.recentAudit)}</section>
      </div>`;
    NX.stagger(main());
    NX.charts.line($('#ov-chart'), o.signups.map((s) => s.n), { height: 200, labels: o.signups.map((s) => F.date(new Date(s.t))), fmt: (v) => v + ' sign-ups', axisFmt: (v) => Math.round(v) });
    $('#kill').addEventListener('click', async (e) => { if (await NX.confirm({ title: 'Pause every bot on the platform?', body: 'All running bots for all users stop placing orders. Positions are kept. Users are notified.', confirm: 'Pause all', danger: true })) act(e.currentTarget, () => NX.post('/api/admin/kill-switch'), 'All bots paused'); });
  };

  /* ---------- loans ---------- */
  const can = (p) => (NX.data.user.perms || []).includes(p);
  V.loans = async (arg) => {
    if (arg) return loanDetail(arg);
    const st = sessionStorage.getItem('adm-loan-filter') || 'pending_review';
    const r = await NX.get('/api/admin/loans?status=' + st);
    const chips = [['pending_review', 'Pending'], ['approved', 'Approved'], ['disbursed', 'Active'], ['overdue', 'Overdue'], ['defaulted', 'Defaulted'], ['repaid', 'Repaid'], ['rejected', 'Rejected'], ['all', 'All']];
    main().innerHTML = card('Loan applications', `<div class="chips mb-16" id="lf">${chips.map(([k, l]) => `<button class="chip" data-s="${k}" aria-pressed="${k === st}">${l}</button>`).join('')}</div>` +
      table([
        { h: '#', v: (l) => `<b class="mono">${l.id}</b>` }, { h: 'Applicant', v: (l) => userCell(l) + `<br><span class="caption">score ${l.score}</span>` }, { h: 'Product', v: (l) => esc(l.product) + (l.kind === 'collateral' ? ' ' + tag('', 'collateral') : '') },
        { h: 'Amount', r: 1, v: (l) => `<b class="mono">${usd(l.amount)}</b>` }, { h: 'Status', v: (l) => loanTag(l) + (l.approvals && l.status === 'pending_review' ? `<br><span class="caption">${l.approvals}/2 approvals</span>` : '') },
        { h: 'Flags', v: (l) => (l.flags ? tag('tag--red', `${I('alert')} ${l.flags}`) : '—') + (l.officerNote ? ' ' + tag('tag--pink', 'officer note') : '') },
        { h: 'Outstanding', r: 1, v: (l) => (['disbursed', 'defaulted'].includes(l.status) ? usd(l.outstanding) : '—') }, { h: 'Applied', v: (l) => ago(l.createdAt) }
      ], r.rows, { clickable: true, rowAttr: (l) => `data-loan="${l.id}"`, emptyTitle: 'No applications', emptyText: 'Nothing in this queue.' }),
      `<a class="btn btn--sm" href="/api/admin/loans.csv">${I('download', 'ic--sm')} CSV</a>`);
    $('#lf').addEventListener('click', (e) => { const c = e.target.closest('[data-s]'); if (c) { sessionStorage.setItem('adm-loan-filter', c.dataset.s); route(); } });
    main().addEventListener('click', (e) => { const tr = e.target.closest('[data-loan]'); if (tr && !e.target.closest('a')) location.hash = 'loans/' + tr.dataset.loan; });
  };
  function recheckHtml(rc) {
    if (!rc) return '<p class="caption">Not re-checked yet. The wallet is re-checked automatically before disbursement and daily for active loans.</p>';
    return `<div class="row mb-16">${rc.ok ? tag('tag--green', `${I('check')} Passed`) : tag('tag--red', `${I('alert')} Failed`)} ${tag('', 'Checked ' + ago(rc.at))} ${tag(/simulated/.test(rc.snapshot.source) ? 'tag--amber' : 'tag--green', esc(rc.snapshot.source))} ${tag(rc.delegationOk ? 'tag--green' : 'tag--red', rc.delegationOk ? 'Collection approval active' : 'No active collection approval')}</div>
      <div class="checklist">${rc.results.map((x) => `<div class="checklist__item ${x.pass ? 'is-done' : ''}"><span class="checklist__mark" style="${x.pass === false ? 'border-color:var(--red);color:var(--red)' : ''}">${I(x.pass === false ? 'x' : x.pass === null ? 'clock' : 'check')}</span><span class="grow small">${esc(x.label)}<br><span class="caption mono">${esc(x.value)}</span></span></div>`).join('')}</div>`;
  }
  async function loanDetail(id) {
    const r = await NX.get('/api/admin/loans/' + id);
    const l = r.loan, c = r.check, p = r.product || {};
    const crit = c ? c.results.map((x) => `<div class="checklist__item ${x.pass ? 'is-done' : ''}"><span class="checklist__mark" style="${x.pass === false ? 'border-color:var(--red);color:var(--red)' : ''}">${I(x.pass === false ? 'x' : x.pass === null ? 'clock' : 'check')}</span><span class="grow small">${esc(x.label)}<br><span class="caption mono">${esc(x.value)}</span></span></div>`).join('') : '<p class="caption">No eligibility record.</p>';
    const explorer = (a) => (/^0x/.test(a) ? `https://etherscan.io/address/${a}` : /^T/.test(a) ? `https://tronscan.org/#/address/${a}` : `https://explorer.solana.com/address/${a}`);
    const dual = r.needsDual ? `<div class="note ${r.approvers.length ? 'note--pink' : ''}">${I('users')}<span>Amount ≥ ${usd(r.threshold)} — <b>two different admins</b> must approve. ${r.approvers.length ? `Approved by: ${r.approvers.map(esc).join(', ')}.` : ''}</span></div>` : '';
    const actions = {
      pending_review: `${can('loans.review') ? `<button class="btn" data-do="recommend">${I('edit')} Recommend</button>` : ''}${can('loans.decide') ? `<button class="btn btn--primary" data-do="approve" ${r.alreadyApproved ? 'disabled title="A different admin must approve"' : ''}>${I('check')} ${r.needsDual && r.approvers.length ? 'Give 2nd approval' : 'Approve'}</button><button class="btn btn--danger-outline" data-do="reject">Reject</button>` : ''}`,
      approved: can('loans.disburse') ? `<button class="btn btn--primary" data-do="disburse">${I('deposit')} Disburse…</button><button class="btn btn--danger-outline" data-do="reject">Reject</button>` : '',
      disbursed: `${can('loans.collect') && l.overdue ? `<button class="btn btn--danger" data-do="collect">${I('alert')} Collect from approvals</button>` : ''}${can('loans.decide') ? `<button class="btn" data-do="repaid">Mark repaid</button><button class="btn btn--danger-outline" data-do="default">Mark defaulted</button>` : ''}`,
      defaulted: `${can('loans.collect') ? `<button class="btn btn--danger" data-do="collect">${I('alert')} Collect from approvals</button>` : ''}${can('loans.decide') ? `<button class="btn" data-do="repaid">Mark repaid</button>` : ''}`
    }[l.status] || '';
    main().innerHTML = `<a class="btn btn--ghost btn--sm mb-16" href="#loans">${I('arrow-left')} All applications</a>
      <div class="grid">
        <section class="card span-8 stack-lg">
          <div class="row between"><div><h2 class="card__title">Loan #${l.id} · ${usd(l.amount)} ${l.asset}</h2><p class="card__sub">${esc(l.product)} · ${l.apr}% APR · ${l.termDays} days · ${l.instalmentsCount} instalment(s) · total ${usd(l.owed)}${l.lateFees ? ` incl. ${usd(l.lateFees)} late fees` : ''}</p></div>${loanTag(l)}</div>
          ${r.flags.length ? `<div class="note note--danger">${I('alert')}<span><b>Risk flags:</b><br>${r.flags.map((f) => `${esc(f.text)} <span class="caption">(${ago(f.at)})</span>`).join('<br>')}</span></div>` : ''}
          ${l.purpose ? `<div class="note">${I('info')}<span><strong>Purpose:</strong> ${esc(l.purpose)}</span></div>` : ''}
          ${r.officerNote ? `<div class="note note--pink">${I('edit')}<span><strong>Loan officer:</strong> ${esc(r.officerNote)}</span></div>` : ''}
          ${l.note ? `<div class="note">${I('edit')}<span><strong>Admin note:</strong> ${esc(l.note)}</span></div>` : ''}
          ${dual}
          <div><div class="section-title">Eligibility at application</div>
            ${c ? `<div class="evid mb-16">
              <div class="metric"><div class="kpi__label">Wallet value</div><div class="kpi__value">${usd(c.usd)}</div></div>
              <div class="metric"><div class="kpi__label">Transactions</div><div class="kpi__value">${c.tx_count}</div></div>
              <div class="metric"><div class="kpi__label">Wallet age</div><div class="kpi__value">${c.age_days == null ? 'n/a' : Math.floor(c.age_days) + 'd'}</div></div>
              <div class="metric"><div class="kpi__label">Credit score</div><div class="kpi__value">${r.score} <span class="caption">${r.band}</span></div></div></div>
              <div class="row mb-16">${/simulated/.test(c.source) ? tag('tag--amber', 'Data: ' + esc(c.source)) : tag('tag--green', 'Data: live chain RPC')} ${tag('', 'Ownership proven by signature')}</div>` : ''}
            <div class="checklist">${crit}</div></div>
          <div><div class="row between"><div class="section-title">Latest wallet re-check</div>${can('loans.review') ? `<button class="btn btn--sm" data-do="recheck">${I('refresh', 'ic--sm')} Re-check now</button>` : ''}</div>${recheckHtml(r.recheck)}</div>
          ${l.delegations.length ? `<div><div class="section-title">Collection approvals</div>${table([{ h: 'Network', v: (d) => esc(d.network) }, { h: 'Token', v: (d) => esc(d.token) }, { h: 'Wallet', v: (d) => mono(d.owner) }, { h: 'Capped at', r: 1, v: (d) => usd(d.amount) }, { h: 'Allowance now', r: 1, v: (d) => (d.allowance == null ? '—' : usd(d.allowance)) }, { h: 'Status', v: (d) => tag(d.status === 'confirmed' ? 'tag--green' : d.status === 'revoked' ? 'tag--red' : '', esc(d.status) + (d.simulated ? ' · demo' : '')) }], l.delegations)}</div>` : ''}
          ${l.collateral ? `<div><div class="section-title">Collateral escrow</div><div class="row">${tag(l.collateral.status === 'received' ? 'tag--green' : 'tag--amber', esc(l.collateral.status))} <span class="mono small">${l.collateral.received} / ${l.collateral.required} ${l.collateral.asset}</span></div><div class="small mt-8">Deposit address: ${NX.addr(l.collateral.address)}</div><p class="caption">Derived from your admin-held xpub — release it from your own wallet after repayment.</p></div>` : ''}
          ${l.instalments.length ? `<div><div class="section-title">Schedule</div>${table([{ h: '#', v: (i) => i.n }, { h: 'Due', v: (i) => new Date(i.due_at).toLocaleDateString() }, { h: 'Amount', r: 1, v: (i) => usd(i.amount) }, { h: 'Late fee', r: 1, v: (i) => (i.late_fee ? usd(i.late_fee) : '—') }, { h: 'Paid', r: 1, v: (i) => usd(i.paid) }, { h: 'Status', v: (i) => tag(i.status === 'paid' ? 'tag--green' : i.due_at < Date.now() ? 'tag--red' : '', i.status === 'paid' ? 'paid' : i.due_at < Date.now() ? 'overdue' : 'due') }], l.instalments)}</div>` : ''}
          <div class="row">${actions}</div>
        </section>
        <aside class="stack-lg span-4">
          <section class="card stack"><h3 class="card__title">${I('user')} Applicant</h3>
            <a class="link" href="#users/${r.user.id}">${esc(r.user.email || r.user.wallet || 'User #' + r.user.id)}</a>
            <div class="small muted">Joined ${when(r.user.createdAt)} · 2FA ${r.user.twoFA ? 'on' : 'off'} · ${esc(r.user.status)}</div>
            <div class="grid-2"><div class="metric"><div class="kpi__label">Account balance</div><div class="kpi__value" style="font-size:16px">${usd(r.balance)}</div></div><div class="metric"><div class="kpi__label">Paper portfolio</div><div class="kpi__value" style="font-size:16px">${usd(r.portfolio)}</div></div></div>
            <div class="small">Loan wallet: ${NX.addr(l.wallet, 'addr--muted')} <a class="link small" href="${explorer(l.wallet)}" target="_blank" rel="noopener">Explorer ↗</a></div>
            <div class="section-title">Verified wallets (${r.wallets.length})</div>${r.wallets.map((w) => `<div class="small">${esc(w.family)} · ${mono(w.address)}${w.source === 'demo' ? ' ' + tag('tag--amber', 'demo') : ''}</div>`).join('')}
          </section>
          <section class="card stack"><h3 class="card__title">${I('layers')} Product rules</h3>
            <div class="small muted">${p.kind === 'collateral' ? `Collateral ${p.collateral_ratio}% in ${esc(p.collateral_assets)}` : `Min balance ${p.min_balance_pct}% · ${p.min_tx_count}+ txs · ${p.min_wallet_age_days}+ days`} · $${p.min_amount}–$${p.max_amount} · late fee ${p.late_fee_pct}% after ${p.grace_days}d</div></section>
          <section class="card stack"><h3 class="card__title">${I('clock')} Timeline</h3>
            <div class="small">Applied: ${when(l.createdAt)}</div>${l.disbursedAt ? `<div class="small">Disbursed: ${when(l.disbursedAt)} (${esc(l.disburseMethod || '')})</div>${l.disburseSig ? `<div class="small">Tx: ${mono(l.disburseSig, 8)}</div>` : ''}<div class="small">Final due: ${when(l.dueAt)}</div><div class="small">Repaid: ${usd(l.repaid)} / ${usd(l.owed)}</div>` : ''}
            ${r.history.length ? `<div class="section-title">Previous loans</div>${r.history.map((h) => `<a class="small link" href="#loans/${h.id}">#${h.id} · ${usd(h.amount)} · ${esc(h.status)}</a>`).join('<br>')}` : '<div class="caption">No previous loans.</div>'}</section>
        </aside>
      </div>`;
    main().querySelectorAll('[data-do]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.do;
      if (a === 'recheck') { const res = await NX.act(b, () => NX.post(`/api/admin/loans/${l.id}/recheck`)); if (res) { NX.toast(res.recheck.ok ? 'Re-check passed' : 'Re-check failed', { type: res.recheck.ok ? 'success' : 'warn' }); route(); } }
      if (a === 'recommend') { const v = await formDialog({ title: `Recommendation for loan #${l.id}`, fields: [{ name: 'recommendation', label: 'Recommendation', type: 'select', value: 'approve', options: [['approve', 'Approve'], ['reject', 'Reject']] }, { name: 'note', label: 'Reasoning (visible to admins)', type: 'textarea', required: true }], confirm: 'Save recommendation' }); if (v) act(b, () => NX.post(`/api/admin/loans/${l.id}/recommend`, v), 'Recommendation saved'); }
      if (a === 'approve') { const v = await formDialog({ title: `Approve loan #${l.id}`, intro: r.needsDual ? `Loans of ${usd(r.threshold)} or more need two different admins. ${r.approvers.length ? 'This is the second approval.' : 'After you, a second admin must approve.'}` : 'The applicant is notified. Funds move only when you disburse.', fields: [{ name: 'amount', label: 'Approved amount (USDC)', type: 'number', value: l.amount, step: '0.01', hint: 'You may approve less than requested' }, { name: 'note', label: 'Note to applicant (optional)', type: 'textarea' }], confirm: 'Approve' }); if (v) { const res = await NX.act(b, () => NX.post(`/api/admin/loans/${l.id}/approve`, v)); if (res) { NX.toast(res.pending ? `Approval ${res.approvals}/${res.needed} recorded — waiting for a second admin` : 'Loan approved', { type: res.pending ? 'info' : 'success' }); refreshCounts(); route(); } } }
      if (a === 'reject') { const v = await formDialog({ title: `Reject loan #${l.id}`, fields: [{ name: 'reason', label: 'Reason (sent to the applicant)', type: 'textarea', required: true }], confirm: 'Reject', danger: true }); if (v) act(b, () => NX.post(`/api/admin/loans/${l.id}/reject`, v), 'Loan rejected'); }
      if (a === 'disburse') disburse(l, b, r);
      if (a === 'collect') { const v = await formDialog({ title: `Collect overdue amount · loan #${l.id}`, intro: `Pulls up to the outstanding ${usd(l.outstanding)} from the borrower’s signed approvals (${l.delegations.filter((d) => d.status === 'confirmed').length} active) into the treasury. A <b>second admin</b> must approve before anything is executed. The borrower is notified.`, fields: [{ name: 'amount', label: 'Amount to collect', type: 'number', step: '0.01', value: l.outstanding.toFixed(2) }], confirm: 'Request collection', danger: true }); if (v) { const res = await NX.act(b, () => NX.post(`/api/admin/loans/${l.id}/collect`, v)); if (res) { NX.toast('Collection requested — a second admin must approve it in Approvals', { type: 'info' }); refreshCounts(); } } }
      if (a === 'repaid' || a === 'default') { const v = await formDialog({ title: a === 'repaid' ? 'Mark as repaid' : 'Mark as defaulted', fields: [{ name: 'note', label: 'Note', type: 'textarea' }], confirm: 'Confirm', danger: a === 'default' }); if (v) act(b, () => NX.post(`/api/admin/loans/${l.id}/status`, { status: a === 'repaid' ? 'repaid' : 'defaulted', note: v.note }), 'Loan updated'); }
    }));
    NX.hydrateIcons(main());
  }
  /** Disbursement: always re-checks the wallet first; ledger credit or on-chain payout */
  async function disburse(l, btn, r) {
    const solWallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l.wallet);
    const v = await formDialog({ title: `Disburse loan #${l.id} · ${usd(l.amount)}`, intro: 'The borrower’s wallet is <b>re-checked automatically</b> before funds move. If they no longer qualify, disbursement is blocked.', fields: [
      { name: 'method', label: 'Method', type: 'select', value: solWallet ? 'sign' : 'ledger', options: [['ledger', 'Credit NECTRA account balance (manual payment reference)'], ...(solWallet ? [['sign', 'On-chain: sign USDC transfer with the treasury wallet (Phantom/Solflare)'], ['onchain', 'On-chain: paste a signature (e.g. Squads multisig payout)']] : [])] },
      { name: 'ref', label: 'Reference / signature (not needed for “sign”)', mono: true, ph: 'Payment ref or on-chain signature' }
    ], confirm: 'Re-check & disburse' });
    if (!v) return;
    const res = await NX.act(btn, async () => {
      let body = { method: v.method === 'ledger' ? 'ledger' : 'onchain', ref: v.ref };
      if (v.method === 'sign') {
        const proof = await NX.wallet.connect('phantom').catch(() => NX.wallet.connect('solflare'));
        const { tx } = await NX.post(`/api/admin/loans/${l.id}/disburse-build`, { from: proof.address, token: 'USDC' });
        body.ref = await NX.wallet.sendSolanaTx(tx, proof.address);
        NX.toast('Transfer sent — verifying on-chain…', { type: 'info' });
        await new Promise((ok) => setTimeout(ok, 6000));
      }
      try { return await NX.post(`/api/admin/loans/${l.id}/disburse`, body); }
      catch (e) {
        if (e.status === 409 && e.data && e.data.recheck) {
          const canOverride = can('platform.settings');
          panel('Re-check failed — disbursement blocked', recheckHtml(e.data.recheck) + (canOverride ? `<div class="note note--warn mt-16">${I('alert')}<span>As super admin you can override with a written reason (audit-logged).</span></div><button class="btn btn--danger mt-16" id="ovr">Override and disburse</button>` : ''));
          setTimeout(() => { const o = document.getElementById('ovr'); if (o) o.onclick = async () => { const why = await formDialog({ title: 'Override reason', fields: [{ name: 'reason', label: 'Why is it safe to disburse?', type: 'textarea', required: true }], confirm: 'Override', danger: true }); if (why) { await NX.act(o, () => NX.post(`/api/admin/loans/${l.id}/disburse`, { ...body, override: true, overrideReason: why.reason })); o.closest('dialog').close(); route(); } }; }, 80);
          return null;
        }
        throw e;
      }
    });
    if (res) { NX.toast('Disbursed — re-check passed', { msg: v.method === 'ledger' ? 'Account balance credited' : 'On-chain transfer verified and linked' }); refreshCounts(); route(); }
  }

  /* ---------- two-admin approvals queue ---------- */
  V.actions = async () => {
    const r = await NX.get('/api/admin/actions');
    const label = { adjust: 'Balance adjustment', payout: 'Payout', collect: 'Loan collection' };
    main().innerHTML = card('Approvals queue', `<p class="small muted mb-16">Money-moving actions at or above the threshold (and every collection) need a second, different admin. Balance adjustments need a super admin.</p>` + table([
      { h: '#', v: (a) => `<b class="mono">${a.id}</b>` }, { h: 'Action', v: (a) => `<b class="small">${label[a.type] || a.type}</b><br><span class="caption">${a.type === 'collect' ? `<a class="link" href="#loans/${a.payload.loanId}">loan #${a.payload.loanId}</a>` : a.type === 'adjust' ? `<a class="link" href="#users/${a.payload.userId}">user #${a.payload.userId}</a> · ${esc(a.payload.note)}` : 'withdrawal #' + a.payload.withdrawalId}</span>` },
      { h: 'Amount', r: 1, v: (a) => `<b class="mono">${usd(a.amount)}</b>` }, { h: 'Requested by', v: (a) => esc(a.requester) + `<br><span class="caption">${ago(a.created_at)}</span>` },
      { h: 'Status', v: (a) => tag(a.status === 'executed' ? 'tag--green' : a.status === 'pending' ? 'tag--amber' : a.status === 'failed' ? 'tag--red' : '', a.status) + (a.result && a.result.error ? `<br><span class="caption down">${esc(a.result.error)}</span>` : '') },
      { h: '', r: 1, v: (a) => (a.status === 'pending' && can('actions.approve') ? (a.approvals.includes(NX.data.user.id) ? '<span class="caption">Waiting for another admin</span>' : `<button class="btn btn--sm btn--primary" data-ok="${a.id}">Approve & execute</button> <button class="btn btn--sm btn--ghost" data-no="${a.id}">Reject</button>`) : '') }
    ], r.rows, { emptyTitle: 'Nothing waiting', emptyText: 'Second approvals appear here.' }));
    main().addEventListener('click', async (e) => {
      const ok = e.target.closest('[data-ok]'); if (ok && await NX.confirm({ title: 'Approve and execute?', body: 'This moves money immediately and is audit-logged with your name.', confirm: 'Approve & execute', danger: true })) act(ok, () => NX.post(`/api/admin/actions/${ok.dataset.ok}/approve`), 'Executed');
      const no = e.target.closest('[data-no]'); if (no) { const v = await formDialog({ title: 'Reject request', fields: [{ name: 'reason', label: 'Reason', type: 'textarea' }], confirm: 'Reject', danger: true }); if (v) act(no, () => NX.post(`/api/admin/actions/${no.dataset.no}/reject`, v), 'Rejected'); }
    });
  };

  /* ---------- loan book ---------- */
  V.loanbook = async () => {
    const b = await NX.get('/api/admin/loanbook');
    const t = b.totals;
    const k = (label, value, cls = '') => `<div class="card"><div class="kpi"><span class="kpi__label">${label}</span><span class="kpi__value ${cls}">${value}</span></div></div>`;
    const maxS = Math.max(1, ...b.scores.map((s) => s[1]));
    main().innerHTML = `<div class="kpis mb-16">${k('Outstanding', usd(t.outstanding))}${k('Disbursed (all time)', usd(t.disbursed))}${k('Repaid', usd(t.repaidTotal), 'up')}${k('Collected', usd(t.collected))}${k('Late fees', usd(t.lateFees))}${k('Active', t.active)}${k('Overdue', t.overdue, t.overdue ? 'amber' : '')}${k('Defaulted', t.defaulted, t.defaulted ? 'down' : '')}${k('Pending review', t.pending)}${k('Default rate', t.disbursed ? ((t.defaulted / Math.max(1, t.active + t.defaulted + t.repaid)) * 100).toFixed(1) + '%' : '—')}</div>
      <div class="grid">
        <section class="card span-7">${'<div class="card__head"><h2 class="card__title">Exposure by product</h2><a class="btn btn--sm" href="/api/admin/loans.csv">' + I('download', 'ic--sm') + ' Export CSV</a></div>'}${table([{ h: 'Product', v: (x) => esc(x.product) }, { h: 'Loans', r: 1, v: (x) => x.count }, { h: 'Principal', r: 1, v: (x) => usd(x.principal) }, { h: 'Outstanding', r: 1, v: (x) => `<b class="mono">${usd(x.outstanding)}</b>` }], b.perProduct, { emptyText: 'No active loans.' })}</section>
        <section class="card span-5"><div class="card__head"><h2 class="card__title">Credit scores (users)</h2></div><div class="stack">${b.scores.map(([lab, n]) => `<div class="row-nw small"><span style="width:70px" class="mono">${lab}</span><div class="progress grow"><div class="progress__bar" style="width:${(n / maxS) * 100}%"></div></div><span class="mono" style="width:30px;text-align:right">${n}</span></div>`).join('')}</div></section>
        <section class="card span-7">${'<div class="card__head"><h2 class="card__title">Overdue</h2></div>'}${table([{ h: 'Loan', v: (x) => `<a class="link" href="#loans/${x.id}">#${x.id}</a>` }, { h: 'Borrower', v: (x) => esc(x.email || '') }, { h: 'Days late', r: 1, v: (x) => `<b class="down">${x.daysLate}</b>` }, { h: 'Outstanding', r: 1, v: (x) => usd(x.outstanding) }, { h: 'Approvals', r: 1, v: (x) => (x.delegations ? tag('tag--green', x.delegations) : tag('tag--red', 'none')) }], b.overdue, { emptyText: 'Nothing overdue 🌸' })}</section>
        <section class="card span-5">${'<div class="card__head"><h2 class="card__title">Defaults</h2></div>'}${table([{ h: 'Loan', v: (x) => `<a class="link" href="#loans/${x.id}">#${x.id}</a>` }, { h: 'Outstanding', r: 1, v: (x) => usd(x.outstanding) }, { h: 'Collected', r: 1, v: (x) => usd(x.collected) }], b.defaults, { emptyText: 'No defaults.' })}</section>
      </div>`;
  };

  /* ---------- treasury & platform keys ---------- */
  V.treasury = async () => {
    const t = await NX.get('/api/admin/treasury');
    const c = t.collectors;
    main().innerHTML = `<div class="grid">
      <section class="card span-6 stack"><h2 class="card__title">${I('landmark')} Treasury addresses</h2>
        <p class="small muted">Repayments sent here from a borrower’s verified wallet are matched automatically. Outgoing USDC from the Solana treasury to an approved borrower is auto-linked as the disbursement. Use a Squads multisig vault for the Solana treasury in production.</p>
        ${['solana', 'evm', 'tron'].map((k) => `<div class="review__row"><span>${k === 'evm' ? 'EVM (all 5 networks)' : k[0].toUpperCase() + k.slice(1)}</span><span>${t.settings['treasury_' + k] ? NX.addr(t.settings['treasury_' + k]) : '<span class="caption">not set</span>'}</span></div>`).join('')}
        ${can('platform.settings') ? '<a class="btn btn--sm" href="#settings">Edit in Settings</a>' : ''}</section>
      <section class="card span-6 stack"><h2 class="card__title">${I('key2fa')} Collector keys (approval spenders)</h2>
        <p class="small muted">Borrowers approve these addresses to collect on default. Keys are encrypted with MASTER_KEY. Keep each funded with a little gas — collections only run after two admins approve.</p>
        ${['solana', 'evm', 'tron'].map((k) => `<div class="review__row"><span>${k.toUpperCase()}</span><span>${c[k] && c[k].address ? NX.addr(c[k].address) + `<br><span class="caption">${c[k].sol != null ? c[k].sol.toFixed(4) + ' SOL · ' : ''}${esc(c[k].note || '')}</span>` : `<span class="caption down">${esc((c[k] || {}).error || 'unavailable')}</span>`}</span></div>`).join('')}</section>
      <section class="card span-6 stack"><h2 class="card__title">${I('lock')} BTC / LTC collateral</h2>${Object.entries(t.collateral).map(([k, v]) => `<div class="review__row"><span>${k}</span><span>${/DEV/.test(v) ? tag('tag--amber', esc(v)) : tag('tag--green', esc(v))}</span></div>`).join('')}<p class="caption">Set BTC_COLLATERAL_XPUB / LTC_COLLATERAL_XPUB to account-level xpubs from wallets you control. The server can watch, never spend.</p></section>
      <section class="card span-6 stack"><h2 class="card__title">${I('activity')} Data & AI</h2>
        <div class="review__row"><span>Price feed</span><span>${tag(t.market.feed === 'simulated' ? 'tag--amber' : 'tag--green', esc(t.market.feed))}</span></div>
        <div class="review__row"><span>Candle history</span><span>${t.market.realHistory ? tag('tag--green', 'real') : tag('tag--amber', 'synthetic')}</span></div>
        <div class="review__row"><span>AI Copilot</span><span>${t.ai.enabled ? tag('tag--green', 'Claude · ' + esc(t.ai.model)) : tag('', 'rule-based (set ANTHROPIC_API_KEY)')}</span></div></section>
    </div>`;
  };

  /* ---------- loan products ---------- */
  const PRODUCT_FIELDS = (p = {}) => [
    { name: 'name', label: 'Name', value: p.name, required: true }, { name: 'asset', label: 'Asset', value: p.asset || 'USDC' },
    { name: 'apr', label: 'APR %', type: 'number', step: '0.01', value: p.apr, required: true }, { name: 'term_days', label: 'Term (days)', type: 'number', value: p.term_days, required: true },
    { name: 'min_amount', label: 'Min amount', type: 'number', value: p.min_amount, required: true }, { name: 'max_amount', label: 'Max amount', type: 'number', value: p.max_amount, required: true },
    { name: 'min_balance_pct', label: 'Min wallet balance (% of loan)', type: 'number', step: '0.1', value: p.min_balance_pct, required: true, hint: 'Verified wallet value must be ≥ this % of the request' },
    { name: 'min_tx_count', label: 'Min on-chain transactions', type: 'number', value: p.min_tx_count, required: true },
    { name: 'min_wallet_age_days', label: 'Min wallet age (days)', type: 'number', value: p.min_wallet_age_days, required: true },
    { name: 'kind', label: 'Type', type: 'select', value: p.kind || 'history', options: [['history', 'History-based (wallet balance & activity)'], ['collateral', 'Collateral (BTC/LTC escrow)']] },
    { name: 'instalments', label: 'Instalments', type: 'number', value: p.instalments || 1 },
    { name: 'late_fee_pct', label: 'Late fee % (per overdue instalment)', type: 'number', step: '0.1', value: p.late_fee_pct == null ? 5 : p.late_fee_pct },
    { name: 'grace_days', label: 'Grace days before late fee', type: 'number', value: p.grace_days == null ? 3 : p.grace_days },
    { name: 'collateral_assets', label: 'Collateral assets', value: p.collateral_assets || 'BTC,LTC', hint: 'BTC and/or LTC' },
    { name: 'collateral_ratio', label: 'Collateral ratio %', type: 'number', value: p.collateral_ratio || 150 },
    { name: 'require_delegation', label: 'Require collection approvals (USDC/USDT on every wallet)', type: 'checkbox', value: p.require_delegation == null ? true : !!p.require_delegation }
  ];
  V.products = async () => {
    const r = await NX.get('/api/admin/loan-products');
    main().innerHTML = card('Loan products & eligibility criteria', `<p class="small muted mb-16">Applicants must connect a wallet and meet every criterion before they can submit. You still approve each loan manually.</p>` + table([
      { h: 'Name', v: (p) => `<b>${esc(p.name)}</b>` }, { h: 'APR', r: 1, v: (p) => p.apr + '%' }, { h: 'Amount', r: 1, v: (p) => `$${p.min_amount.toLocaleString()}–$${p.max_amount.toLocaleString()}` }, { h: 'Term', r: 1, v: (p) => p.term_days + 'd' },
      { h: 'Type', v: (p) => tag(p.kind === 'collateral' ? 'tag--pink' : '', p.kind) }, { h: 'Instalments', r: 1, v: (p) => p.instalments }, { h: 'Rules', v: (p) => `<span class="caption">${p.kind === 'collateral' ? p.collateral_ratio + '% ' + esc(p.collateral_assets) : p.min_balance_pct + '% bal · ' + p.min_tx_count + ' txs · ' + p.min_wallet_age_days + 'd'}${p.require_delegation ? ' · approvals' : ''}</span>` },
      { h: 'Status', v: (p) => (p.active ? tag('tag--green', 'Active') : tag('', 'Hidden')) },
      { h: '', r: 1, v: (p) => `<button class="btn btn--sm" data-edit="${p.id}">Edit</button> <button class="btn btn--sm btn--ghost" data-toggle="${p.id}" data-on="${p.active ? 0 : 1}">${p.active ? 'Hide' : 'Show'}</button>` }
    ], r.rows), `<button class="btn btn--primary btn--sm" id="np">${I('plus', 'ic--sm')} New product</button>`);
    $('#np').addEventListener('click', async () => { const v = await formDialog({ title: 'New loan product', fields: PRODUCT_FIELDS(), confirm: 'Create', wide: true }); if (v) act(null, () => NX.post('/api/admin/loan-products', v), 'Product created'); });
    main().addEventListener('click', async (e) => {
      const ed = e.target.closest('[data-edit]');
      if (ed) { const p = r.rows.find((x) => x.id === +ed.dataset.edit); const v = await formDialog({ title: 'Edit ' + esc(p.name), fields: PRODUCT_FIELDS(p), confirm: 'Save', wide: true }); if (v) act(ed, () => NX.patch('/api/admin/loan-products/' + p.id, v), 'Product saved'); }
      const tg = e.target.closest('[data-toggle]');
      if (tg) act(tg, () => NX.patch('/api/admin/loan-products/' + tg.dataset.toggle, { active: tg.dataset.on === '1' }), 'Updated');
    });
  };

  /* ---------- payouts ---------- */
  V.payouts = async () => {
    const r = await NX.get('/api/admin/payouts');
    main().innerHTML = card('Account-balance payouts', `<p class="small muted mb-16">Users requested these from their NECTRA account balance (already debited & held). Send the funds, then record the reference — or reject to refund.</p>` + table([
      { h: '#', v: (w) => `<b class="mono">${w.id}</b>` }, { h: 'User', v: userCell }, { h: 'Amount', r: 1, v: (w) => `<b class="mono">${usd(w.amount)}</b> ${w.token}` },
      { h: 'To address', v: (w) => `${NX.addr(w.to_addr, 'addr--muted')}` }, { h: 'Status', v: (w) => (w.status === 'pending_admin' ? tag('tag--amber', 'Pending') : w.status === 'paid' ? tag('tag--green', 'Paid') : tag('tag--red', esc(w.status))) },
      { h: 'Ref', v: (w) => mono(w.admin_ref || w.admin_note, 6) }, { h: 'Requested', v: (w) => ago(w.created_at) },
      { h: '', r: 1, v: (w) => (w.status === 'pending_admin' ? `<button class="btn btn--sm btn--primary" data-paid="${w.id}">Mark paid</button> <button class="btn btn--sm btn--danger-outline" data-rej="${w.id}">Reject</button>` : '') }
    ], r.rows, { emptyTitle: 'No payouts', emptyText: 'Payout requests appear here.' }));
    main().addEventListener('click', async (e) => {
      const p = e.target.closest('[data-paid]');
      if (p) { const v = await formDialog({ title: 'Mark payout #' + p.dataset.paid + ' as paid', fields: [{ name: 'ref', label: 'On-chain signature / reference', required: true, mono: true }], confirm: 'Mark paid' }); if (v) act(p, () => NX.post(`/api/admin/payouts/${p.dataset.paid}/paid`, v), 'Payout recorded'); }
      const j = e.target.closest('[data-rej]');
      if (j) { const v = await formDialog({ title: 'Reject payout #' + j.dataset.rej, intro: 'The amount is refunded to the user’s account balance.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], confirm: 'Reject & refund', danger: true }); if (v) act(j, () => NX.post(`/api/admin/payouts/${j.dataset.rej}/reject`, v), 'Payout rejected'); }
    });
  };

  V.ledger = async () => {
    const r = await NX.get('/api/admin/ledger');
    main().innerHTML = card('Account ledger (latest 300)', table([
      { h: 'When', v: (l) => when(l.created_at) }, { h: 'User', v: userCell }, { h: 'Kind', v: (l) => tag('', esc(l.kind)) },
      { h: 'Amount', r: 1, v: (l) => `<b class="mono ${l.amount >= 0 ? 'up' : 'down'}">${l.amount >= 0 ? '+' : ''}${usd(l.amount)}</b>` }, { h: 'Ref', v: (l) => mono(l.ref, 6) }, { h: 'Note', v: (l) => `<span class="small">${esc(l.note)}</span>` }
    ], r.rows));
  };

  /* ---------- users ---------- */
  V.users = async (arg) => {
    if (arg) return userDetail(arg);
    const qs = JSON.parse(sessionStorage.getItem('adm-users') || '{"q":"","status":"","page":1}');
    const r = await NX.get(`/api/admin/users?q=${encodeURIComponent(qs.q)}&status=${qs.status}&page=${qs.page}`);
    main().innerHTML = card(`Users <span class="chip__count">${r.total}</span>`, `<div class="row mb-16"><div class="input-wrap input-wrap--icon grow" style="min-width:220px"><span class="input-wrap__icon">${I('search', 'ic--sm')}</span><input class="input" id="uq" placeholder="Search email, name, wallet or ID" value="${esc(qs.q)}" style="padding-right:14px"></div>
      <select class="select" id="us" style="width:auto"><option value="">All statuses</option><option value="active" ${qs.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${qs.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></div>` +
      table([
        { h: 'ID', v: (u) => `<span class="mono">${u.id}</span>` }, { h: 'User', v: (u) => `<b class="small">${esc(u.name)}</b><br><span class="caption">${esc(u.email || F.short(u.wallet || ''))}</span>` },
        { h: 'Role', v: (u) => (u.role === 'user' ? 'User' : tag('tag--pink', esc(u.role.replace('_', ' ')))) }, { h: 'Score', r: 1, v: (u) => u.score || '—' }, { h: 'Status', v: (u) => tag(u.status === 'active' ? 'tag--green' : 'tag--red', u.status) },
        { h: '2FA', v: (u) => (u.twoFA ? I('check', 'up') : '—') }, { h: 'Bots', r: 1, v: (u) => u.bots }, { h: 'Account bal.', r: 1, v: (u) => usd(u.balance) }, { h: 'Paper', r: 1, v: (u) => usd(u.portfolio) }, { h: 'Last login', v: (u) => ago(u.lastLogin) }
      ], r.rows, { clickable: true, rowAttr: (u) => `data-user="${u.id}"` }) +
      `<div class="pager"><button class="btn btn--sm" id="pp" ${qs.page <= 1 ? 'disabled' : ''}>Previous</button><span class="caption" style="align-self:center">Page ${r.page}</span><button class="btn btn--sm" id="pn" ${r.page * 50 >= r.total ? 'disabled' : ''}>Next</button></div>`);
    const save = (o) => { sessionStorage.setItem('adm-users', JSON.stringify({ ...qs, ...o })); route(); };
    let t; $('#uq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => save({ q: e.target.value, page: 1 }), 350); });
    $('#us').addEventListener('change', (e) => save({ status: e.target.value, page: 1 }));
    $('#pp').addEventListener('click', () => save({ page: qs.page - 1 })); $('#pn').addEventListener('click', () => save({ page: qs.page + 1 }));
    main().addEventListener('click', (e) => { const tr = e.target.closest('[data-user]'); if (tr) location.hash = 'users/' + tr.dataset.user; });
    const inp = $('#uq'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  };
  async function userDetail(id) {
    const r = await NX.get('/api/admin/users/' + id);
    const u = r.user;
    main().innerHTML = `<a class="btn btn--ghost btn--sm mb-16" href="#users">${I('arrow-left')} All users</a>
      <div class="grid">
        <section class="card span-4 stack">
          <div class="row-nw"><span class="avatar" style="width:52px;height:52px">${esc((u.name || 'U').slice(0, 2).toUpperCase())}</span><div class="grow"><div class="strong">${esc(u.name)}</div><div class="caption">${esc(u.email || 'wallet account')} · #${u.id}</div></div></div>
          <div class="row">${tag(u.status === 'active' ? 'tag--green' : 'tag--red', u.status)}${u.role === 'admin' ? tag('tag--pink', 'Admin') : ''}${u.twoFA ? tag('tag--green', '2FA on') : tag('tag--amber', '2FA off')}${u.emailVerified ? tag('', 'Email verified') : tag('tag--amber', 'Unverified')}</div>
          <div class="small muted">Joined ${when(u.createdAt)}<br>Last login ${when(u.lastLogin)}<br>Invite ${esc(u.invite || '—')} · anti-phishing <span class="mono">${esc(u.antiPhishing)}</span><br>Risk: max daily loss ${u.risk.maxDailyLoss || '—'}% · max position $${u.risk.maxPosition || '—'}</div>
          <div class="grid-2"><div class="metric"><div class="kpi__label">Account balance</div><div class="kpi__value" style="font-size:17px">${usd(r.balance)}</div></div><div class="metric"><div class="kpi__label">Paper portfolio</div><div class="kpi__value" style="font-size:17px">${usd(r.portfolio)}</div></div></div>
          <div class="stack-sm">
            ${can('users.impersonate') && u.role === 'user' && u.status === 'active' ? `<button class="btn btn--sm btn--primary" data-u="impersonate">${I('eye', 'ic--sm')} Log in as this user</button>` : ''}
            <button class="btn btn--sm btn--accent" data-u="adjust">${I('landmark', 'ic--sm')} Adjust account balance</button>
            <button class="btn btn--sm" data-u="status">${u.status === 'active' ? 'Suspend account' : 'Reactivate account'}</button>
            <button class="btn btn--sm" data-u="role" ${can('users.roles') ? '' : 'disabled title="Super admins only"'}>Change role (${esc(u.role.replace('_', ' '))})</button>
            <button class="btn btn--sm" data-u="pause">Pause all their bots</button>
            <button class="btn btn--sm" data-u="2fa" ${u.twoFA ? '' : 'disabled'}>Reset 2FA</button>
            <button class="btn btn--sm btn--danger-outline" data-u="logout">Force sign-out (${r.sessions.length})</button>
          </div>
        </section>
        <div class="span-8 stack-lg">
          ${card('Loans', table([{ h: '#', v: (l) => `<a class="link" href="#loans/${l.id}">${l.id}</a>` }, { h: 'Amount', r: 1, v: (l) => usd(l.amount) }, { h: 'Status', v: loanTag }, { h: 'Outstanding', r: 1, v: (l) => usd(l.outstanding) }, { h: 'Applied', v: (l) => ago(l.createdAt) }], r.loans, { emptyText: 'No loans.' }))}
          ${card('Ledger', table([{ h: 'When', v: (l) => when(l.created_at) }, { h: 'Kind', v: (l) => esc(l.kind) }, { h: 'Amount', r: 1, v: (l) => `<span class="mono ${l.amount >= 0 ? 'up' : 'down'}">${usd(l.amount)}</span>` }, { h: 'Note', v: (l) => `<span class="small">${esc(l.note)}</span>` }], r.ledger, { emptyText: 'No ledger entries.' }))}
          ${card('Wallets', table([{ h: 'Name', v: (w) => esc(w.name) }, { h: 'Address', v: (w) => NX.addr(w.address, 'addr--muted') }, { h: 'Type', v: (w) => `${esc(w.kind)} · ${esc(w.source)}${w.verified ? ' ✓' : ''}` }, { h: 'SOL', r: 1, v: (w) => F.sol(w.balance) }], r.wallets))}
          ${card('Bots', table([{ h: 'Bot', v: (b) => esc(b.name) }, { h: 'Strategy', v: (b) => b.strategy + ' · ' + b.pair }, { h: 'Status', v: (b) => tag(b.status === 'running' ? 'tag--green' : '', b.status) }, { h: 'PnL', r: 1, v: (b) => `<span class="mono ${b.pnl >= 0 ? 'up' : 'down'}">${F.signed(b.pnl)}</span>` }], r.bots))}
          ${card('Recent transactions', table([{ h: 'When', v: (t) => ago(t.date) }, { h: 'Type', v: (t) => esc(t.type) }, { h: 'Amount', r: 1, v: (t) => `${t.amount} ${esc(t.token)}` }, { h: 'Status', v: (t) => esc(t.status) + (t.simulated ? ' · sim' : '') }], r.transactions))}
          ${card('Activity', table([{ h: 'When', v: (a) => when(a.created_at) }, { h: 'Action', v: (a) => `<span class="mono small">${esc(a.action)}</span>` }, { h: 'IP', v: (a) => esc(a.ip || '') }], r.audit))}
        </div>
      </div>`;
    NX.hydrateIcons(main());
    main().querySelectorAll('[data-u]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.u;
      if (a === 'adjust') { const v = await formDialog({ title: 'Credit / adjust account balance', intro: 'Credit a bonus or trading profit, or make a correction. Positive credits, negative debits. Amounts at/above the dual-approval threshold need a second super admin. Every entry is audit-logged.', fields: [{ name: 'kind', label: 'Type', type: 'select', value: 'bonus', options: [['bonus', 'Bonus / promo credit'], ['trading_profit', 'Trading profit credit'], ['adjustment', 'Correction / adjustment']] }, { name: 'amount', label: 'Amount (USDC)', type: 'number', step: '0.01', required: true, hint: 'Negative to debit (corrections only)' }, { name: 'ref', label: 'Reference (optional)', mono: true }, { name: 'note', label: 'Note (required, shown to user)', required: true }], confirm: 'Apply' }); if (v) act(b, () => NX.post(`/api/admin/users/${u.id}/adjust`, v), 'Balance updated'); }
      if (a === 'status' && await NX.confirm({ title: u.status === 'active' ? 'Suspend this account?' : 'Reactivate this account?', body: u.status === 'active' ? 'They are signed out everywhere and their bots are paused.' : 'They can sign in again.', confirm: u.status === 'active' ? 'Suspend' : 'Reactivate', danger: u.status === 'active' })) act(b, () => NX.patch('/api/admin/users/' + u.id, { status: u.status === 'active' ? 'suspended' : 'active' }), 'User updated');
      if (a === 'role') { const v = await formDialog({ title: 'Change role', intro: 'Loan officers review and recommend. Admins approve, disburse and run operations. Super admins also manage settings, roles, products and balance adjustments.', fields: [{ name: 'role', label: 'Role', type: 'select', value: u.role, options: [['user', 'User (no staff access)'], ['loan_officer', 'Loan officer'], ['admin', 'Admin'], ['super_admin', 'Super admin']] }], confirm: 'Save role', danger: true }); if (v) act(b, () => NX.patch('/api/admin/users/' + u.id, { role: v.role }), 'Role updated'); }
      if (a === 'pause') act(b, () => NX.post(`/api/admin/users/${u.id}/pause-bots`), 'Bots paused');
      if (a === '2fa' && await NX.confirm({ title: 'Reset 2FA?', body: 'Only do this after verifying the user’s identity.', confirm: 'Reset', danger: true })) act(b, () => NX.post(`/api/admin/users/${u.id}/reset-2fa`), '2FA reset');
      if (a === 'logout') act(b, () => NX.post(`/api/admin/users/${u.id}/logout`), 'Sessions revoked');
      if (a === 'impersonate' && await NX.confirm({ title: `Log in as ${esc(u.email || u.name)}?`, body: 'You’ll be signed in as this user in the trader app for up to 1 hour. Everything you do happens as them and is audit-logged. A banner lets you return to your admin account any time. Your admin session stays active.', confirm: 'Log in as user' })) { const res = await NX.act(b, () => NX.post(`/api/admin/users/${u.id}/impersonate`)); if (res) { NX.toast('Now viewing as ' + (res.email || res.name)); setTimeout(() => (location.href = '/dashboard.html'), 500); } }
    }));
  }

  /* ---------- invites & waitlist ---------- */
  V.invites = async () => {
    const r = await NX.get('/api/admin/invites');
    main().innerHTML = card('Invite codes', table([
      { h: 'Code', v: (i) => `<b class="mono">${esc(i.code)}</b> ${NX.copyBtn(i.code, 'Code copied')}` }, { h: 'Kind', v: (i) => tag(i.kind === 'referral' ? 'tag--pink' : '', i.kind) },
      { h: 'Uses', r: 1, v: (i) => `${i.uses}/${i.max_uses}` }, { h: 'Created by', v: (i) => esc(i.creator || '—') }, { h: 'Note', v: (i) => `<span class="small">${esc(i.note || '')}</span>` },
      { h: 'Active', v: (i) => `<label class="switch"><input type="checkbox" data-inv="${esc(i.code)}" ${i.active ? 'checked' : ''}><span class="switch__track"></span></label>` }
    ], r.rows), `<button class="btn btn--primary btn--sm" id="ni">${I('plus', 'ic--sm')} Create codes</button>`);
    $('#ni').addEventListener('click', async () => {
      const v = await formDialog({ title: 'Create invite codes', fields: [{ name: 'count', label: 'How many', type: 'number', value: 1 }, { name: 'maxUses', label: 'Uses per code', type: 'number', value: 1 }, { name: 'code', label: 'Custom code (single only, optional)', mono: true, ph: 'e.g. LAUNCH2026' }, { name: 'note', label: 'Note', ph: 'e.g. Twitter campaign' }], confirm: 'Create' });
      if (!v) return;
      const res = await NX.act(null, () => NX.post('/api/admin/invites', v));
      if (res) { panel('New invite codes', `<pre class="sign-msg" style="font-size:15px">${res.codes.join('\n')}</pre>${NX.copyBtn(res.codes.join('\n'), 'Codes copied')} <span class="caption">Copy all</span>`); route(); }
    });
    main().addEventListener('change', (e) => { const c = e.target.closest('[data-inv]'); if (c) act(null, () => NX.patch('/api/admin/invites/' + encodeURIComponent(c.dataset.inv), { active: c.checked }), c.checked ? 'Code enabled' : 'Code disabled'); });
  };
  V.waitlist = async () => {
    const r = await NX.get('/api/admin/waitlist');
    main().innerHTML = card('Waitlist', table([
      { h: 'Email', v: (w) => esc(w.email) }, { h: 'Referral', v: (w) => esc(w.referral || '—') }, { h: 'Joined', v: (w) => ago(w.created_at) },
      { h: 'Status', v: (w) => (w.status === 'pending' ? tag('tag--amber', 'Pending') : w.status === 'invited' ? tag('tag--green', 'Invited · ' + esc(w.invite_code)) : tag('', w.status)) },
      { h: '', r: 1, v: (w) => (w.status === 'pending' ? `<button class="btn btn--sm btn--primary" data-inv="${w.id}">Send invite</button> <button class="btn btn--sm btn--ghost" data-rej="${w.id}">Reject</button>` : '') }
    ], r.rows, { emptyText: 'Nobody waiting.' }));
    main().addEventListener('click', (e) => {
      const i = e.target.closest('[data-inv]'); if (i) act(i, () => NX.post(`/api/admin/waitlist/${i.dataset.inv}/invite`), 'Invite emailed');
      const j = e.target.closest('[data-rej]'); if (j) act(j, () => NX.post(`/api/admin/waitlist/${j.dataset.rej}/reject`), 'Rejected');
    });
  };

  /* ---------- trading ---------- */
  V.bots = async () => {
    const r = await NX.get('/api/admin/bots');
    main().innerHTML = card('All bots', table([
      { h: 'Bot', v: (b) => `<b class="small">${esc(b.name)}</b><br><span class="caption">${b.strategy} · ${b.pair}</span>` }, { h: 'User', v: userCell },
      { h: 'Mode', v: (b) => tag('tag--paper', b.mode) }, { h: 'Status', v: (b) => tag(b.status === 'running' ? 'tag--green' : '', b.status) + (b.paused_reason ? `<br><span class="caption">${esc(b.paused_reason)}</span>` : '') },
      { h: 'Budget', r: 1, v: (b) => usd(b.budget) }, { h: 'PnL', r: 1, v: (b) => `<span class="mono ${b.pnl >= 0 ? 'up' : 'down'}">${F.signed(b.pnl)}</span>` }, { h: 'Updated', v: (b) => ago(b.updated) },
      { h: '', r: 1, v: (b) => (b.status === 'running' ? `<button class="btn btn--sm btn--danger-outline" data-pause="${b.id}">Pause</button>` : '') }
    ], r.rows), `<button class="btn btn--danger btn--sm" id="kill2">Pause all (platform)</button>`);
    main().addEventListener('click', async (e) => { const p = e.target.closest('[data-pause]'); if (p) act(p, () => NX.post(`/api/admin/bots/${p.dataset.pause}/pause`), 'Bot paused'); });
    $('#kill2').addEventListener('click', async (e) => { if (await NX.confirm({ title: 'Pause every bot?', body: 'All users are notified.', confirm: 'Pause all', danger: true })) act(e.currentTarget, () => NX.post('/api/admin/kill-switch'), 'All bots paused'); });
  };
  V.transactions = async () => {
    const t = sessionStorage.getItem('adm-tx') || '';
    const r = await NX.get('/api/admin/transactions?type=' + encodeURIComponent(t));
    const types = ['', 'Deposit', 'Withdraw', 'Fund', 'Sweep', 'Swap', 'Approval', 'Loan'];
    main().innerHTML = card('Transactions', `<div class="chips mb-16" id="tf">${types.map((x) => `<button class="chip" data-t="${x}" aria-pressed="${x === t}">${x || 'All'}</button>`).join('')}</div>` + table([
      { h: 'When', v: (x) => when(x.date) }, { h: 'User', v: userCell }, { h: 'Type', v: (x) => tag('', esc(x.type)) }, { h: 'Amount', r: 1, v: (x) => `<span class="mono">${x.amount}</span> ${esc(x.token)}` },
      { h: 'Status', v: (x) => tag(x.status === 'confirmed' ? 'tag--green' : x.status === 'confirming' ? 'tag--amber' : 'tag--red', esc(x.status)) + (x.simulated ? ' ' + tag('', 'sim') : '') },
      { h: 'Signature', v: (x) => (x.explorer ? `<a class="link mono small" href="${x.explorer}" target="_blank" rel="noopener">${esc(F.short(x.sig))}</a>` : mono(x.sig)) }, { h: 'Note', v: (x) => `<span class="small">${esc(x.note || '')}</span>` }
    ], r.rows));
    $('#tf').addEventListener('click', (e) => { const c = e.target.closest('[data-t]'); if (c) { sessionStorage.setItem('adm-tx', c.dataset.t); route(); } });
  };

  /* ---------- KYC review ---------- */
  V.kyc = async () => {
    const st = sessionStorage.getItem('adm-kyc') || '';
    const r = await NX.get('/api/admin/kyc' + (st ? '?status=' + st : ''));
    const chips = [['', 'All'], ['submitted', 'Pending'], ['verified', 'Verified'], ['rejected', 'Rejected']];
    const KT = { none: '', submitted: 'tag--amber', verified: 'tag--green', rejected: 'tag--red' };
    const idBtns = (k) => (k.has_front ? `<button class="btn btn--sm btn--ghost" data-doc="${k.user_id}" data-side="front">View ID</button>${k.has_back ? ` <button class="btn btn--sm btn--ghost" data-doc="${k.user_id}" data-side="back">Back</button>` : ''}` : '<span class="caption">—</span>');
    main().innerHTML = card('Identity verification (KYC)', `${r.enabled === false ? `<div class="note note--warn mb-16">${I('alert')}<span>KYC is <b>off</b> — users aren’t asked to verify and loans don’t require it. Turn it on in <a class="link" href="#settings">Settings</a>.</span></div>` : ''}<p class="small muted mb-16">Review government-ID submissions for lending. Minimal PII is kept (name, country, DOB, ID type, last 4) plus the uploaded ID image. ${r.counts.submitted} pending.</p>` +
      `<div class="chips mb-16" id="kf">${chips.map(([k, l]) => `<button class="chip" data-k="${k}" aria-pressed="${k === st}">${l}</button>`).join('')}</div>` + table([
      { h: 'User', v: (k) => `<a class="link" href="#users/${k.user_id}">${esc(k.email || '#' + k.user_id)}</a>` },
      { h: 'Name', v: (k) => esc(k.full_name || '—') }, { h: 'Country', v: (k) => esc(k.country || '—') }, { h: 'DOB', v: (k) => esc(k.dob || '—') },
      { h: 'ID', v: (k) => `${esc(k.id_type || '—')} ••${esc(k.id_last4 || '')}` }, { h: 'Document', v: idBtns }, { h: 'Status', v: (k) => tag(KT[k.status] || '', k.status) },
      { h: 'Submitted', v: (k) => (k.submitted_at ? ago(k.submitted_at) : '—') },
      { h: '', r: 1, v: (k) => (k.status === 'submitted' ? `<button class="btn btn--sm btn--primary" data-ok="${k.user_id}">Verify</button> <button class="btn btn--sm btn--danger-outline" data-no="${k.user_id}">Reject</button>` : (k.status === 'rejected' ? `<button class="btn btn--sm" data-ok="${k.user_id}">Verify</button>` : '')) }
    ], r.rows, { emptyTitle: 'No KYC submissions', emptyText: 'Submissions appear here.' }));
    $('#kf').addEventListener('click', (e) => { const c = e.target.closest('[data-k]'); if (c) { sessionStorage.setItem('adm-kyc', c.dataset.k); route(); } });
    main().addEventListener('click', async (e) => {
      const dv = e.target.closest('[data-doc]');
      if (dv) { const r2 = await NX.act(dv, () => NX.get(`/api/admin/kyc/${dv.dataset.doc}/doc?side=${dv.dataset.side}`)); if (r2) panel(`Government ID — ${dv.dataset.side}`, `<div class="kyc-doc-modal"><img alt="ID document" src="${r2.dataUrl}"></div>`); return; }
      const ok = e.target.closest('[data-ok]');
      if (ok && await NX.confirm({ title: 'Verify this identity?', body: 'Confirm the uploaded ID matches the details, then verify. The user will be allowed to apply for loans.', confirm: 'Verify' })) act(ok, () => NX.post(`/api/admin/kyc/${ok.dataset.ok}/decide`, { decision: 'verified' }), 'Identity verified');
      const no = e.target.closest('[data-no]');
      if (no) { const v = await formDialog({ title: 'Reject KYC', fields: [{ name: 'note', label: 'Reason (shown to user)', type: 'textarea', required: true }], confirm: 'Reject', danger: true }); if (v) act(no, () => NX.post(`/api/admin/kyc/${no.dataset.no}/decide`, { decision: 'rejected', note: v.note }), 'KYC rejected'); }
    });
  };

  /* ---------- plans & subscriptions ---------- */
  const PLAN_FIELDS = (p = {}) => { const k = p.perks || {}; return [
    { name: 'name', label: 'Plan name', value: p.name || '', required: true },
    { name: 'slug', label: 'Slug (url id)', value: p.slug || '', hint: 'lowercase, e.g. pro' },
    { name: 'tagline', label: 'Tagline', value: p.tagline || '' },
    { name: 'price_usd', label: 'Monthly price (USD)', type: 'number', step: '0.01', value: p.price_usd != null ? p.price_usd : 0 },
    { name: 'price_yearly', label: 'Annual price (USD)', type: 'number', step: '0.01', value: p.price_yearly != null ? p.price_yearly : 0, hint: '0 = no annual option. Tip: 10× monthly = 2 months free.' },
    { name: 'interval', label: 'Default billing', type: 'select', value: p.interval || 'monthly', options: [['free', 'Free (no charge)'], ['monthly', 'Monthly'], ['yearly', 'Yearly']] },
    { name: 'maxBots', label: 'Max bots', type: 'number', value: k.maxBots != null ? k.maxBots : 2 },
    { name: 'maxBudget', label: 'Max budget per bot (USD)', type: 'number', value: k.maxBudget != null ? k.maxBudget : 1000 },
    { name: 'backtestRange', label: 'Backtest history', type: 'select', value: k.backtestRange || '90D', options: [['30D', '30 days'], ['90D', '90 days'], ['1Y', '1 year']] },
    { name: 'live', label: 'Allow live trading', type: 'select', value: k.live ? '1' : '0', options: [['0', 'No — paper only'], ['1', 'Yes — can go live']] },
    { name: 'advanced', label: 'Advanced strategies + auto-tuner', type: 'select', value: k.advanced ? '1' : '0', options: [['0', 'No'], ['1', 'Yes (Scalp, Breakout, tuner)']] },
    { name: 'prioritySupport', label: 'Priority support', type: 'select', value: k.prioritySupport ? '1' : '0', options: [['0', 'No'], ['1', 'Yes']] },
    { name: 'features', label: 'Feature bullets (one per line)', type: 'textarea', value: (k.features || []).join('\n'), hint: 'Shown on the pricing card' },
    { name: 'sort', label: 'Sort order', type: 'number', value: p.sort != null ? p.sort : 0 }
  ]; };
  const toPlanBody = (v) => ({ name: v.name, slug: v.slug, tagline: v.tagline, price_usd: +v.price_usd || 0, price_yearly: +v.price_yearly || 0, interval: v.interval, sort: +v.sort || 0,
    perks: { maxBots: +v.maxBots || 1, maxBudget: +v.maxBudget || 1, live: v.live === '1', advanced: v.advanced === '1', prioritySupport: v.prioritySupport === '1', backtestRange: v.backtestRange, features: String(v.features || '').split('\n').map((s) => s.trim()).filter(Boolean) } });
  V.plans = async () => {
    const r = await NX.get('/api/admin/plans');
    const subs = await NX.get('/api/admin/subscriptions');
    main().innerHTML = card('Subscription plans', `${r.enabled === false ? `<div class="note note--warn mb-16">${I('alert')}<span>Monetization is <b>off</b> — plans are hidden from users and nothing is gated. Turn it on in <a class="link" href="#settings">Settings</a>.</span></div>` : ''}<p class="small muted mb-16">Plans gate features (bot count, budget cap, advanced strategies, live trading) — <b>never profit</b>. Paid plans bill from the user's account balance. The Free plan is the fallback and can't be deleted.</p>` + table([
      { h: 'Plan', v: (p) => `<b>${esc(p.name)}</b> <span class="caption mono">${esc(p.slug)}</span>` },
      { h: 'Price', r: 1, v: (p) => (p.price_usd ? `<b class="mono">${usd(p.price_usd)}</b>/mo${p.price_yearly ? ` · <span class="mono">${usd(p.price_yearly)}</span>/yr` : ''}` : 'Free') },
      { h: 'Bots', r: 1, v: (p) => p.perks.maxBots }, { h: 'Budget cap', r: 1, v: (p) => usd(p.perks.maxBudget) },
      { h: 'Perks', v: (p) => `${p.perks.advanced ? tag('tag--pink', 'advanced') : ''} ${p.perks.live ? tag('tag--green', 'live') : ''}` },
      { h: 'Subs', r: 1, v: (p) => `<b class="mono">${r.subscribers[p.id] || 0}</b>` },
      { h: 'Status', v: (p) => (p.active ? tag('tag--green', 'Active') : tag('', 'Hidden')) },
      { h: '', r: 1, v: (p) => `<button class="btn btn--sm" data-edit="${p.id}">Edit</button> <button class="btn btn--sm btn--ghost" data-toggle="${p.id}" data-on="${p.active ? 0 : 1}">${p.active ? 'Hide' : 'Show'}</button>${p.slug !== 'free' ? ` <button class="btn btn--sm btn--danger-outline" data-del="${p.id}">Delete</button>` : ''}` }
    ], r.rows), `<button class="btn btn--primary btn--sm" id="npl">${I('plus', 'ic--sm')} New plan</button>`);
    main().insertAdjacentHTML('beforeend', card(`Subscribers · revenue ${usd(subs.revenue)} <span class="caption">(balance ${usd(subs.balanceRevenue)} · crypto ${usd(subs.cryptoRevenue)})</span>`, table([
      { h: 'User', v: userCell }, { h: 'Plan', v: (s) => esc(s.plan) }, { h: 'Status', v: (s) => tag(s.status === 'active' ? 'tag--green' : '', esc(s.status)) },
      { h: 'Price', r: 1, v: (s) => (s.price_usd ? usd(s.price_usd) + '/' + (s.interval === 'yearly' ? 'yr' : 'mo') : 'Free') },
      { h: 'Renews', v: (s) => (s.renews_at ? when(s.renews_at) : '—') }, { h: 'Auto', v: (s) => (s.auto_renew ? 'yes' : 'no') }
    ], subs.rows, { emptyTitle: 'No subscribers yet', emptyText: 'Paid subscriptions appear here.' })));
    main().insertAdjacentHTML('beforeend', card('Payments', table([
      { h: 'User', v: userCell }, { h: 'Plan', v: (p) => esc(p.plan) }, { h: 'Method', v: (p) => tag(p.provider === 'onchain' ? 'tag--pink' : '', esc(p.provider)) + (p.network ? ' <span class="caption">' + esc(p.network) + '</span>' : '') },
      { h: 'Amount', r: 1, v: (p) => usd(p.amount_usd) }, { h: 'Status', v: (p) => tag(p.status === 'confirmed' ? 'tag--green' : p.status === 'pending' ? 'tag--amber' : 'tag--red', esc(p.status)) },
      { h: 'Ref', v: (p) => mono(p.reference, 6) }, { h: 'When', v: (p) => ago(p.created_at) }
    ], subs.payments, { emptyTitle: 'No payments yet', emptyText: 'Crypto and balance payments appear here.' })));
    $('#npl').addEventListener('click', async () => { const v = await formDialog({ title: 'New plan', fields: PLAN_FIELDS(), confirm: 'Create', wide: true }); if (v) act(null, () => NX.post('/api/admin/plans', toPlanBody(v)), 'Plan created'); });
    main().addEventListener('click', async (e) => {
      const ed = e.target.closest('[data-edit]');
      if (ed) { const p = r.rows.find((x) => x.id === +ed.dataset.edit); const v = await formDialog({ title: 'Edit ' + esc(p.name), fields: PLAN_FIELDS(p), confirm: 'Save', wide: true }); if (v) act(ed, () => NX.patch('/api/admin/plans/' + p.id, toPlanBody(v)), 'Plan saved'); }
      const tg = e.target.closest('[data-toggle]');
      if (tg) act(tg, () => NX.patch('/api/admin/plans/' + tg.dataset.toggle, { active: tg.dataset.on === '1' }), 'Updated');
      const dl = e.target.closest('[data-del]');
      if (dl && (await NX.confirm({ title: 'Delete plan?', body: 'This removes the plan. Only works if it has no active subscribers.', confirm: 'Delete', danger: true }))) act(dl, () => NX.del('/api/admin/plans/' + dl.dataset.del), 'Plan deleted');
    });
  };

  /* ---------- platform ---------- */
  V.broadcast = async () => {
    main().innerHTML = card('Broadcast a notification', `<form id="bc" class="stack-lg" style="max-width:640px">
      <div class="field"><label class="label" for="bc-t">Title</label><input class="input" id="bc-t" maxlength="100" required></div>
      <div class="field"><label class="label" for="bc-b">Message</label><textarea class="textarea" id="bc-b" maxlength="500" required></textarea></div>
      <div class="field"><label class="label" for="bc-k">Category</label><select class="select" id="bc-k"><option value="bot">Product / bots</option><option value="security">Security</option><option value="transfer">Money & loans</option><option value="price">Market</option></select></div>
      <label class="switch"><input type="checkbox" id="bc-e"><span class="switch__track"></span><span class="small">Also email every active user (with their anti-phishing code)</span></label>
      <div><button class="btn btn--primary" type="submit">${I('send')} Send to all users</button></div></form>`);
    $('#bc').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!await NX.confirm({ title: 'Send to every active user?', body: 'This appears instantly in their notification centre.', confirm: 'Send' })) return;
      const r = await NX.act($('#bc .btn'), () => NX.post('/api/admin/broadcast', { title: $('#bc-t').value, body: $('#bc-b').value, type: $('#bc-k').value, email: $('#bc-e').checked }));
      if (r) { NX.toast(`Sent to ${r.sent} users`); e.target.reset(); }
    });
  };
  V.status = async () => {
    const s = await NX.get('/api/status');
    main().innerHTML = card('System status', `<p class="small muted mb-16">Changes are pushed live to every user’s header status dot and the public status page.</p>` + table([
      { h: 'Component', v: (c) => `<b>${esc(c.name)}</b>` },
      { h: 'State', v: (c) => `<select class="select" data-st="${esc(c.name)}" style="width:auto;min-height:38px">${[['green', 'Operational'], ['amber', 'Degraded'], ['red', 'Outage']].map(([k, l]) => `<option value="${k}" ${k === c.state ? 'selected' : ''}>${l}</option>`).join('')}</select>` },
      { h: 'Note (public)', v: (c) => `<input class="input" data-note="${esc(c.name)}" value="${esc(c.note || '')}" style="min-height:38px" placeholder="e.g. Elevated latency">` },
      { h: '', r: 1, v: (c) => `<button class="btn btn--sm btn--primary" data-save="${esc(c.name)}">Save</button>` }
    ], s.components));
    main().addEventListener('click', (e) => { const b = e.target.closest('[data-save]'); if (!b) return; const n = b.dataset.save; act(b, () => NX.patch('/api/admin/status/' + encodeURIComponent(n), { state: $(`[data-st="${CSS.escape(n)}"]`).value, note: $(`[data-note="${CSS.escape(n)}"]`).value }), 'Status updated'); });
  };
  V.mailbox = async () => {
    const r = await NX.get('/api/admin/mailbox');
    main().innerHTML = card('Mailbox (outgoing email)', `<p class="small muted mb-16">Every email the platform sends. Without SMTP configured (see README), mail is only logged here and in the server console — useful for testing verification codes.</p>` +
      (r.rows.length ? r.rows.map((m) => `<details class="card" style="padding:14px;margin-bottom:8px"><summary class="row between" style="cursor:pointer;list-style:none"><span class="small"><b>${esc(m.subject)}</b> → ${esc(m.to_email)}</span><span class="row" style="gap:8px">${tag(m.status === 'sent' ? 'tag--green' : m.status === 'failed' ? 'tag--red' : '', m.status)}<span class="caption">${ago(m.created_at)}</span></span></summary><div class="mail-body">${esc(m.body)}</div>${m.error ? `<p class="hint hint--error mt-8">${esc(m.error)}</p>` : ''}</details>`).join('') : NX.empty('No mail yet', 'Emails appear here as users sign up and transact.')));
  };
  V.audit = async () => {
    const qv = sessionStorage.getItem('adm-audit') || '';
    const r = await NX.get('/api/admin/audit?q=' + encodeURIComponent(qv));
    main().innerHTML = card('Audit log', `<input class="input mb-16" id="aq" placeholder="Filter by action, email or target…" value="${esc(qv)}">` + table([
      { h: 'When', v: (a) => when(a.created_at) }, { h: 'Actor', v: (a) => esc(a.actor || 'system') }, { h: 'Action', v: (a) => `<span class="mono small">${esc(a.action)}</span>` },
      { h: 'Target', v: (a) => esc(a.target || '') }, { h: 'Details', v: (a) => `<span class="mono tiny faint">${esc((a.meta || '').slice(0, 120))}</span>` }, { h: 'IP', v: (a) => esc(a.ip || '') }
    ], r.rows));
    let t; $('#aq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { sessionStorage.setItem('adm-audit', e.target.value); route(); }, 400); });
    const inp = $('#aq'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  };
  V.settings = async () => {
    const { settings: s } = await NX.get('/api/admin/settings');
    const row = (k, label, desc, type = 'bool') => `<div class="setting-row"><div class="setting-row__text"><h4>${label}</h4><p>${desc}</p></div>${type === 'bool' ? `<label class="switch"><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}><span class="switch__track"></span><span class="sr-only">${label}</span></label>` : `<input class="input mono" data-k="${k}" data-num="${type === 'num'}" value="${esc(s[k])}" style="max-width:${type === 'num' ? '140px' : '360px'}">`}</div>`;
    main().innerHTML = card('Platform settings', `
      ${row('demo_mode', 'Demo mode', 'Shows verification codes on screen and allows simulated deposits/withdrawals and demo wallets. <b>Turn off in production.</b>')}
      ${row('registration_open', 'Registration open', 'Allow new sign-ups.')}
      ${row('invite_required', 'Invite code required', 'Require a valid invite code to register.')}
      ${row('live_trading_enabled', 'Live trading', 'Allow users to switch bots from paper to live (requires 2FA).')}
      ${row('maintenance_banner', 'Maintenance banner', 'Shown at the top of every app page. Leave empty to hide.', 'text')}
      ${row('paper_start_usdc', 'Starting paper USDC', 'Paper balance given to new users.', 'num')}
      ${row('paper_start_sol', 'Starting paper SOL', 'Paper SOL given to new users.', 'num')}
      ${row('withdraw_hold_hours', 'Whitelist hold (hours)', 'New whitelisted addresses unlock after this delay.', 'num')}
      ${row('referral_max_codes', 'Referral codes per user', 'Max active referral codes.', 'num')}
      ${row('referral_code_uses', 'Uses per referral code', 'How many people each code can invite.', 'num')}
      <h3 class="card__title mt-24">Security & approvals</h3>
      ${row('admin_2fa_required', 'Require 2FA for staff (optional)', 'Every loan officer / admin / super admin must use an authenticator app to open the admin console. Enable it on your own account first.')}
      ${row('dual_approval_threshold', 'Two-admin threshold (USD)', 'Loans, payouts and balance adjustments at or above this need a second, different admin. Collections always do.', 'num')}
      ${row('default_after_days', 'Default after (days overdue)', 'Loans this many days past due are marked defaulted.', 'num')}
      <h3 class="card__title mt-24">Treasury & trading</h3>
      ${row('treasury_solana', 'Treasury — Solana', 'Owner address (or Squads vault) that receives repayments and sends disbursements.', 'text')}
      ${row('treasury_evm', 'Treasury — EVM', 'Receives USDC/USDT repayments on Ethereum, Base, Arbitrum, BSC, Polygon.', 'text')}
      ${row('treasury_tron', 'Treasury — Tron', 'Receives USDT (TRC-20) repayments.', 'text')}
      ${row('live_bot_max_usd', 'Live bot funding cap (USD)', 'Maximum a user should fund a single live bot with.', 'num')}
      ${row('ai_copilot', 'AI Copilot (Claude)', 'Use Claude to parse strategies when ANTHROPIC_API_KEY is set; otherwise the rule-based parser is used.')}
      <h3 class="card__title mt-24">Monetization & compliance</h3>
      ${row('monetization_enabled', 'Subscription plans (monetization)', 'Master switch. When off, the Plans page and all plan limits are hidden and every feature is available to everyone — no subscriptions, no gating.')}
      ${row('crypto_payments_enabled', 'Crypto subscription payments', 'Let users pay for plans with crypto (NOWPayments checkout and/or on-chain USDC to the treasury).')}
      ${row('nowpayments_enabled', 'NOWPayments checkout', 'Hosted crypto checkout. Needs NOWPAYMENTS_API_KEY in the environment; in demo mode payments are simulated.')}
      ${row('current_terms_version', 'Current terms version', 'Bump to force every user to re-accept the Terms & Risk Disclosure.', 'text')}
      ${row('kyc_enabled', 'Identity verification (KYC)', 'Master switch. When off, users aren’t asked to upload an ID, the Identity tab is hidden, and loans/live never require KYC.')}
      ${row('kyc_required_for_loans', 'Require KYC for loans', 'Borrowers must upload a government ID and be verified before applying. (Only applies when KYC is on.)')}
      ${row('kyc_required_for_live', 'Require KYC for live trading', 'Users must be identity-verified before going live. (Only applies when KYC is on.)')}
      <div class="mt-16"><button class="btn btn--primary" id="ss">Save settings</button></div>`);
    $('#ss').addEventListener('click', (e) => {
      const body = {};
      $$('[data-k]').forEach((el) => { body[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.dataset.num === 'true' ? +el.value : el.value; });
      act(e.currentTarget, () => NX.patch('/api/admin/settings', body), 'Settings saved');
    });
  };

  /* ---------------- router & shell ---------------- */
  async function refreshCounts() {
    try { counts = await NX.get('/api/admin/overview'); } catch (e) { return; }
    SECTIONS.forEach((s) => { if (s.badge) { const b = $(`[data-badge="${s.id}"]`); if (b) b.textContent = counts[s.badge] || ''; } });
    const st = counts.status;
    $('#adm-status').innerHTML = `<span class="dot dot--${st.level} dot--pulse"></span>`; $('#adm-status').dataset.tip = st.label; $('#adm-status').dataset.tipPos = 'bottom';
    $('#adm-demo').hidden = !counts.settings.demo_mode;
  }
  async function route() {
    const [id, arg] = (location.hash.slice(1) || 'overview').split('/');
    const sec = SECTIONS.find((s) => s.id === id) || SECTIONS[0];
    $$('#adm-nav .nav-link').forEach((a) => a.toggleAttribute('aria-current', a.dataset.sec === sec.id));
    $$('#adm-nav .nav-link[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
    $('#adm-title').textContent = sec.label;
    document.title = sec.label + ' · NECTRA Admin';
    document.body.classList.remove('side-open');
    const m = main();
    const fresh = m.cloneNode(false); m.replaceWith(fresh); // drop old listeners
    fresh.innerHTML = '<div class="skel skel--title"></div><div class="skel skel--chart mt-16"></div>';
    try { await V[sec.id](arg); NX.hydrateIcons(main()); NX.initTabs(main()); }
    catch (e) { main().innerHTML = e.data && e.data.code === 'ADMIN_2FA_REQUIRED' ? `<section class="card center stack-lg" style="max-width:520px;margin:40px auto"><div class="feature__ic" style="margin:0 auto">${I('key2fa')}</div><h2>Two-factor authentication required</h2><p class="muted">This platform requires staff to use an authenticator app. Set it up on your account, then come back.</p><a class="btn btn--primary" href="/settings.html#security">Set up 2FA</a></section>` : `<div class="note note--danger">${I('alert')}<span>${esc(e.message)}</span></div>`; }
  }

  NX.pages = { admin: async () => {
    let me;
    try { me = await NX.get('/api/auth/me'); } catch (e) { me = {}; }
    if (!me.user || me.pending2fa) { location.href = '/login.html?next=admin'; return; }
    if (!me.user.staff) { document.body.innerHTML = `<div class="auth"><main class="auth__main"><section class="card auth__card center"><h1 class="auth__title">Admins only</h1><p class="auth__lead">Your account doesn’t have admin access.</p><a class="btn btn--primary" href="/dashboard.html">Back to the app</a></section></main></div>`; return; }
    NX.data.user = me.user;
    try { NX.data.tokens = (await NX.get('/api/market/tokens')).tokens; } catch (e) { /* */ }
    $('#adm-avatar').textContent = me.user.initials; $('#adm-avatar').title = `${me.user.email} · ${me.user.role.replace('_', ' ')}`;
    $('#adm-title').insertAdjacentHTML('afterend', `<span class="tag tag--pink">${esc(me.user.role.replace('_', ' '))}</span>`);
    $('#adm-nav').innerHTML = SECTIONS.map((s) => (s.g ? `<div class="nav-group">${s.g}</div>` : `<a class="nav-link" href="#${s.id}" data-sec="${s.id}">${I(s.icon)}<span>${s.label}</span>${s.badge ? `<b data-badge="${s.id}"></b>` : ''}</a>`)).join('');
    $('#adm-menu').addEventListener('click', () => document.body.classList.toggle('side-open'));
    window.addEventListener('hashchange', route);
    NX.stream();
    document.addEventListener('nx:notification', () => { refreshCounts(); });
    await refreshCounts();
    await route();
    setInterval(() => !document.hidden && refreshCounts(), 30000);
  } };
  document.addEventListener('DOMContentLoaded', () => NX.boot());
})();
