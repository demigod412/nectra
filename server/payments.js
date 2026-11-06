/* ==========================================================================
   Subscription payments — crypto only (no cards, no stored PII)
   - NOWPayments: hosted crypto checkout (user picks the coin). Confirmed via
     IPN webhook (HMAC-SHA512 verified).
   - On-chain USDC: user sends USDC to the treasury from a verified wallet;
     the existing treasury scan matches it to a pending payment.
   - In demo mode without API keys, crypto payments are simulated so the flow
     is testable end-to-end.
   Activation never touches the user's balance — the money goes to the treasury
   / gateway, and a confirmed payment just unlocks the plan.
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const { q, now, getSettings, J } = require('./db');
const { notify, notifyAdmins } = require('./events');

const NP_API = 'https://api.nowpayments.io/v1';
const npKey = () => process.env.NOWPAYMENTS_API_KEY || '';
const npIpnSecret = () => process.env.NOWPAYMENTS_IPN_SECRET || '';
const nowpaymentsConfigured = () => !!npKey();
const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');

/** Which checkout methods are available right now (for the UI). */
function methods() {
  const s = getSettings();
  if (s.monetization_enabled === false) return [];
  const out = [{ id: 'balance', label: 'Account balance', note: 'Pay from your NECTRA paper balance' }];
  if (s.crypto_payments_enabled) {
    const np = nowpaymentsConfigured() || s.demo_mode;
    if (np) out.push({ id: 'nowpayments', label: 'Crypto checkout', note: 'Pay with BTC, ETH, USDT and more (NOWPayments)' + (nowpaymentsConfigured() ? '' : ' — simulated in demo mode') });
    const chain = s.treasury_solana ? 'Solana' : s.treasury_evm ? 'EVM' : s.demo_mode ? 'Solana' : null;
    if (chain) out.push({ id: 'onchain', label: 'On-chain USDC', note: `Send USDC to the treasury on ${chain}` });
  }
  return out;
}

/* ---------- sorted-key JSON (NOWPayments IPN signing scheme) ---------- */
function sortedStringify(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
  if (obj && typeof obj === 'object') return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + sortedStringify(obj[k])).join(',') + '}';
  return JSON.stringify(obj);
}
function verifyIpn(body) {
  const secret = npIpnSecret(); if (!secret) return false;
  const sig = body && body.__sig; if (!sig) return false;
  const copy = { ...body }; delete copy.__sig;
  const hmac = crypto.createHmac('sha512', secret).update(sortedStringify(copy)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(sig))); } catch (e) { return false; }
}

async function createNowpaymentsInvoice(payment, plan) {
  if (!nowpaymentsConfigured()) return null; // caller falls back to simulated
  const res = await fetch(NP_API + '/invoice', {
    method: 'POST', headers: { 'x-api-key': npKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: payment.amount_usd, price_currency: 'usd', order_id: 'sub_' + payment.id,
      order_description: `NECTRA ${plan.name} subscription`,
      ipn_callback_url: publicUrl() ? publicUrl() + '/api/webhooks/nowpayments' : undefined,
      success_url: publicUrl() ? publicUrl() + '/plans.html?paid=1' : undefined,
      cancel_url: publicUrl() ? publicUrl() + '/plans.html' : undefined
    })
  });
  if (!res.ok) throw new Error('NOWPayments error ' + res.status);
  const j = await res.json();
  return { external_id: String(j.id), invoice_url: j.invoice_url };
}

