/* CI dependency audit: fail on any HIGH/CRITICAL advisory in production dependencies,
   except reviewed ones listed in audit-allowlist.json (each with a reason and review-by date).
   An expired review date fails the build too, so exceptions can't be forgotten.
   Usage: node tools/audit-check.js */
'use strict';
const { execSync } = require('node:child_process');
const path = require('node:path');

const allow = require(path.join(__dirname, '..', 'audit-allowlist.json')).advisories || {};
let raw;
try { raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds anything
const report = JSON.parse(raw || '{}');
if (report.error) { console.error('npm audit failed:', report.error.summary || report.error); process.exit(2); }

const SEV = { critical: 4, high: 3 };
const found = new Map(); // GHSA id -> { pkg, severity, title, url }
for (const [pkg, v] of Object.entries(report.vulnerabilities || {})) {
  for (const via of v.via) {
    if (typeof via !== 'object' || !SEV[via.severity]) continue; // strings = "inherited from another package"
    const id = (String(via.url || '').match(/GHSA-[\w-]+/) || [String(via.source)])[0];
    found.set(id, { pkg: via.name || pkg, severity: via.severity, title: via.title, url: via.url });
  }
}

const today = new Date().toISOString().slice(0, 10);
let failed = false;
for (const [id, f] of found) {
  const a = allow[id];
  if (!a) { failed = true; console.error(`FAIL  ${f.severity.toUpperCase()}  ${f.pkg}  ${id}  ${f.title}\n      ${f.url}`); continue; }
  if (a.reviewBy && a.reviewBy < today) { failed = true; console.error(`FAIL  allowlisted ${id} (${f.pkg}) passed its review date ${a.reviewBy} - re-review it in audit-allowlist.json`); continue; }
  console.log(`ok    ${f.severity.toUpperCase()}  ${f.pkg}  ${id}  allowlisted until ${a.reviewBy}: ${a.reason.slice(0, 90)}...`);
}
for (const id of Object.keys(allow)) if (!found.has(id)) console.log(`note  ${id} is allowlisted but no longer reported - remove it from audit-allowlist.json`);
console.log(failed ? '\nDependency audit FAILED' : `\nDependency audit passed (${found.size} high/critical advisor${found.size === 1 ? 'y' : 'ies'} found, all reviewed)`);
process.exit(failed ? 1 : 0);
