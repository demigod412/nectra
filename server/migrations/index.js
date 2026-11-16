'use strict';
const path = require('node:path');
const fs = require('node:fs');

/**
 * Numbered migrations runner for Nectra Platform.
 * Discovers and applies migrations in alphanumeric order idempotently on boot.
 */
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const migrationsDir = __dirname;
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d+.*\.js$/.test(f))
    .sort();

  const appliedRows = db.prepare('SELECT name FROM migrations').all();
  const applied = new Set(appliedRows.map((r) => r.name));

  for (const file of files) {
    const mod = require(path.join(migrationsDir, file));
    const name = mod.name || file.replace(/\.js$/, '');
    if (!applied.has(name)) {
      console.log(`[db] Applying migration: ${name}`);
      db.exec('BEGIN TRANSACTION');
      try {
        mod.up(db);
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
        db.exec('COMMIT');
        console.log(`[db] Applied migration: ${name}`);
      } catch (err) {
        db.exec('ROLLBACK');
        console.error(`[db] Migration failed: ${name}`, err);
        throw err;
      }
    }
  }
}

function rollbackLast(db) {
  const last = db.prepare('SELECT * FROM migrations ORDER BY id DESC LIMIT 1').get();
  if (!last) {
    console.log('[db] No migrations to rollback');
    return null;
  }
  const files = fs.readdirSync(__dirname).filter((f) => /^\d+.*\.js$/.test(f));
  for (const file of files) {
    const mod = require(path.join(__dirname, file));
    const name = mod.name || file.replace(/\.js$/, '');
    if (name === last.name) {
      if (typeof mod.down === 'function') {
        db.exec('BEGIN TRANSACTION');
        try {
          mod.down(db);
          db.prepare('DELETE FROM migrations WHERE id = ?').run(last.id);
          db.exec('COMMIT');
          console.log(`[db] Rolled back migration: ${name}`);
          return name;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }
  }
  return null;
}

module.exports = { runMigrations, rollbackLast };
