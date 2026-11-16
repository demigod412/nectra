/* ==========================================================================
   Referral Program — Single source of truth for tiers, instant transactional
   accrual, idempotency, and pending → settled payout execution.
   ========================================================================== */
'use strict';
const { q, tx, now, getSettings } = require('./db');
const { notify } = require('./events');
const M = require('./money');

// Single source of truth for tiers shared by API and accrual
const TIERS = [
  { name: 'Bronze', at: 1, rateBps: 500, pct: 5, perk: '5% of plan payments and loan interest' },
  { name: 'Silver', at: 5, rateBps: 1000, pct: 10, perk: '10% of plan payments and loan interest' },
  { name: 'Gold', at: 10, rateBps: 2000, pct: 20, perk: '20% + early features' },
  { name: 'Petal', at: 25, rateBps: 3000, pct: 30, perk: '30% + priority support' }
];

const tierFor = (uses) => {
  const count = Number(uses) || 0;
  return [...TIERS].reverse().find((t) => count >= t.at) || TIERS[0];
};

const rateFor = (uses) => tierFor(uses).pct;
const rateBpsFor = (uses) => tierFor(uses).rateBps;
const usesFor = (earnerId) => q.val('SELECT COUNT(*) FROM users WHERE referred_by = ?', earnerId) || 0;

/**
 * Accrue referral commission inside the exact same database transaction
 * as the generating event (loan interest, plan fee, repayment).
 * Idempotent on (source_type, source_id).
 */
function accrue(sourceUserId, sourceType, sourceId, basisAmount) {
  if (getSettings().referral_payout_enabled === false) return null;
  const basis = Number(basisAmount) || 0;
  if (basis <= 0) return null;

  const referee = q.get('SELECT id, referred_by FROM users WHERE id = ?', sourceUserId);
  if (!referee || !referee.referred_by || referee.referred_by === referee.id) return null;

  const referrer = q.get('SELECT id FROM users WHERE id = ?', referee.referred_by);
  if (!referrer) return null;

  // Sybil check: wallets shared between referee and referrer
  const shared = q.val(`SELECT 1 FROM wallets a JOIN wallets b ON LOWER(a.address) = LOWER(b.address)
    WHERE a.user_id = ? AND b.user_id = ? AND a.verified = 1 AND b.verified = 1 LIMIT 1`, referrer.id, referee.id);
  if (shared) return null;

  const uses = usesFor(referrer.id);
  const rateBps = rateBpsFor(uses);
  const amount = M.round2(basis * rateBps / 10000);
  if (amount <= 0) return null;

  const t = now();
  const res = q.run(`INSERT INTO referral_commissions(
      referrer_id, referee_id, source_type, source_id, basis_amount, rate_bps, amount, status, created_at
    ) VALUES(?,?,?,?,?,?,?,'pending',?)
    ON CONFLICT(source_type, source_id) DO NOTHING`,
    referrer.id, referee.id, String(sourceType), String(sourceId), basis, rateBps, amount, t);

  if (!res.changes) {
    // Already accrued for this exact source event
    return q.get('SELECT * FROM referral_commissions WHERE source_type = ? AND source_id = ?', String(sourceType), String(sourceId));
  }

  notify(referrer.id, 'transfer', 'Referral commission accrued',
    `$${amount.toFixed(2)} (${rateBps / 100}%) from a referred account. Payable after ${getSettings().referral_hold_days} days.`, 'referrals.html');

  return q.get('SELECT * FROM referral_commissions WHERE id = ?', res.lastInsertRowid || res.id);
}

/** Convenience wrapper for loan interest events */
function accrueInterest(loan, basisAmount = null) {
  if (!loan) return null;
  const basis = basisAmount != null ? basisAmount : M.fromCents(M.interestCents(loan.amount, loan.apr, loan.term_days));
  return accrue(loan.user_id, 'loan_interest', `loan:${loan.id}`, basis);
}

const voidFor = (sourceUserId, sourceId) => {
  q.run("UPDATE referral_commissions SET status = 'void' WHERE referee_id = ? AND (? IS NULL OR source_id = ?)",
    sourceUserId, sourceId || null, sourceId || null);
};

const payable = (referrerId) => {
  const holdMs = (getSettings().referral_hold_days || 14) * 864e5;
  const cutoff = now() - holdMs;
  return q.get(
    "SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total FROM referral_commissions WHERE referrer_id = ? AND status = 'pending' AND created_at <= ?",
    referrerId, cutoff) || { n: 0, total: 0 };
};

/** Payout execution: pending → settled transition with ledger credit */
function payout(referrerId) {
  const s = getSettings();
  const minPayout = s.referral_min_payout != null ? Number(s.referral_min_payout) : 25;
  const holdDays = s.referral_hold_days != null ? Number(s.referral_hold_days) : 14;
  const holdMs = holdDays * 864e5;
  const cutoff = now() - holdMs;

  return tx(() => {
    const eligible = q.all(
      "SELECT id, amount FROM referral_commissions WHERE referrer_id = ? AND status = 'pending' AND created_at <= ?",
      referrerId, cutoff);

    const total = M.round2(eligible.reduce((sum, row) => sum + row.amount, 0));
    if (!eligible.length || total <= 0) {
      throw Object.assign(new Error('Nothing is payable yet'), { status: 400 });
    }
    if (total < minPayout) {
      throw Object.assign(new Error(`Minimum payout is $${minPayout}`), { status: 400 });
    }

    const t = now();
    const ids = eligible.map((e) => e.id).join(',');
    q.run(`UPDATE referral_commissions SET status = 'settled', settled_at = ? WHERE id IN (${ids})`, t);
    q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_at) VALUES(?,?,?,?,?,?)',
      referrerId, total, 'referral', 'REF' + t, `Referral payout (${eligible.length} commissions settled)`, t);

    notify(referrerId, 'transfer', 'Referral payout sent',
      `$${total.toFixed(2)} was credited to your account balance.`, 'wallets.html');

    return { paid: total, count: eligible.length, settled_at: t };
  });
}

function start() {
  // Catch-up processor if any historical unrecorded transactions exist
}

module.exports = {
  TIERS,
  tierFor,
  rateFor,
  rateBpsFor,
  usesFor,
  accrue,
  accrueInterest,
  voidFor,
  payable,
  payout,
  start
};
