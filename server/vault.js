/* ==========================================================================
   Vault — AES-256-GCM encryption for server-held secrets (collector keys,
   live-bot wallet keys, VAPID keys). The master key comes from MASTER_KEY
   (64 hex chars). In development a key is generated into data/master.key —
   for production set MASTER_KEY from a secrets manager and back it up:
   losing it means losing access to every encrypted key.
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { q, now } = require('./db');

let master;
function masterKey() {
  if (master) return master;
  if (process.env.MASTER_KEY) {
    master = Buffer.from(process.env.MASTER_KEY, 'hex');
    if (master.length !== 32) throw new Error('MASTER_KEY must be 64 hex characters (32 bytes)');
    return master;
  }
  const file = path.join(__dirname, '..', 'data', 'master.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn('[vault] Generated data/master.key — set MASTER_KEY in production and back it up.');
  }
  master = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return master;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown vault format');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Named secret: env var wins; otherwise stored encrypted in the DB, created on first use */
function secret(name, generate, envName) {
  if (envName && process.env[envName]) return process.env[envName];
  const row = q.get('SELECT value FROM secrets WHERE name = ?', name);
  if (row) return decrypt(row.value);
  const v = generate();
  q.run('INSERT INTO secrets(name, value, created_at) VALUES(?,?,?)', name, encrypt(v), now());
  return v;
}

module.exports = { encrypt, decrypt, secret };
