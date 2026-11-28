"""
Account balance + ledger.

No balance ever moves without a `balance_ledger` row. Every amount is rounded to
two decimals at write time; callers still get a float for display only.

`credit_balance` is the single write path for deposits, trade P&L, adjustments
and withdrawals (negative delta).
"""
import logging
from typing import Any, Dict, List

from database import now, q_all, q_get, q_val, tx

logger = logging.getLogger("ledger")

SYMBOL = "USD"


def _money(value: float) -> float:
    return round(float(value), 2)


def _wrapper(kind: str, ref: str) -> str:
    return f"{kind}:{ref}" if ref else kind


def credit_balance(user_id: int, delta: float, kind: str, ref: str = "") -> float:
    """Apply `delta` (may be negative) atomically and write the matching ledger row."""
    delta = _money(delta)
    if delta == 0:
        return account_balance(user_id)

    with tx() as conn:
        row = conn.execute(
            "SELECT id, balance FROM paper_balances WHERE user_id = ? AND symbol = ?",
            (user_id, SYMBOL)).fetchone()
        if row:
            conn.execute("UPDATE paper_balances SET balance = ?, updated_at = ?"
                         " WHERE id = ?", (_money(row["balance"] + delta), now(), row["id"]))
        else:
            conn.execute("INSERT INTO paper_balances (user_id, symbol, balance, updated_at)"
                         " VALUES (?, ?, ?, ?)", (user_id, SYMBOL, delta, now()))
        conn.execute(
            "INSERT INTO balance_ledger (user_id, delta, kind, ref, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (user_id, delta, kind, _wrapper(kind, ref), now()))

    return account_balance(user_id)


def debit_balance(user_id: int, delta: float, kind: str, ref: str = "") -> float:
    """Debit `delta` (positive amount). Caller checked sufficiency first."""
    return credit_balance(user_id, -abs(delta), kind, ref)


def account_balance(user_id: int) -> float:
    return _money(q_val("SELECT COALESCE(SUM(balance), 0) FROM paper_balances"
                        " WHERE user_id = ? AND symbol = ?", user_id, SYMBOL) or 0.0)


def totals(user_id: int) -> Dict[str, float]:
    """Deposited vs withdrawn, for spotting the synthetic-P&L spread."""
    deposited = q_val("SELECT COALESCE(SUM(credit), 0) FROM deposit_intents"
                      " WHERE user_id = ? AND status = 'credited'", user_id) or 0.0
    withdrawn = q_val("SELECT COALESCE(SUM(amount), 0) FROM withdrawals"
                      " WHERE user_id = ? AND status IN ('approved','paid')",
                      user_id) or 0.0
    return {"deposited": _money(deposited), "withdrawn": _money(withdrawn)}


def ledger_rows(user_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    return q_all("SELECT delta, kind, ref, created_at FROM balance_ledger"
                 " WHERE user_id = ? ORDER BY id DESC LIMIT ?", user_id, limit)
