/* ==========================================================================
   Subscription plans + billing (honest model)
   - Plans are admin-managed and gate real, deliverable perks (bot/budget
     limits, live trading, advanced strategies). They NEVER promise profit.
   - Paid plans are charged from the user's paper account balance (the ledger).
   - Free is the implicit fallback whenever no paid plan is active.
   ========================================================================== */
'use strict';
const { q, tx, now, J, getSettings } = require('./db');
const { notify } = require('./events');
const { sendMail } = require('./mail');

const DAY = 864e5;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/* Fallback perks for users on no paid plan (mirrors the seeded Free plan). */
const FREE_PERKS = { maxBots: 2, maxBudget: 1000, live: false, advanced: false, backtestRange: '90D', prioritySupport: false };
/* When monetization is turned off platform-wide, nothing is gated by a plan. */
const UNLIMITED_PERKS = { maxBots: 999, maxBudget: 1e9, live: true, advanced: true, backtestRange: '1Y', prioritySupport: true };

/** Is the subscription/plan system enabled platform-wide? */
const enabled = () => getSettings().monetization_enabled !== false;

/** Email a billing notice to a user who has an address and hasn't muted email. */
function mailUser(userId, subject, body) {
  const u = q.get('SELECT email, name, anti_phishing, prefs FROM users WHERE id = ?', userId);
  if (!u || !u.email) return;
  const prefs = J(u.prefs, {});
  if (prefs.emailNotif === false) return;
  sendMail(u.email, subject, body, u);
}
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

const periodMs = (interval) => (interval === 'yearly' ? YEAR : interval === 'free' ? 0 : MONTH);
const accountBalance = (userId) => q.val('SELECT COALESCE(SUM(amount), 0) FROM ledger WHERE user_id = ?', userId) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

/** The billing interval that actually applies (falls back to monthly if a plan has no annual price). */
function effInterval(plan, interval) {
  if (!plan.price_usd) return 'free';
  return interval === 'yearly' && plan.price_yearly > 0 ? 'yearly' : 'monthly';
}
/** The list price for a plan at a given interval. */
function priceFor(plan, interval) { return effInterval(plan, interval) === 'yearly' ? plan.price_yearly : (plan.price_usd || 0); }

/** Unused value of the user's current paid plan, pro-rated by time remaining (goodwill credit toward an upgrade). */
function prorationCredit(userId) {
  const sub = currentSub(userId);
  if (!sub || !sub.price_usd || !sub.renews_at) return 0;
  const frac = Math.max(0, Math.min(1, (sub.renews_at - now()) / periodMs(sub.interval)));
  return r2(sub.price_usd * frac);
}

/** Price breakdown for a plan + interval, applying any proration credit. */
function quote(userId, plan, interval) {
  const eff = effInterval(plan, interval);
  const price = priceFor(plan, interval);
  const credit = price > 0 ? Math.min(prorationCredit(userId), price) : 0; // never refunds beyond the new price here
  const rawCredit = price > 0 ? prorationCredit(userId) : 0;
  return { interval: eff, price: r2(price), credit: r2(credit), charge: r2(Math.max(0, price - credit)), surplus: r2(Math.max(0, rawCredit - price)) };
}

function planRow(id) { const p = q.get('SELECT * FROM plans WHERE id = ?', id); return p ? { ...p, perks: J(p.perks, {}) } : null; }
function freePlan() { const p = q.get("SELECT * FROM plans WHERE slug = 'free'"); return p ? { ...p, perks: J(p.perks, {}) } : null; }
function listPlans(includeInactive = false) {
  return q.all(`SELECT * FROM plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, price_usd, id`).map((p) => ({ ...p, perks: J(p.perks, {}) }));
}

/** The user's current active (or still-in-period cancelled) subscription, with its plan. */
function currentSub(userId) {
  const s = q.get(`SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','cancelled') AND (renews_at IS NULL OR renews_at > ?) ORDER BY id DESC LIMIT 1`, userId, now());
  if (!s) return null;
  const plan = planRow(s.plan_id);
  return { ...s, plan };
}

/** Perks in force for a user right now (paid plan if active, else Free). */
function perksFor(userId) {
  if (!enabled()) return { ...UNLIMITED_PERKS };   // monetization off → no plan gating
  const sub = currentSub(userId);
  if (sub && sub.plan && sub.plan.price_usd > 0) return { ...FREE_PERKS, ...sub.plan.perks };
  const free = freePlan();
  return { ...FREE_PERKS, ...(free ? free.perks : {}) };
}

