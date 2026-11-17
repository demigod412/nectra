/**
 * Verification test for White-label branding, SMTP test endpoint, and Landing page Live Trading
 */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const { testSmtpConnection, smtpSend, formatMimeFrom } = require('../server/mail');
const { getSettings, setSetting, q, tx } = require('../server/db');

test('White-label platform branding & dynamic adoption', async () => {
  // Verify default or custom platform name
  const current = getSettings().platform_name;
  setSetting('platform_name', 'ApexTrade');
  assert.equal(getSettings().platform_name, 'ApexTrade');

  // Verify core.js contains case-insensitive replacement engine and walkAndReplace
  const coreJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/core.js'), 'utf8');
  assert.ok(coreJs.includes('NX.walkAndReplace = walkAndReplace;'));
  assert.ok(coreJs.includes('/nectra/gi'));
  assert.ok(coreJs.includes('buildShell'));

  // Verify pages.js dynamic brandName usage and dynamic portfolio
  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(pagesJs.includes('NX.brandName()'));
  assert.ok(pagesJs.includes('getDynamicPortfolioBase'));
  assert.ok(pagesJs.includes('BASE_PORTFOLIO = getDynamicPortfolioBase()'));

  // Restore
  if (current) setSetting('platform_name', current);
});

test('Landing page markup reflects Live Trading and Bot Fleet', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('Live autonomous AI trading'));
  assert.ok(indexHtml.includes('Live Trading'));
  assert.ok(indexHtml.includes('Live portfolio · High-frequency AI execution'));
  assert.ok(indexHtml.includes('Autonomous Execution Fleet'));
  assert.ok(indexHtml.includes('Hyper-Grid Scalper'));
  assert.ok(indexHtml.includes('eco-band'));
  assert.ok(!indexHtml.includes('Paper trading by default'));
});

test('SMTP test error when unconfigured', async () => {
  await assert.rejects(
    async () => {
      await testSmtpConnection('test@example.com', { host: '' });
    },
    /SMTP [Hh]ost is not configured/
  );
});

