/* ==========================================================================
   Mailer — every email carries the user's anti-phishing code.
   With SMTP_HOST set, mail is sent via a minimal SMTP client (STARTTLS/TLS,
   AUTH LOGIN). Without it, mail is stored in the outbox (Admin → Mailbox)
   and printed to the console — fine for local development.
   ========================================================================== */
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { q, now } = require('./db');

const FROM = process.env.MAIL_FROM || 'NECTRA <no-reply@nectra.local>';

function smtpSend({ to, subject, text }) {
  const host = process.env.SMTP_HOST, port = +(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  const implicitTls = port === 465;
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
    const cmd = async (c, ok) => { sock.write(c + '\r\n'); const code = await expect(); if (!ok.includes(code)) throw new Error(`SMTP ${c.split(' ')[0]} failed (${code})`); return code; };
    (async () => {
      if ((await expect()) !== 220) throw new Error('SMTP greeting failed');
      await cmd('EHLO nectra', [250]);
      if (!implicitTls) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host });
        sock.on('data', onData);
        await new Promise((r) => sock.once('secureConnect', r));
        await cmd('EHLO nectra', [250]);
      }
      if (user) { await cmd('AUTH LOGIN', [334]); await cmd(Buffer.from(user).toString('base64'), [334]); await cmd(Buffer.from(pass || '').toString('base64'), [235]); }
      const fromAddr = (FROM.match(/<(.+)>/) || [, FROM])[1];
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const msg = [`From: ${FROM}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', `Date: ${new Date().toUTCString()}`, '', text.replace(/^\./gm, '..')].join('\r\n');
      await cmd(msg + '\r\n.', [250]);
      sock.write('QUIT\r\n'); sock.end();
      resolve();
    })().catch((e) => { sock.destroy(); reject(e); });
  });
}

/** Send (or queue) an email. `user` (optional) supplies the anti-phishing code. */
async function sendMail(to, subject, body, user) {
  if (!to) return;
  const phish = user && user.anti_phishing ? `Your anti-phishing code: ${user.anti_phishing}\n\n` : '';
  const text = `${phish}${body}\n\n— NECTRA\nNECTRA will never ask for your seed phrase, recovery phrase or private key.`;
  const id = q.run('INSERT INTO outbox(to_email, subject, body, status, created_at) VALUES(?,?,?,?,?)', to, subject, text, process.env.SMTP_HOST ? 'sending' : 'logged', now()).id;
  if (!process.env.SMTP_HOST) { console.log(`\n[mail] → ${to}\n  ${subject}\n  ${text.split('\n').join('\n  ')}\n`); return; }
  try { await smtpSend({ to, subject, text }); q.run("UPDATE outbox SET status = 'sent' WHERE id = ?", id); }
  catch (e) { q.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", e.message, id); console.error('[mail] failed:', e.message); }
}

module.exports = { sendMail };
