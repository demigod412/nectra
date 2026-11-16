/* ==========================================================================
   Database Online Backup Service (Release 2)
   - Scheduled online backup via SQLite VACUUM INTO (WAL-safe, non-blocking)
   - Immediate PRAGMA integrity_check validation on generated backup artifact
   - Configurable retention policy (auto-prune older backups)
   - Off-host destination support (BACKUP_OFFHOST_DIR / BACKUP_REMOTE_DEST)
   ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { db, now, getSettings, kvGet, kvSet, DB_PATH } = require('./db');
const { notifyAdmins } = require('./events');

const DIR = path.join(path.dirname(DB_PATH), 'backups');

function verifyBackupIntegrity(filePath) {
  let tempDb = null;
  try {
    tempDb = new DatabaseSync(filePath);
    const row = tempDb.prepare('PRAGMA integrity_check').get();
    if (!row || row.integrity_check !== 'ok') {
      throw new Error(`Integrity check failed: ${JSON.stringify(row)}`);
    }
    return true;
  } finally {
    if (tempDb) {
      try { tempDb.close(); } catch (e) {}
    }
  }
}

function runOnce() {
  if (getSettings().backup_enabled === false) return null;
  fs.mkdirSync(DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DIR, 'nectra-' + stamp + '.db');

  // 1. Online VACUUM INTO (safe under active WAL mode)
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");

  // 2. Immediate integrity verification pass
  try {
    verifyBackupIntegrity(file);
  } catch (err) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    throw new Error(`Backup failed integrity verification: ${err.message}`);
  }

  const size = fs.statSync(file).size;

  // 3. Optional copy to off-host / secondary destination
  const offhostDir = process.env.BACKUP_OFFHOST_DIR || process.env.BACKUP_REMOTE_DEST || getSettings().backup_offhost_dir || null;
  let offhostCopy = null;
  if (offhostDir) {
    try {
      fs.mkdirSync(offhostDir, { recursive: true });
      offhostCopy = path.join(offhostDir, path.basename(file));
      fs.copyFileSync(file, offhostCopy);
    } catch (e) {
      console.warn('[backup] Off-host destination copy warning:', e.message);
    }
  }

  // 4. Enforce retention policy
  const keepDays = Number(getSettings().backup_keep_days) || 14;
  const keepMs = keepDays * 864e5;
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.db')) continue;
    const p = path.join(DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < now() - keepMs) {
        fs.unlinkSync(p);
      }
    } catch (e) {}
  }

  const result = { at: now(), file, size, integrity: 'ok', offhostCopy };
  kvSet('backup_last', result);
  return result;
}

function start() {
  const tick = () => {
    const last = (kvGet('backup_last', {}) || {}).at || 0;
    if (now() - last < 24 * 3600e3) return;
    try {
      const r2 = runOnce();
      if (r2) {
        console.log(`  💾 Backup verified & written: ${path.basename(r2.file)} (${Math.round(r2.size / 1024)} KB)`);
      }
    } catch (e) {
      console.error('  Backup error:', e.message);
      notifyAdmins('security', 'Database backup failed', e.message, '/admin/#status');
    }
  };
  setInterval(tick, 6 * 3600e3).unref();
  setTimeout(tick, 30000).unref();
}

module.exports = { start, runOnce, verifyBackupIntegrity, DIR };
