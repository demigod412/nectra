/* Content for the NECTRA Go-Live Checklist PDF (admin). Build: node tools/make-golive-pdf.js */
const B = [];
const title = (v, sub) => B.push({ t: 'title', v, sub });
const h1 = (v) => B.push({ t: 'h1', v });
const h2 = (v) => B.push({ t: 'h2', v });
const p = (v) => B.push({ t: 'p', v });
const li = (...xs) => xs.forEach((v) => B.push({ t: 'li', v }));
const steps = (...xs) => xs.forEach((v, i) => B.push({ t: 'num', n: i + 1, v }));
const code = (v) => B.push({ t: 'code', v });
const note = (v) => B.push({ t: 'note', v });
const env = (key, what, req) => { B.push({ t: 'code', v: key + (req ? '   [' + req + ']' : '') }); B.push({ t: 'li', v: what }); B.push({ t: 'space', v: 4 }); };

title('NECTRA - Go-Live Checklist for Admins', 'Every environment variable, API key, admin setting and step needed to take NECTRA v2 from demo to production.');

p('How to use this: work through sections 1-8 in order. Section 1 is the .env file on the server (restart the service after editing). Section 4 is Admin > Settings in the web console. Section 9 is a one-page tick list.');
note('Tags: [REQUIRED] = must be set to go live. [RECOMMENDED] = strongly advised. [OPTIONAL] = only for that feature. [ADVANCED] = leave the default unless you know why.');

/* ------------------------------------------------------------------ */
h1('1. Server environment (.env)');
p('The file lives at the project root (nectra-platform/.env). The Lightsail installer creates it with chmod 600. After any change run:');
code('sudo systemctl restart nectra');

h2('1.1 Core server');
env('DEMO_MODE=0', 'Turns off on-screen codes, demo wallets and simulated chain actions. On every start the server applies DEMO_MODE from .env to the demo_mode setting, so this one line is enough.', 'REQUIRED');
env('PUBLIC_URL=https://app.yourdomain.com', 'Public HTTPS address. Used in emails and as the NOWPayments IPN callback base.', 'REQUIRED');
env('COOKIE_SECURE=1', 'Secure cookies over HTTPS. Required for login sessions, wallets and push in production.', 'REQUIRED');
env('TRUST_PROXY=1', 'Set when behind nginx / Cloudflare so the real client IP is used for rate limits and audit logs.', 'REQUIRED');
env('HOST=127.0.0.1   PORT=3000', 'Bind locally; nginx proxies to it. Use HOST=0.0.0.0 only inside Docker.', 'RECOMMENDED');
env('LOG_REQUESTS=0', 'Set 1 temporarily to log every HTTP request while debugging.', 'OPTIONAL');
env('DB_PATH=./data/nectra.db', 'SQLite database location (WAL mode). Put it on a backed-up disk.', 'OPTIONAL');

h2('1.2 Secrets');
env('MASTER_KEY=<64 hex chars>', 'AES-256-GCM key that encrypts collector keys, live-bot wallet keys and VAPID keys. Generate with: openssl rand -hex 32. Store in a secrets manager AND an offline backup. Losing it = losing every encrypted key and the funds in live-bot wallets.', 'REQUIRED');
env('SOLANA_COLLECTOR_SECRET=<base58 secret key>', 'Bring your own Solana collector key (otherwise one is generated and stored encrypted).', 'OPTIONAL');
env('EVM_COLLECTOR_KEY=0x<private key>', 'Bring your own EVM collector key (same key on all 5 EVM networks).', 'OPTIONAL');
env('TRON_COLLECTOR_KEY=<hex private key>', 'Bring your own Tron collector key.', 'OPTIONAL');
note('Collector keys only pull funds a borrower has approved. Keep them separate from the treasury, and fund them only with gas.');

