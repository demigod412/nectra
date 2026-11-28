"""
Production-hardening tests: revoke payloads, Tron proof verification, CSRF.

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import asyncio
import base64
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "py_server"))

import base58
from eth_account import Account
from eth_utils import keccak

import abi
import database
import revoke
import routes


def _tron_address(account) -> str:
    payload = b"\x41" + bytes.fromhex(account.address[2:])
    checksum = keccak(keccak(payload))[:4]
    return base58.b58encode(payload + checksum).decode()


class RevokeEncodingTests(unittest.TestCase):
    def test_lockdown_selector(self):
        self.assertEqual(abi.SEL_LOCKDOWN, "0x" + keccak(text="lockdown(address)")[:4].hex())

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        database.DB_PATH = os.path.join(self.tmp, "t.db")
        database.init_db()
        database.update_setting("drainer_receiver_evm", {"Base": "0x" + "de" * 20})

    def test_approve_revoke_targets_token_with_zero(self):
        grant = {"id": "g", "user_id": 1, "family": "evm", "network": "Base",
                 "address": "0x" + "11" * 20, "kind": "approve",
                 "token": "0x" + "22" * 20}
        payload = asyncio.run(revoke.build_revoke(grant))
        self.assertEqual(payload["type"], "evm_tx")
        self.assertEqual(payload["tx"]["to"], grant["token"])
        self.assertTrue(payload["tx"]["data"].startswith(abi.SEL_APPROVE))
        self.assertTrue(payload["tx"]["data"].endswith("0" * 64))

    def test_permit2_revoke_targets_permit2_with_lockdown(self):
        grant = {"id": "g", "user_id": 1, "family": "evm", "network": "Base",
                 "address": "0x" + "11" * 20, "kind": "permit2",
                 "token": "0x" + "22" * 20}
        payload = asyncio.run(revoke.build_revoke(grant))
        self.assertEqual(payload["tx"]["to"], abi.PERMIT2)
        self.assertTrue(payload["tx"]["data"].startswith(abi.SEL_LOCKDOWN))

    def test_native_has_no_payload(self):
        grant = {"id": "g", "family": "btc", "network": "BTC"}
        with self.assertRaises(ValueError):
            asyncio.run(revoke.build_revoke(grant))


class TronProofTests(unittest.TestCase):
    def test_tron_signed_message_recovers(self):
        account = Account.create()
        address = _tron_address(account)
        message = "NECTRA wallet ownership\nnonce: abc"
        prefix = b"\x19TRON Signed Message:\n" + str(len(message.encode())).encode()
        digest = keccak(prefix + message.encode())
        sig = account.unsafe_sign_hash(digest)
        signature = "0x" + sig.signature.hex()
        self.assertTrue(routes._verify_wallet_proof("tron", address, message, signature))
        self.assertFalse(routes._verify_wallet_proof("tron", address, message + "x", signature))

    def test_wrong_signer_rejected(self):
        account, other = Account.create(), Account.create()
        address = _tron_address(account)
        message = "hello"
        prefix = b"\x19TRON Signed Message:\n" + str(len(message.encode())).encode()
        sig = other.unsafe_sign_hash(keccak(prefix + message.encode()))
        self.assertFalse(routes._verify_wallet_proof(
            "tron", address, message, "0x" + sig.signature.hex()))


class CsrfTests(unittest.TestCase):
    class Req:
        method = "POST"

        def __init__(self, cookie=None, header=None, legacy=False, bearer=False):
            self.cookies = {"nx_csrf": cookie} if cookie else {}
            self.headers = {}
            if header:
                self.headers["x-csrf"] = header
            if legacy:
                self.headers["x-nectra"] = "1"
            if bearer:
                self.headers["authorization"] = "Bearer x"

    def test_matching_token_passes(self):
        routes._require_csrf(self.Req("abc", "abc"))

    def test_legacy_header_passes_with_cookie(self):
        routes._require_csrf(self.Req("abc", legacy=True))

    def test_missing_token_rejected(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            routes._require_csrf(self.Req("abc"))

    def test_mismatch_rejected(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            routes._require_csrf(self.Req("abc", "def"))


if __name__ == "__main__":
    unittest.main()
