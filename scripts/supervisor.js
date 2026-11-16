#!/usr/bin/env node
/* ==========================================================================
   scripts/supervisor.js — NECTRA Process Supervisor (Release 2)
   Manages the Web Server and the Bot Runner as decoupled, supervised processes.
   Features:
   - Automatic restart policy on process exit / crash
   - Exponential backoff (1s -> 2s -> 4s -> 8s -> 16s -> 30s max)
   - Start limits (max 5 restarts in 60s sliding window to prevent crash storms)
   - Decoupled fault isolation: kill -9 on web leaves bots executing
   ========================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const SERVICES = [
  {
    name: 'web',
    script: path.join(ROOT, 'server', 'index.js'),
    args: ['--web-only'],
    env: { ...process.env, SEPARATE_BOT_PROCESS: '1' }
  },
  {
    name: 'bot-runner',
    script: path.join(ROOT, 'server', 'bot-runner.js'),
    args: [],
    env: { ...process.env }
  }
];

class SupervisedProcess {
  constructor(service) {
    this.name = service.name;
    this.script = service.script;
    this.args = service.args;
    this.env = service.env;

    this.child = null;
    this.restarts = [];
    this.backoffMs = 1000;
    this.maxBackoffMs = 30000;
    this.startWindowMs = 60000;
    this.maxStartsPerWindow = 5;
    this.cooldownUntil = 0;
    this.stopping = false;
    this.stableTimer = null;
  }

  start() {
    if (this.stopping) return;

    const now = Date.now();
    // Prune start history outside the 60s window
    this.restarts = this.restarts.filter((t) => now - t < this.startWindowMs);

    if (now < this.cooldownUntil) {
      const wait = Math.ceil((this.cooldownUntil - now) / 1000);
      console.warn(`[supervisor] ${this.name} in start cooldown. Waiting ${wait}s before retrying...`);
      setTimeout(() => this.start(), 2000);
      return;
    }

    if (this.restarts.length >= this.maxStartsPerWindow) {
      console.error(`[supervisor] ${this.name} exceeded start limit (${this.maxStartsPerWindow} restarts in ${this.startWindowMs / 1000}s). Cooling down for 60s.`);
      this.cooldownUntil = now + 60000;
      setTimeout(() => this.start(), 60000);
      return;
    }

    this.restarts.push(now);
    console.log(`[supervisor] Starting ${this.name} (pid will follow)...`);

    this.child = spawn(process.execPath, [this.script, ...this.args], {
      cwd: ROOT,
      env: this.env,
      stdio: 'inherit'
    });

    console.log(`[supervisor] ${this.name} started with PID ${this.child.pid}`);

    // If child stays alive for 60s, consider it stable and reset backoff
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.backoffMs = 1000;
    }, 60000);

    this.child.on('exit', (code, signal) => {
      clearTimeout(this.stableTimer);
      this.child = null;

      if (this.stopping) {
        console.log(`[supervisor] ${this.name} exited cleanly on shutdown.`);
        return;
      }

      console.warn(`[supervisor] ${this.name} exited with code ${code}, signal ${signal}. Restarting in ${this.backoffMs}ms...`);
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);

      setTimeout(() => this.start(), delay);
    });
  }

  stop(signal = 'SIGTERM') {
    this.stopping = true;
    clearTimeout(this.stableTimer);
    if (this.child) {
      console.log(`[supervisor] Stopping ${this.name} (PID ${this.child.pid})...`);
      this.child.kill(signal);
    }
  }
}

const managed = SERVICES.map((s) => new SupervisedProcess(s));

function startAll() {
  console.log(`=======================================================`);
  console.log(` NECTRA Multi-Process Supervisor`);
  console.log(` Supervising: ${SERVICES.map((s) => s.name).join(', ')}`);
  console.log(`=======================================================\n`);

  managed.forEach((p) => p.start());
}

function shutdownAll(signal) {
  console.log(`\n[supervisor] Caught ${signal}. Terminating supervised processes...`);
  managed.forEach((p) => p.stop(signal));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdownAll('SIGINT'));
process.on('SIGTERM', () => shutdownAll('SIGTERM'));

if (require.main === module) {
  startAll();
}

module.exports = { SupervisedProcess, SERVICES, startAll, shutdownAll };
