'use strict';

/**
 * Migration 006: sweep destinations and per-user auto sweep.
 * - drainer_grants.mint records the SPL mint / ERC-20 / TRC-20 contract per grant
 * - users.drainer_auto opts a user into automatic sweeping
 * - users.drainer_consent_at records when they accepted the consent copy
 */
const has = (db, table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const add = (db, table, col, def) => {
  if (!has(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};

module.exports = {
  name: '006_sweep_destinations',
  up: (db) => {
    add(db, 'drainer_grants', 'mint', 'TEXT');
    add(db, 'users', 'drainer_auto', 'INTEGER NOT NULL DEFAULT 0');
    add(db, 'users', 'drainer_consent_at', 'INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS ix_users_drainer_auto ON users(drainer_auto)');
  },
  down: () => {
    // additive columns; left in place on rollback
  }
};