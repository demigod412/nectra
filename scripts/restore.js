#!/usr/bin/env node
/* ==========================================================================
   scripts/restore.js — Database Restore & Integrity Verification Tool
   Restores data/nectra.db (or a scratch destination) from a validated backup.
   ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(__dirname, '..', 'data', 'backups');
const DEFAULT_DB = path.join(__dirname, '..', 'data', 'nectra.db');

const args = process.argv.slice(2);
let targetDb = DEFAULT_DB;
let sourceBackup = null;
let verifyBoot = true;

for (const arg of args) {
  if (arg.startsWith('--target=')) targetDb = path.resolve(arg.split('=')[1]);
  else if (arg === '--no-verify') verifyBoot = false;
  else if (!arg.startsWith('--')) sourceBackup = path.resolve(arg);
}

if (!sourceBackup) {
  if (fs.existsSync(DIR)) {
    const list = fs.readdirSync(DIR).filter((f) => f.endsWith('.db')).sort();
    if (list.length) sourceBackup = path.join(DIR, list[list.length - 1]);
  }
}

if (!sourceBackup || !fs.existsSync(sourceBackup)) {
  console.error('[restore] No valid backup file found to restore from.');
  process.exit(1);
}

console.log(`=======================================================`);
console.log(` NECTRA Database Restore Tool`);
console.log(` Source Backup: ${sourceBackup}`);
console.log(` Destination:   ${targetDb}`);
console.log(`=======================================================\n`);

// 1. Verify integrity of the source backup prior to restore
console.log('Validating backup integrity...');
let sourceDb = null;
try {
  sourceDb = new DatabaseSync(sourceBackup);
  const check = sourceDb.prepare('PRAGMA integrity_check').get();
  if (!check || check.integrity_check !== 'ok') {
    throw new Error(`Corrupted backup artifact: ${JSON.stringify(check)}`);
  }
  console.log('✓ Source backup passed PRAGMA integrity_check.');
} finally {
  if (sourceDb) try { sourceDb.close(); } catch (e) {}
}

// 2. Prepare target directory
fs.mkdirSync(path.dirname(targetDb), { recursive: true });

// 3. Backup existing DB if in-place restore
if (fs.existsSync(targetDb) && targetDb === DEFAULT_DB) {
  const preRestore = targetDb + '.pre-restore';
  fs.copyFileSync(targetDb, preRestore);
  console.log(`Preserved existing database as: ${path.basename(preRestore)}`);
}

// 4. Remove any stale WAL/SHM companion files for target
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(targetDb + ext)) {
    try { fs.unlinkSync(targetDb + ext); } catch (e) {}
  }
}

// 5. Restore the file
fs.copyFileSync(sourceBackup, targetDb);
console.log(`✓ Restored database to: ${targetDb}`);

// 6. Post-restore boot verification test
if (verifyBoot) {
  console.log('Testing application boot against restored database...');
  let restored = null;
  try {
    restored = new DatabaseSync(targetDb);
    const check = restored.prepare('PRAGMA integrity_check').get();
    if (!check || check.integrity_check !== 'ok') throw new Error('Target DB integrity check failed');

    const usersCount = restored.prepare('SELECT COUNT(*) n FROM users').get().n;
    const settingsCount = restored.prepare('SELECT COUNT(*) n FROM settings').get().n;
    console.log(`✓ Restored DB operational: ${usersCount} user(s), ${settingsCount} setting(s).`);
  } finally {
    if (restored) try { restored.close(); } catch (e) {}
  }
}

console.log('\n[SUCCESS] Database restore complete.');
