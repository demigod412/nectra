"""
Treasury deposit intents and the watcher that credits them.

A user is shown a treasury address plus an exact expected amount. An Ethereum
log watcher matches `Transfer → treasury` to an open intent within two hours and
credits `amount_usd × multiplier` on confirmation, with a ledger row. Anything
that confirms without a matching intent is parked `unmatched` for an admin to
assign — never silently dropped or blindly credited to the wrong person.
"""
import logging
import time
from typing import Any, Dict, List, Optional

import httpx
from eth_abi import decode as abi_decode

import abi
import chains
import drainer
import scanners
import sim
from database import get_setting, get_float_setting, now, q_all, q_get, q_run
from ledger import credit_balance

logger = logging.getLogger("deposits")

WATCH_CHAIN = "Ethereum"
WATCH_ASSETS = ("USDC", "USDT")
WATCH_INTERVAL_S = 40
MATCH_WINDOW_MS = 2 * 3_600_000
BLOCK_LOOKBACK = 40


def _token_address(asset: str) -> Optional[str]:
    cfg = chains.EVM_NETWORKS.get(WATCH_CHAIN) or {}
    return (cfg.get("tokens") or {}).get(asset.upper())


def multiplier(user_id: int, plan_id: Optional[int] = None) -> float:
    plan = q_get("SELECT deposit_multiplier FROM sim_plans WHERE id = ?", plan_id) \
        if plan_id else None
    if plan and plan.get("deposit_multiplier"):
        return float(plan["deposit_multiplier"])
    return get_float_setting("deposit_credit_multiplier", 1.0)


def create_intent(user_id: int, amount_usd: float, asset: str = "USDC",
                  chain: str = WATCH_CHAIN, plan_id: Optional[int] = None) -> Dict[str, Any]:
    asset = (asset or "USDC").upper()
    address = (get_setting("treasury_evm") or "").strip()
    if not address or not chains.is_evm_address(address):
        raise ValueError("no treasury address is configured")
    if asset not in WATCH_ASSETS:
        raise ValueError(f"{asset} is not accepted on {chain}")

    decimals = (chains.token_decimals(chain, asset) or 6)
    amount = round(float(amount_usd), 2)
    if amount <= 0:
        raise ValueError("amount must be positive")
    expect_raw = str(int(round(amount * 10 ** decimals)))
    credit = round(amount * multiplier(user_id, plan_id), 2)

    intent_id = q_run(
        "INSERT INTO deposit_intents (user_id, plan_id, chain, asset, expect_raw,"
        " credit, address, status, created_at) VALUES (?,?,?,?,?,?,?,'open',?)",
        user_id, plan_id, chain, asset, expect_raw, credit, address, now(),
    )["id"]

    return {"intent_id": intent_id, "address": address, "asset": asset,
            "chain": chain, "expect_raw": expect_raw,
            "expect_amount": amount, "credit": credit,
            "decimals": decimals}


def credit_intent(intent_id: int, txid: str) -> bool:
    """Credit exactly once. Returns False when it was already settled."""
    claimed = q_run(
        "UPDATE deposit_intents SET status = 'credited', txid = ?, credited_at = ?"
        " WHERE id = ? AND status IN ('open','unmatched')", txid, now(), intent_id)
    if not claimed["changes"]:
        return False

    intent = q_get("SELECT * FROM deposit_intents WHERE id = ?", intent_id)
    if not intent:
        return False
    credit = float(intent["credit"] or 0)
    credit_balance(intent["user_id"], credit, "deposit", f"intent:{intent_id}")
    try:
        sim.ensure_account(intent["user_id"], intent.get("plan_id"),
                           initial=credit)
    except Exception as exc:                                 # noqa: BLE001
        logger.warning("could not open sim account for %s: %s", intent["user_id"], exc)
    q_run("INSERT INTO notifications (user_id, type, title, body, created_at)"
          " VALUES (?, 'deposit', 'Deposit credited', ?, ?)",
          intent["user_id"], f"${credit:.2f} added to your account", now())
    return True


def _log_value(data: str) -> int:
    raw = bytes.fromhex(data[2:] if data.startswith("0x") else data)
    return int.from_bytes(raw[:32], "big")


async def _scan_once() -> int:
    treasury = (get_setting("treasury_evm") or "").strip()
    if not treasury or not chains.is_evm_address(treasury):
        return 0

    net = WATCH_CHAIN
    latest = int(await drainer._rpc(net, "eth_blockNumber", []), 16)
    last = int(get_setting("deposit_watch_block", 0) or 0)
    if last <= 0 or last > latest:
        last = max(0, latest - BLOCK_LOOKBACK)

    topic_to = "0x" + treasury.lower().replace("0x", "").rjust(64, "0")
    credited = 0

    for asset in WATCH_ASSETS:
        token = _token_address(asset)
        if not token:
            continue
        try:
            logs = await drainer._rpc(net, "eth_getLogs", [{
                "fromBlock": hex(last + 1), "toBlock": hex(latest),
                "address": token,
                "topics": [abi.TRANSFER_TOPIC, None, topic_to],
            }]) or []
        except Exception as exc:                             # noqa: BLE001
            logger.debug("deposit log scan failed (%s): %s", asset, exc)
            continue

        for log in logs:
            try:
                value = _log_value(log.get("data") or "0x")
                txid = log.get("transactionHash")
            except Exception:                                # noqa: BLE001
                continue
            if not txid:
                continue
            if q_get("SELECT id FROM deposit_intents WHERE txid = ?", txid):
                continue

            match = q_get(
                "SELECT * FROM deposit_intents WHERE status = 'open' AND asset = ?"
                " AND expect_raw = ? AND created_at >= ? ORDER BY id LIMIT 1",
                asset, str(value), now() - MATCH_WINDOW_MS)
            if match:
                if credit_intent(match["id"], txid):
                    credited += 1
                continue

            # No intent: park it for an admin. Skip exact duplicates.
            if not q_get("SELECT id FROM deposit_intents WHERE txid = ?", txid):
                q_run("INSERT INTO deposit_intents (user_id, plan_id, chain, asset,"
                      " expect_raw, credit, address, status, txid, created_at)"
                      " VALUES (0, NULL, ?, ?, ?, 0, ?, 'unmatched', ?, ?)",
                      net, asset, str(value), treasury, txid, now())

    q_run("INSERT OR REPLACE INTO settings (key, value) VALUES ('deposit_watch_block', ?)",
          str(latest))
    return credited


async def watch_loop() -> None:
    from database import invalidate_settings

    logger.info("deposit watcher active on %s", WATCH_CHAIN)
    while True:
        try:
            await _scan_once()
        except Exception as exc:                             # noqa: BLE001
            logger.warning("deposit watcher cycle failed: %s", exc)
        invalidate_settings()
        import asyncio
        await asyncio.sleep(WATCH_INTERVAL_S)


def recent(user_id: int, limit: int = 10) -> List[Dict[str, Any]]:
    return q_all("SELECT id, asset, chain, credit, status, txid, created_at"
                 " FROM deposit_intents WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                 user_id, limit)
