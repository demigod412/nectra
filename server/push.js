/* ==========================================================================
   Web Push (VAPID) — real push notifications for the installable app (PWA).
   Keys are generated once and stored encrypted (or set VAPID_PUBLIC_KEY /
   VAPID_PRIVATE_KEY). events.notify() fans out to every subscribed device.
   ========================================================================== */
'use strict';
const webpush = require('web-push');
const { q, now, J } = require('./db');
const vault = require('./vault');

let ready = false;
function init() {
  if (ready) return true;
  try {
    const keys = JSON.parse(vault.secret('vapid', () => JSON.stringify(webpush.generateVAPIDKeys())));
    const pub = process.env.VAPID_PUBLIC_KEY || keys.publicKey, priv = process.env.VAPID_PRIVATE_KEY || keys.privateKey;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@nectra.local', pub, priv);
    module.exports.publicKey = pub;
    ready = true;
  } catch (e) { console.warn('[push] disabled:', e.message); }
  return ready;
}
function subscribe(userId, sub, ua) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('Invalid subscription');
  q.run('INSERT INTO push_subs(user_id, endpoint, keys, ua, created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys', userId, sub.endpoint, JSON.stringify(sub.keys), String(ua || '').slice(0, 120), now());
}
function unsubscribe(userId, endpoint) { q.run('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, endpoint); }
/** Fire-and-forget push to every device of a user (respects the user's push preference) */
function send(userId, payload) {
  if (!init()) return;
  const u = q.get('SELECT prefs FROM users WHERE id = ?', userId);
  if (u && J(u.prefs).pushNotif === false) return;
  for (const s of q.all('SELECT * FROM push_subs WHERE user_id = ?', userId)) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: J(s.keys) }, JSON.stringify(payload), { TTL: 3600 })
      .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) q.run('DELETE FROM push_subs WHERE id = ?', s.id); });
  }
}
module.exports = { init, subscribe, unsubscribe, send, publicKey: null };
