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
  const platformName = s.platform_name || 'Ascendex';
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds an accessible, responsive HTML email matching the dark landing page theme:
 * - Background: #0A0A0C
 * - Card background: #131318, Border: #23232E
 * - Brand Accent: #F2559A / gradient (#FF66A1 to #D82675)
 * - Anti-phishing code banner, verification code chip, and security footer
 */
function buildHtmlEmail({ platformName = 'Ascendex', subject = '', body = '', antiPhishing = null, to = '' }) {
  const brand = escapeHtml(platformName || 'Ascendex');
  const safeSubject = escapeHtml(subject || 'Important Notification');
  const cleanBody = String(body || '');

  // Preheader preview snippet (hidden from email body, shown in inbox preview snippet)
  const preheaderText = escapeHtml(
    (antiPhishing ? `[Anti-Phishing: ${antiPhishing}] ` : '') +
    cleanBody.replace(/\r?\n+/g, ' ').slice(0, 140)
  );

  const lines = cleanBody.split(/\r?\n/);
  const contentBlocks = [];
  let inList = false;
  let currentList = [];

  const flushList = () => {
    if (inList && currentList.length) {
      contentBlocks.push(
        `<ul style="margin:14px 0 18px 0;padding-left:22px;color:#E4E4E8;line-height:1.75;font-size:14px;">${currentList.map(item => `<li style="margin-bottom:6px;">${item}</li>`).join('')}</ul>`
      );
      currentList = [];
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) {
      flushList();
      continue;
    }

    // Bulleted list item
    if (/^[•\-\*]\s+/.test(rawLine)) {
      inList = true;
      currentList.push(escapeHtml(rawLine.replace(/^[•\-\*]\s+/, '')));
      continue;
    } else {
      flushList();
    }

    // Verification code / OTP highlight
    const codeMatch = rawLine.match(/(?:verification code is:?|code:?|code is:?)\s*([A-Za-z0-9]{4,8})\b/i);
    if (codeMatch) {
      const code = escapeHtml(codeMatch[1]);
      contentBlocks.push(
        `<div style="text-align:center;margin:24px 0 20px 0;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#9E9EA8;margin-bottom:8px;font-weight:600;">Verification Code</div>
          <div style="display:inline-block;background:#181822;border:1px solid #F2559A;color:#FFFFFF;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;padding:12px 28px;border-radius:10px;box-shadow:0 0 22px rgba(242,85,154,0.22);">${code}</div>
        </div>`
      );
      continue;
    }

    // Actionable link detection -> CTA Button
    if (/^https?:\/\/[^\s]+$/.test(rawLine)) {
      const url = rawLine;
      const isVerify = /verify/i.test(url) || /auth/i.test(url);
      const btnText = isVerify ? 'Verify Email Address' : 'Open ' + brand;
      contentBlocks.push(
        `<div style="text-align:center;margin:24px 0 20px 0;">
          <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:13px 32px;background:linear-gradient(135deg, #FF66A1 0%, #D82675 100%);color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;border-radius:8px;box-shadow:0 4px 16px rgba(216,38,117,0.35);">${btnText}</a>
          <div style="margin-top:10px;font-size:11px;color:#9E9EA8;word-break:break-all;">Or copy link: <a href="${escapeHtml(url)}" style="color:#F2559A;text-decoration:underline;">${escapeHtml(url)}</a></div>
        </div>`
      );
      continue;
    }

    // Normal paragraph
    contentBlocks.push(
      `<p style="margin:10px 0;line-height:1.65;color:#E4E4E8;font-size:14px;">${escapeHtml(rawLine)}</p>`
    );
  }
  flushList();

  const antiPhishingBanner = antiPhishing
    ? `
      <!-- Anti-Phishing Security Banner -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;background:#181822;border:1px solid #2B2B3C;border-radius:8px;">
        <tr>
          <td style="padding:10px 14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:12px;color:#9E9EA8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  <span style="color:#10B981;font-weight:bold;margin-right:6px;">&#10003; Security Verified</span>
                  <span>Anti-Phishing Code:</span>
                </td>
                <td align="right" style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:13px;font-weight:700;color:#F2559A;letter-spacing:1px;">
                  ${escapeHtml(antiPhishing)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#0A0A0C;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#F4F4F6;">
  <!-- Preheader text for inbox preview -->
  <span style="display:none;font-size:1px;color:#0A0A0C;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheaderText}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0A0A0C;padding:32px 14px;">
    <tr>
      <td align="center">
        <!-- Main Card Container with Landing Page Theme -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background-color:#131318;border:1px solid #23232E;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
          <!-- Brand Header -->
          <tr>
            <td style="padding:24px 28px 18px 28px;border-bottom:1px solid #1E1E28;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <div style="display:inline-block;vertical-align:middle;width:32px;height:32px;background:linear-gradient(135deg, #FF66A1 0%, #D82675 100%);border-radius:8px;text-align:center;line-height:32px;color:#FFFFFF;font-weight:800;font-size:17px;">
                      ${brand.charAt(0)}
                    </div>
                    <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:19px;font-weight:700;letter-spacing:-0.3px;color:#FFFFFF;">
                      ${brand}
                    </span>
                  </td>
                  <td align="right">
                    <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#F2559A;background:rgba(242,85,154,0.12);padding:4px 10px;border-radius:20px;font-weight:600;border:1px solid rgba(242,85,154,0.3);">Official</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Email Content Body -->
          <tr>
            <td style="padding:28px;">
              ${antiPhishingBanner}

              <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.35;letter-spacing:-0.2px;">
                ${safeSubject}
              </h1>

              ${contentBlocks.join('\n')}

              <!-- Divider -->
              <div style="margin:28px 0 20px 0;border-top:1px solid #23232E;"></div>

              <!-- Security Notice Footer -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0F0F14;border:1px dashed #2A2A38;border-radius:8px;">
                <tr>
                  <td style="padding:12px 14px;">
                    <div style="font-size:12px;line-height:1.6;color:#9E9EA8;">
                      <strong style="color:#F4F4F6;">&#9888;&#65039; Security Reminder:</strong> ${brand} will never ask for your seed phrase, recovery phrase, or private key. Never share your credentials.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer Note -->
          <tr>
            <td style="padding:18px 28px;background:#0D0D11;border-top:1px solid #1E1E28;font-size:11px;color:#71717A;line-height:1.5;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    &copy; ${new Date().getFullYear()} ${brand}. All rights reserved.
                  </td>
                  <td align="right">
                    <span style="color:#52525B;">Autonomous Trading</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function smtpSend({ to, subject, text, html = null, config = null }) {
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

      const boundary = `_=_boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const htmlBody = html || buildHtmlEmail({ platformName: displayName, subject, body: text, to: cleanTo });

      const msg = [
        `From: ${mimeFrom}`,
        `Reply-To: ${mimeFrom}`,
        `To: <${cleanTo}>`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        `Date: ${new Date().toUTCString()}`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        text.replace(/^\./gm, '..'),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        htmlBody.replace(/^\./gm, '..'),
        '',
        `--${boundary}--`
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
  const html = buildHtmlEmail({
    platformName: cfg.platformName,
    subject,
    body,
    antiPhishing: user && user.anti_phishing,
    to
  });
  const id = q.run('INSERT INTO outbox(to_email, subject, body, status, created_at) VALUES(?,?,?,?,?)', to, subject, text, cfg.host ? 'sending' : 'logged', now()).id;

  if (!cfg.host) {
    console.log(`\n[mail] → ${to}\n  ${subject}\n  ${text.split('\n').join('\n  ')}\n`);
    return { id, status: 'logged', html };
  }

  try {
    await smtpSend({ to, subject, text, html, config: cfg });
    q.run("UPDATE outbox SET status = 'sent' WHERE id = ?", id);
    return { id, status: 'sent', html };
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
  const text = `Hello,\n\nThis is a verification test from ${cfg.platformName}.\nYour SMTP email settings have been configured and verified successfully!\n\nDetails:\n• Server: ${cfg.host}:${cfg.port}\n• Sender: ${cfg.from}\n• Timestamp: ${new Date().toUTCString()}`;
  const html = buildHtmlEmail({ platformName: cfg.platformName, subject, body: text, to: targetEmail });
  await smtpSend({ to: targetEmail, subject, text, html, config: cfg });
  return { ok: true, recipient: targetEmail };
}

module.exports = { sendMail, smtpSend, getMailConfig, testSmtpConnection, formatMimeFrom, buildHtmlEmail };
