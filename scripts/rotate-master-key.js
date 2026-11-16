#!/usr/bin/env node
/* ==========================================================================
   scripts/rotate-master-key.js — Vault Master Key Rotation Tool
   Re-encrypts all vaulted secrets and bot private keys under a new key version.
   Features:
   - Supports --dry-run (validates decryption/re-encryption without DB writes)
   - Resumable and idempotent (skips items already on target key version)
   - Strict verification pass before committing transaction
   - Zero downtime: old keys remain accessible in keyring during migration
   ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Load environment if .env exists
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const { q, tx } = require('../server/db');
const vault = require('../server/vault');

const KEYRING_FILE = path.join(__dirname, '..', 'data', 'master-keyring.json');

// Parse arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

let newKeyHex = null;
let targetVersion = null;

for (const arg of args) {
  if (arg.startsWith('--new-key=')) newKeyHex = arg.split('=')[1].trim();
  else if (arg.startsWith('--target-version=')) targetVersion = arg.split('=')[1].trim();
  else if (!arg.startsWith('--') && /^[0-9a-fA-F]{64}$/.test(arg)) newKeyHex = arg.trim();
}

// If no key provided, generate a cryptographically random 32-byte key
if (!newKeyHex) {
  newKeyHex = crypto.randomBytes(32).toString('hex');
  console.log(`[rotation] Generated new master key: ${newKeyHex}`);
}

if (!/^[0-9a-fA-F]{64}$/i.test(newKeyHex)) {
  console.error('Error: New master key must be exactly 64 hex characters (32 bytes).');
  process.exit(1);
}

const currentActive = vault.getActiveVersion();
if (!targetVersion) {
  const num = parseInt(currentActive.replace(/\D/g, ''), 10) || 1;
  targetVersion = `v${num + 1}`;
}

console.log(`=======================================================`);
console.log(` NECTRA Vault Master Key Rotation Tool`);
console.log(` Mode:           ${isDryRun ? 'DRY-RUN (No DB modifications)' : 'LIVE EXECUTION'}`);
console.log(` Target Version: ${targetVersion}`);
console.log(` Active Version: ${currentActive}`);
console.log(`=======================================================\n`);

const newKeyBuffer = Buffer.from(newKeyHex, 'hex');

// Encryption function for target version
function encryptTarget(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', newKeyBuffer, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [targetVersion, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decryptTarget(blob) {
  const [ver, iv, tag, data] = String(blob).split('.');
  if (ver !== targetVersion) throw new Error(`Expected version ${targetVersion}, got ${ver}`);
  const d = crypto.createDecipheriv('aes-256-gcm', newKeyBuffer, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

async function runRotation() {
  const secrets = q.all('SELECT name, value, key_version FROM secrets');
  const botWallets = q.all('SELECT bot_id, secret, key_version FROM bot_wallets');

  console.log(`Found ${secrets.length} secret(s) and ${botWallets.length} bot wallet key(s) to process.`);

  let secretsRotated = 0;
  let secretsSkipped = 0;
  let walletsRotated = 0;
  let walletsSkipped = 0;
  let failures = 0;

  const secretsUpdates = [];
  const walletUpdates = [];

  // Pass 1: Decrypt and Re-encrypt in memory
  for (const s of secrets) {
    const currentVer = String(s.value).split('.')[0];
    if (currentVer === targetVersion) {
      secretsSkipped++;
      continue;
    }
    try {
      const plaintext = vault.decrypt(s.value);
      const reEncrypted = encryptTarget(plaintext);
      // Immediate verification check
      const verifyPlain = decryptTarget(reEncrypted);
      if (verifyPlain !== plaintext) {
        throw new Error(`Verification mismatch on secret "${s.name}"`);
      }
      secretsUpdates.push({ name: s.name, value: reEncrypted, key_version: targetVersion });
      secretsRotated++;
    } catch (err) {
      failures++;
      console.error(`[FAIL] Secret "${s.name}":`, err.message);
    }
  }

  for (const w of botWallets) {
    const currentVer = String(w.secret).split('.')[0];
    if (currentVer === targetVersion) {
      walletsSkipped++;
      continue;
    }
    try {
      const plaintext = vault.decrypt(w.secret);
      const reEncrypted = encryptTarget(plaintext);
      // Immediate verification check
      const verifyPlain = decryptTarget(reEncrypted);
      if (verifyPlain !== plaintext) {
        throw new Error(`Verification mismatch on bot wallet id ${w.bot_id}`);
      }
      walletUpdates.push({ bot_id: w.bot_id, secret: reEncrypted, key_version: targetVersion });
      walletsRotated++;
    } catch (err) {
      failures++;
      console.error(`[FAIL] Bot wallet #${w.bot_id}:`, err.message);
    }
  }

  console.log(`\nResults summary:`);
  console.log(`  Secrets to rotate:     ${secretsRotated} (skipped: ${secretsSkipped})`);
  console.log(`  Bot wallets to rotate: ${walletsRotated} (skipped: ${walletsSkipped})`);
  console.log(`  Decryption failures:   ${failures}`);

  if (failures > 0) {
    console.error(`\n[ABORT] Rotation encountered ${failures} failure(s). Aborting without committing any changes.`);
    process.exit(2);
  }

  if (isDryRun) {
    console.log(`\n[DRY-RUN COMPLETE] All ${secretsRotated + walletsRotated} items verified successfully. No changes written.`);
    return { secretsRotated, walletsRotated, failures: 0, dryRun: true };
  }

  // Pass 2: Transactional commit
  tx(() => {
    for (const u of secretsUpdates) {
      q.run('UPDATE secrets SET value = ?, key_version = ? WHERE name = ?', u.value, u.key_version, u.name);
    }
    for (const u of walletUpdates) {
      q.run('UPDATE bot_wallets SET secret = ?, key_version = ? WHERE bot_id = ?', u.secret, u.key_version, u.bot_id);
    }
  });

  // Pass 3: Post-commit verification pass from live DB
  console.log('Performing post-commit database verification pass...');
  for (const u of secretsUpdates) {
    const row = q.get('SELECT value FROM secrets WHERE name = ?', u.name);
    const plain = decryptTarget(row.value);
    if (!plain) throw new Error(`Post-commit verification failed for secret "${u.name}"`);
  }
  for (const u of walletUpdates) {
    const row = q.get('SELECT secret FROM bot_wallets WHERE bot_id = ?', u.bot_id);
    const plain = decryptTarget(row.secret);
    if (!plain) throw new Error(`Post-commit verification failed for bot wallet #${u.bot_id}`);
  }
  console.log('✓ All database records verified in place.');

  // Update keyring configuration
  let keyringData = { keys: {}, active: targetVersion };
  if (fs.existsSync(KEYRING_FILE)) {
    try { keyringData = JSON.parse(fs.readFileSync(KEYRING_FILE, 'utf8')); } catch (e) {}
  }
  keyringData.keys = keyringData.keys || {};
  // Retain existing active key under its version
  const oldActiveKey = vault.getKey(currentActive);
  if (oldActiveKey) keyringData.keys[currentActive] = oldActiveKey.toString('hex');
  keyringData.keys[targetVersion] = newKeyHex;
  keyringData.active = targetVersion;

  fs.mkdirSync(path.dirname(KEYRING_FILE), { recursive: true });
  fs.writeFileSync(KEYRING_FILE, JSON.stringify(keyringData, null, 2), { mode: 0o600 });
  console.log(`✓ Updated keyring config: ${KEYRING_FILE}`);

  vault.resetKeyringCache();

  try {
    const { sendAdminWebhook } = require('../server/events');
    sendAdminWebhook({
      title: 'Vault Master Key Rotated',
      text: `Master key rotated successfully to version "${targetVersion}". Rotated ${secretsRotated} secret(s) and ${walletsRotated} bot wallet(s).`,
      severity: 'warn',
      fields: {
        ActiveVersion: targetVersion,
        SecretsRotated: secretsRotated,
        WalletsRotated: walletsRotated
      }
    });
  } catch (e) {}

  console.log(`\n[SUCCESS] Master key rotated successfully to version "${targetVersion}".`);
  console.log(`Next steps:`);
  console.log(`  1. Back up data/master-keyring.json securely.`);
  console.log(`  2. In your production secrets manager, update MASTER_KEY or MASTER_KEYS with the new key.`);
  return { secretsRotated, walletsRotated, failures: 0, dryRun: false };
}

if (require.main === module) {
  runRotation().catch((err) => {
    console.error('Fatal rotation error:', err);
    process.exit(1);
  });
}

module.exports = { runRotation, encryptTarget, decryptTarget };
