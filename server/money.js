/* ==========================================================================
   Money helpers — all lending math runs in integer cents.

   Amounts are stored in the database as dollars (REAL columns) but every value
   written by the lending code is an exact cent amount produced here, and every
   calculation converts to integer cents first, so no floating-point error can
   accumulate across instalments, late fees or repayments. Integer cents in a JS
   Number are exact up to 2^53 (~$90 trillion), so BigInt isn't needed.

   Loan policy (defined here, tested in test/money.test.js):
   - Interest: simple, fixed at origination: principal × APR × term_days / 365,
     rounded half-up to the cent. It does not accrue daily.
   - Prepayment: allowed at any time with no penalty. Because interest is fixed
     at origination there is no interest rebate for paying early.
   - Schedule: the total (principal + interest) is split into N equal instalments;
     the final instalment absorbs the rounding remainder so the sum is exact.
   - Late fee: once per instalment, after the grace period: late_fee_pct of that
     instalment's unpaid amount, rounded half-up to the cent.
   - Allocation: payments go to the oldest unpaid instalment first, late fee
     included. Anything beyond what is owed is returned as `excess` (never
     silently absorbed).
   ========================================================================== */
'use strict';

/** dollars (number|string) -> integer cents, half-up (with an epsilon for binary noise like 1.005) */
function toCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Invalid money amount: ' + v);
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * 100 + 1e-7);
}
/** integer cents -> dollars (exact two-decimal number) */
const fromCents = (c) => {
  if (!Number.isInteger(c)) throw new Error('Cents must be an integer: ' + c);
  return c / 100;
};
/** round any dollar amount to the cent */
const round2 = (v) => fromCents(toCents(v));
/** (cents × num / den) for non-negative integers, rounded half-up, exact via BigInt (no overflow) */
function mulDivCents(cents, num, den) {
  if (![cents, num, den].every(Number.isInteger) || cents < 0 || num < 0 || den <= 0) throw new Error('mulDivCents expects non-negative integers');
  const n = BigInt(cents) * BigInt(num), d = BigInt(den);
  return Number((n * 2n + d) / (2n * d));
}

/** Interest in cents: simple interest fixed at origination */
function interestCents(principal, aprPct, termDays) {
  // principal_c × apr% × days / (100 × 365); APR may have decimals, so scale it to an integer basis-points×100
  const aprMicro = Math.round(Number(aprPct) * 10000); // 12.5% -> 125000
  return mulDivCents(toCents(principal), aprMicro * Number(termDays), 100 * 10000 * 365);
}
/** Total owed in cents = principal + interest + late fees */
const owedCents = (l) => toCents(l.amount) + interestCents(l.amount, l.apr, l.term_days) + toCents(l.late_fees || 0);
const outstandingCents = (l) => Math.max(0, owedCents(l) - toCents(l.repaid || 0));

/** Split total cents into n instalments; the last one absorbs the remainder */
function splitCents(totalCents, n) {
  n = Math.max(1, Math.floor(n));
  const per = Math.floor(totalCents / n);
  const out = Array(n).fill(per);
  out[n - 1] = totalCents - per * (n - 1);
  return out;
}
/** Late fee in cents on an instalment's unpaid amount */
const lateFeeCents = (unpaidCents, pct) => mulDivCents(Math.max(0, unpaidCents), Math.round(Number(pct) * 10000), 100 * 10000);

/**
 * Allocate a payment across instalments, oldest first.
 * instalments: [{ id, amount, late_fee, paid }] in dollars. Returns per-instalment cents applied and excess.
 */
function allocate(paymentCents, instalments) {
  let left = paymentCents;
  const applied = [];
  for (const i of instalments) {
    if (left <= 0) break;
    const due = toCents(i.amount) + toCents(i.late_fee || 0) - toCents(i.paid || 0);
    if (due <= 0) continue;
    const pay = Math.min(due, left);
    left -= pay;
    applied.push({ id: i.id, cents: pay, settled: pay === due });
  }
  return { applied, excess: left };
}

module.exports = { toCents, fromCents, round2, interestCents, owedCents, outstandingCents, splitCents, lateFeeCents, allocate };
