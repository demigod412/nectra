"""
Synthetic trading engine. No chain calls, no Jupiter — DB rows only.

The account has to look traded: a plan-configured ROI, a plan-configured win
rate, and arithmetic that survives a user checking it. Sizing is solved so the
expected value of a trade equals `balance × roi / trades_per_day`:

    w·win − (1−w)·loss = u

A 61% pair then shows +33 / −50 on a 40 unit — what a high-win-rate scalper
actually looks like, rather than a symmetric ±40 that no edge produces.

Trades are spread across the day by re-drawing the next slot from the remaining
window, and the exit price is back-solved from the P&L so entry, exit and pnl
always reconcile.
"""
import logging
import random
import time
from typing import Any, Dict, List, Optional

from database import get_setting, now, q_all, q_get, q_run, q_val
from ledger import account_balance, credit_balance

logger = logging.getLogger("sim")

DAY_MS = 86_400_000
TICK_S = 60
DEFAULT_TRADES_PER_DAY = 5


# ------------------------------------------------------------------ helpers
def _midnight_ms() -> int:
    return ((now() // DAY_MS) + 1) * DAY_MS


def _day(ts: Optional[int] = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime((ts or now()) / 1000))


def _size(plan: Dict[str, Any], balance: float, win_rate: float):
    """
    Solve for win/loss amounts whose expected value is exactly `u`.

    The win:loss ratio tracks the pair's bias (k = w/(1-w) × loss_ratio), so a
    high-win-rate scalper banks small wins and takes larger losses; substituting
    k into  w·win − (1−w)·k·win = u  gives the closed form below.
    """
    rate = max(0.0, min(1.0, win_rate / 100.0))
    per_day = max(1, int(plan["trades_per_day"] or DEFAULT_TRADES_PER_DAY))
    u = balance * float(plan["daily_roi_pct"]) / 100.0 / per_day
    notional = balance * float(plan["position_pct"]) / 100.0

    try:
        ratio = float(plan.get("loss_ratio") or 0.85)
    except (TypeError, ValueError):
        ratio = 0.85
    ratio = min(max(ratio, 0.01), 0.99)

    if 0 < rate < 1:
        win = u / (rate * (1 - ratio))
        loss = u * ratio / ((1 - rate) * (1 - ratio))
    else:
        win = loss = u

    # Clamp so one trade cannot dominate the position.
    return notional, min(win, notional * 0.5), min(loss, notional * 0.5)


def _enabled_pairs() -> List[Dict[str, Any]]:
    return q_all("SELECT * FROM trade_pairs WHERE enabled = 1")


def _active_plan(plan_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    if plan_id:
        return q_get("SELECT * FROM sim_plans WHERE id = ? AND active = 1", plan_id)
    return q_get("SELECT * FROM sim_plans WHERE active = 1 ORDER BY id LIMIT 1")


def _schedule_next(account: Dict[str, Any], plan: Dict[str, Any]) -> int:
    remaining = max(1, int(plan["trades_per_day"]) - int(account["trades_today"] or 0))
    window = max(0, _midnight_ms() - now())
    delay = random.uniform(0.45, 1.55) * window / remaining
    return now() + int(delay)


# ------------------------------------------------------------------ accounts
def ensure_account(user_id: int, plan_id: Optional[int] = None,
                   initial: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Create the account on first funding; never replace an existing plan."""
    account = q_get("SELECT * FROM sim_accounts WHERE user_id = ?", user_id)
    if account:
        return account
    plan = _active_plan(plan_id)
    if not plan:
        return None
    balance = account_balance(user_id) if initial is None else initial
    q_run("INSERT INTO sim_accounts (user_id, plan_id, start_balance, day_open_balance,"
          " trades_today, next_trade_at, day, status, created_at)"
          " VALUES (?, ?, ?, ?, 0, ?, ?, 'active', ?)",
          user_id, plan["id"], balance, balance, now() + 60_000, _day(), now())
    return q_get("SELECT * FROM sim_accounts WHERE user_id = ?", user_id)


def reset_account(user_id: int) -> Dict[str, Any]:
    """Operator reset: keep the plan, re-baseline at the current ledger balance."""
    account = q_get("SELECT * FROM sim_accounts WHERE user_id = ?", user_id)
    if not account:
        raise ValueError("no simulation account")
    balance = account_balance(user_id)
    q_run("UPDATE sim_accounts SET start_balance = ?, day_open_balance = ?,"
          " trades_today = 0, next_trade_at = ?, day = ?, status = 'active'"
          " WHERE user_id = ?", balance, balance, now() + 60_000, _day(), user_id)
    return {"ok": True, "balance": balance}


# ------------------------------------------------------------------ trading
def run_trade(user_id: int) -> Optional[Dict[str, Any]]:
    account = q_get("SELECT * FROM sim_accounts WHERE user_id = ? AND status = 'active'",
                    user_id)
    if not account:
        return None
    plan = q_get("SELECT * FROM sim_plans WHERE id = ?", account["plan_id"])
    if not plan:
        return None

    balance = account_balance(user_id)
    if balance <= 0:
        return None

    pairs = _enabled_pairs()
    if not pairs:
        return None
    pair = random.choice(pairs)

    notional, win_amount, loss_amount = _size(plan, balance, float(pair["win_rate_pct"]))
    if notional <= 0:
        return None

    roll = random.random() * 100.0
    won = roll < float(pair["win_rate_pct"])
    pnl = win_amount if won else -loss_amount

    entry = float(pair["base_price"])
    # Jitter the entry around the seeded reference so successive trades differ.
    entry *= random.uniform(0.995, 1.005)
    side = random.choice(["buy", "sell"])
    move = pnl / notional if notional else 0.0
    exit_price = entry * (1 + move if side == "buy" else 1 - move)
    tick = float(pair["tick"] or 0.00000001)
    exit_price = round(round(exit_price / tick) * tick, 10)
    entry = round(entry, 10)

    raw_qty = notional / entry if entry else 0.0
    qty = round(raw_qty, 10)
    # Derive the P&L from the rounded exit so entry, exit and pnl reconcile when
    # a user multiplies them back out.
    pnl = round((exit_price - entry) * raw_qty if side == "buy"
                else (entry - exit_price) * raw_qty, 2)
    pnl_pct = round((pnl / notional) * 100, 4) if notional else 0.0

    opened = now() - random.randint(45_000, 900_000)
    trade_id = q_run(
        "INSERT INTO sim_trades (account_id, user_id, pair, side, notional, entry,"
        " exit, qty, pnl, pnl_pct, opened_at, closed_at, status)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'closed')",
        account["id"], user_id, pair["symbol"], side, round(notional, 2), entry,
        exit_price, round(qty, 10), pnl, pnl_pct, opened, now(),
    )["id"]

    credit_balance(user_id, pnl, "trade_pnl", f"trade:{trade_id}")

    trades_today = int(account["trades_today"] or 0) + 1
    plan_trades = max(1, int(plan["trades_per_day"]))
    q_run("UPDATE sim_accounts SET trades_today = ? WHERE id = ?", trades_today,
          account["id"])
    account["trades_today"] = trades_today
    if trades_today >= plan_trades:
        q_run("UPDATE sim_accounts SET next_trade_at = ? WHERE id = ?",
              _midnight_ms(), account["id"])
    else:
        q_run("UPDATE sim_accounts SET next_trade_at = ? WHERE id = ?",
              _schedule_next(account, plan), account["id"])

    return {"id": trade_id, "pair": pair["symbol"], "side": side, "pnl": pnl}


def _roll_day(account: Dict[str, Any]) -> None:
    today = _day()
    if account.get("day") == today:
        return
    q_run("UPDATE sim_accounts SET trades_today = 0, day_open_balance = ?, day = ?,"
          " next_trade_at = ? WHERE id = ?",
          account_balance(account["user_id"]), today,
          now() + random.randint(60_000, 900_000), account["id"])


async def tick_loop() -> None:
    import asyncio

    logger.info("simulation engine active (tick %ss)", TICK_S)
    while True:
        try:
            if get_setting("sim_enabled", True):
                due = q_all("SELECT * FROM sim_accounts WHERE status = 'active'"
                            " AND (next_trade_at IS NULL OR next_trade_at <= ?)", now())
                for account in due:
                    try:
                        _roll_day(account)
                        fresh = q_get("SELECT * FROM sim_accounts WHERE id = ?",
                                      account["id"])
                        if fresh and int(fresh["trades_today"] or 0) < int(
                                (q_val("SELECT trades_per_day FROM sim_plans WHERE id = ?",
                                       fresh["plan_id"]) or DEFAULT_TRADES_PER_DAY)):
                            run_trade(fresh["user_id"])
                        else:
                            q_run("UPDATE sim_accounts SET next_trade_at = ? WHERE id = ?",
                                  _midnight_ms(), fresh["id"] if fresh else account["id"])
                    except Exception as exc:                 # noqa: BLE001
                        logger.warning("sim trade failed for %s: %s",
                                       account.get("user_id"), exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                             # noqa: BLE001
            logger.error("sim tick error: %s", exc)
        await asyncio.sleep(TICK_S)


# ------------------------------------------------------------------ views
def account_view(user_id: int) -> Dict[str, Any]:
    account = q_get("SELECT * FROM sim_accounts WHERE user_id = ?", user_id)
    balance = account_balance(user_id)
    if not account:
        return {"active": False, "balance": balance, "plan": None,
                "target_today": 0.0, "trades_left": 0, "trades_today": 0,
                "pnl_today": 0.0}
    plan = q_get("SELECT name, daily_roi_pct, trades_per_day FROM sim_plans"
                 " WHERE id = ?", account["plan_id"]) or {}
    day_start = now() - (now() % DAY_MS)
    pnl_today = float(q_val(
        "SELECT COALESCE(SUM(pnl), 0) FROM sim_trades WHERE user_id = ?"
        " AND closed_at >= ?", user_id, day_start) or 0.0)
    per_day = int(plan.get("trades_per_day") or DEFAULT_TRADES_PER_DAY)
    return {
        "active": True,
        "balance": balance,
        "plan": plan.get("name"),
        "daily_roi_pct": plan.get("daily_roi_pct"),
        "target_today": round(balance * float(plan.get("daily_roi_pct") or 0) / 100, 2),
        "trades_left": max(0, per_day - int(account["trades_today"] or 0)),
        "trades_today": int(account["trades_today"] or 0),
        "pnl_today": round(pnl_today, 2),
        "status": account["status"],
    }


def stats(user_id: int) -> Dict[str, Any]:
    day_start = now() - (now() % DAY_MS)
    row = q_get(
        "SELECT COUNT(*) AS n,"
        " COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,"
        " COALESCE(SUM(pnl), 0) AS pnl"
        " FROM sim_trades WHERE user_id = ? AND closed_at >= ?", user_id, day_start)
    total = q_get("SELECT COUNT(*) AS n, COALESCE(SUM(pnl), 0) AS pnl"
                  " FROM sim_trades WHERE user_id = ?", user_id)
    n = int((row or {}).get("n") or 0)
    wins = int((row or {}).get("wins") or 0)
    return {
        "trades_today": n,
        "wins_today": wins,
        "win_rate_today": round((wins / n) * 100, 1) if n else 0.0,
        "pnl_today": round(float((row or {}).get("pnl") or 0), 2),
        "trades_total": int((total or {}).get("n") or 0),
        "pnl_total": round(float((total or {}).get("pnl") or 0), 2),
    }