/** Public snapshot for the pricing page. */
function statusFor(userId) {
  const sub = currentSub(userId);
  return {
    enabled: enabled(),
    plans: listPlans(),
    balance: accountBalance(userId),
    current: sub ? { id: sub.id, planId: sub.plan_id, planName: sub.plan ? sub.plan.name : '—', status: sub.status, price: sub.price_usd, interval: sub.interval, renewsAt: sub.renews_at, autoRenew: !!sub.auto_renew } : null,
    perks: perksFor(userId)
  };
}

/**
 * Activate a plan for a user WITHOUT charging the balance (payment already
 * settled elsewhere, or a free switch). Closes any open subscription.
 * autoRenew defaults off for one-off crypto payments (no stored method).
 */
function activate(userId, plan, { method = null, ref = null, autoRenew = false, interval = 'monthly' } = {}) {
  const at = now();
  const eff = effInterval(plan, interval);
  const recurring = priceFor(plan, eff);  // the price charged on each renewal
  const sub = tx(() => {
    q.run("UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status IN ('active','cancelled')", userId);
    const renews = eff === 'free' || !recurring ? null : at + periodMs(eff);
    const id = q.run('INSERT INTO subscriptions(user_id, plan_id, status, price_usd, interval, started_at, renews_at, auto_renew, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      userId, plan.id, 'active', recurring, eff, at, renews, autoRenew ? 1 : 0, at).id;
    return q.get('SELECT * FROM subscriptions WHERE id = ?', id);
  });
  notify(userId, 'transfer', `Subscribed to ${plan.name}`, recurring ? `Your ${plan.name} plan is active${method ? ' (' + method + ')' : ''}. ${eff === 'yearly' ? 'Renews yearly.' : 'Renews monthly.'}` : `You're on the ${plan.name} plan.`, 'plans.html');
  if (recurring) mailUser(userId, `Your NECTRA ${plan.name} subscription is active`,
    `Thanks for subscribing to NECTRA ${plan.name}.\n\nPlan: ${plan.name} (${eff} billing)\nPrice: $${recurring.toFixed(2)} / ${eff === 'yearly' ? 'year' : 'month'}${method ? `\nPaid with: ${method}` : ''}\nRenews: ${fmtDate(sub.renews_at)}\n\nYou can change or cancel your plan any time on the Plans page. Subscriptions unlock features — they don't guarantee any trading profit.`);
  return sub;
}

/**
 * Subscribe a user to a plan, charged from the account balance (instant path).
 * Switching to Free (or any $0 plan) just cancels the paid one — no charge, no refund.
 * Crypto payments go through server/payments.js instead and call activate().
 * Returns { ok, charged, sub } or throws { status, message }.
 */
function subscribe(userId, planId, { interval = 'monthly', by = null } = {}) {
  if (!enabled()) { const e = new Error('Subscriptions are not available right now'); e.status = 403; throw e; }
  const plan = planRow(planId);
  if (!plan || !plan.active) { const e = new Error('Plan not available'); e.status = 404; throw e; }
  const cur = currentSub(userId);
  const eff = effInterval(plan, interval);
  if (cur && cur.plan_id === plan.id && cur.status === 'active' && cur.interval === eff) { const e = new Error('You are already on this plan'); e.status = 400; throw e; }
  const qt = quote(userId, plan, interval);
  if (qt.charge > 0 && accountBalance(userId) < qt.charge - 1e-9) {
    const e = new Error(`Not enough account balance: this costs $${qt.charge.toFixed(2)}${qt.credit ? ` after a $${qt.credit.toFixed(2)} credit for your current plan` : ''}. Pay with crypto, or ask an admin to credit your balance.`); e.status = 400; throw e;
  }
  tx(() => {
    if (qt.charge > 0) q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', userId, -qt.charge, 'subscription', 'plan:' + plan.slug, `Subscription — ${plan.name} (${qt.interval})${qt.credit ? ` · incl. $${qt.credit.toFixed(2)} proration credit` : ''}`, by, now());
    if (qt.surplus > 0) q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', userId, qt.surplus, 'plan_credit', 'plan:' + plan.slug, `Unused plan credit from your previous subscription`, by, now());
    activate(userId, plan, { method: 'account balance', ref: 'plan:' + plan.slug, autoRenew: true, interval });
  });
  return { ok: true, charged: qt.charge, credit: qt.credit, interval: qt.interval, sub: currentSub(userId) };
}

/** Cancel auto-renew. Perks stay until the period ends, then fall back to Free. */
function cancel(userId) {
  const sub = currentSub(userId);
  if (!sub || sub.price_usd === 0) { const e = new Error('No paid subscription to cancel'); e.status = 400; throw e; }
  q.run("UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, cancelled_at = ? WHERE id = ?", now(), sub.id);
  notify(userId, 'transfer', 'Subscription cancelled', sub.renews_at ? `Your ${sub.plan.name} perks stay until ${new Date(sub.renews_at).toLocaleDateString()}, then you move to Free.` : 'You have moved to the Free plan.', 'plans.html');
  mailUser(userId, `Your NECTRA ${sub.plan.name} subscription was cancelled`,
    `Your ${sub.plan.name} subscription has been cancelled and will not renew.\n\n${sub.renews_at ? `You keep your current perks until ${fmtDate(sub.renews_at)}, then move to the Free plan.` : 'You are now on the Free plan.'}\nNo refund is issued for the current period. You can resubscribe any time.`);
  return { ok: true };
}

/** Billing job: renew due subscriptions (charge if balance covers), else expire → Free. */
function runRenewals() {
  if (!enabled()) return;
  const at = now();
  for (const s of q.all("SELECT * FROM subscriptions WHERE status IN ('active','cancelled') AND renews_at IS NOT NULL AND renews_at <= ?", at)) {
    const plan = planRow(s.plan_id);
    if (s.status === 'cancelled' || !s.auto_renew || !plan || !plan.active || s.price_usd === 0) {
      q.run("UPDATE subscriptions SET status = 'expired' WHERE id = ?", s.id);
      notify(s.user_id, 'transfer', 'Plan ended', `Your ${plan ? plan.name : ''} subscription ended — you’re now on Free.`, 'plans.html');
      mailUser(s.user_id, `Your NECTRA ${plan ? plan.name : ''} plan has ended`, `Your ${plan ? plan.name : ''} subscription has ended and you're now on the Free plan. Resubscribe any time on the Plans page.`);
      continue;
    }
    if (accountBalance(s.user_id) < s.price_usd - 1e-9) {
      q.run("UPDATE subscriptions SET status = 'expired' WHERE id = ?", s.id);
      notify(s.user_id, 'transfer', 'Subscription lapsed', `We couldn’t renew ${plan.name} — your balance didn’t cover $${s.price_usd.toFixed(2)}. You’re on Free until you resubscribe.`, 'plans.html');
      mailUser(s.user_id, `Couldn't renew your NECTRA ${plan.name} plan`, `We couldn't renew your ${plan.name} subscription because your account balance didn't cover the $${s.price_usd.toFixed(2)} ${s.interval === 'yearly' ? 'annual' : 'monthly'} fee.\n\nYou're on the Free plan until you resubscribe or top up your balance.`);
      continue;
    }
    tx(() => {
      q.run('INSERT INTO ledger(user_id, amount, kind, ref, note, created_by, created_at) VALUES(?,?,?,?,?,?,?)', s.user_id, -s.price_usd, 'subscription', 'renew:' + plan.slug, `Renewal — ${plan.name}`, null, at);
      q.run('UPDATE subscriptions SET renews_at = ?, started_at = ? WHERE id = ?', at + periodMs(s.interval), at, s.id);
    });
    notify(s.user_id, 'transfer', `${plan.name} renewed`, `$${s.price_usd.toFixed(2)} charged from your account balance.`, 'plans.html');
    mailUser(s.user_id, `Your NECTRA ${plan.name} plan renewed`, `Your ${plan.name} subscription renewed.\n\nAmount: $${s.price_usd.toFixed(2)} (${s.interval === 'yearly' ? 'annual' : 'monthly'})\nCharged from: account balance\nNext renewal: ${fmtDate(at + periodMs(s.interval))}\n\nManage or cancel any time on the Plans page.`);
  }
}

module.exports = { FREE_PERKS, enabled, planRow, freePlan, listPlans, currentSub, perksFor, statusFor, subscribe, activate, cancel, runRenewals, accountBalance, quote, priceFor, effInterval, prorationCredit };
