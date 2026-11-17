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
  const defaultFrom = host ? `${platformName} <no-reply@${host.includes('.') ? host.split('.').slice(-2).join('.') : 'domain.local'}>` : `${platformName} <no-reply@domain.local>`;
  const from = s.smtp_from || process.env.MAIL_FROM || defaultFrom;
  const secure = s.smtp_secure || port === 465;
  return { host, port, user, pass, from, secure, platformName };
}

function extractEmail(str) {
  if (!str) return '';
  const s = String(str).trim();
  // 1. Angle bracket match: e.g. "Name <email@domain.com>" -> email@domain.com
  const angleMatch = s.match(/<([^>]+)>/);
  if (angleMatch) {
    const inside = angleMatch[1].trim();
    if (inside.includes('@')) return inside.toLowerCase();
  }
  // 2. Parentheses match: e.g. "Name (email@domain.com)" -> email@domain.com
  const parenMatch = s.match(/\(([^)]+@[^)]+)\)/);
  if (parenMatch) {
    return parenMatch[1].trim().toLowerCase();
  }
  // 3. Match general email address pattern anywhere in the string
  const m = s.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (m) return m[0].trim().toLowerCase();
  // 4. Strip any invalid characters
  return s.replace(/[<>"'() \t\r\n]/g, '').trim().toLowerCase();
}

function formatMimeFrom(displayName, cleanEmail) {
  const email = extractEmail(cleanEmail);
  const name = String(displayName || '').replace(/[\r\n]/g, '').trim();
  if (!name) return `<${email}>`;
  // RFC 2047 Base64 encoding if non-ASCII characters present
  if (/[^\x20-\x7E]/.test(name)) {
    return `=?UTF-8?B?${Buffer.from(name).toString('base64')}?= <${email}>`;
  }
  // Quote if special RFC 5322 characters are present
  if (/[,;"\\]/.test(name)) {
    return `"${name.replace(/["\\]/g, '')}" <${email}>`;
  }
  return `${name} <${email}>`;
}

function smtpSend({ to, subject, text, config = null }) {
  const cfg = config || getMailConfig();
  const host = (cfg.host || '').trim();
  const port = +(cfg.port || 587);
  const user = (cfg.user || '').trim();
  const pass = (cfg.pass || '').trim();
  const from = (cfg.from || '').trim();
  const implicitTls = !!cfg.secure || port === 465;

  if (!host) {
    return Promise.reject(new Error('SMTP host is not configured'));
  }

  const cleanTo = extractEmail(to);
  if (!cleanTo || !cleanTo.includes('@')) {
    return Promise.reject(new Error(`Recipient email is missing or invalid: ${to}`));
  }

  let cleanFrom = extractEmail(from);
  // If cleanFrom is not a valid email, check if username is an email address
  if (!cleanFrom.includes('@') && user && user.includes('@')) {
    cleanFrom = extractEmail(user);
  }
  // If still no valid email, synthesize one with host domain
  if (!cleanFrom.includes('@')) {
    const hostDomain = host.includes('.') ? host.split('.').slice(-2).join('.') : 'domain.local';
    cleanFrom = `no-reply@${hostDomain}`;
  }

  // Proper RFC 5322 MIME From header: ensure platform/company name is always the display name
  let s = {};
  try { s = getSettings ? getSettings() : {}; } catch (_) {}
  const platform = (cfg.platformName || s.platform_name || 'NECTRA').replace(/[\r\n]/g, '').trim();

  let displayName = platform;
  if (from && from.includes('<')) {
    const m = from.match(/^(.*?)\s*<[^>]+>/);
    if (m && m[1]) {
      const explicit = m[1].replace(/["']/g, '').trim();
      const generic = ['noreply', 'no-reply', 'no_reply', 'mailer', 'smtp', 'admin', 'platform', 'nectra', 'email'];
      if (explicit && !generic.includes(explicit.toLowerCase())) {
        displayName = explicit;
      }
    }
  }
  if (!displayName || ['noreply', 'no-reply', 'no_reply'].includes(displayName.toLowerCase())) {
    displayName = platform;
  }

  const mimeFrom = formatMimeFrom(displayName, cleanFrom);

  const domain = host.includes('.') ? host.split('.').slice(-2).join('.') : 'domain.local';

  return new Promise((resolve, reject) => {
    let resolved = false;
    let sock;
    const cleanupAndReject = (err) => {
      if (resolved) return;
      resolved = true;
      try { if (sock) sock.destroy(); } catch (_) {}
      reject(err);
    };

    try {
      sock = implicitTls
        ? tls.connect(port, host, { servername: host, rejectUnauthorized: false })
        : net.connect(port, host);
    } catch (err) {
      return cleanupAndReject(err);
    }

    sock.setTimeout(18000, () => {
      cleanupAndReject(new Error(`SMTP connection timeout after 18s to ${host}:${port}`));
    });

    let buf = '';
    let lastMsg = '';
    let receivedLines = [];
    const queue = [];
    const expect = () => new Promise((res) => queue.push(res));

    const onData = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.search(/\r?\n/)) !== -1) {
        const isCrlf = buf[idx] === '\r' && buf[idx + 1] === '\n';
        const lineEnd = idx + (isCrlf ? 2 : 1);
        const line = buf.slice(0, lineEnd);
        buf = buf.slice(lineEnd);
        const codeMatch = line.match(/^(\d{3})([ -])(.*)/);
        if (codeMatch) {
          const code = +codeMatch[1];
          const sep = codeMatch[2];
          lastMsg = (codeMatch[3] || '').trim();
          receivedLines.push(lastMsg);
          if (sep === '' || sep === ' ') {
            if (queue.length) {
              queue.shift()({ code, lines: receivedLines });
              receivedLines = [];
            }
          }
        }
      }
    };

    sock.on('data', onData);
    sock.on('error', cleanupAndReject);

    const cmd = async (c, okCodes) => {
      sock.write(c + '\r\n');
      const { code, lines } = await expect();
      if (!okCodes.includes(code)) {
        throw new Error(`SMTP ${c.split(' ')[0]} failed (${code}${lastMsg ? ': ' + lastMsg : ''})`);
      }
      return { code, lines };
    };

    (async () => {
      const { code: greetingCode } = await expect();
      if (greetingCode !== 220) {
        throw new Error(`SMTP greeting failed (${greetingCode}${lastMsg ? ': ' + lastMsg : ''})`);
      }

      const { lines: caps } = await cmd(`EHLO ${domain}`, [250]);
      const supportsStartTls = caps && caps.some((l) => /STARTTLS/i.test(l));

      if (!implicitTls && supportsStartTls) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false });
        sock.on('data', onData);
        sock.on('error', cleanupAndReject);
        await new Promise((r, rej) => {
          sock.once('secureConnect', r);
          sock.once('error', rej);
        });
        await cmd(`EHLO ${domain}`, [250]);
      }

      if (user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user).toString('base64'), [334]);
        await cmd(Buffer.from(pass || '').toString('base64'), [235]);
      }

      await cmd(`MAIL FROM:<${cleanFrom}>`, [250]);
      await cmd(`RCPT TO:<${cleanTo}>`, [250, 251]);
      await cmd('DATA', [354]);

      const msg = [
        `From: ${mimeFrom}`,
        `Reply-To: ${mimeFrom}`,
        `To: <${cleanTo}>`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        `Date: ${new Date().toUTCString()}`,
        '',
        text.replace(/^\./gm, '..')
      ].join('\r\n');

      await cmd(msg + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch (_) {}
      try { sock.end(); } catch (_) {}
      resolved = true;
      resolve({ ok: true, recipient: cleanTo });
    })().catch(cleanupAndReject);
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

async function testSmtpConnection(targetEmail, customConfig = null) {
  const cfg = customConfig ? Object.assign(getMailConfig(), customConfig) : getMailConfig();
  if (!cfg.host) {
    throw new Error('SMTP Host is not configured. Set SMTP Server Host in Admin Settings or .env');
  }
  const subject = `${cfg.platformName} — SMTP Verification Test`;
  const text = `Hello,\n\nThis is a verification test from ${cfg.platformName}.\nYour SMTP email settings have been configured and verified successfully!\n\nDetails:\n- Server: ${cfg.host}:${cfg.port}\n- Sender: ${cfg.from}\n- Timestamp: ${new Date().toUTCString()}`;
  await smtpSend({ to: targetEmail, subject, text, config: cfg });
  return { ok: true, recipient: targetEmail };
}

module.exports = { sendMail, smtpSend, getMailConfig, testSmtpConnection, formatMimeFrom };