h2('1.3 First-run staff accounts (only used when the database is empty)');
env('ADMIN_EMAIL=you@yourdomain.com', 'Super admin login email.', 'REQUIRED');
env('ADMIN_PASSWORD=<strong password>', 'Super admin password. If omitted a random one is printed and saved to data/first-run-credentials.txt.', 'RECOMMENDED');
env('ADMIN2_PASSWORD=<strong password>', 'ops@nectra.local - admin and second approver.', 'RECOMMENDED');
env('OFFICER_PASSWORD=<strong password>', 'officer@nectra.local - loan officer.', 'RECOMMENDED');
env('CREDENTIALS_FILE=<path>', 'Where first-run credentials are written. Delete this file after you have stored the passwords.', 'OPTIONAL');
note('DEMO_PASSWORD only seeds the demo trader. In production remove or disable demo@nectra.local after launch. If the database was created in demo mode, either run "npm run reset" before launch (wipes everything) or change every staff password and delete demo users.');

/* ------------------------------------------------------------------ */
h1('2. Third-party APIs and accounts you need');
p('Below is every external service NECTRA talks to, what it is for, and where to get the key.');

h2('2.1 Anthropic Claude - AI Copilot');
env('ANTHROPIC_API_KEY=sk-ant-...', 'Powers the Copilot (strategy intents, auto-tune explanations). Get it at console.anthropic.com > API Keys. Set billing limits there. Without it the rule-based parser is used.', 'RECOMMENDED');
env('COPILOT_MODEL=claude-opus-5-5', 'Model id. Default is claude-opus-5-5.', 'OPTIONAL');
env('ANTHROPIC_AUTH_TOKEN', 'Alternative to the API key (gateway / bearer token setups).', 'ADVANCED');

h2('2.2 Solana RPC - wallets, loans, treasury, live bots');
env('SOLANA_RPC=https://<your-provider-endpoint>', 'Dedicated mainnet RPC. The public endpoint rate-limits and will break live trading and treasury scans. Providers: Helius, Triton, QuickNode, Alchemy.', 'REQUIRED');
env('SOLANA_CLUSTER=mainnet-beta', 'Must be mainnet-beta in production - other values switch USDC/USDT to devnet test mints (the server prints a warning at startup if it is not).', 'REQUIRED');

h2('2.3 Jupiter - Solana swaps and prices');
env('JUPITER_API=https://lite-api.jup.ag/swap/v1', 'Swap API used by live bots and the in-app Swap. For higher limits get a key/plan at portal.jup.ag and point this at the paid endpoint.', 'OPTIONAL');
env('JUPITER_PRICE_API=https://lite-api.jup.ag/price/v3', 'Price API for Solana tokens.', 'OPTIONAL');

h2('2.4 EVM RPCs - Ethereum, Base, Arbitrum, BSC, Polygon');
env('RPC_ETHEREUM=   RPC_BASE=   RPC_ARBITRUM=   RPC_BSC=   RPC_POLYGON=', 'One HTTPS RPC URL per network. Public defaults exist but are unreliable. Providers: Alchemy, Infura, QuickNode, Ankr, Chainstack. Needed for wallet verification, ERC-20 approvals, collections and repayment detection.', 'RECOMMENDED');

h2('2.5 Tron - TronGrid');
env('TRON_API_KEY=<key>', 'Get a free key at trongrid.io (sign in > API Keys). Without it TronGrid throttles heavily.', 'RECOMMENDED');
env('TRON_RPC=https://api.trongrid.io', 'Tron full node URL.', 'OPTIONAL');
env('TRON_USDT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TRC-20 USDT contract (mainnet default - leave as is).', 'ADVANCED');

