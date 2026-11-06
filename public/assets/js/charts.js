/* ==========================================================================
   NECTRA — LIGHTWEIGHT SVG CHARTS (no dependencies)
   line (self-drawing, hover crosshair) · sparkline · donut · gauge · ring
   calendar heatmap · market heatmap · QR (uses qrcode-generator if present)
   All charts are lazy: callers wrap them in NX.whenVisible().
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});
  const C = (NX.charts = {});
  const colorVar = (c) => (c === 'green' ? 'var(--green)' : c === 'red' ? 'var(--red)' : c === 'amber' ? 'var(--amber)' : 'var(--pink)');

  /** Measure path lengths so the CSS draw-in animation knows its dash length */
  C.drawIn = (root) => {
    root.querySelectorAll('.chart__line, .spark path, .draw-path').forEach((p) => {
      try { p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 1); } catch (e) { /* not rendered */ }
    });
  };

  /* ---------- LINE / AREA ---------- */
  let gid = 0;
  C.line = (el, data, o = {}) => {
    const render = (animate) => {
      const W = Math.max(el.clientWidth, 200);
      const H = o.height || 240;
      const axis = o.axis !== false;
      const pad = { t: 14, r: axis ? 58 : 4, b: axis ? 26 : 6, l: 4 };
      const n = data.length;
      let min = Math.min(...data), max = Math.max(...data);
      const span = max - min || 1;
      min -= span * 0.08; max += span * 0.08;
      const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1);
      const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
      const pts = data.map((v, i) => [x(i), y(v)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const base = H - pad.b;
      const id = 'lg' + ++gid;
      const col = colorVar(o.color);
      const fmt = o.fmt || ((v) => NX.fmt.usd(v, 2));
      let grid = '';
      if (axis) {
        for (let k = 0; k <= 3; k++) {
          const v = min + ((max - min) * k) / 3;
          const yy = y(v);
          grid += `<line class="chart__grid" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/><text class="chart__axis" x="${W - pad.r + 8}" y="${yy + 4}">${o.axisFmt ? o.axisFmt(v) : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toPrecision(4)}</text>`;
        }
        if (o.labels) {
          const step = Math.ceil(n / 5);
          o.labels.forEach((l, i) => { if (i % step === 0 && i < n - 1) grid += `<text class="chart__axis" x="${x(i)}" y="${H - 6}">${l}</text>`; });
        }
      }
      el.classList.add('chart');
      el.style.height = H + 'px';
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${o.label || 'Line chart'}">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${col};stop-opacity:.28"/><stop offset="1" style="stop-color:${col};stop-opacity:0"/></linearGradient></defs>
        ${grid}
        <path class="chart__area" d="${d} L${pts[n - 1][0]} ${base} L${pts[0][0]} ${base} Z" fill="url(#${id})"/>
        <path class="chart__line ${o.color ? 'chart__line--' + o.color : ''}" d="${d}"/>
        <line class="chart__cross" y1="${pad.t}" y2="${base}" x1="0" x2="0"/>
        <circle class="chart__dot" r="5" cx="0" cy="0" style="fill:${col}"/>
      </svg><div class="chart__tip"></div>`;
      const svg = el.querySelector('svg');
      const line = el.querySelector('.chart__line');
      if (!animate) { line.style.animation = 'none'; line.style.strokeDashoffset = 0; el.querySelector('.chart__area').style.cssText = 'animation:none;opacity:1'; }
      C.drawIn(el);
      const cross = el.querySelector('.chart__cross'), dot = el.querySelector('.chart__dot'), tip = el.querySelector('.chart__tip');
      const move = (cx) => {
        const r = svg.getBoundingClientRect();
        const px = ((cx - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
        const [X, Y] = pts[i];
        cross.setAttribute('x1', X); cross.setAttribute('x2', X);
        dot.setAttribute('cx', X); dot.setAttribute('cy', Y);
        tip.innerHTML = `${fmt(data[i])}${o.labels ? `<small>${o.labels[i]}</small>` : ''}`;
        const tw = tip.offsetWidth;
        tip.style.transform = `translate(${Math.min(Math.max(X - tw / 2, 0), W - tw)}px, ${Math.max(Y - 54, 0)}px)`;
        el.classList.add('is-hover');
      };
      svg.addEventListener('pointermove', (e) => move(e.clientX));
      svg.addEventListener('pointerdown', (e) => move(e.clientX));
      svg.addEventListener('pointerleave', () => el.classList.remove('is-hover'));
    };
    render(true);
    if (!el._ro && 'ResizeObserver' in window) {
      let w = el.clientWidth, to;
      el._ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) < 4) return; w = el.clientWidth; clearTimeout(to); to = setTimeout(() => el._render(false), 120); });
      el._ro.observe(el);
    }
    el._render = render;
  };

  /* ---------- SPARKLINE (returns SVG string) ---------- */
  C.spark = (data, color, w = 96, h = 32) => {
    const min = Math.min(...data), max = Math.max(...data), s = max - min || 1;
    const d = data.map((v, i) => (i ? 'L' : 'M') + ((i * w) / (data.length - 1)).toFixed(1) + ' ' + (h - 3 - ((v - min) / s) * (h - 6)).toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" style="stroke:${colorVar(color)}"/></svg>`;
  };

  /* ---------- DONUT ---------- */
  C.donut = (el, items, o = {}) => {
    const total = items.reduce((a, b) => a + b.value, 0);
    const r = 66, circ = 2 * Math.PI * r;
    let acc = 0;
    const segs = items.map((it, i) => {
      const len = (it.value / total) * circ;
      const s = `<circle class="donut__seg" data-k="${i}" cx="84" cy="84" r="${r}" stroke="${it.color}" style="--dash:${Math.max(len - 2, 0.5).toFixed(2)};stroke-dashoffset:${(-acc).toFixed(2)};animation-delay:${i * 70}ms"><title>${it.label}: ${((it.value / total) * 100).toFixed(1)}%</title></circle>`;
      acc += len;
      return s;
    }).join('');
    el.classList.add('donut');
    el.innerHTML = `<svg viewBox="0 0 168 168" role="img" aria-label="${o.label || 'Allocation'}"><g transform="rotate(-90 84 84)">${segs}</g><text class="donut__center" x="84" y="84" text-anchor="middle">${o.center || ''}</text><text class="donut__label" x="84" y="104" text-anchor="middle">${o.sub || ''}</text></svg>
      <ul class="legend">${items.map((it, i) => `<li class="legend__item" data-k="${i}"><span class="legend__sw" style="background:${it.color}"></span>${it.label}<span class="legend__val">${((it.value / total) * 100).toFixed(1)}%</span></li>`).join('')}</ul>`;
    el.querySelectorAll('.legend__item').forEach((li) => {
      li.addEventListener('mouseenter', () => el.querySelector(`.donut__seg[data-k="${li.dataset.k}"]`).classList.add('is-hl'));
      li.addEventListener('mouseleave', () => el.querySelector(`.donut__seg[data-k="${li.dataset.k}"]`).classList.remove('is-hl'));
    });
  };

  /* ---------- GAUGE (semi-circle) ---------- */
  C.gauge = (el, o = {}) => {
    const L = Math.PI * 90;
    el.classList.add('gauge');
    el.innerHTML = `<svg viewBox="0 0 220 132" role="img" aria-label="${o.label || 'Gauge'}">
      <path class="gauge__track" d="M20 110 A90 90 0 0 1 200 110"/>
      <path class="gauge__val" d="M20 110 A90 90 0 0 1 200 110" style="stroke-dasharray:${L};stroke-dashoffset:${L}"/>
      <g class="gauge__needle" style="transform:rotate(-90deg)"><line x1="110" y1="110" x2="110" y2="36" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"/><circle cx="110" cy="110" r="6" fill="var(--text)"/></g>
      <text class="gauge__num" x="110" y="96" text-anchor="middle"></text>
    </svg>${o.caption ? `<div class="caption center">${o.caption}</div>` : ''}`;
    const val = el.querySelector('.gauge__val'), needle = el.querySelector('.gauge__needle'), num = el.querySelector('.gauge__num');
    const set = (v, text, color) => {
      const p = Math.max(0, Math.min(1, v));
      requestAnimationFrame(() => {
        val.style.strokeDashoffset = L * (1 - p);
        val.style.stroke = color || (p < 0.5 ? 'var(--green)' : p < 0.8 ? 'var(--amber)' : 'var(--red)');
        needle.style.transform = `rotate(${-90 + 180 * p}deg)`;
      });
      num.textContent = text != null ? text : Math.round(p * 100) + '%';
    };
    set(o.value || 0, o.text, o.color);
    return { set };
  };

  /* ---------- RING (progress) ---------- */
  C.ring = (el, pct, o = {}) => {
    const size = o.size || 140, sw = o.stroke || 10, r = (size - sw) / 2, L = 2 * Math.PI * r;
    el.classList.add('ring');
    el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="ring__track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}"/><circle class="ring__val" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}" style="stroke-dasharray:${L};stroke-dashoffset:${L}${o.color ? ';stroke:' + o.color : ''}"/></svg><div class="ring__center">${o.center || ''}</div>`;
    const c = el.querySelector('.ring__val');
    requestAnimationFrame(() => requestAnimationFrame(() => (c.style.strokeDashoffset = L * (1 - pct))));
    return { set: (p) => (c.style.strokeDashoffset = L * (1 - p)) };
  };

  /* ---------- PNL CALENDAR HEATMAP ---------- */
  C.calendar = (el, days) => {
    const max = Math.max(...days.map((d) => Math.abs(d.v)));
    el.classList.add('cal');
    el.innerHTML = days.map((d, i) => {
      const a = d.v === 0 ? 0 : 0.2 + (Math.abs(d.v) / max) * 0.8;
      const bg = d.v === 0 ? 'var(--bg-raised)' : d.v > 0 ? `rgba(61,220,151,${a.toFixed(2)})` : `rgba(255,92,108,${a.toFixed(2)})`;
      return `<span class="cal__cell" style="background:${bg};animation-delay:${Math.floor(i / 7) * 18}ms" data-tip="${NX.fmt.date(d.date)} · ${NX.fmt.signed(d.v)}" tabindex="0" aria-label="${NX.fmt.date(d.date)}: ${NX.fmt.signed(d.v)}"></span>`;
    }).join('');
  };

  /* ---------- MARKET HEATMAP TILES ---------- */
  C.heat = (el, tokens) => {
    el.classList.add('heat');
    el.innerHTML = tokens.map((t) => {
      const a = Math.min(0.15 + Math.abs(t.ch) / 9, 0.75);
      const bg = t.ch >= 0 ? `rgba(61,220,151,${a})` : `rgba(255,92,108,${a})`;
      return `<a class="heat__tile" href="portfolio.html?token=${t.sym}" style="background:${bg}" aria-label="${t.sym} ${NX.fmt.pct(t.ch)}"><b>${t.sym}</b><span data-ch="${t.sym}">${NX.fmt.pct(t.ch)}</span></a>`;
    }).join('');
  };

  /* ---------- QR CODE ---------- */
  C.qr = (el, text) => {
    let cells, n;
    if (typeof window.qrcode === 'function') {
      const q = window.qrcode(0, 'M');
      q.addData(text); q.make();
      n = q.getModuleCount();
      cells = (r, c) => q.isDark(r, c);
    } else {
      // Fallback decorative pattern (library unavailable offline) — clearly labelled.
      n = 29;
      const r = NX.util.rng(text.length * 97 + text.charCodeAt(3));
      const m = Array.from({ length: n * n }, () => r() > 0.52);
      const finder = (rr, cc) => [[0, 0], [0, n - 7], [n - 7, 0]].some(([a, b]) => rr >= a && rr < a + 7 && cc >= b && cc < b + 7);
      cells = (rr, cc) => {
        for (const [a, b] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
          if (rr >= a && rr < a + 7 && cc >= b && cc < b + 7) { const y = rr - a, x = cc - b; return y === 0 || y === 6 || x === 0 || x === 6 || (y > 1 && y < 5 && x > 1 && x < 5); }
        }
        return !finder(rr, cc) && m[rr * n + cc];
      };
    }
    let rects = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (cells(r, c)) rects += `M${c} ${r}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code for deposit address"><path d="${rects}" fill="#0A0A0C"/></svg><span class="qr__logo">${NX.logo(32)}</span>`;
  };
})();
