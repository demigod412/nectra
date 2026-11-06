# NECTRA Platform v2

AI trading platform with:

- a Claude-powered Copilot
- paper and live trading bots (live bots trade through Jupiter)
- wallet-verified, credit-scored loans with instalments
- collection approvals across Solana, EVM and Tron, plus BTC/LTC collateral escrow
- an admin console with staff roles and two-admin approvals
- admin-managed subscription plans (feature gating — never profit) with crypto payments (NOWPayments + on-chain USDC), bonus/trading-profit credits
- per-bot performance analytics, identity verification (KYC) and terms acceptance
- an installable app (PWA) with real push notifications

## Run

Requires Node.js 22.5+ (24 recommended).

```bash
cd nectra-platform
npm install
npm start            # or: npm run dev (auto-restart)
```

- **App:** http://localhost:3000
- **Admin:** http://localhost:3000/admin

The first run creates `data/` and prints four accounts. They're also saved to `data/first-run-credentials.txt`.

| Account | Role | What it can do |
|---|---|---|
| `admin@nectra.local` | super admin | Everything, including settings, roles, products, balance adjustments, kill switch |
| `ops@nectra.local` | admin | Approve, disburse, payouts, collections — the **second approver** |
| `officer@nectra.local` | loan officer | Review applications and recommend; can't move money |
| `demo@nectra.local` / `Demo-Trader-2026` | trader | Demo data |

Other commands:

- `npm test` starts a private server on a throwaway database and runs 50 end-to-end checks.
- `npm run reset` wipes `data/` (stop the server first).

## What's new in v2

### Loan safety
- **The wallet is re-checked at disbursement.** Balance, history and collection approvals are read live from the chain right before funds move. A failed re-check blocks disbursement. A super admin can override with a written, audit-logged reason.
- **One wallet per open loan, across all users.** This is checked when the client applies, submits and is approved.
- **Daily re-verification of active loans.** If the borrower revokes an approval or their wallet value drops below 25% of what they owe, the loan gets a **risk flag** and admins are notified.

### Collection approvals (your default-collection rule)
At application, the borrower signs a token approval for NECTRA's collector, **capped at exactly what they'll owe**. It's required on the loan wallet and on every other verified wallet holding USDC/USDT:

| Network | Mechanism |
|---|---|
| Solana | SPL delegate (USDC, USDT) |
| Ethereum, Base, Arbitrum, BSC, Polygon | ERC-20 `approve` (USDC, USDT) |
| Tron | TRC-20 `approve` (USDT) |
| **BTC, LTC** | **Approvals are impossible on UTXO chains.** Use the **collateral loan** product instead: the borrower deposits to a unique escrow address derived from an admin-held xpub, which the server can watch but never spend |
| Native SOL, ETH, TRX | Not approvable on any chain; approvals cover stablecoins |

How collection works:

1. On default, an admin requests a collection (Admin → loan → *Collect from approvals*).
2. A **second, different admin** approves it in the **Approvals queue**.
3. The collector key pulls up to the outstanding amount into the treasury and applies it to the loan. The borrower is notified.

Things to know:

- A borrower can still revoke an approval on-chain. That raises a risk flag and lowers their credit score.
- Taking funds from a customer's wallet is regulated in many jurisdictions. Get legal advice before using it.

### Admin security
- **Roles:** loan officer → admin → super admin. Every API route is permission-checked.
- **Optional staff 2FA (authenticator app):** Admin → Settings → *Require 2FA for staff*. It can only be turned on by someone who already has 2FA, so nobody gets locked out.
- **Two-admin approvals:** needed for loans, payouts and balance adjustments at or above the threshold (default $1,000, configurable), and for **every** collection. The requester can't approve their own request. Only super admins can approve balance adjustments.

### Loans v2
- **Instalments:** set per product. The schedule is created at disbursement.
- **Late fees:** a percentage of the overdue instalment after a grace period. Loans are marked defaulted after N days.
- **Reminders:** 3 days and 1 day before each due date, by in-app notification, email and **push**.
- **Credit score (300–850):** built from on-time and late instalments, repaid loans, defaults, account age and verified wallets. It scales each product's limit from 50% to 150%.
- **Collateral product:** BTC or LTC escrow at 150%, detected automatically through a public block explorer API.
- **Loan book:** outstanding, overdue, defaults, exposure per product, credit-score distribution, and CSV export.

