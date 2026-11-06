/* Content for the NECTRA guide PDF (summarized user + admin). Edit freely. */
const B = [];
const title = (v, sub) => B.push({ t: 'title', v, sub });
const h1 = (v) => B.push({ t: 'h1', v });
const h2 = (v) => B.push({ t: 'h2', v });
const p = (v) => B.push({ t: 'p', v });
const li = (...xs) => xs.forEach((v) => B.push({ t: 'li', v }));
const steps = (...xs) => xs.forEach((v, i) => B.push({ t: 'num', n: i + 1, v }));
const code = (v) => B.push({ t: 'code', v });
const note = (v) => B.push({ t: 'note', v });
const sp = (v) => B.push({ t: 'space', v });

title('NECTRA - Quick Guide', 'AI trading bots, multi-chain wallets and wallet-verified loans. Summary for users and admins.');

h1('1. Getting started');
p('NECTRA runs in your browser and installs as an app. Open the site, then on a phone use "Add to Home Screen" to install it and get push notifications.');
h2('Accounts you start with (demo)');
li('Trader: demo@nectra.local / Demo-Trader-2026',
  'Admin console at /admin - super admin, plus an ops admin (second approver) and a loan officer. Passwords are printed when the server first starts and saved in data/first-run-credentials.txt.');
h2('Signing up');
steps('Open the app and choose "Have an invite code". The demo invite code is NECTRA26.',
  'Register with email + password, or "Continue with wallet" and sign a message.',
  'Verify the 6-digit email code. In demo mode every code is shown on screen (any code except 000000 works).');
note('Demo mode shows codes on screen and lets you simulate on-chain actions. A real deployment emails codes and uses live chains.');

h1('2. Connecting a wallet');
p('NECTRA is non-custodial: your keys stay in your wallet and you sign every action. Supported wallets:');
li('Solana: Phantom, Solflare, Backpack',
  'EVM (Ethereum, Base, Arbitrum, BSC, Polygon): MetaMask, Trust Wallet, Coinbase Wallet, Binance Wallet',
  'Tron: TronLink',
  'Demo wallet: a key generated in your browser, for trying things in demo mode');
steps('Go to Wallets and press "Add wallets" > "Connect wallet".',
  'Pick your wallet and approve the connection, then sign the message to prove ownership (no fee, no transaction).',
  'NECTRA immediately shows every non-zero balance across that wallet\'s chains (BTC, LTC, ETH, BNB, SOL, USDT, TRX and more).');

h1('3. Your balances: send, swap, receive');
p('Open a connected wallet\'s menu and choose "View balances - send - swap". Zero balances are hidden. For each coin you can:');
li('Send: enter any destination address and amount; you approve the exact transfer in your wallet. Works for Solana (SOL + tokens), EVM (native + USDC/USDT) and Tron (TRX + USDT).',
  'Swap: swap one Solana token for another through Jupiter at the best route; you approve it in your wallet.',
  'Receive / Deposit: shows your wallet address and a QR for that coin, with a network warning. Send funds there from any exchange or wallet and the balance updates after the network confirms.');
note('Only send a coin on its own network (for example, only SOL on Solana). Sending on the wrong network can cause permanent loss. Bitcoin and Litecoin sending is done from your own wallet app; NECTRA shows their balances and receive addresses.');

h1('4. AI trading bots');
h2('Set up a bot with the Copilot');
steps('Go to AI Bots and type what you want in plain English, e.g. "DCA $50 into SOL every Monday" or "Grid trade SOL/USDC between $88 and $104".',
  'The Copilot turns it into a strategy card showing entry, exit, stop-loss, take-profit and budget. Read every line.',
  'Press "Quick backtest" to see how it would have done on real hourly prices, with a buy-and-hold comparison.',
  'Press "Confirm & deploy". The bot starts in PAPER mode - simulated money, live prices. Nothing real is spent.');
h2('Strategy types');
li('DCA - buy a fixed amount on a schedule', 'Grid - buy low / sell high in a range', 'Momentum - ride breakouts',
  'Dip-buy - buy a set dip', 'Mean-reversion - buy below the average, sell back to it', 'Copy-trader / Arbitrage - paper only');
h2('Going live (real trading)');
p('Live trading is enabled by the platform and needs 2FA. A live bot gets its own dedicated wallet; you fund it with only what you are willing to risk.');
steps('Enable 2FA in Settings > Security (authenticator app).',
  'On a bot, press "Go live" and enter your 2FA code. NECTRA creates the bot\'s wallet.',
  'Send USDC (and a little SOL for fees) to that wallet address, then resume the bot. It trades via Jupiter.',
  'Use "Wallet" > withdraw any time to send everything back to your main wallet.');
note('A live bot\'s key is held encrypted on the server (custodial for that bot wallet only). Keep its balance small.');

