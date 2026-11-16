'use strict';

/**
 * Migration 005: Audit Log Enrichment for Impersonated Sessions
 * Adds actor_admin_id, subject_user_id, before_balance, after_balance, and signature columns.
 */
module.exports = {
  name: '005_audit_impersonation',
  up: (db) => {
    const addCol = (table, col, def) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    addCol('audit', 'actor_admin_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
    addCol('audit', 'subject_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
    addCol('audit', 'before_balance', 'REAL');
    addCol('audit', 'after_balance', 'REAL');
    addCol('audit', 'signature', 'TEXT');
  },
  down: (db) => {
    // Non-breaking additive columns
  }
};
