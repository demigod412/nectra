# Security Policy

NECTRA moves real funds (loan disbursements, collections, live-bot wallets), so security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public GitHub issue.** Report privately through
[GitHub Security Advisories](https://github.com/demigod412/nectra/security/advisories/new)
("Report a vulnerability" on the repository's Security tab).

Please include the affected route or file, steps to reproduce, and the impact. We aim to acknowledge
reports within 3 business days and to ship a fix or mitigation for critical issues within 14 days.

## Scope

In scope: the server (`server/`), the web app and admin console (`public/`), and the deploy script.
Especially interesting: anything that moves money twice or to the wrong place, bypasses two-admin
approvals or role checks, lets a collection exceed the borrower's approval or outstanding balance,
leaks `MASTER_KEY`-encrypted secrets or KYC documents, or replays wallet signatures.

Out of scope: denial of service by volume, findings that need a compromised server or admin account,
and the simulated behaviour of demo mode (`DEMO_MODE=1`).

## Handling secrets

- Never commit `.env`, `data/` (database, `master.key`, first-run credentials) or private keys —
  they are in `.gitignore`, and CI scans history for secrets.
- `MASTER_KEY` encrypts collector keys, live-bot wallet keys and VAPID keys. Keep it in a secrets
  manager with an offline backup. If it leaks, rotate every key it protects.
- If a secret is committed by mistake, rotate it first, then remove it from history.
