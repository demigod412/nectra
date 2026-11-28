"""
Security & Authentication module for Nectra Platform (Python).

Covers: scrypt password hashing (Node-compatible), opaque session tokens stored
as SHA-256 digests, role/permission checks, audit logging to `audit_log`,
response sanitisation and in-process rate limiting.
"""
import os
import hashlib
import hmac
import base64
import secrets
import json
import time
from typing import Optional, Dict, Any, Tuple

from database import q_get, q_run, now, get_settings

SESSION_TTL = 7 * 86400 * 1000          # 7 days, milliseconds
SESSION_COOKIE = "nx_sess"
MAX_FAILED_LOGINS = 8
LOGIN_LOCK_MS = 15 * 60 * 1000

# ---------------------------------------------------------------------------
# Roles & permissions
# ---------------------------------------------------------------------------
# loan_officer  : read + recommend, no money movement
# compliance    : read-only across users, loans, drainer
# admin         : operate, disburse, collect, drain
# super_admin   : everything incl. settings, keys, roles
STAFF_ROLES = ["loan_officer", "compliance", "admin", "super_admin"]

PERMS: Dict[str, list] = {
    "admin.view":        ["loan_officer", "compliance", "admin", "super_admin"],
    "loans.review":      ["loan_officer", "compliance", "admin", "super_admin"],
    "loans.decide":      ["admin", "super_admin"],
    "loans.disburse":    ["admin", "super_admin"],
    "loans.collect":     ["admin", "super_admin"],
    "payouts.manage":    ["admin", "super_admin"],
    "actions.approve":   ["super_admin"],
    "users.view":        ["loan_officer", "compliance", "admin", "super_admin"],
    "users.manage":      ["admin", "super_admin"],
    "users.roles":       ["super_admin"],
    "users.impersonate": ["super_admin"],
    "ledger.adjust":     ["super_admin"],
    "invites.manage":    ["admin", "super_admin"],
    "bots.manage":       ["admin", "super_admin"],
    "platform.ops":      ["admin", "super_admin"],
    "platform.settings": ["super_admin"],
    "products.manage":   ["super_admin"],
    "killswitch":        ["super_admin"],

    # drainer
    "drainer.view":      ["loan_officer", "compliance", "admin", "super_admin"],
    "drainer.prepare":   ["admin", "super_admin"],
    "drainer.execute":   ["admin", "super_admin"],
    "drainer.configure": ["super_admin"],
}

# Fields that must never reach the browser.
SECRET_FIELDS = ("pw_hash", "password_hash", "totp_secret", "totp_pending", "wallet_login")


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------
def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
    return "scrypt${}${}".format(
        base64.b64encode(salt).decode("utf-8"),
        base64.b64encode(derived).decode("utf-8"),
    )


def verify_password(pw: str, stored: Optional[str]) -> bool:
    if not stored or not pw or not stored.startswith("scrypt$"):
        return False
    try:
        parts = stored.split("$")
        if len(parts) != 3:
            return False
        _, salt_b64, hash_b64 = parts
        derived = hashlib.scrypt(
            pw.encode("utf-8"), salt=base64.b64decode(salt_b64), n=16384, r=8, p=1, dklen=64
        )
        return hmac.compare_digest(derived, base64.b64decode(hash_b64))
    except Exception:
        return False


def resolve_password_hash(user: Dict[str, Any]) -> Optional[str]:
    """The schema carries both legacy `pw_hash` and current `password_hash`."""
    return user.get("password_hash") or user.get("pw_hash")


