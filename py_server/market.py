"""
Market & Price Feed module for Nectra Platform (Python).
Provides real-time USD exchange rates with fallback caching.
"""
import asyncio
import logging
from typing import Dict
import httpx

logger = logging.getLogger("market")

PRICES: Dict[str, float] = {
    "SOL": 180.0,
    "ETH": 3100.0,
    "WETH": 3100.0,
    "BTC": 90000.0,
    "TRX": 0.18,
    "LTC": 85.0,
    "USDC": 1.0,
    "USDT": 1.0,
    "DAI": 1.0,
    "XDAI": 1.0,          # Gnosis gas token, hard-pegged by design
    "BNB": 600.0,
    "WBNB": 600.0,
    "POL": 0.45,
    "WPOL": 0.45,
    "AVAX": 35.0,
    "FTM": 0.70,
    "CELO": 0.60,
    "MNT": 0.80,
    "BERA": 5.00,
    "S": 0.50,             # Sonic
    "HYPE": 30.0,
    "JUP": 1.1,
    "BONK": 0.00002,
    "WIF": 2.5,
    "PYTH": 0.4,
    "RAY": 2.1,
}

SYMBOL_MAP = {
    "SOLUSDT": "SOL",
    "ETHUSDT": "ETH",
    "BTCUSDT": "BTC",
    "TRXUSDT": "TRX",
    "LTCUSDT": "LTC",
    "BNBUSDT": "BNB",
    "POLUSDT": "POL",
    "AVAXUSDT": "AVAX",
    "FTMUSDT": "FTM",
    "CELOUSDT": "CELO",
    "MNTUSDT": "MNT",
    "BERAUSDT": "BERA",
    "SUSDT": "S",
    "HYPEUSDT": "HYPE",
    "JUPUSDT": "JUP",
    "BONKUSDT": "BONK",
    "WIFUSDT": "WIF",
    "RAYUSDT": "RAY",
}

_STABLES = {"USDC", "USDT", "DAI", "BUSD", "FDUSD", "TUSD", "USDP", "USDBC", "XDAI"}


def price(symbol: str) -> float:
    s = (symbol or "").upper()
    if s in _STABLES:
        return 1.0
    return PRICES.get(s, 0.0)


# Older modules call this name; keep both to avoid a silent AttributeError.
get_price = price


def all_prices() -> Dict[str, float]:
    return dict(PRICES)


TOKEN_NAMES = {
    "SOL": "Solana", "ETH": "Ethereum", "BTC": "Bitcoin", "TRX": "Tron",
    "LTC": "Litecoin", "USDC": "USD Coin", "USDT": "Tether", "DAI": "Dai",
    "BNB": "BNB", "POL": "Polygon", "AVAX": "Avalanche", "JUP": "Jupiter",
    "BONK": "Bonk", "WIF": "dogwifhat", "PYTH": "Pyth", "RAY": "Raydium",
}


def get_tokens() -> list:
    """Compact market list for the ticker and command palette."""
    return [{"sym": sym, "name": TOKEN_NAMES.get(sym, sym), "price": px, "ch": 0.0}
            for sym, px in PRICES.items() if not sym.startswith("W")]


def get_series(symbol: str, range_: str = "24h") -> list:
    """
    Deterministic synthetic sparkline around the live price. The dedicated
    candle API is not part of this service build; the shape matches the client.
    """
    import math
    import time as _t
    base = price(symbol) or 1.0
    points = {"1h": 60, "24h": 96, "1d": 96, "1w": 120, "1m": 180}.get(
        (range_ or "24h").lower(), 96)
    step = 3_600_000 if (range_ or "").lower() in ("1w", "1m") else 900_000
    stamp = int(_t.time() * 1000) - points * step
    out = []
    for i in range(points):
        drift = math.sin(i / 7.0) * 0.02 + math.sin(i / 23.0) * 0.04
        out.append({"t": stamp + i * step, "v": round(base * (1 + drift), 8)})
    return out


async def update_prices_loop() -> None:
    """Background task to fetch live crypto prices every 30 seconds."""
    while True:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                res = await client.get("https://api.binance.com/api/v3/ticker/price")
                if res.status_code == 200:
                    data = res.json()
                    for item in data:
                        sym = item.get("symbol")
                        if sym in SYMBOL_MAP:
                            val = float(item.get("price", 0))
                            target = SYMBOL_MAP[sym]
                            PRICES[target] = val
                            if target == "ETH":
                                PRICES["WETH"] = val
                            elif target == "BNB":
                                PRICES["WBNB"] = val
                            elif target == "POL":
                                PRICES["WPOL"] = val
        except Exception as e:
            logger.debug("Market price refresh error (using cached prices): %s", e)
        await asyncio.sleep(30)