h1('5. How to aim for profit (and manage risk)');
p('This is general guidance, not financial advice. Crypto trading can lose money, including everything you put in.');
li('Start in paper mode and run a strategy for at least a week before risking real funds.',
  'Backtest first and compare against simply holding - a bot that beats buy-and-hold on fees-included history is more promising.',
  'DCA smooths out volatility and suits beginners; grids suit sideways markets; momentum suits trends.',
  'Always set a stop-loss and a max position. In Settings > Risk limits, set a max daily loss and max concurrent bots.',
  'Add a portfolio guard ("stop all bots if portfolio drops 10%") via the Copilot.',
  'Fees and slippage (about 0.1% per trade here) add up - avoid over-trading tiny edges.',
  'Fund live bots with small amounts, watch drawdown, and withdrawal profits regularly.',
  'Never invest borrowed money you cannot repay, and never share your seed phrase - NECTRA will never ask for it.');

h1('6. Approvals, deposits, withdrawals');
li('Approvals: grant a contract permission capped to an exact amount (never unlimited by default). Revoke any approval from the Approvals page - it signs a real on-chain revoke.',
  'Deposit: the Deposit page shows your main wallet address + QR per chain.',
  'Withdraw: send from a wallet (you sign it) or from your NECTRA account balance (our team pays it out). Whitelisted addresses and a 2FA/email code protect withdrawals.');

h1('7. Loans');
p('Borrow USDC against your on-chain history or with BTC/LTC collateral. Every application is reviewed by the NECTRA team.');
steps('On the Loans page pick a product and amount (your limit scales with your credit score).',
  'Connect and verify the wallet you want to borrow against - NECTRA reads its balance and transaction history live.',
  'Sign a collection approval, capped at exactly what you will owe, on each wallet that holds USDC/USDT. For BTC/LTC products you deposit collateral to a unique address instead.',
  'Submit. The team reviews; large loans need two admins. You are notified at each step.',
  'When approved, funds are credited to your NECTRA account balance (or sent on-chain).',
  'Repay in instalments from your account balance, or send USDC/USDT from your verified wallet to the repayment address - it is detected automatically.');
h2('Credit score');
p('Ranges 300-850. On-time repayments and repaid loans raise it; late payments and defaults lower it. A higher score raises your borrowing limit (50%-150% of each product cap).');
note('If you default, NECTRA may collect up to what you owe using the approvals you signed, after two admins sign off. Revoking an approval is flagged and lowers your score. Borrowing is regulated in many places - this build is a demo.');

h1('8. Other features');
li('Portfolio & history: holdings, a PnL calendar, filterable transactions and CSV export.',
  'Price alerts: tap the bell on any token to be notified in-app, by email and by push.',
  'Referrals: generate invite codes and climb reward tiers.',
  'Notifications: live updates for bots, prices, transfers, loans and security.',
  'Settings: profile, password, 2FA, anti-phishing code (shown in every email), sessions, withdrawal whitelist, risk limits, theme, currency and push notifications.',
  'Install the app: from your phone browser, "Add to Home Screen" for an app icon, offline support and push.');

h1('9. Admin console (/admin)');
p('Three staff roles with least-privilege access:');
li('Loan officer - review applications and leave a recommendation; cannot move money.',
  'Admin - approve/disburse loans, process payouts and collections, manage invites, bots and status.',
  'Super admin - everything, plus settings, roles, products, balance adjustments and the platform kill switch.');
h2('Reviewing and funding loans');
steps('Admin > Loan applications shows the queue with eligibility evidence and the officer\'s recommendation.',
  'Open one, press "Re-check now" to re-read the wallet, then Approve (loans at/over the threshold need a second, different admin) or Reject with a reason.',
  'Disburse: the wallet is re-checked automatically first. Credit the account balance, sign the USDC transfer with the treasury wallet, or paste a payout signature. A failed re-check blocks disbursement.');
h2('Defaults and collection');
steps('An overdue loan is flagged; after the default window it is marked defaulted.',
  'Press "Collect from approvals". A second admin approves it in the Approvals queue.',
  'NECTRA pulls up to the outstanding amount from the borrower\'s signed approvals into the treasury and applies it to the loan.');
h2('Other admin tools');
li('Approvals queue - two-admin sign-off for large loans, payouts, balance adjustments and all collections.',
  'Loan book - outstanding, overdue, defaults, exposure by product, credit-score spread, CSV export.',
  'Users - search everyone; adjust balances (super admin, audit-logged), suspend, reset 2FA, change roles, and "Log in as this user" to support them (super admin; time-limited; a banner lets you exit back to admin).',
  'Payouts, invites, waitlist, bots (with a platform-wide pause), transactions, broadcast, system status, mailbox, audit log.',
  'Treasury & keys - set treasury addresses (use a multisig in production) and fund the collector keys.',
  'Settings - demo mode, registration, invite requirement, live trading, two-admin threshold, optional staff 2FA, late-fee and default windows, and the AI Copilot.');

h1('10. Security notes');
li('NECTRA never asks for your seed phrase or private key.',
  'Collection approvals are always capped at what you owe - never unlimited.',
  'Turn on 2FA; staff can be required to use it.',
  'In production: set a MASTER_KEY and back it up, use dedicated RPCs, serve over HTTPS, and get legal/compliance advice for lending and collections.');
sp(6);
note('All figures in the demo are simulated or test data. This guide summarizes the platform; screens may vary as it is developed.');

module.exports = B;