h2('2.6 Market data');
env('COINGECKO_API_KEY=<key>', 'Demo or Pro key from coingecko.com/en/api. Raises rate limits for BTC/ETH/LTC/TRX/BNB/POL prices and fallback candles.', 'RECOMMENDED');
env('PYTH_API_KEY=<key>', 'Uses Pyth Hermes for prices (the public Hermes endpoint now needs a key). Otherwise Jupiter + CoinGecko are used.', 'OPTIONAL');
env('PYTH_HERMES=https://hermes.pyth.network', 'Hermes base URL.', 'ADVANCED');
env('CANDLES_API=https://data-api.binance.vision/api/v3/klines', 'Hourly candles for backtests (no key needed). Falls back to CoinGecko.', 'OPTIONAL');
env('PRICE_FEED=sim', 'Forces the simulated feed. Do NOT set this in production.', 'ADVANCED');

h2('2.7 BTC / LTC collateral escrow');
env('BTC_COLLATERAL_XPUB=<xpub/zpub>', 'Account-level extended PUBLIC key from a BTC wallet YOU control (e.g. hardware wallet). The server derives unique deposit addresses and can only watch, never spend.', 'REQUIRED for collateral loans');
env('LTC_COLLATERAL_XPUB=<xpub/Ltub>', 'Same for Litecoin.', 'REQUIRED for collateral loans');
env('BTC_ESPLORA=https://blockstream.info/api   LTC_ESPLORA=https://litecoinspace.org/api', 'Block-explorer APIs used to detect deposits. Self-host Esplora/mempool for reliability.', 'OPTIONAL');

h2('2.8 NOWPayments - crypto subscription checkout');
env('NOWPAYMENTS_API_KEY=<key>', 'From account.nowpayments.io > Settings > Payments > API keys. Also set your payout wallet there.', 'REQUIRED for crypto checkout');
env('NOWPAYMENTS_IPN_SECRET=<secret>', 'From the same page (IPN secret). Used to verify the HMAC-SHA512 signature on webhooks.', 'REQUIRED for crypto checkout');
p('In the NOWPayments dashboard set the IPN callback URL to:');
code('https://app.yourdomain.com/api/webhooks/nowpayments');

h2('2.9 Email (SMTP)');
env('SMTP_HOST=   SMTP_PORT=587   SMTP_USER=   SMTP_PASS=', 'Any SMTP provider: Amazon SES, Postmark, SendGrid, Mailgun, Brevo, Google Workspace. Needed for sign-up codes, 2FA/security mail, loan reminders and billing receipts. Without it mail only appears in Admin > Mailbox.', 'REQUIRED');
env('MAIL_FROM=NECTRA <no-reply@yourdomain.com>', 'Sender. Verify the domain with your provider and publish SPF, DKIM and DMARC records in DNS.', 'REQUIRED');

h2('2.10 Web push (VAPID)');
env('VAPID_SUBJECT=mailto:you@yourdomain.com', 'Contact for push services.', 'RECOMMENDED');
env('VAPID_PUBLIC_KEY=   VAPID_PRIVATE_KEY=', 'Generate with: npx web-push generate-vapid-keys. If omitted they are auto-generated and stored encrypted - fine, but setting them keeps subscriptions valid if the database is rebuilt.', 'OPTIONAL');

h2('2.11 Infrastructure');
li('Domain + Cloudflare: A record to the server, orange cloud ON. SSL mode "Full (strict)" with a Cloudflare Origin Certificate (installer option 1).',
  'Server: AWS Lightsail Ubuntu, Node.js 22.5+ (24 recommended), nginx, ufw. Run: bash deploy-lightsail.sh',
  'Optional: lock the firewall to Cloudflare IP ranges (installer prompt).',
  'Squads multisig (squads.so) for the Solana treasury vault.');

/* ------------------------------------------------------------------ */
h1('3. Wallets and keys you must create yourself');
li('Solana treasury - a Squads multisig vault address (receives repayments and crypto subscription payments; pays out loans).',
  'EVM treasury - a multisig (e.g. Safe) address used on Ethereum, Base, Arbitrum, BSC and Polygon.',
  'Tron treasury - a TronLink / hardware-wallet address (multisig permissions recommended).',
  'BTC and LTC hardware wallets - export the account xpub for section 2.7.',
  'Collector gas - after launch open Admin > Treasury & keys and send a small amount of SOL, ETH, BNB, POL, ETH-on-Base/Arbitrum and TRX to each collector address so collections can pay fees.',
  'MASTER_KEY backup - printed/offline copy kept apart from the server.');

