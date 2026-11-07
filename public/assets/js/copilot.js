/* ==========================================================================
   NECTRA — AI COPILOT (chat → server-parsed STRATEGY CARD → review → deploy)
   POST /api/copilot/parse returns the strategy; nothing runs until the user
   clicks "Confirm & deploy" (POST /api/copilot/deploy).
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});
  const $ = (s, r = document) => r.querySelector(s);

  const SUGGESTIONS = [
    'Scalp SOL with a 0.5% take-profit and 0.3% stop',
    'Breakout buy ETH above its 24h high, trail 3%',
    'Momentum trade SOL with a 4% stop and trailing stop',
    'DCA $50 into SOL every Monday',
    'Grid trade SOL/USDC between $88 and $104',
    'Buy $100 of JUP if it dips 5%',
    'Stop all bots if portfolio drops 10%'
  ];

  function strategyCard(id, s) {
    return `<div class="strategy" data-strategy="${id}">
      <div class="strategy__head"><span class="strategy__name">${NX.icon('sparkles', 'ic--sm')} ${NX.esc(s.name)}</span><span class="row" style="gap:6px"><span class="tag tag--pink">${NX.esc(s.type)}</span><span class="tag tag--paper">Paper trading</span></span></div>
      <dl>${s.rows.map(([k, v]) => `<dt>${NX.esc(k)}</dt><dd>${NX.esc(v)}</dd>`).join('')}${s.budget ? `<dt>Budget</dt><dd>$${Number(s.budget).toLocaleString()} paper USDC</dd>` : ''}</dl>
      <div class="strategy__foot"><span class="fee-chip">${NX.icon('fuel')} Sim. fees <b>0.1% / trade</b></span>${s.type !== 'Guardrail' ? `<button class="btn btn--sm btn--ghost" data-st="backtest">${NX.icon('bar-chart', 'ic--sm')} Quick backtest</button><button class="btn btn--sm btn--ghost" data-st="tune">${NX.icon('sliders', 'ic--sm')} Auto-tune</button>` : ''}</div>
      <div class="strategy__bt" hidden></div>
      <div class="strategy__foot"><button class="btn btn--sm btn--ghost" data-st="discard">Discard</button><button class="btn btn--sm" data-st="edit">${NX.icon('edit', 'ic--sm')} Edit</button><button class="btn btn--sm btn--primary" data-st="deploy">${NX.icon('check', 'ic--sm')} Confirm &amp; deploy</button></div>
    </div>`;
  }

  /** Mounts a chat UI into an element with [data-chat] */
  NX.mountChat = (root) => {
    if (root._chat) return root._chat;
    root.innerHTML = `<div class="chat__log" role="log" aria-live="polite"></div>
      <div class="chat__suggest">${SUGGESTIONS.map((s) => `<button class="chip" type="button">${s}</button>`).join('')}</div>
      <form class="chat__form"><label class="sr-only" for="ct-${root.dataset.chat}">Message the AI Copilot</label><textarea id="ct-${root.dataset.chat}" rows="1" placeholder="Describe a strategy in plain English…" maxlength="500"></textarea><button class="btn btn--primary" aria-label="Send">${NX.icon('send')}</button></form>`;
    const log = root.querySelector('.chat__log');
    const ta = root.querySelector('textarea');
    let lastId = null, editing = false;
    const add = (html, who) => {
      const m = document.createElement('div');
      m.className = 'msg msg--' + who;
      m.innerHTML = who === 'ai' ? `<span class="msg__avatar">${NX.logo(18)}</span><div class="msg__body">${html}</div>` : `<div class="msg__bubble">${html}</div>`;
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    };
    add(`<div class="msg__bubble">Hi! I’m your NECTRA Copilot. Tell me what you want in plain English — I’ll turn it into a strategy you can <b>review before anything runs</b>. Bots start in <b>paper trading</b>.</div>`, 'ai');

    const send = async (text) => {
      if (!text.trim()) return;
      add(NX.esc(text), 'user');
      ta.value = ''; ta.style.height = '';
      const think = add(`<div class="msg__bubble"><span class="thinking"><span class="thinking__petals"><i></i><i></i><i></i></span><span class="typing">Thinking</span></span></div>`, 'ai');
      const t0 = Date.now();
      let res;
      try { res = await NX.post('/api/copilot/parse', { text, editOf: editing ? lastId : undefined }); editing = false; }
      catch (e) { think.querySelector('.msg__body').innerHTML = `<div class="msg__bubble">${NX.esc(e.message)}</div>`; return; }
      const badge = res.engine === 'claude' ? '<span class="tag tag--pink" title="Parsed by Claude">AI</span>' : '<span class="tag" title="Rule-based parser (no AI key configured)">Rules</span>';
      setTimeout(() => {
        if (!res.strategy) { think.querySelector('.msg__body').innerHTML = `<div class="msg__bubble">${NX.esc(res.clarification)} ${badge}</div>`; log.scrollTop = log.scrollHeight; return; }
        lastId = res.id;
        think.querySelector('.msg__body').innerHTML = `<div class="msg__bubble">${res.explanation ? NX.esc(res.explanation) + ' ' : 'Here’s what I understood. '}Please check every line — nothing runs until you confirm. ${badge}</div>${res.clarification ? `<div class="msg__bubble"><b>Question:</b> ${NX.esc(res.clarification)}</div>` : ''}${strategyCard(res.id, res.strategy)}`;
        log.scrollTop = log.scrollHeight;
      }, Math.max(0, (NX.reduced ? 100 : 900) - (Date.now() - t0)));
    };
    root.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
    ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
    root.querySelector('.chat__suggest').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) send(c.textContent); });
    log.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-st]');
      if (!b) return;
      const card = b.closest('[data-strategy]');
      const id = +card.dataset.strategy;
      const act = b.dataset.st;
      if (act === 'discard') { card.style.opacity = '.4'; card.querySelectorAll('button').forEach((x) => (x.disabled = true)); add('<div class="msg__bubble">Discarded. Want to try something else?</div>', 'ai'); }
      if (act === 'edit') { lastId = id; editing = true; ta.value = ''; ta.placeholder = 'Describe the change, e.g. “make it daily” or “use a 5% stop-loss”'; ta.focus(); }
      if (act === 'backtest') {
        const r = await NX.act(b, () => NX.post('/api/backtest', { strategyId: id, range: '90D' }));
        if (!r) return;
        const box = card.querySelector('.strategy__bt'); box.hidden = false;
        box.innerHTML = `<div style="padding:10px 14px"><div class="bt-mini" style="height:90px"></div><div class="row small mt-8" style="gap:14px"><span>Return <b class="mono ${r.totalReturn >= 0 ? 'up' : 'down'}">${NX.fmt.pct(r.totalReturn, 1)}</b></span><span>Buy &amp; hold <b class="mono">${NX.fmt.pct(r.buyAndHold, 1)}</b></span><span>Max DD <b class="mono down">${r.maxDrawdown.toFixed(1)}%</b></span><span>Win <b class="mono">${r.winRate.toFixed(0)}%</b></span><span>Sharpe <b class="mono">${r.sharpe.toFixed(2)}</b></span></div><p class="caption mt-8">90 days on ${r.source === 'synthetic' ? 'synthetic data (market data unavailable)' : 'real hourly prices (' + r.source + ')'}. Past performance ≠ future results.</p></div>`;
        NX.charts.line(box.querySelector('.bt-mini'), r.equity, { height: 90, axis: false, color: r.totalReturn >= 0 ? 'green' : 'red', label: 'Backtest equity' });
      }
      if (act === 'tune') {
        const r = await NX.act(b, () => NX.post('/api/copilot/tune', { strategyId: id, range: '90D' }));
        if (!r) return;
        const box = card.querySelector('.strategy__bt'); box.hidden = false;
        if (!r.tunable) { box.innerHTML = `<div style="padding:10px 14px"><p class="caption">This strategy type has no parameters to tune.</p></div>`; return; }
        const d = (r.after.totalReturn - r.before.totalReturn);
        const params = Object.entries(r.params).map(([k, v]) => `${k} ${v === true ? 'on' : v === false || v == null ? 'off' : v}`).join(' · ');
        box.innerHTML = `<div style="padding:10px 14px">
          <div class="row small" style="gap:18px;flex-wrap:wrap"><span>Return <b class="mono down">${NX.fmt.pct(r.before.totalReturn, 1)}</b> → <b class="mono ${r.after.totalReturn >= 0 ? 'up' : 'down'}">${NX.fmt.pct(r.after.totalReturn, 1)}</b></span><span>Max DD <b class="mono">${r.before.maxDrawdown.toFixed(1)}%</b> → <b class="mono down">${r.after.maxDrawdown.toFixed(1)}%</b></span><span>Buy &amp; hold <b class="mono">${NX.fmt.pct(r.buyAndHold, 1)}</b></span></div>
          <p class="small mt-8">${r.verdict === 'holds-up' ? `Best of <b>${r.tried}</b> settings tried: <b>${NX.esc(params)}</b> — and it also beat your settings on the held-out data.` : r.verdict === 'overfit' ? `The best of <b>${r.tried}</b> settings (${NX.esc(params)}) looked better on the tuning period but <b>did worse on the held-out data</b>, so it isn’t recommended — likely overfitting.` : `Your current settings already scored best among the <b>${r.tried}</b> tried.`}</p>
          <p class="caption mt-4">Numbers above are <b>out-of-sample</b>: settings were tuned on the first ${Math.round((1 - r.split.outOfSampleFraction) * 100)}% of the last 90 days of ${r.source === 'synthetic' ? 'synthetic data' : 'real prices'} and tested on the last ${Math.round(r.split.outOfSampleFraction * 100)}% they never saw. Trying ${r.tried} combinations makes a lucky fit likely — past results don’t predict future results. Fees are simulated at 0.1%; real Jupiter fills will differ. Still paper-only.</p>
          ${r.changed ? `<button class="btn btn--sm btn--primary mt-8" data-st="apply-tune">${NX.icon('check', 'ic--sm')} Apply tuned settings</button>` : ''}
        </div>`;
        NX.hydrateIcons(box);
      }
      if (act === 'apply-tune') {
        const r = await NX.act(b, () => NX.post('/api/copilot/tune', { strategyId: id, range: '90D', apply: true }));
        if (!r) return;
        b.outerHTML = `<span class="tag tag--green">${NX.icon('check')} Tuned settings applied</span>`;
        NX.hydrateIcons(card);
        add('<div class="msg__bubble">Applied the tuned settings to this draft. Re-run a backtest to compare, or deploy when you’re ready. Remember these were optimised on past data.</div>', 'ai');
      }
      if (act === 'deploy') {
        const ok = await NX.confirm({ title: 'Deploy in paper trading?', body: 'This strategy runs with simulated funds from your paper account against live prices. No real transaction is signed.', confirm: 'Confirm & deploy' });
        if (!ok) return;
        const r = await NX.act(b, () => NX.post('/api/copilot/deploy', { id }));
        if (!r) return;
        card.classList.add('is-deployed');
        card.querySelector('.strategy__foot:last-child').innerHTML = `<span class="tag tag--green">${NX.icon('check')} ${r.guard ? 'Guard active' : 'Deployed · paper'}</span><a class="btn btn--sm btn--ghost" href="${r.guard ? 'settings.html#risk' : 'dashboard.html'}">${r.guard ? 'View risk limits' : 'View on dashboard'}</a>`;
        NX.toast(r.guard ? `Portfolio guard set at −${r.guard}%` : 'Strategy deployed', { msg: r.guard ? 'All bots pause if triggered.' : 'Running in paper-trading mode.' });
        document.dispatchEvent(new CustomEvent('nx:refresh'));
      }
    });
    root._chat = { send };
    return root._chat;
  };

  NX.initCopilotPanel = () => { const el = $('#copilot [data-chat]'); if (el) NX.mountChat(el); NX.hydrateIcons(el); };
})();
