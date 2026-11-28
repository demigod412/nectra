#!/usr/bin/env python3
"""
Create (or reset) the fixed test accounts used by TESTING-GUIDE.txt.

Run from the repo root with the app venv:
    python scripts/create_test_users.py

Idempotent: existing accounts get their password and role reset. Never use
these passwords on a public production site without rotating them.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "py_server"))

from database import init_db, now, q_get, q_run     # noqa: E402
import security as S                                 # noqa: E402

ACCOUNTS = [
    ("admin@nectra.local",      "Adm1n!Test2026",    "Super Admin",  "super_admin"),
    ("ops@nectra.local",        "0ps!Test2026",      "Ops Approver", "admin"),
    ("officer@nectra.local",    "0ff1cer!Test2026",  "Loan Officer", "loan_officer"),
    ("compliance@nectra.local", "C0mply!Test2026",   "Compliance",   "compliance"),
    ("trader@nectra.local",     "Trader!Test2026",   "Test Trader",  "trader"),
]

if __name__ == "__main__":
    init_db()
    print()
    print("  test account                          role           password")
    print("  " + "-" * 74)
    for email, password, name, role in ACCOUNTS:
        hashed = S.hash_password(password)
        existing = q_get("SELECT id FROM users WHERE email = ?", email)
        if existing:
            q_run("UPDATE users SET pw_hash = ?, password_hash = ?, name = ?, role = ?,"
                  " status = 'active', email_verified = 1, failed_logins = 0,"
                  " locked_until = NULL WHERE id = ?",
                  hashed, hashed, name, role, existing["id"])
        else:
            q_run("INSERT INTO users (email, pw_hash, password_hash, name, role, status,"
                  " email_verified, paper_mode, created_at)"
                  " VALUES (?, ?, ?, ?, ?, 'active', 1, 1, ?)",
                  email, hashed, hashed, name, role, now())
        print(f"  {email:<36} {role:<14} {password}")
    print()
    print("  Two-admin test: sign in as admin@ in one browser and ops@ in a private")
    print("  window. The second one approves the first one's drain.")
    print()
