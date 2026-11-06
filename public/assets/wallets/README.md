# Wallet provider icons

Drop a PNG here named after the wallet **id** (lowercase), e.g.:

```
phantom.png  solflare.png  backpack.png
metamask.png  coinbase.png  trust.png  binance.png
tronlink.png
```

The connect-wallet list uses `/assets/wallets/<id>.png`. **If a file is missing it falls
back to a colored rounded square with the wallet's first letter**, so the list works with
no icons; real logos just look better.

## Specification
- **Format:** PNG, transparent background.
- **Size:** 128×128 px square (shown at 36×36, rounded corners applied by CSS).
- **File size:** under ~30 KB.
- **Names (exact):** `phantom.png`, `solflare.png`, `backpack.png`, `metamask.png`,
  `coinbase.png`, `trust.png`, `binance.png`, `tronlink.png`.

`_placeholder.png` is a template at the right size — copy, replace, rename.

Get official logos from each wallet's brand/press page:
Phantom, Solflare, Backpack, MetaMask, Coinbase Wallet, Trust Wallet, Binance Wallet, TronLink.
