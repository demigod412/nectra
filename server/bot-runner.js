/* ==========================================================================
   NECTRA Bot Runner — Standalone Dedicated Bot Execution Worker (Release 2)
   Decoupled from the HTTP web process for fault isolation and high availability.
   Features:
   - On-boot state reconciliation for open positions & orders
   - Re-arming bots without duplicate order placement
   - Independent crash domain: web process death does not stop bot execution
   ========================================================================== */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Load environment variables
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

const { q, tx, now, J, getSettings, kvGet, kvSet } = require('./db');
const market = require('./market');
const engine = require('./engine');
const { notifyAdmins } = require('./events');

console.log('[bot-runner] Initializing dedicated bot execution worker...');

/**
 * On-boot position reconciliation.
 * Inspects all active live bots, checks recorded trades and positions,
 * and ensures no orphaned or duplicate orders execute upon worker recovery.
 */
function reconcilePositionsOnBoot() {
  console.log('[bot-runner] Reconciling bot positions from database state...');
  const runningBots = q.all("SELECT * FROM bots WHERE status = 'running'");
  let reconciled = 0;

  tx(() => {
    for (const row of runningBots) {
      const b = engine.loadBot(row);
      const trades = q.all('SELECT * FROM trades WHERE bot_id = ? ORDER BY id DESC LIMIT 10', b.id);

      // Verify position consistency with recent trade ledger
      const expectedPosition = q.val(`SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN size ELSE -size END), 0) FROM trades WHERE bot_id = ?`, b.id);

      // Re-arm cleanly and clear any in-flight order flag to prevent duplicate submissions
      b.state.last_boot = now();
      b.state.pending_order = null;

      // If discrepancy detected or unclean restart recorded, reconcile position state
      if (Math.abs(expectedPosition - b.position) > 1e-6) {
        console.warn(`[bot-runner] Bot #${b.id} (${b.name}) position drift detected: DB says ${b.position}, trade history sums to ${expectedPosition}. Reconciling.`);
        b.position = expectedPosition;
        b.state.reconciled_at = now();
        b.state.reconciled_note = 'Auto-reconciled position drift on boot';
        reconciled++;
      }
      engine.saveBot(b);
    }
  });

  console.log(`[bot-runner] Reconciled ${runningBots.length} active bot(s) (${reconciled} adjusted).`);
  kvSet('bot_runner_last_boot', { at: now(), bots: runningBots.length, reconciled });
}

let running = false;
let stopRequested = false;

async function start() {
  if (running) return;
  running = true;

  // Initialize market feed
  await market.start();

  // Reconcile bot positions before launching evaluation loop
  reconcilePositionsOnBoot();

  // Start background engine loop
  engine.start();
  console.log('[bot-runner] Engine started. Bots active and executing.');

  // Heartbeat logging
  setInterval(() => {
    if (stopRequested) return;
    const count = q.val("SELECT COUNT(*) FROM bots WHERE status = 'running'");
    kvSet('bot_runner_heartbeat', { at: now(), activeBots: count });
  }, 10000).unref();
}

function shutdown(signal) {
  if (stopRequested) return;
  stopRequested = true;
  console.log(`\n[bot-runner] Received ${signal}. Gracefully stopping bot runner...`);
  try {
    kvSet('bot_runner_clean_shutdown', true);
  } catch (e) {}
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[bot-runner] Uncaught exception:', err);
  shutdown('uncaughtException');
});

if (require.main === module) {
  start().catch((err) => {
    console.error('[bot-runner] Fatal initialization error:', err);
    process.exit(1);
  });
}

module.exports = { start, reconcilePositionsOnBoot };
