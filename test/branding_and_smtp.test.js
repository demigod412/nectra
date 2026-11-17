/**
 * Verification test for White-label branding, SMTP test endpoint, and Landing page Live Trading
 */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const { testSmtpConnection, smtpSend } = require('../server/mail');
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
