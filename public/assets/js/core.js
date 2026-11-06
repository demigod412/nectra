/* ==========================================================================
   NECTRA — CORE UI
   Icons · logo · formatting · app shell (sidebar/topbar/ticker/bottom nav/FAB)
   toasts · modals · confirm · menus · tabs · copy · count-up · ripple
   command palette · page transitions · theme · live price simulation
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  NX.$ = $; NX.$$ = $$;
  NX.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- safe storage (may throw in private mode) ---------- */
  NX.store = {
    get(k, d) { try { const v = localStorage.getItem('nx-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('nx-' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  /* ---------- ICONS (Lucide-style, 1.75 stroke) ---------- */
  const P = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    radar: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    deposit: '<path d="M12 3v12"/><path d="m6 9 6 6 6-6"/><path d="M5 21h14"/>',
    withdraw: '<path d="M12 15V3"/><path d="m18 9-6-6-6 6"/><path d="M5 21h14"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4M12 16h.01"/>',
    landmark: '<path d="M3 22h18"/><path d="M6 18v-7M10 18v-7M14 18v-7M18 18v-7"/><path d="M12 2 20 7H4z"/>',
    pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 11 5 12 8c1-3 2.5-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    bell: '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>',
    'bell-plus': '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M15 8h6M18 5v6"/><path d="M20.5 15.33c-.6-.6-1.3-1.4-1.8-2.83M14.5 3.3A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33A1 1 0 0 0 4 17h16"/>',
    settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    play: '<path d="M6 3l14 9-14 9z"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/>',
    smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'trending-up': '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    'trending-down': '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    swap: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    fuel: '<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    'bar-chart': '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    copytrade: '<circle cx="8" cy="8" r="4"/><path d="M2 21a6 6 0 0 1 12 0"/><path d="m16 11 2 2 4-4"/>',
    key2fa: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 10h6M9 14h4"/>'
  };
  NX.icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || P.info}</svg>`;
  NX.hydrateIcons = (root = document) => $$('i[data-i]', root).forEach((i) => { i.outerHTML = NX.icon(i.dataset.i, i.className); });

  /* ---------- LOGO (5-petal blossom, inline SVG) ---------- */
  let logoN = 0;
  NX.logo = (size = 28, cls = '') => {
    const id = 'nxl' + ++logoN;
    const petals = [0, 72, 144, 216, 288].map((a) => `<path transform="rotate(${a} 50 50)" d="M50 48C38.5 41 35 23 50 7c15 16 11.5 34 0 41z" fill="url(#${id}g)"/>`).join('');
    return `<svg class="logo ${cls}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="${id}g" x1="50" y1="7" x2="50" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFA9CF"/><stop offset=".5" stop-color="#F2559A"/><stop offset="1" stop-color="#B21F66"/></linearGradient><radialGradient id="${id}c"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".45" stop-color="#FFC4DF"/><stop offset="1" stop-color="#F2559A" stop-opacity="0"/></radialGradient></defs><g class="logo__petals">${petals}</g><circle class="logo__glow" cx="50" cy="50" r="15" fill="url(#${id}c)"/><circle cx="50" cy="50" r="4.5" fill="#FFF1F7"/></svg>`;
  };
  NX.hydrateLogos = (root = document) => $$('[data-logo]', root).forEach((el) => { el.outerHTML = NX.logo(+el.dataset.logo || 28, el.className); });

  /** Friendly empty-state blossom illustration */
  NX.emptyArt = () => `<svg class="empty__art" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="var(--pink-tint)"/><circle cx="60" cy="60" r="40" fill="none" stroke="var(--border-strong)" stroke-dasharray="3 6"/><g transform="translate(30 30) scale(.6)" opacity=".9">${[0, 72, 144, 216, 288].map((a) => `<path transform="rotate(${a} 50 50)" d="M50 48C38.5 41 35 23 50 7c15 16 11.5 34 0 41z" fill="none" stroke="var(--pink)" stroke-width="2.5"/>`).join('')}<circle cx="50" cy="50" r="5" fill="var(--pink)"/></g></svg>`;
  NX.empty = (title, text, cta) => `<div class="empty">${NX.emptyArt()}<h3>${title}</h3><p>${text}</p>${cta || ''}</div>`;

  /* ---------- FORMATTING ---------- */
  NX.fmt = {
    usd(v, d) {
      const dec = d != null ? d : Math.abs(v) >= 1 ? 2 : Math.abs(v) >= 0.01 ? 4 : 8;
      return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    },
    num(v, d = 2) { return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); },
    sol(v) { return v.toFixed(4); },
    pct(v, d = 2) { return (v > 0 ? '+' : '') + v.toFixed(d) + '%'; },
    signed(v) { return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); },
    short(a, n = 4) { return a.length > n * 2 + 1 ? a.slice(0, n) + '…' + a.slice(-n) : a; },
    time(d) { return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); },
    date(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); },
    compact(v) { return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v); }
  };
  /** Colored-initial fallback shown when no PNG is dropped in /assets/tokens */
  NX.tokText = (sym, cls, bg) => `<span class="tok ${cls}" style="background:${bg}" aria-hidden="true">${String(sym).slice(0, 3)}</span>`;
  /**
   * Token badge. Uses /assets/tokens/<SYMBOL>.png if you've dropped one in,
   * otherwise falls back to the colored initials. See assets/tokens/README.md.
   */
  NX.icons = { tokens: new Set(), wallets: new Set() };
  NX.tokIcon = (sym, cls = '') => {
    const t = NX.data && NX.data.token && NX.data.token(sym);
    const bg = t ? t.color : '#555';
    const s = String(sym).toUpperCase();
    if (!NX.icons.tokens.has(s)) return NX.tokText(s, cls, bg);
    return `<img src="/assets/tokens/${encodeURIComponent(s)}.png" alt="${s}" class="tok ${cls}" loading="lazy" style="background:${bg}" onerror="this.onerror=null;this.outerHTML=NX.tokText('${s}','${cls}','${bg}')">`;
  };
  /** Truncated address + copy button (✓ morph + toast) */
  NX.addr = (full, cls = '') => `<span class="addr ${cls}"><span class="mono" title="${full}">${NX.fmt.short(full)}</span>${NX.copyBtn(full, 'Address copied')}</span>`;
  NX.copyBtn = (text, msg = 'Copied to clipboard') => `<button type="button" class="copy-btn" data-copy="${text}" data-copy-msg="${msg}" aria-label="Copy">${NX.icon('copy', 'ic-copy')}${NX.icon('check', 'ic-check')}</button>`;
  NX.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- THEME ---------- */
  NX.setTheme = (t) => { document.documentElement.dataset.theme = t; NX.store.set('theme', t); };

  /* ---------- TOASTS ---------- */
  NX.toast = (title, opts = {}) => {
    let wrap = $('.toasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap); }
    const type = opts.type || 'success';
    const icon = { success: 'check', error: 'alert', warn: 'alert', info: 'sparkles' }[type];
    const t = document.createElement('div');
    const dur = opts.duration || 3600;
    t.className = 'toast toast--' + type;
    t.style.setProperty('--t', dur + 'ms');
    t.innerHTML = `${NX.icon(icon)}<div class="grow"><div class="toast__title">${title}</div>${opts.msg ? `<div class="toast__msg">${opts.msg}</div>` : ''}</div><button class="copy-btn" aria-label="Dismiss">${NX.icon('x')}</button>`;
    wrap.appendChild(t);
    const kill = () => { t.classList.add('is-out'); setTimeout(() => t.remove(), 260); };
    t.querySelector('button').onclick = kill;
    setTimeout(kill, dur);
  };

  /* ---------- MODALS (native <dialog>) ---------- */
  NX.modal = {
    open(id) {
      const d = typeof id === 'string' ? document.getElementById(id) : id;
      if (!d) return;
      if (!d.querySelector('.sheet-handle')) d.insertAdjacentHTML('afterbegin', '<div class="sheet-handle" aria-hidden="true"></div>');
      d.classList.remove('is-closing');
      if (!d.open) d.showModal();
      NX.hydrateIcons(d);
      d.dispatchEvent(new CustomEvent('nx:open'));
    },
    close(id) {
      const d = typeof id === 'string' ? document.getElementById(id) : id;
      if (!d || !d.open) return;
      if (NX.reduced) { d.close(); return; }
      d.classList.add('is-closing');
      setTimeout(() => { d.classList.remove('is-closing'); d.close(); }, 200);
    }
  };
  /** Promise-based confirm dialog */
  NX.confirm = ({ title, body, confirm = 'Confirm', danger = false, extra = '' }) => new Promise((res) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${title}</h2><button class="icon-btn icon-btn--sm" data-x aria-label="Close">${NX.icon('x')}</button></div><div class="modal__body"><p class="muted">${body}</p>${extra}</div><div class="modal__foot"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${confirm}</button></div>`;
    document.body.appendChild(d);
    let done = false;
    const finish = (v) => { if (done) return; done = true; NX.modal.close(d); setTimeout(() => d.remove(), 260); res(v); };
    d.addEventListener('click', (e) => { if (e.target.closest('[data-x]') || e.target === d) finish(false); if (e.target.closest('[data-ok]')) finish(true); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    NX.modal.open(d);
    d.querySelector('[data-ok]').focus();
  });

  /** Terms & Risk Disclosure — prompt once per load until accepted (money actions are server-gated regardless). */
  NX.maybePromptTerms = () => {
    const t = NX.data && NX.data.compliance && NX.data.compliance.terms;
    if (!t || t.accepted) return;
    const d = document.createElement('dialog');
    d.className = 'modal'; d.setAttribute('data-static', '');
    d.innerHTML = `<div class="modal__head"><h2 class="modal__title">${NX.icon('shield')} Terms &amp; Risk Disclosure</h2></div>
      <div class="modal__body">
        <p class="muted">Before trading or borrowing, please accept the current terms (v${NX.esc(t.version)}).</p>
        <ul class="small" style="line-height:1.6;padding-left:18px">
          <li><b>Trading carries risk.</b> Bots can lose money. Past or backtested performance never guarantees future results, and no plan or strategy promises profit.</li>
          <li><b>Non-custodial wallets.</b> NECTRA never holds your wallet keys and can’t move your funds except a capped, pre-authorised loan-collection approval you sign.</li>
          <li><b>Loans</b> require identity verification and are subject to collection on default per the signed approval.</li>
          <li>This is not financial advice.</li>
        </ul>
        <label class="row" style="gap:8px;margin-top:10px;align-items:flex-start"><input type="checkbox" id="terms-ck"><span class="small">I have read and accept the Terms &amp; Risk Disclosure.</span></label>
      </div>
      <div class="modal__foot"><button class="btn" data-later>Later</button><button class="btn btn--primary" id="terms-ok" disabled>Accept &amp; continue</button></div>`;
    document.body.appendChild(d);
    const ck = d.querySelector('#terms-ck'), ok = d.querySelector('#terms-ok');
    ck.addEventListener('change', () => (ok.disabled = !ck.checked));
    d.addEventListener('click', (e) => { if (e.target.closest('[data-later]')) { NX.modal.close(d); setTimeout(() => d.remove(), 260); } });
    ok.addEventListener('click', async () => {
      try { const r = await NX.post('/api/terms/accept'); NX.data.compliance.terms = r.terms; NX.modal.close(d); setTimeout(() => d.remove(), 260); NX.toast('Thanks — terms accepted'); }
      catch (e) { NX.toast(e.message || 'Could not record acceptance', { type: 'error' }); }
    });
    NX.modal.open(d);
  };

  /* ---------- COUNT-UP + flash ---------- */
  NX.countUp = (el, to, o = {}) => {
    if (!el) return;
    const dec = o.dec != null ? o.dec : +(el.dataset.dec || 2);
    const pre = o.prefix != null ? o.prefix : el.dataset.prefix || '';
    const suf = o.suffix != null ? o.suffix : el.dataset.suffix || '';
    const from = el._v != null ? el._v : o.from != null ? o.from : 0;
    const dur = o.dur || (el._v != null ? 700 : 1400);
    const fmt = (v) => pre + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
    if (o.flash && el._v != null && to !== el._v) {
      el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
      el.classList.add(to > el._v ? 'flash-up' : 'flash-down');
    }
    el._v = to;
    if (NX.reduced) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    cancelAnimationFrame(el._raf);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  };

  /** Run fn once when el scrolls into view (lazy charts / count-ups) */
  NX.whenVisible = (el, fn) => {
    if (!el) return;
    if (!('IntersectionObserver' in window)) return fn(el);
    const io = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { io.disconnect(); fn(el); } }), { rootMargin: '80px' });
    io.observe(el);
  };

  /** Apply staggered entrance index to children */
  NX.stagger = (root = document) => $$('.stagger', root).forEach((s) => Array.from(s.children).forEach((c, i) => c.style.setProperty('--i', i)));

  /* ---------- SEGMENTED TABS ---------- */
  function moveInd(tl) {
    const ind = tl.querySelector('.seg__ind');
    const sel = tl.querySelector('[aria-selected="true"]');
    if (!ind || !sel) return;
    ind.style.width = sel.offsetWidth + 'px';
    ind.style.transform = `translateX(${sel.offsetLeft}px)`;
  }
  NX.initTabs = (root = document) => {
    $$('[role="tablist"]', root).forEach((tl) => {
      if (tl._init) return; tl._init = true;
      if (tl.classList.contains('seg') && !tl.querySelector('.seg__ind')) tl.insertAdjacentHTML('afterbegin', '<span class="seg__ind" aria-hidden="true"></span>');
      const tabs = $$('[role="tab"]', tl);
      const select = (tab, focus) => {
        tabs.forEach((t) => {
          const on = t === tab;
          t.setAttribute('aria-selected', on);
          t.tabIndex = on ? 0 : -1;
          const p = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
          if (p) { p.hidden = !on; if (on) { p.classList.remove('tab-panel'); void p.offsetWidth; p.classList.add('tab-panel'); } }
        });
        if (focus) tab.focus();
        moveInd(tl);
        tl.dispatchEvent(new CustomEvent('nx:tab', { detail: { value: tab.dataset.value, tab } }));
      };
      tl._select = select;
      tabs.forEach((t, i) => {
        t.addEventListener('click', () => select(t));
        t.addEventListener('keydown', (e) => {
          const vertical = tl.getAttribute('aria-orientation') === 'vertical';
          const next = e.key === (vertical ? 'ArrowDown' : 'ArrowRight'), prev = e.key === (vertical ? 'ArrowUp' : 'ArrowLeft');
          if (next || prev) { e.preventDefault(); select(tabs[(i + (next ? 1 : -1) + tabs.length) % tabs.length], true); }
        });
      });
      const cur = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
      if (cur) { tabs.forEach((t) => (t.tabIndex = t === cur ? 0 : -1)); requestAnimationFrame(() => moveInd(tl)); }
    });
  };
  window.addEventListener('resize', () => $$('.seg[role="tablist"]').forEach(moveInd));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => $$('.seg[role="tablist"]').forEach(moveInd));

  /* ---------- RANGE fill ---------- */
  NX.syncRange = (r) => { const p = ((r.value - (r.min || 0)) / ((r.max || 100) - (r.min || 0))) * 100; r.style.setProperty('--p', p + '%'); };

  /* ---------- OTP / segmented code input ---------- */
  /**
   * NX.otp(container, {length, minLength, alnum, onComplete(code)})
   * Auto-advance, backspace, arrows, paste support.
   */
  NX.otp = (wrap, o = {}) => {
    const len = o.length || 6;
    const min = o.minLength || len;
    wrap.innerHTML = Array.from({ length: len }, (_, i) => `<input inputmode="${o.alnum ? 'text' : 'numeric'}" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" maxlength="1" aria-label="Character ${i + 1} of ${len}${i >= min ? ' (optional)' : ''}" ${i >= min ? 'class="is-optional" placeholder="·"' : 'placeholder=" "'} style="--k:${i}">`).join('');
    const ins = $$('input', wrap);
    const clean = (s) => (o.alnum ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : s.replace(/\D/g, ''));
    const val = () => ins.map((i) => i.value).join('');
    const changed = () => {
      wrap.classList.remove('is-invalid', 'is-valid');
      ins.forEach((i) => i.classList.toggle('is-filled', !!i.value));
      o.onChange && o.onChange(val());
      if (val().length === len) o.onComplete && o.onComplete(val());
    };
    ins.forEach((inp, i) => {
      inp.addEventListener('input', () => {
        const v = clean(inp.value);
        if (v.length > 1) { fill(v, i); return; }
        inp.value = v;
        if (v && ins[i + 1]) ins[i + 1].focus();
        changed();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && ins[i - 1]) { ins[i - 1].value = ''; ins[i - 1].focus(); changed(); e.preventDefault(); }
        if (e.key === 'ArrowLeft' && ins[i - 1]) ins[i - 1].focus();
        if (e.key === 'ArrowRight' && ins[i + 1]) ins[i + 1].focus();
        if (e.key === 'Enter') o.onEnter && o.onEnter(val());
      });
      inp.addEventListener('paste', (e) => { e.preventDefault(); fill(clean((e.clipboardData || window.clipboardData).getData('text')), 0); });
      inp.addEventListener('focus', () => inp.select());
    });
    function fill(str, start) {
      str.slice(0, len - start).split('').forEach((c, k) => (ins[start + k].value = c));
      const last = Math.min(start + str.length, len - 1);
      ins[last].focus();
      changed();
    }
    return {
      value: val,
      invalid() { wrap.classList.remove('is-invalid'); void wrap.offsetWidth; wrap.classList.add('is-invalid'); },
      valid() { wrap.classList.add('is-valid'); },
      clear() { ins.forEach((i) => (i.value = '')); ins[0].focus(); changed(); },
      focus() { ins[0].focus(); },
      fill: (s) => fill(clean(s), 0)
    };
  };

  /* ---------- APP SHELL ---------- */
  const NAV = [
    { g: 'Trade' },
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'bot', label: 'AI Bots', icon: 'bot' },
    { id: 'portfolio', label: 'Portfolio', icon: 'pie' },
    { g: 'Funds' },
    { id: 'wallets', label: 'Wallets', icon: 'wallet' },
    { id: 'deposit', label: 'Deposit', icon: 'deposit' },
    { id: 'withdraw', label: 'Withdraw', icon: 'withdraw' },
    { id: 'loans', label: 'Loans', icon: 'landmark' },
    { g: 'Safety' },
    { id: 'approvals', label: 'Approvals', icon: 'shield' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', badge: true },
    { id: 'settings', label: 'Settings', icon: 'settings' },
    { g: 'Grow' },
    { id: 'plans', label: 'Plans', icon: 'sparkles' },
    { id: 'referrals', label: 'Referrals', icon: 'gift' },
    { id: 'status', label: 'System status', icon: 'activity' }
  ];
  NX.NAV = NAV;
  // Hide monetization-only pages when the admin has turned monetization off.
  const visibleNav = () => NAV.filter((n) => n.id !== 'plans' || !(NX.data && NX.data.settings && NX.data.settings.monetization_enabled === false));
  const FAB_ITEMS = [
    { label: 'Deposit', icon: 'deposit', href: 'deposit.html' },
    { label: 'Withdraw', icon: 'withdraw', href: 'withdraw.html' },
    { label: 'New Bot', icon: 'bot', href: 'bot.html#new' },
    { label: 'Swap', icon: 'swap', action: 'swap' },
    { label: 'Apply for Loan', icon: 'landmark', href: 'loans.html#apply' }
  ];
  NX.unread = () => NX.data.unread || 0;
  /** Re-render the header status dot (called on SSE status updates) */
  NX.renderStatus = () => {
    const st = NX.data.status, b = $('.status-btn');
    if (!b) return;
    const tip = st.level === 'green' ? 'All systems normal' : st.label;
    b.dataset.tip = tip; b.setAttribute('aria-label', 'System status: ' + tip);
    b.innerHTML = `<span class="dot dot--${st.level} dot--pulse"></span>`;
  };

  function buildShell() {
    const page = document.body.dataset.page;
    const unread = NX.unread();
    const st = NX.data.status;
    const statusTip = st.level === 'green' ? 'All systems normal' : st.label;

    // Sidebar (tablet rail / desktop labelled)
    const side = document.createElement('aside');
    side.className = 'sidebar';
    side.setAttribute('aria-label', 'Primary');
    side.innerHTML = `
      <a class="brand" href="dashboard.html" aria-label="NECTRA home">${NX.logo(30)}<span class="brand__name">NECTRA</span></a>
      <button class="nav-link sidebar__collapse" data-rail-toggle aria-label="Expand navigation" aria-expanded="false">${NX.icon('menu')}<span>Collapse</span></button>
      <nav>${visibleNav().map((n) => n.g ? `<div class="nav-group">${n.g}</div>` : `<a class="nav-link" href="${n.id}.html" ${n.id === page ? 'aria-current="page"' : ''}>${NX.icon(n.icon)}<span>${n.label}</span>${n.badge && unread ? `<b class="nav-badge" data-unread>${unread}</b><i class="nav-dot" aria-hidden="true"></i>` : ''}</a>`).join('')}</nav>
      <div class="sidebar__foot">
        <div class="sidebar__card"><span class="tag tag--paper">${NX.icon('activity')} Paper trading</span><span>Bots simulate trades with mock funds until you switch to live.</span></div>
        <div class="sidebar__card"><span class="seed-note">${NX.icon('shield')} Non-custodial</span><span>NECTRA will never ask for your seed phrase.</span></div>
      </div>`;

    // Topbar
    const top = document.createElement('header');
    top.className = 'topbar';
    top.innerHTML = `
      <a class="brand" href="dashboard.html" aria-label="NECTRA home">${NX.logo(28)}<span class="brand__name">NECTRA</span></a>
      <button class="search-trigger" data-palette aria-label="Search coins, wallets, bots (Ctrl+K)">${NX.icon('search', 'ic--sm')}<span>Search coins, wallets, bots…</span><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></button>
      <div class="topbar__actions">
        <a class="status-btn" href="status.html" data-tip="${statusTip}" data-tip-pos="bottom" aria-label="System status: ${statusTip}"><span class="dot dot--${st.level} dot--pulse"></span></a>
        <a class="icon-btn" href="notifications.html" aria-label="Notifications, ${unread} unread">${NX.icon('bell')}${unread ? `<span class="badge-count" data-unread>${unread}</span>` : ''}</a>
        <a class="balance-pill" href="wallets.html" aria-label="Main wallet balance">${NX.icon('wallet', 'ic--sm')}<b data-main-sol>${(NX.data.mainWallet ? NX.data.mainWallet.sol : 0).toFixed(NX.data.mainWallet && NX.data.mainWallet.sol < 0.01 && NX.data.mainWallet.sol > 0 ? 4 : 2)}</b> SOL</a>
        <button class="icon-btn copilot-toggle" data-copilot-toggle aria-label="Toggle AI Copilot" aria-expanded="false" data-tip="AI Copilot" data-tip-pos="bottom">${NX.icon('sparkles')}</button>
        <div class="menu-anchor avatar-wrap"><button class="avatar" data-menu-btn aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">${NX.data.user.initials}</button>
          <div class="menu" role="menu">
            <div style="padding:10px 12px"><div class="strong">${NX.data.user.name}</div><div class="caption">${NX.data.user.email}</div></div>
            <div class="menu__sep"></div>
            <a class="menu__item" role="menuitem" href="settings.html">${NX.icon('settings')} Settings</a>
            <a class="menu__item" role="menuitem" href="referrals.html">${NX.icon('gift')} Invite friends</a>
            <button class="menu__item" role="menuitem" data-action="theme">${NX.icon('moon')} Toggle theme</button>
            <div class="menu__sep"></div>
            ${NX.data.user.role === 'admin' ? `<a class="menu__item" role="menuitem" href="/admin">${NX.icon('shield')} Admin console</a>` : ''}
            <button class="menu__item menu__item--danger" role="menuitem" data-action="logout">${NX.icon('logout')} Sign out</button>
          </div></div>
      </div>`;

    // Ticker
    const tick = document.createElement('div');
    tick.className = 'ticker';
    tick.setAttribute('aria-label', 'Live prices');
    const items = NX.data.tokens.map((t) => `<span class="ticker__item">${NX.tokIcon(t.sym, 'tok--sm')}<b>${t.sym}</b><span class="mono" data-px="${t.sym}">${NX.fmt.usd(t.price)}</span><span class="mono ${t.ch >= 0 ? 'up' : 'down'}" data-ch="${t.sym}">${NX.fmt.pct(t.ch)}</span></span>`).join('');
    tick.innerHTML = `<div class="ticker__track">${items}<span aria-hidden="true" style="display:contents">${items}</span></div>`;

    // Bottom nav (mobile)
    const bn = document.createElement('nav');
    bn.className = 'bottom-nav';
    bn.setAttribute('aria-label', 'Primary mobile');
    const bl = (id, label, icon) => `<a class="bn-link" href="${id}.html" ${id === page ? 'aria-current="page"' : ''}>${NX.icon(icon)}<span>${label}</span></a>`;
    bn.innerHTML = `${bl('dashboard', 'Home', 'dashboard')}${bl('bot', 'Bots', 'radar')}<div class="bn-fab-slot"><button class="fab" data-fab aria-label="Quick actions" aria-expanded="false">${NX.icon('plus')}</button></div>${bl('wallets', 'Wallets', 'wallet')}<button class="bn-link" data-more aria-label="More pages">${NX.icon('menu')}<span>More</span></button>`;

    // FAB (desktop) + menus
    const fabD = document.createElement('button');
    fabD.className = 'fab fab-desktop';
    fabD.setAttribute('data-fab', '');
    fabD.setAttribute('aria-label', 'Quick actions');
    fabD.setAttribute('aria-expanded', 'false');
    fabD.innerHTML = NX.icon('plus');
    const fItem = (f, k) => `<${f.href ? `a href="${f.href}"` : `button data-action="${f.action}"`} class="fab-menu__item" style="--k:${k}"><span class="fab-ic">${NX.icon(f.icon)}</span>${f.label}</${f.href ? 'a' : 'button'}>`;
    const fm = document.createElement('div');
    fm.className = 'fab-menu fab-menu--speed';
    fm.innerHTML = FAB_ITEMS.map(fItem).join('');
    const fs = document.createElement('div');
    fs.className = 'fab-menu fab-menu--sheet';
    fs.innerHTML = FAB_ITEMS.map(fItem).join('');
    const scrim = document.createElement('div');
    scrim.className = 'fab-scrim';

    // Copilot panel (chat engine lives in copilot.js)
    const cp = document.createElement('aside');
    cp.className = 'copilot';
    cp.id = 'copilot';
    cp.setAttribute('aria-label', 'AI Copilot');
    cp.innerHTML = `<div class="copilot__head"><h2>${NX.logo(22)} AI Copilot <span class="tag tag--paper">Paper</span></h2><button class="icon-btn icon-btn--sm" data-copilot-toggle aria-label="Close Copilot">${NX.icon('x')}</button></div><div class="chat" data-chat="panel"></div>`;

    // "More" sheet for mobile
    const more = document.createElement('dialog');
    more.className = 'modal';
    more.id = 'more-sheet';
    more.innerHTML = `<div class="modal__head"><h2 class="modal__title">All pages</h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${NX.icon('x')}</button></div><div class="modal__body"><div class="grid-2">${visibleNav().filter((n) => !n.g).map((n) => `<a class="option-card" href="${n.id}.html" ${n.id === page ? 'aria-pressed="true"' : ''}>${NX.icon(n.icon)}<span class="small strong">${n.label}</span></a>`).join('')}</div><button class="option-card" data-action="theme">${NX.icon('moon')}<span class="small strong">Toggle light / dark</span></button><p class="seed-note">${NX.icon('shield')} NECTRA will never ask for your seed phrase.</p></div>`;

    const aurora = document.createElement('div');
    aurora.className = 'aurora';
    aurora.setAttribute('aria-hidden', 'true');

    document.body.prepend(aurora);
    document.body.append(side, top, tick, bn, scrim, fm, fs, fabD, cp, more);

    // Copilot state
    if (NX.store.get('copilot', false) && window.innerWidth >= 1280) document.body.classList.add('copilot-open');
    syncCopilot();
  }

  function syncCopilot() {
    const open = document.body.classList.contains('copilot-open');
    $$('.topbar [data-copilot-toggle]').forEach((b) => b.setAttribute('aria-expanded', open));
    const cp = $('#copilot');
    if (cp) cp.inert = !open;
  }
  NX.toggleCopilot = (force) => {
    const open = force != null ? force : !document.body.classList.contains('copilot-open');
    document.body.classList.toggle('copilot-open', open);
    NX.store.set('copilot', open);
    syncCopilot();
    if (open) { NX.initCopilotPanel && NX.initCopilotPanel(); setTimeout(() => { const ta = $('#copilot textarea'); ta && ta.focus(); }, 300); }
  };

  /* ---------- FAB ---------- */
  function setFab(open) {
    const mobile = window.innerWidth < 768;
    $$('[data-fab]').forEach((f) => f.setAttribute('aria-expanded', open));
    $('.fab-menu--speed') && $('.fab-menu--speed').classList.toggle('is-open', open && !mobile);
    $('.fab-menu--sheet') && $('.fab-menu--sheet').classList.toggle('is-open', open && mobile);
    $('.fab-scrim') && $('.fab-scrim').classList.toggle('is-open', open);
    NX._fabOpen = open;
  }

  /* ---------- COMMAND PALETTE ---------- */
  function buildPalette() {
    const d = document.createElement('dialog');
    d.className = 'modal palette';
    d.id = 'palette';
    d.setAttribute('aria-label', 'Command palette');
    d.innerHTML = `<div class="palette__input">${NX.icon('search')}<input type="text" placeholder="Search coins, wallets, bots, actions…" aria-label="Command" role="combobox" aria-expanded="true" aria-controls="palette-list" autocomplete="off"><kbd>Esc</kbd></div><div class="palette__list" id="palette-list" role="listbox"></div><div class="palette__foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`;
    document.body.appendChild(d);
    const input = d.querySelector('input');
    const list = d.querySelector('.palette__list');
    const pages = visibleNav().filter((n) => !n.g).map((n) => ({ group: 'Pages', label: n.label, icon: n.icon, run: () => go(n.id + '.html') }));
    const actions = [
      { label: 'Deposit SOL', icon: 'deposit', run: () => go('deposit.html') },
      { label: 'Withdraw', icon: 'withdraw', run: () => go('withdraw.html') },
      { label: 'Create new bot with AI', icon: 'sparkles', run: () => go('bot.html#new') },
      { label: 'Pause all bots', icon: 'pause', run: () => NX.killSwitch() },
      { label: 'Connect a wallet', icon: 'link', run: () => go('wallets.html#connect') },
      { label: 'Copy main wallet address', icon: 'copy', run: () => NX.data.mainWallet ? NX.copy(NX.data.mainWallet.address, 'Main wallet address copied') : go('wallets.html#connect') },
      { label: 'Apply for a loan', icon: 'landmark', run: () => go('loans.html#apply') },
      { label: 'Sign out', icon: 'logout', run: () => NX.logout() },
      { label: 'Toggle AI Copilot', icon: 'panel', run: () => NX.toggleCopilot() },
      { label: 'Toggle light / dark theme', icon: 'moon', run: () => NX.setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light') },
      { label: 'Export history as CSV', icon: 'download', run: () => go('portfolio.html#export') }
    ].map((a) => ({ ...a, group: 'Actions' }));
    const tokens = NX.data.tokens.map((t) => ({ group: 'Tokens', label: `${t.sym} · ${t.name}`, html: `${NX.tokIcon(t.sym, 'tok--sm')}<span class="grow">${t.sym} <span class="muted">${t.name}</span></span><span class="mono small">${NX.fmt.usd(t.price)}</span><span class="mono small ${t.ch >= 0 ? 'up' : 'down'}">${NX.fmt.pct(t.ch)}</span>`, run: () => go('portfolio.html?token=' + t.sym) }));
    const wallets = (NX.data.wallets || []).map((w) => ({ group: 'Wallets', label: w.name + ' ' + w.address, html: `${NX.icon('wallet')}<span class="grow">${w.name}</span><span class="mono small muted">${NX.fmt.short(w.address)}</span>`, run: () => go('wallets.html') }));
    const bots = NX.data.bots.map((b) => ({ group: 'Bots', label: `${b.name} ${b.strategy} ${b.pair}`, html: `${NX.icon('bot')}<span class="grow">${b.name} <span class="muted">${b.strategy} · ${b.pair}</span></span>`, run: () => go('bot.html') }));
    const all = actions.concat(pages, tokens, bots, wallets);
    let cur = [], idx = 0;
    function go(h) { NX.modal.close('palette'); setTimeout(() => NX.navigate(h), 120); }
    function render() {
      const q = input.value.trim().toLowerCase();
      cur = (q ? all.filter((c) => c.label.toLowerCase().includes(q)) : actions.slice(0, 5).concat(pages.slice(0, 6), tokens.slice(0, 4))).slice(0, 40);
      idx = Math.min(idx, Math.max(cur.length - 1, 0));
      let g = '';
      list.innerHTML = cur.length ? cur.map((c, i) => {
        const head = c.group !== g ? `<div class="palette__group">${(g = c.group)}</div>` : '';
        return `${head}<button class="palette__item" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === idx}">${c.html || NX.icon(c.icon) + `<span class="grow">${c.label}</span>`}</button>`;
      }).join('') : `<div class="empty" style="padding:28px">${NX.icon('search', 'ic--lg')}<p>No results for “${NX.esc(input.value)}”</p></div>`;
      input.setAttribute('aria-activedescendant', cur.length ? 'pal-' + idx : '');
    }
    function hl() { $$('.palette__item', list).forEach((b) => b.setAttribute('aria-selected', +b.dataset.i === idx)); const el = $('#pal-' + idx); el && el.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', 'pal-' + idx); }
    input.addEventListener('input', () => { idx = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % cur.length; hl(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + cur.length) % cur.length; hl(); }
      if (e.key === 'Enter' && cur[idx]) { e.preventDefault(); cur[idx].run(); }
    });
    list.addEventListener('click', (e) => { const b = e.target.closest('.palette__item'); if (b) cur[+b.dataset.i].run(); });
    list.addEventListener('mousemove', (e) => { const b = e.target.closest('.palette__item'); if (b && +b.dataset.i !== idx) { idx = +b.dataset.i; hl(); } });
    d.addEventListener('nx:open', () => { input.value = ''; idx = 0; render(); setTimeout(() => input.focus(), 30); });
    d.addEventListener('click', (e) => { if (e.target === d) NX.modal.close(d); });
  }

  /* ---------- CLIPBOARD ---------- */
  NX.copy = (text, msg = 'Copied to clipboard', btn) => {
    const ok = () => {
      if (btn) { btn.classList.add('is-copied'); setTimeout(() => btn.classList.remove('is-copied'), 1600); }
      NX.toast(msg, { msg: text.length > 20 ? NX.fmt.short(text, 6) : text });
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { NX.toast('Copy failed', { type: 'error' }); }
      ta.remove();
    }
  };

  /* ---------- NAVIGATION with exit transition ---------- */
  NX.navigate = (href) => {
    if (NX.reduced) { location.href = href; return; }
    document.body.classList.add('is-leaving');
    setTimeout(() => (location.href = href), 140);
  };

  /* ---------- KILL SWITCH (global) ---------- */
  NX.killSwitch = async () => {
    const ok = await NX.confirm({ title: 'Pause all bots?', body: 'Every running bot stops placing new orders immediately. Open positions are kept — nothing is sold automatically. You can resume each bot individually.', confirm: 'Pause all bots', danger: true });
    if (!ok) return false;
    const r = await NX.act(null, () => NX.post('/api/bots/pause-all'));
    if (!r) return false;
    document.dispatchEvent(new CustomEvent('nx:bots-paused'));
    NX.toast(`${r.paused} bot${r.paused === 1 ? '' : 's'} paused`, { type: 'warn', msg: 'No new orders will be placed.' });
    return true;
  };
  NX.logout = async () => { try { await NX.post('/api/auth/logout'); } catch (e) { /* ignore */ } location.href = '/login.html'; };

  /* ---------- SWAP quick action (paper account) ---------- */
  function openSwap() {
    let d = $('#swap-sheet');
    const syms = NX.data.tokens.map((t) => t.sym);
    if (!d) {
      d = document.createElement('dialog');
      d.className = 'modal'; d.id = 'swap-sheet';
      const opts = (sel) => syms.map((s) => `<option ${s === sel ? 'selected' : ''}>${s}</option>`).join('');
      d.innerHTML = `<div class="modal__head"><h2 class="modal__title">Swap <span class="tag tag--paper">Paper</span></h2><button class="icon-btn icon-btn--sm" data-close aria-label="Close">${NX.icon('x')}</button></div>
      <div class="modal__body">
        <div class="field"><label class="label" for="sw-from">You pay</label><div class="row-nw"><input class="input mono grow" id="sw-from" inputmode="decimal" value="100"><select class="select" id="sw-fs" style="width:110px" aria-label="Pay token">${opts('USDC')}</select></div></div>
        <div class="field"><label class="label" for="sw-to">You receive (est.)</label><div class="row-nw"><input class="input mono grow" id="sw-to" readonly><select class="select" id="sw-ts" style="width:110px" aria-label="Receive token">${opts('SOL')}</select></div></div>
        <div class="row"><span class="fee-chip">${NX.icon('percent')} Fee + slippage <b>0.1%</b></span></div>
        <p class="note">${NX.icon('info')}<span>Swaps here use your <strong>paper</strong> balances at live prices. Live swaps are signed in your own wallet.</span></p>
      </div><div class="modal__foot"><button class="btn" data-close>Cancel</button><button class="btn btn--primary" data-swap-go>Swap</button></div>`;
      document.body.appendChild(d);
      const f = d.querySelector('#sw-from'), t = d.querySelector('#sw-to'), fs = d.querySelector('#sw-fs'), ts = d.querySelector('#sw-ts');
      const calc = () => { const a = NX.data.token(fs.value), b = NX.data.token(ts.value); t.value = a && b ? (((parseFloat(f.value) || 0) * a.price / b.price) * 0.999).toPrecision(6) : ''; };
      [f, fs, ts].forEach((x) => x.addEventListener('input', calc)); calc();
      const go = d.querySelector('[data-swap-go]');
      go.onclick = async () => {
        const r = await NX.act(go, () => NX.post('/api/paper/swap', { from: fs.value, to: ts.value, amount: parseFloat(f.value) }));
        if (r) { NX.modal.close(d); NX.toast('Swap complete', { msg: `Received ${r.received.toPrecision(6)} ${ts.value} (paper)` }); document.dispatchEvent(new CustomEvent('nx:refresh')); }
      };
    }
    NX.modal.open(d);
  }

  /* ---------- GLOBAL EVENT DELEGATION ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    // copy
    const cb = t.closest('[data-copy]');
    if (cb) { e.preventDefault(); NX.copy(cb.dataset.copy, cb.dataset.copyMsg || 'Copied to clipboard', cb); return; }
    // modals
    const op = t.closest('[data-open]');
    if (op) { e.preventDefault(); NX.modal.open(op.dataset.open); return; }
    const cl = t.closest('[data-close]');
    if (cl) { NX.modal.close(cl.closest('dialog')); return; }
    if (t.tagName === 'DIALOG' && t.classList.contains('modal') && !t.hasAttribute('data-static')) { NX.modal.close(t); return; }
    // menus
    const mb = t.closest('[data-menu-btn]');
    $$('.menu.is-open').forEach((m) => { if (!mb || m !== mb.nextElementSibling) { m.classList.remove('is-open'); m.previousElementSibling && m.previousElementSibling.setAttribute('aria-expanded', 'false'); } });
    if (mb) {
      const m = mb.nextElementSibling;
      const open = !m.classList.contains('is-open');
      m.classList.toggle('is-open', open);
      mb.setAttribute('aria-expanded', open);
      if (open) { const r = m.getBoundingClientRect(); m.classList.toggle('menu--up', r.bottom > window.innerHeight - 70); const f = m.querySelector('.menu__item'); f && f.focus({ preventScroll: true }); }
      return;
    }
    // palette
    if (t.closest('[data-palette]')) { NX.modal.open('palette'); return; }
    // copilot
    if (t.closest('[data-copilot-toggle]')) { NX.toggleCopilot(); return; }
    // rail
    if (t.closest('[data-rail-toggle]')) { const o = document.body.classList.toggle('rail-open'); t.closest('[data-rail-toggle]').setAttribute('aria-expanded', o); return; }
    if (document.body.classList.contains('rail-open') && !t.closest('.sidebar')) document.body.classList.remove('rail-open');
    // fab
    if (t.closest('[data-fab]')) { setFab(!NX._fabOpen); return; }
    if (t.closest('.fab-scrim')) { setFab(false); return; }
    if (t.closest('.fab-menu__item')) setFab(false);
    if (t.closest('[data-more]')) { NX.modal.open('more-sheet'); return; }
    // actions
    const act = t.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'theme') NX.setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
      if (a === 'swap') openSwap();
      if (a === 'kill') NX.killSwitch();
      if (a === 'logout') NX.logout();
      if (a === 'stop-impersonate') NX.act(t.closest('[data-action]'), () => NX.post('/api/auth/stop-impersonating')).then((r) => { if (r) location.href = '/admin/'; });
    }
    // internal link transitions
    const a = t.closest('a[href]');
    if (a && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.target !== '_blank') {
      const href = a.getAttribute('href');
      if (/^[\w-]+\.html/.test(href) && !href.startsWith(location.pathname.split('/').pop() + '#')) { e.preventDefault(); NX.navigate(href); }
    }
  });

  // Ripple on buttons
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn, .fab, .chip');
    if (!b || NX.reduced) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    const size = Math.max(r.width, r.height);
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    b.style.overflow = 'hidden';
    b.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && $('#palette')) { e.preventDefault(); const p = $('#palette'); p.open ? NX.modal.close(p) : NX.modal.open(p); }
    if (e.key === 'Escape') {
      if (NX._fabOpen) setFab(false);
      $$('.menu.is-open').forEach((m) => m.classList.remove('is-open'));
      document.body.classList.remove('rail-open');
    }
    // dialogs: animate close on Esc
  });
  document.addEventListener('cancel', (e) => { if (e.target.classList && e.target.classList.contains('modal')) { e.preventDefault(); NX.modal.close(e.target); } }, true);
  document.addEventListener('input', (e) => { if (e.target.classList.contains('range')) NX.syncRange(e.target); });

  // Restore page if user navigates back (bfcache)
  window.addEventListener('pageshow', () => document.body.classList.remove('is-leaving'));

  /* ---------- LIVE PRICES (mock websocket) ---------- */
  // WIRE: replace with a real price stream; call NX.updatePrice(sym, price, ch)
  NX.updatePrice = (sym, price, ch) => {
    $$(`[data-px="${sym}"]`).forEach((el) => {
      const up = price >= (el._p || price);
      el._p = price;
      el.textContent = NX.fmt.usd(price);
      el.classList.remove('px-flash-up', 'px-flash-down'); void el.offsetWidth;
      el.classList.add(up ? 'px-flash-up' : 'px-flash-down');
    });
    $$(`[data-ch="${sym}"]`).forEach((el) => { el.textContent = NX.fmt.pct(ch); el.classList.toggle('up', ch >= 0); el.classList.toggle('down', ch < 0); });
  };
  function startPrices() { NX.stream(); } // live prices/notifications arrive over SSE (api.js)

  /* ---------- REVEAL on scroll ---------- */
  NX.initReveal = () => {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window) || NX.reduced) { els.forEach((e) => e.classList.add('is-in')); return; }
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } }), { threshold: 0.15 });
    els.forEach((e) => io.observe(e));
  };

  /* ---------- BOOT ---------- */
  NX.boot = async () => {
    try { const ic = await NX.get('/api/icons'); NX.icons = { tokens: new Set(ic.tokens), wallets: new Set(ic.wallets) }; } catch (e) { /* fallback to colored initials */ }
    if (document.body.classList.contains('app')) {
      try { await NX.bootstrap(); } catch (e) { if (e.status !== 401 && e.data && e.data.code !== 'EMAIL_UNVERIFIED') document.body.insertAdjacentHTML('afterbegin', `<div class="note note--danger" style="margin:16px">${NX.icon('alert')}<span>${NX.esc(e.message)} — is the NECTRA server running?</span></div>`); return; }
      if (NX.data.user.prefs && NX.data.user.prefs.theme && !NX.store.get('theme')) NX.setTheme(NX.data.user.prefs.theme);
      buildShell(); startPrices();
      if (NX.data.impersonatedBy) {
        document.body.classList.add('impersonating');
        document.body.insertAdjacentHTML('afterbegin', `<div class="imp-bar" role="status">${NX.icon('eye')}<span>Viewing as <b>${NX.esc(NX.data.user.email || NX.data.user.name)}</b> — you’re ${NX.esc(NX.data.impersonatedBy)}. Actions you take are performed as this user and are logged.</span><button data-action="stop-impersonate">Exit to admin</button></div>`);
        NX.hydrateIcons(document.querySelector('.imp-bar'));
      }
      if (NX.data.settings.maintenance_banner) document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="note note--warn mb-16">${NX.icon('alert')}<span>${NX.esc(NX.data.settings.maintenance_banner)}</span></div>`);
      NX.maybePromptTerms();
      if (NX.data.settings.demo_mode) document.querySelector('.sidebar__foot').insertAdjacentHTML('afterbegin', `<div class="sidebar__card"><span class="tag tag--amber">${NX.icon('info')} Demo mode</span><span>Codes are shown on screen and chain actions without a connected wallet are simulated.</span></div>`);
    }
    buildPalette();
    NX.hydrateLogos();
    NX.hydrateIcons();
    NX.initTabs();
    NX.stagger();
    NX.initReveal();
    $$('.range').forEach(NX.syncRange);
    $$('[data-count]').forEach((el) => NX.whenVisible(el, () => NX.countUp(el, parseFloat(el.dataset.count))));
    $$('[data-addr]').forEach((el) => { el.outerHTML = NX.addr(el.dataset.addr, el.className); });
    const page = document.body.dataset.page;
    try { NX.pages && NX.pages[page] && (await NX.pages[page]()); } catch (e) { console.error(e); if (e.status !== 401) NX.toast(e.message || 'Something went wrong', { type: 'error' }); }
    NX.hydrateIcons();
    if (document.body.classList.contains('app') && document.body.classList.contains('copilot-open')) NX.initCopilotPanel && NX.initCopilotPanel();
  };
})();