### On-chain treasury
Set the treasury addresses in Admin → Settings. Use a Squads multisig vault for Solana.

- **Disbursement**, three ways:
  - credit the account balance
  - sign the USDC transfer with the treasury wallet in the admin console (it's verified on-chain)
  - paste a signature (e.g. from a Squads payout)

  Outgoing treasury transfers that match an approved loan are also **auto-linked**.
- **Repayments:** the client sends USDC/USDT from their verified wallet to the treasury on Solana, any of the 5 EVM networks, or Tron. It's detected automatically and applied to the oldest instalment. Unmatched deposits alert admins.

### Real data and AI
- **Live prices:** Jupiter Price API (Solana tokens) plus CoinGecko (BTC, ETH, LTC, TRX, BNB, POL). Pyth is used when `PYTH_API_KEY` is set, since the public Pyth endpoint now requires a key. The simulated feed is only a fallback.
- **Real hourly candles** for history and backtests: Binance, falling back to CoinGecko, and cached in SQLite. Backtests report the data source and a buy-and-hold comparison.
- **Strategy types:** DCA, Grid, Momentum, **Scalp** (fast small-target trades off a 9-period EMA), **Breakout** (buys new highs over a lookback window), Dip-buy, Mean-reversion, Copy-trader, Arbitrage and a portfolio Guardrail. Momentum/Scalp/Breakout/Dip-buy support an optional **trailing stop**.
- **Auto-tune** (`/api/copilot/tune`): the Copilot grid-searches a strategy's parameters over the real backtest history and picks the best by a drawdown-penalized score, showing before/after return, max drawdown and a buy-and-hold baseline. It's flagged clearly as *optimised on past data, which can overfit* — it is not a profit guarantee, and bots stay in paper mode until you deploy them.
- **Claude Copilot** (`ANTHROPIC_API_KEY`, model `claude-opus-5-5`):
  - Claude returns a validated *intent* through structured outputs.
  - The server builds the exact bot config from it, so a malformed config is impossible.
  - Server-side refusal fallback is enabled.
  - Without a key it uses the rule-based parser.
  - The Edit button sends the previous strategy as context.

### Live trading (dedicated bot wallets)
1. Admin → Settings → enable *Live trading*.
2. The user enables 2FA, then clicks **Go live** on a bot.
3. NECTRA creates a dedicated Solana wallet for that bot. Its key is encrypted with `MASTER_KEY`. The user funds it (capped by *Live bot funding cap*).
4. The same strategy logic executes real **Jupiter** swaps. Only confirmed swaps are recorded, and any failure pauses the bot.
5. **Withdraw** (2FA) sends everything back to the user's main wallet.

This is custodial for the bot wallet, by design. The UI says so.

### Apps and notifications
- **Installable PWA:** manifest, icons, and an offline-capable service worker (API calls are never cached).
- **Real Web Push (VAPID):** enable it in Settings → Preferences. It fires for every notification and respects the user's push preference. On iPhone, add NECTRA to the Home Screen first.

### Wallets
Phantom, Solflare, Backpack (Solana), MetaMask and Coinbase Wallet (EVM), TronLink (Tron), plus a browser demo wallet in demo mode. Ownership is always proven by a signed nonce. Approvals and revokes are **real transactions** signed in the user's wallet.

### Monetization (plans & subscriptions)
Admin-managed subscription plans gate **real, deliverable features — never profit**. No plan promises or increases trading returns; the pricing page and every confirmation say so.

- **Optional, with a master switch.** Admin → Settings → `monetization_enabled`. When **off**, the Plans page and nav entry disappear, every plan limit is lifted (all features available to everyone), subscribe/checkout/quote endpoints return 403, and renewals pause. Turn it back on and everything resumes. Crypto payments and NOWPayments have their own sub-toggles.
- **Billing emails** (via the existing mail pipeline; respect each user's email-notification preference and carry their anti-phishing code): a receipt when a subscription activates (new, upgrade, or crypto payment confirmed), a renewal receipt, a cancellation notice, and a lapse notice when a renewal can't be charged. Without SMTP configured they're logged to Admin → Mailbox.

- **Plans** (Admin → Plans & subscriptions): seeded with Free, Starter ($19/mo), Pro ($49/mo) and Elite ($149/mo). Each plan's perks are editable: max bots, max budget per bot, backtest history, advanced strategies (Scalp/Breakout + auto-tuner), live trading, priority support, and the feature bullets shown on the card. Create/edit/hide/delete your own; the Free plan is the fallback and can't be deleted.
- **Monthly or annual billing:** each paid plan has a monthly price and an optional annual price (`price_yearly`; default seed is 10× monthly = 2 months free). The Plans page has a Monthly/Annual toggle showing the yearly price and the savings; plans without an annual price stay monthly-only.
- **Proration on upgrades:** switching plan or interval credits the unused time on the current plan against the new one (`GET /api/plans/:id/quote` previews it; the checkout and confirmation show the credit and what you pay today). If the credit exceeds the new price, the surplus is returned to the account balance as a plan credit.
- **Subscribing** (user → Plans page): paid plans are charged from the user's **account balance** (paper USDC in this build) or via crypto (below). Cancelling keeps perks until the period ends, then falls back to Free. A background job renews due subscriptions at the stored interval price, or lapses them to Free if the balance won't cover it.
- **Gating** is enforced server-side: bot count and budget caps and advanced strategies at deploy, the auto-tuner, and live trading (`402` with an upgrade prompt otherwise).
- **Admin credits** (Admin → Users → Credit / adjust): credit a **bonus**, a **trading-profit** credit, or a correction to a user's balance. Credits at or above the dual-approval threshold still need a second super admin, and every entry is audit-logged. (This is a manual credit, not auto-generated profit.)

### Crypto subscription payments
Plans can be paid three ways (Plans page → a paid plan → choose a method):

- **Account balance** — instant, debits the paper ledger.
- **Crypto checkout (NOWPayments)** — hosted checkout where the user picks the coin (BTC/ETH/USDT/…). Set `NOWPAYMENTS_API_KEY` (and `NOWPAYMENTS_IPN_SECRET`, `PUBLIC_URL`) to go live; the IPN webhook (`/api/webhooks/nowpayments`, HMAC-SHA512 verified, CSRF-exempt) confirms the payment and activates the plan. Without a key, demo mode simulates a confirmed payment so the flow is testable.
- **On-chain USDC** — the user sends USDC to the treasury from a verified wallet; the existing treasury scan matches it to the pending payment and activates the plan.

Crypto payments go to the treasury/gateway (not the user's balance) and are one-off (auto-renew off; the user re-pays near expiry). Balance payments auto-renew. Toggles: `crypto_payments_enabled`, `nowpayments_enabled` (Admin → Settings → Monetization). Admin → Plans & subscriptions shows every payment and the balance-vs-crypto revenue split.

### Per-bot performance analytics
Each bot has a **performance** view (bar-chart icon on the AI Bots page → `/api/bots/:id/stats`): total return, realized/unrealized PnL, win rate, closed-trade count, profit factor, average win/loss, best/worst trade, fees paid, max drawdown, and an equity curve reconstructed from closed-trade PnL plus the open position. Honest framing: past performance doesn't predict future results.

### Identity & terms (compliance)
- **Terms & Risk Disclosure:** users accept the current terms version (prompted on load) before trading or borrowing; bump `current_terms_version` to force re-acceptance. Loan actions are gated server-side on acceptance.
- **KYC (manual government-ID upload + admin approval):** Settings → Identity collects minimal PII (name, country, DOB, ID type, **last 4 of the ID only** — full numbers are never stored) **plus a photo of the government ID** (front required, back optional). The image is downscaled client-side, validated (JPEG/PNG/WebP, ≤4 MB) and stored for reviewers only — never web-served. Admins review in **Admin → KYC review**: the queue lists submissions (without the image), **View ID** fetches the document on demand (`GET /api/admin/kyc/:id/doc`), and the admin verifies or rejects with a reason.
- **KYC is optional, with its own master switch** (`kyc_enabled`, Admin → Settings — like monetization). When **off**, users aren't asked to upload an ID, the Identity tab is hidden, submissions are rejected, and loans/live never require KYC regardless of the `kyc_required_*` flags. Those two flags only apply while KYC is on.

## Production checklist
1. `DEMO_MODE=0`. Set `MASTER_KEY` from a secrets manager and **back it up**.
2. Use dedicated RPCs: `SOLANA_RPC`, `RPC_*`, `TRON_API_KEY`. Configure SMTP. Set `COOKIE_SECURE=1` behind HTTPS (also required for push and wallets).
3. Set the treasury addresses (use a Squads vault) and the BTC/LTC xpubs. Fund the collector addresses (Admin → Treasury & keys) with gas.
4. Enable *Require 2FA for staff*. Set the two-admin threshold. Give staff the least role they need.
5. Back up `data/nectra.db` (SQLite, WAL mode).
6. For crypto subscriptions set `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` and `PUBLIC_URL` (for the IPN callback), and enable crypto payments in Settings. For on-chain USDC, set the treasury addresses.
7. Review the Terms & Risk Disclosure copy, set `current_terms_version`, and decide whether KYC is required for loans/live. Wire a real KYC provider if you need more than manual review.
8. Get legal and compliance advice for lending, account balances, collections and KYC/AML in your jurisdictions.

## Honest limits
- **Live trading** is Solana-only (Jupiter). Grid, DCA, Momentum, Scalp, Breakout, Dip-buy and Mean-reversion bots can go live. Copy-trader and Arbitrage stay paper-only.
- **EVM wallet age** isn't readable from a standard RPC. That criterion is marked for staff review instead of auto-pass or auto-fail.
- **Squads payouts** are linked by signature or auto-detection. NECTRA doesn't create Squads proposals itself.
- **Loans are USDC-denominated.** Collateral is BTC or LTC only.

## Structure
```
server/
  index.js · http.js · db.js (schema + migrations) · security.js (roles, 2FA, sessions)
  vault.js        AES-256-GCM secrets
  market.js       Jupiter/CoinGecko/Pyth prices · candles.js real candles
  strategy.js     intents → strategies, step logic, backtests · ai.js Claude Copilot
  engine.js       paper + live bots, risk, alerts, confirmations, loan jobs
  loans.js        credit score, snapshots, re-checks, delegations, collections, schedules, treasury scan
  plans.js        subscription plans, perks/gating, billing from account balance
  payments.js     crypto subscription payments (NOWPayments + on-chain USDC)
  compliance.js   terms acceptance + KYC (identity verification for lending)
  push.js · events.js · mail.js · seed.js
  chains/         solana.js · evm.js · tron.js · utxo.js
  routes/         auth.js · app.js · loans.js (v2 user routes) · admin.js
public/           trader app · admin/ console · sw.js · manifest.webmanifest · offline.html
test/smoke.js     50 end-to-end checks on a throwaway server
```

## v2 follow-ups (wallets, icons, guide)

- **Connected-wallet balances.** Connecting a wallet immediately shows every non-zero
  balance across its chains (SOL/SPL on Solana; native + USDC/USDT on the 5 EVM networks;
  TRX/USDT on Tron; BTC/LTC). From the balances view each coin has **Send** (you sign in
  your wallet), **Swap** (Solana via Jupiter, you sign), and **Receive** (address + QR with a
  network warning). Also reachable from a wallet's ⋯ menu → "View balances · send · swap".
- **More wallets.** Connect list now includes Trust Wallet, Coinbase Wallet, Binance Wallet,
  MetaMask, Phantom, Solflare, Backpack and TronLink.
- **Icon system.** Drop PNGs into `public/assets/tokens/<SYMBOL>.png` and
  `public/assets/wallets/<id>.png` — see the README in each folder for the spec and names.
  Missing icons fall back to a colored initial, so nothing looks broken. The app asks the
  server which icons exist (`/api/icons`) and only requests those (no 404 noise).
- **PDF guide.** `node tools/make-guide-pdf.js` regenerates `NECTRA-Guide.pdf` (also copied to
  `public/NECTRA-Guide.pdf`, downloadable at `/NECTRA-Guide.pdf`). Edit `tools/guide-content.js`
  to change the content.

> Note: after pulling new frontend code, do a hard refresh (Ctrl+Shift+R) once — the service
> worker caches the app shell, and its version bump re-caches on the next load.