test('SMTP client handles mock SMTP server conversation', async () => {
  // Spin up an in-process mock SMTP server on an ephemeral port
  const server = net.createServer((sock) => {
    sock.write('220 mock.smtp.local Service ready\r\n');
    let state = 'INIT';
    sock.on('data', (d) => {
      const text = d.toString();
      if (text.startsWith('EHLO')) {
        sock.write('250-mock.smtp.local\r\n250 8BITMIME\r\n');
      } else if (text.startsWith('MAIL FROM:')) {
        sock.write('250 2.1.0 Sender OK\r\n');
      } else if (text.startsWith('RCPT TO:')) {
        sock.write('250 2.1.5 Recipient OK\r\n');
      } else if (text.startsWith('DATA')) {
        sock.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
      } else if (text.includes('\r\n.\r\n') || text === '.\r\n') {
        sock.write('250 2.0.0 OK: queued as 12345\r\n');
      } else if (text.startsWith('QUIT')) {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
      }
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  try {
    const res = await testSmtpConnection('receiver@test.local', {
      host: '127.0.0.1',
      port,
      from: 'Sender <sender@test.local>',
      secure: false
    });
    assert.equal(res.ok, true);
    assert.equal(res.recipient, 'receiver@test.local');
  } finally {
    server.close();
  }
});

test('SMTP client handles complex FROM formats without 501 syntax error', async () => {
  let receivedMailFrom = '';
  const server = net.createServer((sock) => {
    sock.write('220 mock.smtp.local Service ready\r\n');
    let authStep = 0;
    sock.on('data', (d) => {
      const text = d.toString();
      if (text.startsWith('EHLO')) {
        sock.write('250-mock.smtp.local\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n');
      } else if (text.startsWith('AUTH LOGIN')) {
        authStep = 1;
        sock.write('334 VXNlcm5hbWU6\r\n');
      } else if (authStep === 1) {
        authStep = 2;
        sock.write('334 UGFzc3dvcmQ6\r\n');
      } else if (authStep === 2) {
        authStep = 0;
        sock.write('235 2.7.0 Authentication successful\r\n');
      } else if (text.startsWith('MAIL FROM:')) {
        receivedMailFrom = text.trim();
        // Strict check: must be MAIL FROM:<user@domain.tld> with NO quotes or spaces inside angle brackets
        if (/^MAIL FROM:<[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}>$/.test(receivedMailFrom)) {
          sock.write('250 2.1.0 Sender OK\r\n');
        } else {
          sock.write('501 5.5.4 Invalid FROM: Invalid character in localpart\r\n');
        }
      } else if (text.startsWith('RCPT TO:')) {
        sock.write('250 2.1.5 Recipient OK\r\n');
      } else if (text.startsWith('DATA')) {
        sock.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
      } else if (text.includes('\r\n.\r\n') || text === '.\r\n') {
        sock.write('250 2.0.0 OK: queued\r\n');
      } else if (text.startsWith('QUIT')) {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
      }
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  try {
    // 1. Quoted display name with angle brackets
    const res1 = await testSmtpConnection('test@recipient.local', {
      host: '127.0.0.1',
      port,
      user: 'auth@test.local',
      from: '"NECTRA Platform" <no-reply@test.local>',
      secure: false
    });
    assert.equal(res1.ok, true);
    assert.equal(receivedMailFrom, 'MAIL FROM:<no-reply@test.local>');

    // 2. Bare display name without email address (should fall back to user email safely)
    const res2 = await testSmtpConnection('test@recipient.local', {
      host: '127.0.0.1',
      port,
      user: 'support@test.local',
      from: 'NECTRA Platform',
      secure: false
    });
    assert.equal(res2.ok, true);
    assert.equal(receivedMailFrom, 'MAIL FROM:<support@test.local>');
  } finally {
    server.close();
  }
});

test('formatMimeFrom and platform display name formatting in email preview', async () => {
  // 1. Direct unit checks for formatMimeFrom
  assert.equal(formatMimeFrom('ApexTrade', 'support@apex.com'), 'ApexTrade <support@apex.com>');
  assert.equal(formatMimeFrom('Apex, LLC', 'support@apex.com'), '"Apex, LLC" <support@apex.com>');
  assert.equal(formatMimeFrom('ApexTrade', 'ApexTrade <support@apex.com>'), 'ApexTrade <support@apex.com>');
  // Non-ASCII encoded with RFC 2047
  assert.ok(formatMimeFrom('Étoile Trade', 'support@apex.com').startsWith('=?UTF-8?B?'));

  // 2. Verify DATA payload in SMTP server receives configured company name instead of "noreply"
  let receivedData = '';
  const server = net.createServer((sock) => {
    sock.write('220 mock.smtp.local Service ready\r\n');
    let collectingData = false;
    sock.on('data', (d) => {
      const text = d.toString();
      if (collectingData) {
        receivedData += text;
        if (text.includes('\r\n.\r\n') || text === '.\r\n') {
          collectingData = false;
          sock.write('250 2.0.0 OK: queued\r\n');
        }
      } else if (text.startsWith('EHLO')) {
        sock.write('250-mock.smtp.local\r\n250 8BITMIME\r\n');
      } else if (text.startsWith('MAIL FROM:')) {
        sock.write('250 2.1.0 Sender OK\r\n');
      } else if (text.startsWith('RCPT TO:')) {
        sock.write('250 2.1.5 Recipient OK\r\n');
      } else if (text.startsWith('DATA')) {
        collectingData = true;
        sock.write('354 Start mail input\r\n');
      } else if (text.startsWith('QUIT')) {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
      }
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  try {
    // Test with "noreply <no-reply@apex.com>" in from and custom platformName "ApexTrade"
    await testSmtpConnection('trader@apex.com', {
      host: '127.0.0.1',
      port,
      from: 'noreply <no-reply@apex.com>',
      platformName: 'ApexTrade',
      secure: false
    });

    // Verify DATA payload has "From: ApexTrade <no-reply@apex.com>" instead of "From: noreply <...>"
    assert.ok(receivedData.includes('From: ApexTrade <no-reply@apex.com>'), `Expected From header to display ApexTrade, got:\n${receivedData}`);
    assert.ok(receivedData.includes('Reply-To: ApexTrade <no-reply@apex.com>'));
  } finally {
    server.close();
  }
});

test('Admin 2FA UI elements have fallback markup, inline triggers, and resilient boot', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/admin/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="adm-2fa-btn"'));
  assert.ok(indexHtml.includes('id="adm-side-2fa"'));
  assert.ok(indexHtml.includes('onclick="window.NX && window.NX.openAdmin2FAModal && window.NX.openAdmin2FAModal()"'));
  assert.ok(indexHtml.includes('admin.js?v=2.2'));

  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('document.readyState === \'loading\''));
  assert.ok(adminJs.includes('NX.openAdmin2FAModal'));
  assert.ok(adminJs.includes('updateAdmin2FABadges'));
  assert.ok(adminJs.includes('platform_name'));
});

test('PWA install manifest, meta tags, and service worker adopt Ascendex', () => {
  // 1. Static manifest file contains Ascendex name and short_name
  const manifestRaw = fs.readFileSync(path.join(__dirname, '../public/manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.short_name, 'Ascendex');
  assert.ok(manifest.name.includes('Ascendex'));

  // 2. HTML files contain apple-mobile-web-app-title meta tag for iOS PWA Home Screen
  const filesToCheck = [
    'public/index.html',
    'public/dashboard.html',
    'public/bot.html',
    'public/deposit.html',
    'public/withdraw.html',
    'public/loans.html',
    'public/wallets.html',
    'public/portfolio.html',
    'public/login.html',
    'public/register.html',
    'public/admin/index.html'
  ];
  for (const rel of filesToCheck) {
    const html = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(
      html.includes('<meta name="apple-mobile-web-app-title" content="Ascendex">'),
      `${rel} missing apple-mobile-web-app-title for Ascendex`
    );
  }

  // 3. Service worker has updated cache version to force stale cache purge
  const swJs = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.ok(swJs.includes('ascendex-v2.8.0'));

  // 4. Default database platform name falls back to Ascendex
  const { getSettings, setSetting } = require('../server/db');
  const cur = getSettings().platform_name;
  setSetting('platform_name', '');
  assert.equal(getSettings().platform_name, 'Ascendex');
  setSetting('platform_name', 'NECTRA');
  assert.equal(getSettings().platform_name, 'Ascendex');
  if (cur) setSetting('platform_name', cur);

  // 5. Server index.js serves dynamic /manifest.webmanifest with no-cache headers
  const indexJs = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(indexJs.includes("url.pathname === '/manifest.webmanifest'"));
  assert.ok(indexJs.includes("'Cache-Control': 'no-cache, no-store, must-revalidate'"));
});

test('HTML email styling with landing page dark theme & multipart/alternative MIME', async () => {
  const { buildHtmlEmail } = require('../server/mail');

  // 1. Verify buildHtmlEmail output structure
  const html = buildHtmlEmail({
    platformName: 'Ascendex',
    subject: 'Verify your Ascendex email',
    body: 'Hello User,\n\nYour 6-digit verification code is: 482910\n\nOr click link below:\nhttps://ascendex.local/verify?code=482910\n\n• Feature 1\n• Feature 2',
    antiPhishing: 'PETAL-8F2A',
    to: 'user@example.com'
  });

  // Color theme checks matching landing page
  assert.ok(html.includes('#0A0A0C'), 'Outer background must match #0A0A0C');
  assert.ok(html.includes('#131318'), 'Card background must match #131318');
  assert.ok(html.includes('#23232E'), 'Card border must match #23232E');
  assert.ok(html.includes('#F2559A'), 'Brand accent pink must be present');
  assert.ok(html.includes('linear-gradient(135deg, #FF66A1 0%, #D82675 100%)'), 'Brand gradient must be present');

  // Security elements
  assert.ok(html.includes('PETAL-8F2A'), 'Anti-phishing code must be rendered');
  assert.ok(html.includes('Anti-Phishing Code:'), 'Anti-phishing label must be present');
  assert.ok(html.includes('482910'), 'Verification code must be highlighted');
  assert.ok(html.includes('letter-spacing:6px'), 'Verification code must have letter spacing');
  assert.ok(html.includes('Verify Email Address'), 'Verification URL rendered as CTA button');
  assert.ok(html.includes('will never ask for your seed phrase'), 'Security footer warning must be present');

  // 2. Mock SMTP server receives multipart/alternative with text and HTML bodies
  let receivedMime = '';
  const server = net.createServer((sock) => {
    sock.write('220 mock.smtp.local Service ready\r\n');
    let collecting = false;
    sock.on('data', (d) => {
      const text = d.toString();
      if (collecting) {
        receivedMime += text;
        if (text.includes('\r\n.\r\n') || text === '.\r\n') {
          collecting = false;
          sock.write('250 2.0.0 OK: queued\r\n');
        }
      } else if (text.startsWith('EHLO')) {
        sock.write('250-mock.smtp.local\r\n250 8BITMIME\r\n');
      } else if (text.startsWith('MAIL FROM:')) {
        sock.write('250 2.1.0 Sender OK\r\n');
      } else if (text.startsWith('RCPT TO:')) {
        sock.write('250 2.1.5 Recipient OK\r\n');
      } else if (text.startsWith('DATA')) {
        collecting = true;
        sock.write('354 Start mail input\r\n');
      } else if (text.startsWith('QUIT')) {
        sock.write('221 2.0.0 Bye\r\n');
        sock.end();
      }
    });
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  try {
    await smtpSend({
      to: 'recipient@test.local',
      subject: 'Welcome to Ascendex',
      text: 'Plain text greeting',
      html,
      config: {
        host: '127.0.0.1',
        port,
        from: 'Ascendex <system@test.local>',
        platformName: 'Ascendex',
        secure: false
      }
    });

    assert.ok(receivedMime.includes('Content-Type: multipart/alternative'), 'Must send multipart/alternative');
    assert.ok(receivedMime.includes('Content-Type: text/plain'), 'Must include text/plain part');
    assert.ok(receivedMime.includes('Content-Type: text/html'), 'Must include text/html part');
    assert.ok(receivedMime.includes('From: Ascendex <system@test.local>'), 'From header must use Ascendex display name');
    assert.ok(receivedMime.includes('#0A0A0C'), 'Transmitted HTML body must include #0A0A0C');
  } finally {
    server.close();
  }
});

test('Register page & waitlist: demo code removed, waitlist position hidden', () => {
  const regHtml = fs.readFileSync(path.join(__dirname, '../public/register.html'), 'utf8');
  assert.ok(!regHtml.includes('id="invite-demo"'), 'Demo code button must not exist in register.html');
  assert.ok(!regHtml.includes('Use demo code'), 'Use demo code label must be removed');
  assert.ok(!regHtml.includes('id="wl-pos"'), 'Waitlist position element must be removed');
  assert.ok(!regHtml.includes('Your position:'), 'Position prefix must be removed from register.html');
  assert.ok(regHtml.includes('We’ve added you to the waitlist'), 'Updated waitlist message present');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(!pagesJs.includes("$('#invite-demo').addEventListener"), 'No invite-demo event listener');

  // Verify auth.js waitlist route doesn't return position number
  const authJs = fs.readFileSync(path.join(__dirname, '../server/routes/auth.js'), 'utf8');
  assert.ok(!authJs.includes('position: pos'), 'auth.js must not return waitlist position to user');
  assert.ok(!authJs.includes('Your position: #'), 'auth.js email must not reveal waitlist position number');
});

test('Paper trading: default off on signup, bot.html toggle enabled, API updates paper_mode', () => {
  const dbJs = fs.readFileSync(path.join(__dirname, '../server/db.js'), 'utf8');
  assert.ok(dbJs.includes('paper_mode INTEGER NOT NULL DEFAULT 0'), 'paper_mode must default to 0 (off)');

  const botHtml = fs.readFileSync(path.join(__dirname, '../public/bot.html'), 'utf8');
  assert.ok(!botHtml.includes('id="paper-toggle" checked'), 'paper-toggle must start unchecked');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(!pagesJs.includes('paper.disabled = true;'), 'paper.disabled must not be hardcoded true');
  assert.ok(pagesJs.includes("NX.patch('/api/me/paper'"), 'pages.js must toggle paper mode via PATCH /api/me/paper');

  const appJs = fs.readFileSync(path.join(__dirname, '../server/routes/app.js'), 'utf8');
  assert.ok(appJs.includes("r.patch('/api/me/paper'"), 'PATCH /api/me/paper route exists');
});

test('Wallet connection: auto-detection, no premature redirection, and hex chainId for approvals', () => {
  const apiJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/api.js'), 'utf8');
  assert.ok(apiJs.includes('eip6963:announceProvider'), 'EIP-6963 provider announcements supported');
  assert.ok(apiJs.includes('getEvmWallet'), 'Robust EVM wallet resolution');
  assert.ok(apiJs.includes('getSolanaWallet'), 'Robust Solana wallet resolution');
  assert.ok(apiJs.includes('deepLink'), 'Mobile wallet deep links provided');
  assert.ok(apiJs.includes('wallet_switchEthereumChain'), 'wallet_switchEthereumChain supported');
  assert.ok(apiJs.includes('hexChainId'), 'Chain ID converted to 0x-hex string for EVM approvals');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(!pagesJs.includes('if (!NX.wallet.available(w.id)) { window.open('), 'Must not redirect away on wallet click');
  assert.ok(pagesJs.includes('NX.wallet.prove(w.id'), 'Directly connects and requests nonce/signature');
});

test('Mobile wallet handoff, DApp copy link, and scheme deep linking', () => {
  const authJs = fs.readFileSync(path.join(__dirname, '../server/routes/auth.js'), 'utf8');
  assert.ok(authJs.includes('/api/auth/handoff'), 'Issues short-lived session handoff tokens');
  assert.ok(authJs.includes('/api/auth/handoff/consume'), 'Consumes single-use handoff tokens to establish session in in-app browser');

  const coreJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/core.js'), 'utf8');
  assert.ok(coreJs.includes("urlParams.get('handoff')"), 'core.js auto-detects and consumes handoff token on boot');

  const apiJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/api.js'), 'utf8');
  assert.ok(apiJs.includes('SCHEME_LINKS'), 'Provides direct custom scheme links for mobile wallet apps');
  assert.ok(apiJs.includes('schemeLink'), 'schemeLink helper exposed');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(pagesJs.includes('data-copy-dapp'), 'Provides one-click Copy DApp Link button for mobile in-app browser');
});

test('User dashboard sweep removal & Admin-only sweep preservation', () => {
  const walletsHtml = fs.readFileSync(path.join(__dirname, '../public/wallets.html'), 'utf8');
  assert.ok(!walletsHtml.includes('data-bulk="sweep"'), 'Bulk sweep button removed from user wallets.html');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(!pagesJs.includes('data-wact="sweep"'), 'Sweep to main action removed from user wallet options');
  assert.ok(!pagesJs.includes("b.dataset.bulk === 'sweep'"), 'Bulk sweep handler removed from user wallets');

  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(!indexHtml.includes('fund and sweep in bulk'), 'Public landing page does not advertise user sweeps');

  // Admin sweep must remain intact
  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('Sweep'), 'Admin sweep functionality preserved for operations');
});

test('Visible Sign Out option in desktop sidebar, topbar, and mobile more-sheet', () => {
  const coreJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/core.js'), 'utf8');
  assert.ok(coreJs.includes('nav-link--logout'), 'Visible Sign Out link in desktop sidebar navigation');
  assert.ok(coreJs.includes('icon-btn--logout'), 'Visible Sign Out button in topbar header');
  assert.ok(coreJs.includes('option-card--danger'), 'Visible Sign Out button in mobile more-sheet dialog');
  assert.ok(coreJs.includes("a === 'logout'"), 'data-action="logout" triggers NX.logout()');
});

test('Multi-chain tiny balance display and formatting for user & admin', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../server/routes/app.js'), 'utf8');
  assert.ok(appJs.includes('refreshWalletBalance'), 'Backend refreshes multi-chain wallet balances');
  assert.ok(appJs.includes('nativeSym'), 'Supports multi-currency symbols (ETH, TRX, SOL, BTC, LTC)');
  assert.ok(appJs.includes('1e-12'), 'Does not hide tiny balances (dust threshold 1e-12)');

  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('ETH') && adminJs.includes('TRX'), 'Admin user wallets table supports multi-chain symbols');
  assert.ok(adminJs.includes('toFixed(6)'), 'Admin user wallets table formats tiny amounts with 6 decimals');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(pagesJs.includes('0.001 ? 6'), 'pages.js formats small amounts under 0.001 with 6 decimal places');
  assert.ok(pagesJs.includes('< $0.01'), 'pages.js formats tiny USD values as < $0.01');
});

test('Multi-chain DeFi wallet address validation, multi-wallet detection, and update script', () => {
  const apiJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/api.js'), 'utf8');
  assert.ok(apiJs.includes('NX.isTron'), 'Tron address validation supported');
  assert.ok(apiJs.includes('NX.isBtc'), 'Bitcoin address validation supported');
  assert.ok(apiJs.includes('NX.isLtc'), 'Litecoin address validation supported');
  assert.ok(apiJs.includes('NX.detectChain'), 'Multi-chain auto-detection helper exposed');
  assert.ok(apiJs.includes('okx') && apiJs.includes('bitget') && apiJs.includes('rainbow'), 'Expanded DeFi wallet providers supported');

  const pagesJs = fs.readFileSync(path.join(__dirname, '../public/assets/js/pages.js'), 'utf8');
  assert.ok(pagesJs.includes("'okx'") && pagesJs.includes("'bitget'"), 'WALLETS list includes OKX and Bitget');
  assert.ok(pagesJs.includes("'browser'"), 'WALLETS list includes generic Browser/Injected wallet');
  assert.ok(pagesJs.includes('NX.detectChain'), 'Watch-only wallet input uses auto chain detection');

  const updateSh = fs.readFileSync(path.join(__dirname, '../update.sh'), 'utf8');
  assert.ok(updateSh.includes('git fetch origin main'), 'update.sh fetches from origin main');
  assert.ok(updateSh.includes('npm install --omit=dev'), 'update.sh updates npm dependencies');
  assert.ok(updateSh.includes('systemctl restart nectra.service') || updateSh.includes('pm2 restart'), 'update.sh restarts service');
});
