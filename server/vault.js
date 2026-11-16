/* ==========================================================================
   Vault — AES-256-GCM encryption for server-held secrets (collector keys,
   live-bot wallet keys, VAPID keys) with multi-key versioning and zero-downtime
   key rotation support.
   ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { q, now } = require('./db');

const KEYRING_FILE = path.join(__dirname, '..', 'data', 'master-keyring.json');
const LEGACY_KEY_FILE = path.join(__dirname, '..', 'data', 'master.key');

let keyringCache = null;
let activeVersionCache = null;

function loadKeyring() {
  if (keyringCache) return { keyring: keyringCache, active: activeVersionCache };

  const keyring = {};
  let active = process.env.ACTIVE_MASTER_KEY_VERSION || null;

  // 1. Check MASTER_KEYS JSON env var
  if (process.env.MASTER_KEYS) {
    try {
      const parsed = JSON.parse(process.env.MASTER_KEYS);
      for (const [v, hex] of Object.entries(parsed)) {
        const buf = Buffer.from(String(hex).trim(), 'hex');
        if (buf.length === 32) keyring[v] = buf;
      }
    } catch (e) {
      console.error('[vault] Invalid MASTER_KEYS JSON:', e.message);
    }
  }

  // 2. Check MASTER_KEY single key env var
  if (process.env.MASTER_KEY) {
    const buf = Buffer.from(process.env.MASTER_KEY.trim(), 'hex');
    if (buf.length !== 32) throw new Error('MASTER_KEY must be 64 hex characters (32 bytes)');
    const v = process.env.MASTER_KEY_VERSION || 'v1';
    keyring[v] = buf;
    if (!active) active = v;
  }

  // 3. Check data/master-keyring.json
  if (fs.existsSync(KEYRING_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(KEYRING_FILE, 'utf8'));
      if (j.keys) {
        for (const [v, hex] of Object.entries(j.keys)) {
          const buf = Buffer.from(String(hex).trim(), 'hex');
          if (buf.length === 32) keyring[v] = buf;
        }
      }
      if (!active && j.active) active = j.active;
    } catch (e) {
      console.error('[vault] Invalid master-keyring.json:', e.message);
    }
  }

  // 4. Fallback to data/master.key
  if (Object.keys(keyring).length === 0) {
    if (!fs.existsSync(LEGACY_KEY_FILE)) {
      fs.mkdirSync(path.dirname(LEGACY_KEY_FILE), { recursive: true });
      fs.writeFileSync(LEGACY_KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      console.warn('[vault] Generated data/master.key — set MASTER_KEY in production and back it up.');
    }
    const hex = fs.readFileSync(LEGACY_KEY_FILE, 'utf8').trim();
    keyring['v1'] = Buffer.from(hex, 'hex');
    if (!active) active = 'v1';
  }

  // If active is still unset, pick the highest version or first key
  if (!active || !keyring[active]) {
    const versions = Object.keys(keyring).sort();
    active = versions[versions.length - 1];
  }

  keyringCache = keyring;
  activeVersionCache = active;
  return { keyring, active };
}

function resetKeyringCache() {
  keyringCache = null;
  activeVersionCache = null;
}

function getKey(version) {
  const { keyring } = loadKeyring();
  const key = keyring[version];
  if (!key) throw new Error(`Vault key version "${version}" not found in keyring`);
  return key;
}

function getActiveVersion() {
  return loadKeyring().active;
}

function getKeyring() {
  return loadKeyring().keyring;
}

function encrypt(plain, keyVersion = null) {
  const { active } = loadKeyring();
  const ver = keyVersion || active;
  const key = getKey(ver);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [ver, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(blob) {
  const parts = String(blob).split('.');
  if (parts.length !== 4) throw new Error('Invalid vault ciphertext format');
  const [ver, iv, tag, data] = parts;
  const key = getKey(ver);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Named secret: env var wins; otherwise stored encrypted in DB */
function secret(name, generate, envName) {
  if (envName && process.env[envName]) return process.env[envName];
  const row = q.get('SELECT value FROM secrets WHERE name = ?', name);
  if (row) return decrypt(row.value);
  const v = generate();
  const ver = getActiveVersion();
  q.run('INSERT INTO secrets(name, value, key_version, created_at) VALUES(?,?,?,?)', name, encrypt(v, ver), ver, now());
  return v;
}

module.exports = {
  encrypt,
  decrypt,
  secret,
  getKey,
  getActiveVersion,
  getKeyring,
  loadKeyring,
  resetKeyringCache
};
