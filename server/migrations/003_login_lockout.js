'use strict';

/**
 * Migration 003: Login Lockout and Brute-Force Counter
 * Failure counter keyed by identity (address/email + IP pair) and aggregate identity.
 */
module.exports = {
  name: '003_login_lockout',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS login_failures (
      key TEXT PRIMARY KEY,               -- 'id:<identity>' or 'pair:<identity>:<ip>' or 'ip:<ip>'
      identity TEXT NOT NULL,             -- email address or wallet public key
      ip TEXT,                            -- client IP address
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      locked_until INTEGER
    )`);

    const cols = db.prepare('PRAGMA table_info(login_failures)').all().map((c) => c.name);
    if (!cols.includes('identity')) db.exec('ALTER TABLE login_failures ADD COLUMN identity TEXT NOT NULL DEFAULT ""');
    if (!cols.includes('ip')) db.exec('ALTER TABLE login_failures ADD COLUMN ip TEXT');
    if (!cols.includes('count')) db.exec('ALTER TABLE login_failures ADD COLUMN count INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('first_at')) db.exec('ALTER TABLE login_failures ADD COLUMN first_at INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('last_at')) db.exec('ALTER TABLE login_failures ADD COLUMN last_at INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('locked_until')) db.exec('ALTER TABLE login_failures ADD COLUMN locked_until INTEGER');

    db.exec('CREATE INDEX IF NOT EXISTS ix_login_failures_identity ON login_failures(identity)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_login_failures_locked ON login_failures(locked_until)');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS login_failures');
  }
};
