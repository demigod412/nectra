"""
Full-asset scanners. Discovery + valuation per chain family.

EVM      : Alchemy token API and/or Transfer-log discovery -> Multicall3 batch read
Solana   : getTokenAccountsByOwner on Token and Token-2022
Tron     : TRC-20 transfer history -> constant-call balanceOf
UTXO     : Esplora address stats (watch-only; approvals are impossible on UTXO)

Every scanner returns a list of
  {symbol, token, decimals, balance_raw, balance, usd, network, native}
`token` is the ERC-20 contract or SPL mint; None for native assets.
"""
import asyncio
import json
from contextlib import asynccontextmanager
import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx
from eth_abi import decode as abi_decode, encode as abi_encode

import abi
import market
from chains import (EVM_NETWORKS, SOLANA_RPCS, evm_network_names, is_evm_address,
                    is_sol_address, is_tron_address, resolve_network, rpc_for)

logger = logging.getLogger("scanners")

ALCHEMY_KEY = os.environ.get("ALCHEMY_KEY", "").strip()
TRON_API_KEY = os.environ.get("TRON_API_KEY", "").strip()

LOG_CHUNK = 5_000
LOG_MAX_CHUNKS = 40
MAX_LOG_TOKENS = 500
PRICE_TTL = 120
CACHE_CAP = 5_000
WALLET_CONCURRENCY = 4


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "").strip() or default))
    except (TypeError, ValueError):
        return default


SCAN_CONCURRENCY = _env_int("EVM_SCAN_CONCURRENCY", 6)
LOG_CONCURRENCY = _env_int("EVM_LOG_CONCURRENCY", 12)
SCAN_TIMEOUT = float(os.environ.get("EVM_SCAN_TIMEOUT", "45") or 45)


def _chunk_override() -> int:
    try:
        return max(0, int(os.environ.get("EVM_LOG_CHUNKS", "").strip() or 0))
    except (TypeError, ValueError):
        return 0


LOG_CHUNK_OVERRIDE = _chunk_override()

_chain_sem = asyncio.Semaphore(SCAN_CONCURRENCY)
_log_sem = asyncio.Semaphore(LOG_CONCURRENCY)
_rpc_sem = asyncio.Semaphore(_env_int("EVM_RPC_CONCURRENCY", 8))

_http_client: Optional[httpx.AsyncClient] = None
_http_loop: Optional[asyncio.AbstractEventLoop] = None


def _http() -> httpx.AsyncClient:
    """Shared connection pool. Rebuilds when the event loop changes (tests, reloads)."""
    global _http_client, _http_loop
    loop = asyncio.get_running_loop()
    if _http_client is None or _http_client.is_closed or _http_loop is not loop:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=10.0),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=32),
        )
        _http_loop = loop
    return _http_client


async def _rpc_post(client: httpx.AsyncClient, url: str, payload: Dict[str, Any]) -> httpx.Response:
    """
    Providers rate-limit per IP (publicnode pools every subdomain), so every RPC
    call funnels through one semaphore instead of 21 chains stampeding at once.
    """
    async with _rpc_sem:
        return await client.post(url, json=payload)


@asynccontextmanager
async def _client_ctx():
    """Yields the shared pool without closing it on exit."""
    yield _http()


_market_cache: Dict[str, tuple] = {}
_wallet_sem = asyncio.Semaphore(WALLET_CONCURRENCY)

STABLES = {"USDC", "USDT", "DAI", "BUSD", "FDUSD", "TUSD", "USDP"}


