# Token icons

Drop a PNG here named after the token symbol in **UPPERCASE**, e.g.:

```
BTC.png  LTC.png  ETH.png  BNB.png  SOL.png  USDT.png  USDC.png
TRX.png  JUP.png  BONK.png  WIF.png  PYTH.png  JTO.png  RAY.png  RENDER.png  POL.png
```

The app automatically uses `/assets/tokens/<SYMBOL>.png` wherever that coin appears
(tables, ticker, wallet balances, swap, dropdowns). **If a file is missing, it falls
back to a colored circle with the symbol initials** — so the app looks fine with no
icons at all; real PNGs just make it look polished. Add them whenever you like.

## Specification
- **Format:** PNG with transparent background (SVG also works — name it `<SYMBOL>.svg` and
  it will be used if you also change the extension in code; stick to PNG for the simplest path).
- **Size:** 128×128 px (square). 64×64 is acceptable; 128 looks best on retina screens.
- **Shape:** the icon is clipped to a circle, so keep the artwork centered with a little padding.
- **File size:** keep under ~30 KB each.
- **Name:** exactly the uppercase symbol + `.png`. `BTC.png`, not `btc.png` or `bitcoin.png`.

`_placeholder.png` is a reference template at the right size — copy it, replace the art,
and rename it to the symbol. You do **not** need to delete `_placeholder.png`.

Good free sources for coin icons: the "cryptocurrency-icons" icon set, or each project's
official brand/press kit. Use square mark versions.
