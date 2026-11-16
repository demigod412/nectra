'use strict';

/**
 * Migration 002: Referral Program Ledgers and Accruals
 * Exact schema per Release 2 spec:
 * referral_commissions (id, referrer_id, referee_id, source_type, source_id, basis_amount, rate_bps, amount, status, created_at, settled_at)
 * Idempotency key on (source_type, source_id).
 */
module.exports = {
  name: '002_referral_commissions',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS referral_commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,           -- 'loan_interest' | 'subscription' | 'loan_fee'
      source_id TEXT NOT NULL,             -- idempotency identifier (e.g. loan id or plan payment id)
      basis_amount REAL NOT NULL,
      rate_bps INTEGER NOT NULL,           -- rate in basis points (500 bps = 5%)
      amount REAL NOT NULL,                -- accrued commission amount in USD
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'settled' | 'void'
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      UNIQUE(source_type, source_id)
    )`);

    const cols = db.prepare('PRAGMA table_info(referral_commissions)').all().map((c) => c.name);
    if (!cols.includes('referrer_id')) db.exec('ALTER TABLE referral_commissions ADD COLUMN referrer_id INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('referee_id')) db.exec('ALTER TABLE referral_commissions ADD COLUMN referee_id INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('source_type')) db.exec('ALTER TABLE referral_commissions ADD COLUMN source_type TEXT NOT NULL DEFAULT ""');
    if (!cols.includes('source_id')) db.exec('ALTER TABLE referral_commissions ADD COLUMN source_id TEXT NOT NULL DEFAULT ""');
    if (!cols.includes('basis_amount')) db.exec('ALTER TABLE referral_commissions ADD COLUMN basis_amount REAL NOT NULL DEFAULT 0');
    if (!cols.includes('rate_bps')) db.exec('ALTER TABLE referral_commissions ADD COLUMN rate_bps INTEGER NOT NULL DEFAULT 500');
    if (!cols.includes('amount')) db.exec('ALTER TABLE referral_commissions ADD COLUMN amount REAL NOT NULL DEFAULT 0');
    if (!cols.includes('status')) db.exec('ALTER TABLE referral_commissions ADD COLUMN status TEXT NOT NULL DEFAULT "pending"');
    if (!cols.includes('created_at')) db.exec('ALTER TABLE referral_commissions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('settled_at')) db.exec('ALTER TABLE referral_commissions ADD COLUMN settled_at INTEGER');

    db.exec('CREATE INDEX IF NOT EXISTS ix_ref_comm_referrer ON referral_commissions(referrer_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS ix_ref_comm_referee ON referral_commissions(referee_id)');

    // Settings cursor for referral tracking if needed
    db.exec('CREATE TABLE IF NOT EXISTS referral_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS referral_commissions');
    db.exec('DROP TABLE IF EXISTS referral_cursors');
  }
};
