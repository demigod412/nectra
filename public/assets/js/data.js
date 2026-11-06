/* ==========================================================================
   NECTRA — client data store
   Live data comes from the API (/api/bootstrap + page endpoints + SSE).
   This file only keeps small helpers and the in-memory store shape.
   ========================================================================== */
(function () {
  'use strict';
  const NX = (window.NX = window.NX || {});

  function rng(seed) {
    let s = seed | 0 || 1;
    return function () { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }
  /** Seeded random walk — used only for decorative sparklines (e.g. leaderboard) */
  function series(n, start, vol, seed, drift) {
    const r = rng(seed); const out = [start];
    for (let i = 1; i < n; i++) out.push(Math.max(out[i - 1] * (1 + (r() - 0.5 + (drift || 0.02)) * vol), start * 0.2));
    return out;
  }
  NX.util = { rng, series };

  const D = (NX.data = {
    user: { name: '', initials: '··', email: '' },
    status: { level: 'green', label: 'All systems normal', components: [] },
    tokens: [], unread: 0, mainWallet: null, wallets: [], bots: [], settings: {}, solPrice: 0, accountBalance: 0
  });
  D.token = (s) => D.tokens.find((t) => t.sym === s);

  /** Load session-scoped data for app pages. Redirects to login when signed out. */
  NX.bootstrap = async () => {
    const b = await NX.get('/api/bootstrap');
    Object.assign(D, b);
    D.solPrice = (D.token('SOL') || {}).price || 0;
    return b;
  };
})();
