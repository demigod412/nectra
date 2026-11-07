/* Unit tests for the lending money math (node --test test/) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../server/money');

test('toCents rounds half-up and survives binary noise', () => {
  assert.equal(M.toCents(1.005), 101);
  assert.equal(M.toCents('19.99'), 1999);
  assert.equal(M.toCents(0.1 + 0.2), 30);
  assert.equal(M.toCents(-2.675), -268);
  assert.throws(() => M.toCents('abc'));
});

test('interest is simple and fixed at origination', () => {
  // $1,000 at 12% for 365 days = $120.00
  assert.equal(M.interestCents(1000, 12, 365), 12000);
  // $1,000 at 10% for 30 days = 8.2191.. -> $8.22
  assert.equal(M.interestCents(1000, 10, 30), 822);
  // fractional APR
  assert.equal(M.interestCents(250, 12.5, 90), 771); // 7.7054.. -> 7.71
  assert.equal(M.interestCents(500, 0, 30), 0);
  // very large principal stays exact (BigInt path)
  assert.equal(M.interestCents(1e9, 10, 365), 10000000000);
});

test('owed and outstanding include late fees and repayments', () => {
  const l = { amount: 1000, apr: 12, term_days: 365, late_fees: 5.5, repaid: 300.25 };
  assert.equal(M.owedCents(l), 112550);
  assert.equal(M.outstandingCents(l), 82525);
  assert.equal(M.outstandingCents({ ...l, repaid: 5000 }), 0);
});

test('instalments split exactly, last absorbs the remainder', () => {
  const parts = M.splitCents(100000, 3);
  assert.deepEqual(parts, [33333, 33333, 33334]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100000);
  assert.deepEqual(M.splitCents(1, 4), [0, 0, 0, 1]);
  for (const n of [1, 2, 6, 7, 12, 60]) assert.equal(M.splitCents(123457, n).reduce((a, b) => a + b, 0), 123457);
});

test('late fee is a percent of the unpaid instalment, rounded to the cent', () => {
  assert.equal(M.lateFeeCents(33334, 5), 1667); // 1666.7 -> 1667
  assert.equal(M.lateFeeCents(0, 5), 0);
  assert.equal(M.lateFeeCents(10000, 2.5), 250);
});

test('allocation pays oldest first, includes late fees, reports excess', () => {
  const inst = [
    { id: 1, amount: 100, late_fee: 5, paid: 0 },
    { id: 2, amount: 100, late_fee: 0, paid: 20 },
    { id: 3, amount: 100, late_fee: 0, paid: 0 }
  ];
  const r = M.allocate(M.toCents(150), inst);
  assert.deepEqual(r.applied, [{ id: 1, cents: 10500, settled: true }, { id: 2, cents: 4500, settled: false }]);
  assert.equal(r.excess, 0);
  const all = M.allocate(M.toCents(400), inst);
  assert.equal(all.applied.reduce((a, x) => a + x.cents, 0), 28500);
  assert.equal(all.excess, 11500);
});

test('a full schedule repaid in odd pieces lands exactly on zero', () => {
  const loan = { amount: 777.77, apr: 19.9, term_days: 91, late_fees: 0, repaid: 0 };
  const owed = M.owedCents(loan);
  const parts = M.splitCents(owed, 7);
  const inst = parts.map((c, k) => ({ id: k + 1, amount: c / 100, late_fee: 0, paid: 0 }));
  let paidC = 0;
  for (const piece of [0.01, 33.33, 100, 0.07, 250.5, 99.99]) {
    const r = M.allocate(M.toCents(piece), inst);
    for (const a of r.applied) { const i = inst.find((x) => x.id === a.id); i.paid = (M.toCents(i.paid) + a.cents) / 100; }
    paidC += M.toCents(piece) - r.excess;
  }
  const rest = M.allocate(owed - paidC, inst);
  assert.equal(rest.excess, 0);
  for (const a of rest.applied) { const i = inst.find((x) => x.id === a.id); i.paid = (M.toCents(i.paid) + a.cents) / 100; }
  assert.equal(inst.reduce((s, i) => s + M.toCents(i.amount) - M.toCents(i.paid), 0), 0);
});
