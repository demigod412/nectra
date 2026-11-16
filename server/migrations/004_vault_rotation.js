'use strict';

/**
 * Migration 004: Vault Key Versioning and Rotation Support
 * Adds key_version tracking to secrets and bot_wallets tables.
 */
module.exports = {
  name: '004_vault_rotation',
  up: (db) => {
    const addCol = (table, col, def) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    addCol('secrets', 'key_version', "TEXT NOT NULL DEFAULT 'v1'");
    addCol('bot_wallets', 'key_version', "TEXT NOT NULL DEFAULT 'v1'");
  },
  down: (db) => {
    // SQLite alter column drop is destructive; non-breaking no-op on rollback
  }
};
