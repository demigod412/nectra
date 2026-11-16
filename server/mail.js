/* ==========================================================================
   Mailer — every email carries the user's anti-phishing code.
   Supports dynamic SMTP credentials from Admin Settings or process.env
   (STARTTLS/TLS, AUTH LOGIN). Without it, mail is stored in the outbox
   (Admin → Mailbox) and printed to the console — fine for local development.
   ========================================================================== */
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { q, now, getSettings } = require('./db');

function getMailConfig() {
  let s = {};
  try { s = getSettings ? getSettings() : {}; } catch (e) {}
  const host = s.smtp_host || process.env.SMTP_HOST || '';
  const port = +(s.smtp_port || process.env.SMTP_PORT || 587);
  const user = s.smtp_user || process.env.SMTP_USER || '';
  const pass = s.smtp_pass || process.env.SMTP_PASS || '';
  const platformName = s.platform_name || 'NECTRA';
  const defaultFrom = host ? `${platformName} <no-reply@${host.includes('.') ? host.split('.').slice(-2).join('.') : 'domain.local'}>` : `${platformName} <no-reply@nectra.local>`;
  const from = s.smtp_from || process.env.MAIL_FROM || defaultFrom;
  const secure = s.smtp_secure || port === 465;
  return { host, port, user, pass, from, secure, platformName };
}

function smtpSend({ to, subject, text, config = null }) {
  const cfg = config || getMailConfig();
  const host = cfg.host;
  const port = cfg.port;
  const user = cfg.user;
  const pass = cfg.pass;
  const from = cfg.from;
  const implicitTls = cfg.secure || port === 465;

  if (!host) {
    return Promise.reject(new Error('SMTP host is not configured'));
  }

  return new Promise((resolve, reject) => {
    let sock = implicitTls ? tls.connect(port, host, { servername: host }) : net.connect(port, host);
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    let buf = '';
    const queue = [];
    const expect = () => new Promise((res) => queue.push(res));
    const onData = (d) => {
      buf += d.toString();
      let m;
      while ((m = buf.match(/^(\d{3})([ -])(.*)\r\n/m))) {
        const lineEnd = buf.indexOf('\r\n') + 2;
        const line = buf.slice(0, lineEnd);
        buf = buf.slice(lineEnd);
        if (line[3] === ' ' && queue.length) queue.shift()(+line.slice(0, 3));
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
    const cmd = async (c, ok) => {
      sock.write(c + '\r\n');
      const code = await expect();
      if (!ok.includes(code)) throw new Error(`SMTP ${c.split(' ')[0]} failed (${code})`);
      return code;
    };

    (async () => {
      if ((await expect()) !== 220) throw new Error('SMTP greeting failed');
      await cmd('EHLO localhost', [250]);
      if (!implicitTls) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host });
        sock.on('data', onData);
        await new Promise((r) => sock.once('secureConnect', r));
        await cmd('EHLO localhost', [250]);
      }
      if (user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user).toString('base64'), [334]);
        await cmd(Buffer.from(pass || '').toString('base64'), [235]);
      }
      const fromAddr = (from.match(/<(.+)>/) || [, from])[1];
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const msg = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        `Date: ${new Date().toUTCString()}`,
        '',
        text.replace(/^\./gm, '..')
      ].join('\r\n');
      await cmd(msg + '\r\n.', [250]);
      sock.write('QUIT\r\n');
      sock.end();
      resolve({ ok: true });
    })().catch((e) => {
      sock.destroy();
      reject(e);
    });
  });
}

/** Send (or queue) an email. `user` (optional) supplies the anti-phishing code. */
async function sendMail(to, subject, body, user) {
  if (!to) return;
  const cfg = getMailConfig();
  const phish = user && user.anti_phishing ? `Your anti-phishing code: ${user.anti_phishing}\n\n` : '';
  const text = `${phish}${body}\n\n— ${cfg.platformName}\n${cfg.platformName} will never ask for your seed phrase, recovery phrase or private key.`;
  const id = q.run('INSERT INTO outbox(to_email, subject, body, status, created_at) VALUES(?,?,?,?,?)', to, subject, text, cfg.host ? 'sending' : 'logged', now()).id;

  if (!cfg.host) {
    console.log(`\n[mail] → ${to}\n  ${subject}\n  ${text.split('\n').join('\n  ')}\n`);
    return { id, status: 'logged' };
  }

  try {
    await smtpSend({ to, subject, text, config: cfg });
    q.run("UPDATE outbox SET status = 'sent' WHERE id = ?", id);
    return { id, status: 'sent' };
  } catch (e) {
    q.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", e.message, id);
    console.error('[mail] failed:', e.message);
    return { id, status: 'failed', error: e.message };
  }
}

async function testSmtpConnection(targetEmail) {
  const cfg = getMailConfig();
  if (!cfg.host) {
    throw new Error('SMTP Host is not configured. Set SMTP Server Host in Admin Settings or .env');
  }
  const subject = `${cfg.platformName} — SMTP Verification Test`;
  const text = `Hello,\n\nThis is a verification test from ${cfg.platformName}.\nYour SMTP email settings have been configured and verified successfully!\n\nDetails:\n- Server: ${cfg.host}:${cfg.port}\n- Sender: ${cfg.from}\n- Timestamp: ${new Date().toUTCString()}`;
  await smtpSend({ to: targetEmail, subject, text, config: cfg });
  return { ok: true, recipient: targetEmail };
}

module.exports = { sendMail, smtpSend, getMailConfig, testSmtpConnection };