/* ------------------------------------------------------------------ */
h1('4. Admin console settings (Admin > Settings)');
p('Sign in at https://app.yourdomain.com/admin as the super admin. Only super admins can change settings.');

h2('4.1 Platform');
li('demo_mode -> OFF.',
  'registration_open -> on/off as you want sign-ups.',
  'invite_required -> decide (default on). Replace the demo invite code NECTRA26 with your own codes.',
  'maintenance_banner -> empty (use it for planned downtime).',
  'paper_start_usdc / paper_start_sol -> starting paper balances for new users (default 10000 / 20).',
  'withdraw_hold_hours -> hold after security changes before withdrawals (default 24).',
  'referral_max_codes / referral_code_uses -> referral limits (default 5 / 5).');

h2('4.2 Security and approvals');
li('admin_2fa_required -> ON. First enable authenticator 2FA on your own account (Settings > Security), then every staff account.',
  'dual_approval_threshold -> USD amount at/above which loans, payouts and balance adjustments need a second admin (default 1000). Every collection always needs two admins.',
  'Roles -> give each staff member the least role needed (loan officer < admin < super admin). Keep at least two admins so approvals are possible.');

h2('4.3 Treasury');
li('treasury_solana -> Squads vault address.',
  'treasury_evm -> EVM treasury address.',
  'treasury_tron -> Tron treasury address.');
note('Repayments and on-chain USDC subscription payments are only detected once these are set.');

h2('4.4 Lending');
li('default_after_days -> days past due before a loan is marked defaulted (default 30).',
  'Loan products (Admin > Loans / Products) -> set amounts, APR, instalments, late-fee %, grace period and the collateral product (150% BTC/LTC).',
  'Review the loan book and CSV export work before opening applications.');

h2('4.5 Trading');
li('live_trading_enabled -> ON only when SOLANA_RPC and MASTER_KEY are production-ready (default off).',
  'live_bot_max_usd -> per-bot funding cap (default 1000).',
  'ai_copilot -> ON to use Claude when ANTHROPIC_API_KEY is set.');

h2('4.6 Monetization');
li('monetization_enabled -> master switch for plans and gating (default on).',
  'crypto_payments_enabled -> allow NOWPayments / on-chain USDC checkout (default on).',
  'nowpayments_enabled -> ON after NOWPAYMENTS_API_KEY and IPN secret are set (default off).',
  'Admin > Plans & subscriptions -> review Free / Starter $19 / Pro $49 / Elite $149, annual prices and perks.');

h2('4.7 Compliance');
li('current_terms_version -> set after your lawyer approves the Terms & Risk Disclosure copy; bump it to force re-acceptance.',
  'kyc_enabled -> master switch for identity verification (default on).',
  'kyc_required_for_loans -> default on.',
  'kyc_required_for_live -> default off; decide with counsel.',
  'Admin > KYC review -> assign reviewers and test approve/reject.');

/* ------------------------------------------------------------------ */
h1('5. Deployment steps (Lightsail)');
steps('Create the Lightsail Ubuntu instance; open ports 80/443 only.',
  'git clone the repo, cd into it, run: bash deploy-lightsail.sh. Answer: your domain, demo mode = n, SSL option 1 (paste Cloudflare Origin Certificate), firewall lock = y.',
  'Edit .env with every value from sections 1 and 2, then: sudo systemctl restart nectra.',
  'Check logs: sudo journalctl -u nectra -n 100 --no-pager. The startup banner must say Demo mode: off.',
  'In Cloudflare: DNS A record (proxied), SSL/TLS = Full (strict), Always Use HTTPS = on.',
  'Open https://app.yourdomain.com/status and confirm prices, RPCs and mail are healthy.',
  'Sign in to /admin, store the first-run passwords, delete data/first-run-credentials.txt, enable 2FA.',
  'Complete the Admin > Settings values in section 4.');