/** Create a pending payment for a plan and return what the client needs to pay. */
async function createPayment(userId, plan, method, interval = 'monthly') {
  const s = getSettings();
  const plans = require('./plans');
  const qt = plans.quote(userId, plan, interval);     // prorated: charge after any current-plan credit
  const amount = qt.charge;
  const eff = qt.interval;
  const at = now();
  const reference = 'NX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const expires = at + 24 * 60 * 60000;
  if (method === 'nowpayments') {
    if (!s.crypto_payments_enabled) { const e = new Error('Crypto payments are disabled'); e.status = 400; throw e; }
    const id = q.run('INSERT INTO plan_payments(user_id, plan_id, provider, method_label, amount_usd, interval, reference, status, expires_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      userId, plan.id, 'nowpayments', 'Crypto checkout', amount, eff, reference, 'pending', at + 60 * 60000, at, at).id;
    const payment = q.get('SELECT * FROM plan_payments WHERE id = ?', id);
    if (nowpaymentsConfigured()) {
      const inv = await createNowpaymentsInvoice(payment, plan);
      q.run('UPDATE plan_payments SET external_id = ?, invoice_url = ? WHERE id = ?', inv.external_id, inv.invoice_url, id);
      return { paymentId: id, provider: 'nowpayments', invoiceUrl: inv.invoice_url, simulated: false, amount, interval: eff, credit: qt.credit };
    }
    return { paymentId: id, provider: 'nowpayments', simulated: true, amount, interval: eff, credit: qt.credit, reference }; // demo: confirm via /simulate
  }
  if (method === 'onchain') {
    if (!s.crypto_payments_enabled) { const e = new Error('Crypto payments are disabled'); e.status = 400; throw e; }
    const network = s.treasury_solana ? 'Solana' : s.treasury_evm ? 'EVM' : 'Solana';
    const address = network === 'Solana' ? (s.treasury_solana || 'TREASURY_NOT_SET') : (s.treasury_evm || 'TREASURY_NOT_SET');
    const id = q.run('INSERT INTO plan_payments(user_id, plan_id, provider, method_label, amount_usd, interval, pay_currency, pay_amount, pay_address, network, reference, status, expires_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      userId, plan.id, 'onchain', `On-chain USDC (${network})`, amount, eff, 'USDC', amount, address, network, reference, 'pending', expires, at, at).id;
    return { paymentId: id, provider: 'onchain', network, address, token: 'USDC', amount, interval: eff, credit: qt.credit, reference, simulated: s.demo_mode && !s.treasury_solana && !s.treasury_evm };
  }
  const e = new Error('Unknown payment method'); e.status = 400; throw e;
}

/** Mark a pending payment confirmed and activate the subscription (idempotent). */
function confirmPayment(payment, info = {}) {
  if (!payment || payment.status === 'confirmed') return false;
  const plans = require('./plans');
  const plan = plans.planRow(payment.plan_id);
  if (!plan) return false;
  q.run("UPDATE plan_payments SET status = 'confirmed', confirmed_at = ?, external_id = COALESCE(?, external_id), updated_at = ? WHERE id = ?", now(), info.external_id || null, now(), payment.id);
  plans.activate(payment.user_id, plan, { method: payment.method_label || payment.provider, ref: payment.reference, autoRenew: payment.provider === 'balance', interval: payment.interval || 'monthly' });
  notify(payment.user_id, 'transfer', `Payment confirmed — ${plan.name}`, `Your ${payment.provider === 'onchain' ? 'on-chain ' : ''}payment of $${payment.amount_usd.toFixed(2)} was confirmed and your plan is active.`, 'plans.html');
  return true;
}

/** NOWPayments IPN handler (already HMAC-verified by the caller or here). */
function handleNowpaymentsIpn(body) {
  if (nowpaymentsConfigured() && !verifyIpn(body)) { const e = new Error('Bad signature'); e.status = 401; throw e; }
  const orderId = String(body.order_id || '');
  const m = orderId.match(/^sub_(\d+)$/); if (!m) return { ok: true, ignored: true };
  const payment = q.get('SELECT * FROM plan_payments WHERE id = ?', +m[1]);
  if (!payment) return { ok: true, ignored: true };
  const st = String(body.payment_status || '');
  if (['confirmed', 'finished'].includes(st)) confirmPayment(payment, { external_id: body.payment_id });
  else if (['failed', 'expired', 'refunded'].includes(st)) q.run("UPDATE plan_payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", now(), payment.id);
  return { ok: true };
}

/** Called by the treasury scan: an incoming USDC transfer from `fromAddr`. */
function matchOnchainDeposit({ fromAddr, amount, network, userId }) {
  // match the most recent pending on-chain payment for this user with ~equal amount
  const p = q.get("SELECT * FROM plan_payments WHERE user_id = ? AND provider = 'onchain' AND status = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 1", userId, now());
  if (!p) return false;
  if (amount + 1e-6 < p.amount_usd * 0.995) return false; // must cover the price (small tolerance)
  confirmPayment(p, {});
  notifyAdmins('transfer', 'Subscription paid on-chain', `User #${userId} paid $${p.amount_usd.toFixed(2)} USDC on ${network} for a subscription.`, '/admin/#plans');
  return true;
}

module.exports = { methods, nowpaymentsConfigured, createPayment, confirmPayment, handleNowpaymentsIpn, matchOnchainDeposit, verifyIpn };