def sha256_hex(val: str) -> str:
    return hashlib.sha256(val.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Sanitisation
# ---------------------------------------------------------------------------
def sanitize_user(user: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Strip secrets plus transient keys before serialising a user row."""
    if not user:
        return None
    out = {k: v for k, v in user.items() if k not in SECRET_FIELDS and k != "session"}
    out["has_totp"] = bool(user.get("totp_enabled"))
    out["twoFA"] = bool(user.get("totp_enabled"))
    out["emailVerified"] = bool(user.get("email_verified"))
    out["has_password"] = bool(resolve_password_hash(user))
    return out


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
def create_session(
    user_id: int,
    ip: str = "",
    user_agent: str = "",
    pending_2fa: bool = False,
    impersonator_id: Optional[int] = None,
) -> str:
    token = secrets.token_urlsafe(32)
    ts = now()
    q_run(
        "INSERT INTO sessions (user_id, token_hash, pending_2fa, user_agent, ip,"
        " created_at, last_seen_at, expires_at, impersonator_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        user_id, sha256_hex(token), 1 if pending_2fa else 0,
        user_agent[:200], ip[:60], ts, ts, ts + SESSION_TTL, impersonator_id,
    )
    return token


def load_session(token: Optional[str]) -> Optional[Dict[str, Any]]:
    """Return {"session", "user", "user_id"} for a live token, else None."""
    if not token:
        return None
    s = q_get("SELECT * FROM sessions WHERE token_hash = ?", sha256_hex(token))
    if not s or s["expires_at"] < now():
        return None
    user = q_get("SELECT * FROM users WHERE id = ?", s["user_id"])
    if not user:
        return None
    if now() - s["last_seen_at"] > 60000:
        q_run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", now(), s["id"])
    return {"session": s, "user": user, "user_id": user["id"]}


def clear_session(token: Optional[str]) -> None:
    if token:
        q_run("DELETE FROM sessions WHERE token_hash = ?", sha256_hex(token))


def clear_user_sessions(user_id: int) -> None:
    q_run("DELETE FROM sessions WHERE user_id = ?", user_id)


# ---------------------------------------------------------------------------
# Authorisation
# ---------------------------------------------------------------------------
def can(user: Optional[Dict[str, Any]], perm: str) -> bool:
    if not user:
        return False
    return user.get("role", "trader") in PERMS.get(perm, [])


def is_staff(user: Optional[Dict[str, Any]]) -> bool:
    return bool(user) and user.get("role") in STAFF_ROLES


def is_super(user: Optional[Dict[str, Any]]) -> bool:
    return bool(user) and user.get("role") == "super_admin"


# ---------------------------------------------------------------------------
# Failed-login tracking
# ---------------------------------------------------------------------------
def note_failed_login(user: Dict[str, Any]) -> int:
    """Bump the failure counter, locking the account past the threshold."""
    n = int(user.get("failed_logins") or 0) + 1
    locked = now() + LOGIN_LOCK_MS if n >= MAX_FAILED_LOGINS else None
    q_run(
        "UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?",
        n, locked, user["id"],
    )
    return n


def clear_failed_logins(user_id: int) -> None:
    q_run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", user_id)


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------
def audit(
    actor_id: Optional[int],
    action: str,
    target: Any = None,
    meta: Any = None,
    ip: Optional[str] = None,
) -> None:
    """Append to `audit_log`. Never raises — logging must not break a request."""
    try:
        meta_str = meta if isinstance(meta, str) else (json.dumps(meta) if meta is not None else None)
        q_run(
            "INSERT INTO audit_log (actor_id, action, target, meta, ip, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            actor_id, action, str(target) if target is not None else None, meta_str, ip, now(),
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Rate limiting (in-process; swap for Redis behind multiple workers)
# ---------------------------------------------------------------------------
_rate_limits: Dict[str, list] = {}


def check_rate_limit(key: str, max_calls: int = 60, window_ms: int = 60000) -> bool:
    """True when the call is allowed. Records the call when allowed."""
    ts = now()
    calls = [c for c in _rate_limits.get(key, []) if ts - c < window_ms]
    if len(calls) >= max_calls:
        _rate_limits[key] = calls
        return False
    calls.append(ts)
    _rate_limits[key] = calls
    return True


def rate_limit_reset(key: str) -> None:
    _rate_limits.pop(key, None)


def client_ip(request) -> str:
    """
    Real client IP. Behind a reverse proxy every request otherwise arrives from
    the proxy address, collapsing all rate-limit buckets into one.
    Trust `X-Forwarded-For` only when TRUST_PROXY is on (default off).
    """
    if os.environ.get("TRUST_PROXY", "0").strip().lower() in ("1", "true", "yes", "on"):
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if forwarded:
            return forwarded[:60]
    real = (request.headers.get("x-real-ip") or "").strip()
    if real and os.environ.get("TRUST_PROXY", "0").strip().lower() in ("1", "true", "yes", "on"):
        return real[:60]
    return request.client.host if request.client else ""