/* ------------------------------------------------------------------ */
h1('6. Backups and operations');
li('Back up data/nectra.db (plus -wal and -shm, or use sqlite3 .backup) daily to off-server storage.',
  'Back up .env and MASTER_KEY separately and securely.',
  'Keep the OS patched; restrict SSH to your IP.',
  'Watch Admin notifications for risk flags (revoked approvals, wallet value < 25% of debt) and unmatched deposits.',
  'Rotate staff passwords and API keys periodically; remove staff who leave.');

/* ------------------------------------------------------------------ */
h1('7. Pre-launch tests');
steps('Run npm test on the server copy (50 end-to-end checks on a throwaway DB).',
  'Register a real user: email code arrives by SMTP.',
  'Connect Phantom, MetaMask and TronLink; balances load.',
  'Push notification arrives on desktop and on an iPhone Home Screen install.',
  'Subscribe with a small NOWPayments payment; the IPN activates the plan.',
  'Send a small USDC repayment to the treasury; it is detected and applied.',
  'Create a small live bot, fund it, confirm a real Jupiter swap, then withdraw.',
  'Request a collection with one admin and approve with a different admin.',
  'Copilot answers using Claude (not the rule-based fallback).');

/* ------------------------------------------------------------------ */
h1('8. Legal and compliance');
li('Get legal advice for lending, holding account balances, collecting from customer wallets, custodial bot wallets and KYC/AML in every jurisdiction you serve.',
  'Finalize Terms, Risk Disclosure and Privacy Policy before setting current_terms_version.',
  'Decide whether manual KYC is enough or wire a KYC provider (e.g. Sumsub, Persona, Onfido).',
  'Plans gate features only - never market them as increasing profit.');

/* ------------------------------------------------------------------ */
h1('9. One-page tick list');
li('[ ] DEMO_MODE=0 (startup banner shows Demo mode: off)',
  '[ ] MASTER_KEY set and backed up offline',
  '[ ] PUBLIC_URL, COOKIE_SECURE=1, TRUST_PROXY=1',
  '[ ] Strong ADMIN / ADMIN2 / OFFICER passwords; credentials file deleted',
  '[ ] ANTHROPIC_API_KEY',
  '[ ] SOLANA_RPC (dedicated) + SOLANA_CLUSTER=mainnet-beta',
  '[ ] RPC_ETHEREUM, RPC_BASE, RPC_ARBITRUM, RPC_BSC, RPC_POLYGON',
  '[ ] TRON_API_KEY',
  '[ ] COINGECKO_API_KEY (PYTH_API_KEY optional)',
  '[ ] BTC_COLLATERAL_XPUB, LTC_COLLATERAL_XPUB',
  '[ ] NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET, IPN URL set in dashboard',
  '[ ] SMTP_* + MAIL_FROM, SPF/DKIM/DMARC',
  '[ ] VAPID_SUBJECT (+ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)',
  '[ ] Cloudflare DNS + Full (strict) origin certificate',
  '[ ] Treasury addresses: Solana (Squads), EVM, Tron',
  '[ ] Collector addresses funded with gas',
  '[ ] admin_2fa_required ON, dual_approval_threshold set, roles reviewed',
  '[ ] Loan products, default_after_days reviewed',
  '[ ] live_trading_enabled + live_bot_max_usd decided',
  '[ ] Monetization, crypto, NOWPayments toggles set; plans reviewed',
  '[ ] Terms version, KYC switches decided',
  '[ ] Daily DB backups running',
  '[ ] Pre-launch tests in section 7 all pass',
  '[ ] Legal sign-off');

module.exports = B;
