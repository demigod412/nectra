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
}
function insight(userId, icon, text) {
  const id = q.run('INSERT INTO insights(user_id, icon, text, created_at) VALUES(?,?,?,?)', userId, icon, text, now()).id;
  toUser(userId, 'insight', { id, icon, text, created_at: now() });
}

module.exports = { addClient, toUser, broadcast, notify, notifyAdmins, insight, onlineCount };
