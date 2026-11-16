/* ==========================================================================
   Event bus + Server-Sent Events hub, and notification helper
   ========================================================================== */
'use strict';
const { q, now } = require('./db');

const clients = new Map(); // userId -> Set(res)

function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => { const s = clients.get(userId); if (s) { s.delete(res); if (!s.size) clients.delete(userId); } });
}
function write(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ } }
function toUser(userId, event, data) { const s = clients.get(userId); if (s) for (const r of s) write(r, event, data); }
function broadcast(event, data) { for (const s of clients.values()) for (const r of s) write(r, event, data); }
const onlineCount = () => clients.size;
setInterval(() => broadcast('ping', { t: now() }), 25000).unref();

/** Create a notification and push it live */
function notify(userId, type, title, body, link) {
  const id = q.run('INSERT INTO notifications(user_id, type, title, body, link, created_at) VALUES(?,?,?,?,?,?)', userId, type, title, body, link || null, now()).id;
  toUser(userId, 'notification', { id, type, title, body, link, created_at: now(), unread: 1 });
  setImmediate(() => { try { require('./push').send(userId, { title, body, link: link || '/notifications.html', type }); } catch (e) { /* push optional */ } });
  return id;
}
function notifyAdmins(type, title, body, link) {
  q.all("SELECT id FROM users WHERE role IN ('loan_officer','admin','super_admin') AND status = 'active'").forEach((a) => notify(a.id, type, title, body, link));
  sendAdminWebhook({ title, text: body, severity: type === 'security' ? 'warn' : 'info', fields: { type, link: link || '' } });
}
function insight(userId, icon, text) {
  const id = q.run('INSERT INTO insights(user_id, icon, text, created_at) VALUES(?,?,?,?)', userId, icon, text, now()).id;
  toUser(userId, 'insight', { id, icon, text, created_at: now() });
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Dispatch an alert directly via Telegram Bot API.
 * Uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (env or Admin Settings).
 */
async function sendTelegramAlert(payload = {}) {
  let botToken = process.env.TELEGRAM_BOT_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID;
  try {
    const { getSettings } = require('./db');
    const s = getSettings ? getSettings() : {};
    botToken = botToken || s.telegram_bot_token;
    chatId = chatId || s.telegram_chat_id;
  } catch (e) {}

  if (!botToken || !chatId) {
    return { ok: false, error: 'Telegram Bot Token or Chat ID not configured in settings or environment' };
  }

  botToken = String(botToken).trim();
  chatId = String(chatId).trim();

  const title = payload.title || 'NECTRA Admin Alert';
  const text = payload.text || payload.body || '';
  const severity = (payload.severity || 'info').toLowerCase();
  const fields = payload.fields || {};

  const icon = severity === 'danger' || severity === 'error' ? '🚨'
    : severity === 'warn' || severity === 'warning' ? '⚠️'
    : 'ℹ️';

  let html = `<b>${icon} NECTRA Sentinel: ${escapeHtml(title)}</b>\n\n`;
  if (text) html += `${escapeHtml(text)}\n\n`;
  if (fields && Object.keys(fields).length > 0) {
    html += `<b>Metadata:</b>\n`;
    for (const [k, v] of Object.entries(fields)) {
      html += `• <b>${escapeHtml(k)}:</b> <code>${escapeHtml(String(v))}</code>\n`;
    }
  }
  html += `\n<i>Timestamp: ${new Date().toISOString()}</i>`;

  const postData = JSON.stringify({
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  return new Promise((resolve) => {
    try {
      const https = require('node:https');
      const req = https.request(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 8000
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve({ ok: true, data: parsed.result });
            else resolve({ ok: false, error: parsed.description || 'Telegram API returned error' });
          } catch (err) {
            resolve({ ok: res.statusCode === 200, status: res.statusCode });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Telegram request timed out' }); });
      req.write(postData);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/**
 * Dispatch an alert to external listeners:
 * 1. Telegram Bot API (if telegram_bot_token and telegram_chat_id are configured)
 * 2. Webhook endpoint (if admin_alert_webhook_url or ADMIN_ALERT_WEBHOOK_URL is set)
 */
function sendAdminWebhook(payload = {}) {
  // 1. Dispatch to Telegram
  setImmediate(() => {
    sendTelegramAlert(payload).catch(() => {});
  });

  // 2. Dispatch to Generic/Discord/Slack webhook if set
  let url = process.env.ADMIN_ALERT_WEBHOOK_URL;
  if (!url) {
    try {
      const { getSettings } = require('./db');
      url = getSettings().admin_alert_webhook_url;
    } catch (e) {}
  }
  if (!url || typeof url !== 'string' || !url.trim()) return false;
  url = url.trim();

  const title = payload.title || 'NECTRA Admin Alert';
  const text = payload.text || payload.body || '';
  const severity = (payload.severity || 'info').toLowerCase();
  const fields = payload.fields || {};

  const color = severity === 'danger' || severity === 'error' ? 0xff3b30
    : severity === 'warn' || severity === 'warning' ? 0xff9500
    : 0x34c759;

  const discordSlackPayload = {
    username: 'NECTRA Sentinel',
    content: `**[${severity.toUpperCase()}] ${title}**\n${text}`,
    text: `*${title}* [${severity.toUpperCase()}]:\n${text}`,
    embeds: [{
      title,
      description: text,
      color,
      timestamp: new Date().toISOString(),
      fields: Object.entries(fields).map(([name, value]) => ({ name, value: String(value), inline: true }))
    }],
    data: { title, text, severity, fields, timestamp: Date.now() }
  };

  const body = JSON.stringify(discordSlackPayload);

  try {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('node:https') : require('node:http');
    const req = mod.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'NECTRA-Sentinel/2.0'
      },
      timeout: 5000
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { addClient, toUser, broadcast, notify, notifyAdmins, sendAdminWebhook, sendTelegramAlert, insight, onlineCount };