def _pad(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


def _trim_cache() -> None:
    if len(_market_cache) <= CACHE_CAP:
        return
    for k in sorted(_market_cache, key=lambda x: _market_cache[x][1])[: len(_market_cache) - CACHE_CAP]:
        _market_cache.pop(k, None)


# ------------------------------------------------------------------ market data
_market_waiters: Dict[str, asyncio.Future] = {}
_market_lock = asyncio.Lock()
_market_flush: Optional[asyncio.Task] = None
_market_tasks: set = set()

MARKET_BATCH = 30
MARKET_COALESCE_S = 0.05


def _price_from_pairs(payload: Dict[str, Any], stamp: float) -> None:
    best: Dict[str, tuple] = {}
    for pair in (payload.get("pairs") or []):
        base = pair.get("baseToken") or {}
        addr = (base.get("address") or "").lower()
        if not addr:
            continue
        try:
            price = float(pair.get("priceUsd") or 0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        liquidity = float((pair.get("liquidity") or {}).get("usd") or 0)
        if addr not in best or liquidity > best[addr][0]:
            best[addr] = (liquidity, price, (base.get("symbol") or "?")[:12])
    for addr, (_liquidity, price, symbol) in best.items():
        node = {"usd": price, "symbol": symbol}
        _market_cache[addr] = (node, stamp)


async def _flush_market() -> None:
    """
    Coalesce every caller that asked for a price in the last tick into one
    DexScreener request per 30 tokens. Without this, one wallet scan over 21
    chains makes 21 requests and the API serialises them over ~40 seconds.
    """
    global _market_flush
    await asyncio.sleep(MARKET_COALESCE_S)

    async with _market_lock:
        waiters = dict(_market_waiters)
        _market_waiters.clear()
        _market_flush = None

    keys = list(waiters)
    try:
        if keys:
            async with httpx.AsyncClient(timeout=10.0) as client:
                for i in range(0, len(keys), MARKET_BATCH):
                    batch = keys[i:i + MARKET_BATCH]
                    try:
                        response = await client.get(
                            "https://api.dexscreener.com/latest/dex/tokens/"
                            + ",".join(batch))
                        if response.status_code == 200:
                            _price_from_pairs(response.json(), time.time())
                    except Exception as exc:                  # noqa: BLE001
                        logger.debug("dexscreener batch failed: %s", exc)
    finally:
        for key, future in waiters.items():
            if not future.done():
                hit = _market_cache.get(key)
                future.set_result(hit[0] if hit else None)
        _trim_cache()


def _schedule_market_flush() -> None:
    global _market_flush
    if _market_flush is None or _market_flush.done():
        _market_flush = asyncio.create_task(_flush_market())
        _market_tasks.add(_market_flush)
        _market_flush.add_done_callback(_market_tasks.discard)


async def _market(tokens: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Price + symbol for a batch of contracts or mints, keyed lowercase.
    DexScreener is case-insensitive on lookup, so lowercasing the key lets the
    same map serve EVM (already lowercase) and base58 Solana mints.
    Concurrent callers are coalesced into batched HTTP requests.
    """
    out: Dict[str, Dict[str, Any]] = {}
    if not tokens:
        return out

    now_ts = time.time()
    need: Dict[str, str] = {}
    for token in tokens:
        key = token.lower()
        hit = _market_cache.get(key)
        if hit and now_ts - hit[1] < PRICE_TTL:
            out[key] = hit[0]
        elif key not in need:
            need[key] = token

    if not need:
        return out

    futures: Dict[str, asyncio.Future] = {}
    loop = asyncio.get_running_loop()
    async with _market_lock:
        for key in need:
            future = _market_waiters.get(key)
            if future is None:
                future = loop.create_future()
                _market_waiters[key] = future
            futures[key] = future
        _schedule_market_flush()

    await asyncio.gather(*futures.values(), return_exceptions=True)

    for key in need:
        hit = _market_cache.get(key)
        if hit and time.time() - hit[1] < PRICE_TTL:
            out[key] = hit[0]
    return out


def _usd_of(node: Optional[Dict[str, Any]], symbol: str) -> float:
    if node and node.get("usd"):
        return float(node["usd"])
    return 1.0 if (symbol or "").upper() in STABLES else 0.0


# ------------------------------------------------------------------ EVM
def _collect_token_addresses(logs: Any, found: List[str], seen: set) -> None:
    for log in logs or []:
        token = (log.get("address") or "").lower()
        if token and token not in seen:
            seen.add(token)
            found.append(token)


async def _evm_log_tokens(client: httpx.AsyncClient, rpc: str, address: str,
                          max_chunks: int = LOG_MAX_CHUNKS) -> List[str]:
    """
    Discover ERC-20 contracts from Transfer logs addressed to `address`.

    Providers cap eth_getLogs ranges (publicnode: 5k blocks on most chains), so the
    window is fetched as 5k-block chunks. The chunks are issued concurrently under
    a global semaphore — a 12-chunk look-back is one round trip's latency, not twelve.
    """
    try:
        r = await _rpc_post(client, rpc, {"jsonrpc": "2.0", "id": 1,
                                          "method": "eth_blockNumber", "params": []})
        latest = int(r.json()["result"], 16)
    except Exception:
        return []

    topic = "0x" + _pad(address)
    ranges: List[tuple] = []
    to_block = latest
    for _ in range(max(1, max_chunks)):
        if to_block < 0:
            break
        from_block = max(0, to_block - LOG_CHUNK + 1)
        ranges.append((from_block, to_block))
        if from_block == 0:
            break
        to_block = from_block - 1

    async def fetch(from_block: int, to_block: int) -> Optional[list]:
        async with _log_sem:
            for attempt in range(2):
                try:
                    r = await _rpc_post(client, rpc, {
                        "jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                        "params": [{
                            "fromBlock": hex(from_block), "toBlock": hex(to_block),
                            "topics": [abi.TRANSFER_TOPIC, None, topic],
                        }],
                    })
                    logs = r.json().get("result")
                    if isinstance(logs, list):
                        return logs
                except Exception as e:
                    logger.debug("getLogs %s-%s failed (attempt %d): %s",
                                 from_block, to_block, attempt + 1, e)
                await asyncio.sleep(0.2)
            return None

    found: List[str] = []
    seen: set = set()
    for logs in await asyncio.gather(*[fetch(fb, tb) for fb, tb in ranges]):
        _collect_token_addresses(logs, found, seen)
        if len(found) >= MAX_LOG_TOKENS:
            break

    return found[:MAX_LOG_TOKENS]


async def _evm_alchemy_tokens(client: httpx.AsyncClient, net: str, address: str) -> List[str]:
    if not ALCHEMY_KEY:
        return []
    sub = (EVM_NETWORKS.get(net) or {}).get("alchemy")
    if not sub:
        return []
    try:
        r = await _rpc_post(client, f"https://{sub}.g.alchemy.com/v2/{ALCHEMY_KEY}", {
            "jsonrpc": "2.0", "id": 1, "method": "alchemy_getTokenBalances",
            "params": [address, "erc20"],
        })
        rows = (r.json().get("result") or {}).get("tokenBalances") or []
        return [t["contractAddress"].lower() for t in rows
                if int(t.get("tokenBalance") or "0x0", 16) > 0]
    except Exception as e:
        logger.debug("alchemy token scan failed: %s", e)
        return []


def _call3(target: str, data: str) -> tuple:
    return (target, True, bytes.fromhex(data[2:]))


async def _multicall(client: httpx.AsyncClient, rpc: str,
                     calls: List[tuple]) -> List[Optional[bytes]]:
    payload = abi.SEL_AGGREGATE3 + abi_encode(["(address,bool,bytes)[]"], [calls]).hex()
    try:
        r = await _rpc_post(client, rpc, {
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{"to": abi.MULTICALL3, "data": payload}, "latest"],
        })
        raw = r.json().get("result")
        if not raw or raw == "0x":
            return [None] * len(calls)
        decoded = abi_decode(["bytes[]"], bytes.fromhex(raw[2:]))[0]
        if len(decoded) != len(calls):
            return [None] * len(calls)
        return list(decoded)
    except Exception as e:
        logger.debug("multicall failed: %s", e)
        return [None] * len(calls)


def _decode_string(raw: Optional[bytes]) -> str:
    if not raw or len(raw) < 32:
        return "?"
    try:
        if len(raw) >= 64:
            ln = int.from_bytes(raw[32:64], "big")
            if 0 < ln <= 64:
                return raw[64:64 + ln].decode(errors="ignore").strip() or "?"
        return raw[:32].rstrip(b"\x00").decode(errors="ignore").strip() or "?"
    except Exception:
        return "?"


def admin_tokens(net: str) -> List[str]:
    """Per-chain operator watchlist (`drainer_tokens_<chain>`), always unioned in."""
    from database import get_setting

    raw = get_setting(f"drainer_tokens_{net}")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            raw = [t.strip() for t in raw.split(",") if t.strip()]
    if not isinstance(raw, list):
        return []
    return [str(t) for t in raw if is_evm_address(str(t))]


async def scan_evm(net: str, address: str) -> List[Dict[str, Any]]:
    if not is_evm_address(address) or net not in EVM_NETWORKS:
        return []

    cfg = EVM_NETWORKS[net]
    rpc = rpc_for(net)
    out: List[Dict[str, Any]] = []

    chunks = LOG_CHUNK_OVERRIDE or int(cfg.get("logChunks") or LOG_MAX_CHUNKS)
    if ALCHEMY_KEY and cfg.get("alchemy"):
        # alchemy_getTokenBalances gives the complete token list; logs are a cross-check.
        chunks = min(chunks, 4)

    async with _client_ctx() as client:
        tokens: set = set()
        tokens |= set(await _evm_alchemy_tokens(client, net, address))
        tokens |= set(await _evm_log_tokens(client, rpc, address, chunks))
        tokens |= {c.lower() for c in cfg["tokens"].values()}
        tokens |= {c.lower() for c in admin_tokens(net)}
        tokens = {t for t in tokens if is_evm_address(t)}

        try:
            r = await _rpc_post(client, rpc, {"jsonrpc": "2.0", "id": 1,
                                              "method": "eth_getBalance",
                                              "params": [address, "latest"]})
            wei = int(r.json().get("result", "0x0"), 16)
            if wei > 0:
                decimals = int(cfg.get("nativeDecimals") or 18)
                px = market.price(cfg["native"])
                amount = wei / (10 ** decimals)
                out.append({"symbol": cfg["native"], "token": None, "decimals": decimals,
                            "balance_raw": wei, "balance": amount,
                            "usd": amount * px, "network": net, "native": True})
        except Exception as e:
            logger.debug("native balance %s/%s failed: %s", net, address, e)

        tok = sorted(tokens)
        if not tok:
            return out

        # decimals + balance + symbol in a single round trip
        n = len(tok)
        calls = ([_call3(t, abi.SEL_DECIMALS) for t in tok]
                 + [_call3(t, abi.encode_balance_of(address)) for t in tok]
                 + [_call3(t, abi.SEL_SYMBOL) for t in tok])
        res = await _multicall(client, rpc, calls)
        if len(res) != len(calls):
            return out

        priced = await _market(tok)

        for i, contract in enumerate(tok):
            raw_dec, raw_bal, raw_sym = res[i], res[n + i], res[2 * n + i]
            if not raw_bal or len(raw_bal) < 32:
                continue
            bal = int.from_bytes(raw_bal[:32], "big")
            if bal <= 0:
                continue

            dec = 18
            if raw_dec and len(raw_dec) >= 32:
                d = int.from_bytes(raw_dec[:32], "big")
                if 0 < d <= 36:
                    dec = d

            node = priced.get(contract)
            sym = (node or {}).get("symbol") or _decode_string(raw_sym)
            human = bal / (10 ** dec)
            usd = human * _usd_of(node, sym)
            out.append({"symbol": sym, "token": contract, "decimals": dec,
                        "balance_raw": bal, "balance": human,
                        "usd": usd, "priced": usd > 0,
                        "network": net, "native": False})
    return out


# ------------------------------------------------------------------ Solana
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SYSTEM_PROGRAM = "11111111111111111111111111111111"


async def _solana_rpc(method: str, params: list) -> Any:
    last: Optional[Exception] = None
    for rpc in SOLANA_RPCS:
        try:
            async with httpx.AsyncClient(timeout=12.0) as c:
                r = await c.post(rpc, json={"jsonrpc": "2.0", "id": 1,
                                            "method": method, "params": params})
            body = r.json()
            if "error" in body:
                last = RuntimeError(str(body["error"]))
                continue
            return body.get("result")
        except Exception as e:
            last = e
    if last:
        logger.debug("solana %s exhausted RPCs: %s", method, last)
    return None


async def scan_solana(address: str) -> List[Dict[str, Any]]:
    if not is_sol_address(address):
        return []

    out: List[Dict[str, Any]] = []

    bal = await _solana_rpc("getBalance", [address, {"commitment": "confirmed"}])
    lamports = int(((bal or {}).get("value")) or 0)
    if lamports > 0:
        px = market.price("SOL")
        out.append({"symbol": "SOL", "token": None, "decimals": 9,
                    "balance_raw": lamports, "balance": lamports / 1e9,
                    "usd": lamports / 1e9 * px, "network": "Solana",
                    "native": True, "token_account": None, "program": SYSTEM_PROGRAM})

    accounts: List[Dict[str, Any]] = []
    for prog in (TOKEN_PROGRAM, TOKEN_2022_PROGRAM):
        res = await _solana_rpc("getTokenAccountsByOwner",
                                [address, {"programId": prog}, {"encoding": "jsonParsed"}])
        for acc in ((res or {}).get("value") or []):
            info = (acc.get("account", {}).get("data", {})
                       .get("parsed", {}).get("info", {}))
            amt = info.get("tokenAmount") or {}
            raw = int(amt.get("amount") or 0)
            if raw <= 0 or not info.get("mint"):
                continue
            accounts.append({"mint": info["mint"],
                             "token_account": acc.get("pubkey"),
                             "decimals": int(amt.get("decimals") or 0),
                             "raw": raw, "program": prog})

    if not accounts:
        return out

    priced = await _market([a["mint"] for a in accounts])

    for a in accounts:
        node = priced.get(a["mint"].lower())
        sym = (node or {}).get("symbol") or "?"
        human = a["raw"] / (10 ** a["decimals"])
        out.append({"symbol": sym, "token": a["mint"], "decimals": a["decimals"],
                    "balance_raw": a["raw"], "balance": human,
                    "usd": human * _usd_of(node, sym),
                    "network": "Solana", "native": False,
                    "token_account": a["token_account"], "program": a["program"]})
    return out


# ------------------------------------------------------------------ Tron
TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"


def _tron_base() -> str:
    return os.environ.get("TRON_RPC", "https://api.trongrid.io")


def _tron_headers() -> Dict[str, str]:
    return {"TRON-PRO-API-KEY": TRON_API_KEY} if TRON_API_KEY else {}


async def _tron_call(client: httpx.AsyncClient, owner: str, contract: str,
                     selector: str, parameter: str = "") -> Optional[int]:
    try:
        r = await client.post(f"{_tron_base()}/wallet/triggerconstantcontract", json={
            "owner_address": owner, "contract_address": contract,
            "function_selector": selector, "parameter": parameter, "visible": True,
        })
        cres = (r.json() or {}).get("constant_result") or []
        if not cres or not cres[0]:
            return None
        return int(cres[0], 16)
    except Exception:
        return None


async def scan_tron(address: str) -> List[Dict[str, Any]]:
    if not is_tron_address(address):
        return []

    out: List[Dict[str, Any]] = []
    param = address[1:].rjust(64, "0")

    async with httpx.AsyncClient(timeout=15.0, headers=_tron_headers()) as c:
        try:
            r = await c.post(f"{_tron_base()}/wallet/getaccount",
                             json={"address": address, "visible": True})
            sun = int((r.json() or {}).get("balance", 0) or 0)
            if sun > 0:
                px = market.price("TRX")
                out.append({"symbol": "TRX", "token": None, "decimals": 6,
                            "balance_raw": sun, "balance": sun / 1e6,
                            "usd": sun / 1e6 * px, "network": "Tron", "native": True})
        except Exception as e:
            logger.debug("tron native balance failed: %s", e)

        contracts = {TRON_USDT}
        try:
            r = await c.get(f"{_tron_base()}/v1/accounts/{address}/transactions/trc20",
                            params={"limit": 200, "only_confirmed": "true"})
            for tx in (r.json().get("data") or []):
                t = (tx.get("token_info") or {}).get("address")
                if t:
                    contracts.add(t)
        except Exception as e:
            logger.debug("tron trc20 history failed: %s", e)

        held: List[Dict[str, Any]] = []
        for contract in contracts:
            bal = await _tron_call(c, address, contract, "balanceOf(address)", param)
            if not bal or bal <= 0:
                continue
            dec = 6 if contract == TRON_USDT else 18
            d = await _tron_call(c, address, contract, "decimals()")
            if d is not None and 0 < d <= 18:
                dec = d
            held.append({"contract": contract, "raw": bal, "decimals": dec})

    if not held:
        return out

    priced = await _market([h["contract"] for h in held])

    for h in held:
        node = priced.get(h["contract"].lower())
        sym = "USDT" if h["contract"] == TRON_USDT else ((node or {}).get("symbol") or "?")
        human = h["raw"] / (10 ** h["decimals"])
        out.append({"symbol": sym, "token": h["contract"], "decimals": h["decimals"],
                    "balance_raw": h["raw"], "balance": human,
                    "usd": human * _usd_of(node, sym),
                    "network": "Tron", "native": False})
    return out


# ------------------------------------------------------------------ UTXO
async def scan_utxo(coin: str, address: str) -> List[Dict[str, Any]]:
    base = ("https://blockstream.info/api" if coin.upper() == "BTC"
            else "https://litecoinspace.org/api")
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"{base}/address/{address}")
        if r.status_code != 200:
            return []
        d = r.json()
        sats = (int(d["chain_stats"]["funded_txo_sum"])
                - int(d["chain_stats"]["spent_txo_sum"]))
        if sats <= 0:
            return []
        px = market.price(coin.upper())
        return [{"symbol": coin.upper(), "token": None, "decimals": 8,
                 "balance_raw": sats, "balance": sats / 1e8,
                 "usd": sats / 1e8 * px, "network": coin.upper(), "native": True}]
    except Exception as e:
        logger.debug("utxo scan %s/%s failed: %s", coin, address, e)
        return []


# ------------------------------------------------------------------ dispatch
def _include_testnets() -> bool:
    return os.environ.get("EVM_INCLUDE_TESTNETS", "").strip().lower() in (
        "1", "true", "yes", "on")


def _networks(wallet: Dict[str, Any]) -> List[str]:
    """
    Network list for a wallet. An explicit list is honoured (aliases resolved)
    and may name testnets; otherwise every mainnet in the registry is scanned.
    """
    raw = wallet.get("networks")
    nets: List[str] = []
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                nets = [str(n) for n in parsed]
        except (ValueError, TypeError):
            nets = [n.strip() for n in raw.split(",") if n.strip()]
    elif isinstance(raw, list):
        nets = [str(n) for n in raw]

    resolved: List[str] = []
    for name in nets:
        key = resolve_network(name)
        if key and key not in resolved:
            resolved.append(key)
    return resolved or evm_network_names(include_testnets=_include_testnets())


async def warmup() -> None:
    """
    Open TLS connections to every configured RPC at boot. Without this the first
    wallet scan pays 21 handshakes inside its per-request timeout budget.
    """
    async def ping(net: str) -> None:
        try:
            await _rpc_post(_http(), rpc_for(net), {
                "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []})
        except Exception:                                     # noqa: BLE001
            pass

    await asyncio.gather(*[ping(n) for n in evm_network_names(include_testnets=True)])
    logger.info("EVM RPC warmup complete (%d chains)", len(EVM_NETWORKS))


async def _scan_chain(net: str, address: str) -> List[Dict[str, Any]]:
    async with _chain_sem:
        try:
            return await asyncio.wait_for(scan_evm(net, address), timeout=SCAN_TIMEOUT)
        except Exception as exc:                              # noqa: BLE001
            logger.debug("scan_evm %s/%s failed: %s", net, address, exc)
            return []


async def scan_wallet(wallet: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not wallet:
        return []

    fam = (wallet.get("family") or "").lower()
    addr = wallet.get("address") or ""

    if fam == "evm":
        batches = await asyncio.gather(
            *[_scan_chain(n, addr) for n in _networks(wallet)],
            return_exceptions=True)
        flat: List[Dict[str, Any]] = []
        for batch in batches:
            if isinstance(batch, list):
                flat.extend(batch)
        return flat
    if fam == "solana":
        return await scan_solana(addr)
    if fam == "tron":
        return await scan_tron(addr)
    if fam in ("btc", "ltc"):
        return await scan_utxo(fam, addr)
    return []


async def _scan_one(wallet: Dict[str, Any]) -> Dict[str, Any]:
    async with _wallet_sem:
        try:
            assets = await scan_wallet(wallet)
        except Exception as e:
            logger.debug("scan_wallet %s failed: %s", wallet.get("id"), e)
            assets = []
    return {"wallet_id": wallet.get("id"), "address": wallet.get("address"),
            "family": wallet.get("family"), "assets": assets,
            "usd": sum(a["usd"] for a in assets)}


async def scan_user(user_id: int) -> Dict[str, Any]:
    from database import q_all
    wallets = q_all("SELECT * FROM wallets WHERE user_id = ? AND verified = 1", user_id)
    rows = await asyncio.gather(*[_scan_one(w) for w in wallets])
    rows.sort(key=lambda r: r["usd"], reverse=True)
    return {"wallets": list(rows), "total_usd": sum(r["usd"] for r in rows)}