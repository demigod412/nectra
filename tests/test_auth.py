"""
End-to-end auth tests: registration, email verification, login, password reset,
admin 2FA and the staff-2FA gate.

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "py_server"))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp()
os.environ.update({
    "DB_PATH": os.path.join(TMP, "auth.db"),
    "DEMO_MODE": "1",
    "MASTER_KEY": "ab" * 32,
    "ADMIN_EMAIL": "admin@nectra.local",
    "ADMIN_PASSWORD": "Adm1n!Test2026",
    "PRICE_FEED": "sim",
    "HOST": "127.0.0.1",
})

import pyotp
from fastapi.testclient import TestClient

import database
import app as app_module

PASSWORD = "Str0ngPass1!"


class AuthFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        database.init_db()
        cls.ctx = TestClient(app_module.app)
        cls.client = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def csrf(self):
        self.client.get("/api/public/config")
        return self.client.cookies.get("nx_csrf")

    def post(self, path, body=None):
        return self.client.post(path, json=body or {}, headers={"X-CSRF": self.csrf()})

    def patch(self, path, body=None):
        return self.client.patch(path, json=body or {}, headers={"X-CSRF": self.csrf()})

    # ---- registration + verification -------------------------------------
    def test_register_requires_verified_email(self):
        database.update_setting("invite_only", False)
        database.update_setting("registration_open", True)
        r = self.post("/api/auth/register", {
            "email": "a@example.com", "password": PASSWORD,
            "code": "", "acceptTerms": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["needsVerification"])
        code = r.json().get("devCode")
        self.assertTrue(code)

        self.assertEqual(self.client.get("/api/dashboard").status_code, 403)
        bad = self.post("/api/auth/verify-email", {"code": "000000"})
        self.assertEqual(bad.status_code, 400)
        ok = self.post("/api/auth/verify-email", {"code": code})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 200)

    def test_honeypot_and_terms(self):
        database.update_setting("registration_open", True)
        r = self.post("/api/auth/register", {
            "email": "hp@example.com", "password": PASSWORD,
            "acceptTerms": True, "hp_check": "bot"})
        self.assertEqual(r.status_code, 400)
        r = self.post("/api/auth/register", {
            "email": "terms@example.com", "password": PASSWORD, "acceptTerms": False})
        self.assertEqual(r.status_code, 400)

    # ---- password reset --------------------------------------------------
    def test_password_reset(self):
        self.post("/api/auth/register", {
            "email": "reset@example.com", "password": PASSWORD, "acceptTerms": True})
        code = self.post("/api/auth/forgot", {"email": "reset@example.com"}).json()["devCode"]
        r = self.post("/api/auth/reset", {
            "email": "reset@example.com", "code": code, "password": "NewPassw0rd!!"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.post("/api/auth/login", {
            "email": "reset@example.com", "password": PASSWORD}).status_code, 401)
        self.assertEqual(self.post("/api/auth/login", {
            "email": "reset@example.com", "password": "NewPassw0rd!!"}).status_code, 200)

    # ---- admin login + 2FA ----------------------------------------------
    def test_admin_login_and_2fa(self):
        r = self.post("/api/auth/login", {
            "email": "admin@nectra.local", "password": "Adm1n!Test2026"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["twofaRequired"])

        setup = self.post("/api/auth/2fa/setup").json()
        self.assertIn("otpauth", setup)
        code = pyotp.TOTP(setup["secret"]).now()
        self.assertEqual(self.post("/api/auth/2fa/enable", {"code": code}).status_code, 200)

        login = self.post("/api/auth/login", {
            "email": "admin@nectra.local", "password": "Adm1n!Test2026"})
        self.assertTrue(login.json()["twofaRequired"])
        self.assertEqual(self.client.get("/api/admin/overview").status_code, 403)

        code = pyotp.TOTP(setup["secret"]).now()
        verified = self.post("/api/auth/2fa/verify", {"code": code})
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertEqual(self.client.get("/api/admin/overview").status_code, 200)

        # Staff gate: with the requirement on and 2FA off, admin routes close.
        database.update_setting("admin_2fa_required", True)
        latest = pyotp.TOTP(setup["secret"]).now()
        self.assertEqual(self.post("/api/auth/2fa/disable", {"code": latest}).status_code, 200)
        r = self.client.get("/api/admin/overview")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json().get("code"), "ADMIN_2FA_REQUIRED")
        database.update_setting("admin_2fa_required", False)

    # ---- invites ---------------------------------------------------------
    def test_invite_only(self):
        database.update_setting("invite_only", True)
        self.assertEqual(self.post("/api/auth/invite/validate",
                                   {"code": "NOPE1234"}).status_code, 400)
        database.q_run("INSERT INTO invites (code, max_uses, uses, active, created_at)"
                       " VALUES ('GOOD1234', 1, 0, 1, ?)", database.now())
        self.assertEqual(self.post("/api/auth/invite/validate",
                                   {"code": "GOOD1234"}).status_code, 200)
        r = self.post("/api/auth/register", {
            "email": "invited@example.com", "password": PASSWORD,
            "code": "GOOD1234", "acceptTerms": True})
        self.assertEqual(r.status_code, 200, r.text)
        # single-use code is now exhausted
        self.assertEqual(self.post("/api/auth/invite/validate",
                                   {"code": "GOOD1234"}).status_code, 400)
        database.update_setting("invite_only", False)


    # ---- duplicate registration & password hashing ----------------------
    def test_duplicate_registration_rejected(self):
        database.update_setting("registration_open", True)
        database.update_setting("invite_only", False)
        email = "dup_test@example.com"
        r1 = self.post("/api/auth/register", {
            "email": email, "password": PASSWORD, "acceptTerms": True})
        self.assertEqual(r1.status_code, 200)

        # Duplicate attempt must be rejected
        r2 = self.post("/api/auth/register", {
            "email": email, "password": PASSWORD, "acceptTerms": True})
        self.assertEqual(r2.status_code, 409)
        self.assertIn("already registered", r2.text.lower())

    def test_password_hashing_security(self):
        email = "hash_test@example.com"
        self.post("/api/auth/register", {
            "email": email, "password": PASSWORD, "acceptTerms": True})
        user = database.q_get("SELECT pw_hash, password_hash FROM users WHERE email = ?", email)
        self.assertIsNotNone(user)
        pw_hash = user.get("pw_hash") or user.get("password_hash")
        self.assertTrue(pw_hash.startswith("scrypt$"), "Password must be scrypt-hashed")
        self.assertNotIn(PASSWORD, str(user.values()), "Plaintext password must never be stored")

    def _create_user(self, email, password=PASSWORD, role="trader", status="active", verified=True):
        import security as S
        h = S.hash_password(password)
        database.q_run("INSERT INTO users (email, pw_hash, password_hash, name, role, status,"
                       " email_verified, paper_mode, created_at)"
                       " VALUES (?, ?, ?, 'Test User', ?, ?, ?, 1, ?)",
                       email, h, h, role, status, 1 if verified else 0, database.now())

    # ---- login credentials & session management --------------------------
    def test_login_invalid_credentials(self):
        email = "cred_test@example.com"
        self._create_user(email, PASSWORD)

        # Wrong password
        bad_pw = self.post("/api/auth/login", {
            "email": email, "password": "WrongPassword99!"})
        self.assertEqual(bad_pw.status_code, 401)
        self.assertIn("invalid email or password", bad_pw.text.lower())

        # Non-existent email
        bad_email = self.post("/api/auth/login", {
            "email": "nonexistent_999@example.com", "password": PASSWORD})
        self.assertEqual(bad_email.status_code, 401)
        self.assertIn("invalid email or password", bad_email.text.lower())

    def test_logout_and_session_persistence(self):
        email = "session_test@example.com"
        self._create_user(email, PASSWORD)

        # Log in
        login = self.post("/api/auth/login", {
            "email": email, "password": PASSWORD})
        self.assertEqual(login.status_code, 200)

        # Session persistence across requests
        me1 = self.client.get("/api/auth/me")
        self.assertEqual(me1.status_code, 200)
        self.assertEqual(me1.json()["user"]["email"], email)

        me2 = self.client.get("/api/auth/me")
        self.assertEqual(me2.status_code, 200)

        # Logout
        logout = self.post("/api/auth/logout")
        self.assertEqual(logout.status_code, 200)

        # After logout, protected routes must refuse access
        me_after = self.client.get("/api/auth/me")
        self.assertEqual(me_after.status_code, 401)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)

    # ---- authorization: non-admin vs administrator -----------------------
    def test_non_admin_cannot_access_admin_portal(self):
        email = "regular_trader@example.com"
        self._create_user(email, PASSWORD)

        # Regular user logged in
        self.post("/api/auth/login", {"email": email, "password": PASSWORD})

        # Regular user must be blocked from all admin endpoints
        for endpoint in ["/api/admin/overview", "/api/admin/settings", "/api/admin/users", "/api/admin/invites"]:
            res = self.client.get(endpoint)
            self.assertEqual(res.status_code, 403, f"{endpoint} should return 403 for regular user")
            self.assertIn("missing permission", res.text.lower())

    # ---- admin management settings & roles --------------------------------
    def test_admin_settings_view_update_permissions(self):
        # Super admin can view and update settings
        self.post("/api/auth/login", {
            "email": "admin@nectra.local", "password": "Adm1n!Test2026"})
        
        settings_res = self.client.get("/api/admin/settings")
        self.assertEqual(settings_res.status_code, 200)
        self.assertIn("settings", settings_res.json())

        # Update platform setting
        patch_res = self.patch("/api/admin/settings", {"platform_name": "NECTRA Verified"})
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.json()["applied"].get("platform_name"), "NECTRA Verified")

        # Verify setting persisted
        settings_after = self.client.get("/api/admin/settings")
        self.assertEqual(settings_after.json()["settings"]["platform_name"], "NECTRA Verified")

        # Revert platform_name
        self.patch("/api/admin/settings", {"platform_name": "NECTRA"})

        # Restricted management action: non-super-admin staff cannot patch settings
        self._create_user("officer_test@nectra.local", PASSWORD, role="loan_officer")
        self.post("/api/auth/login", {"email": "officer_test@nectra.local", "password": PASSWORD})
        forbidden_patch = self.patch("/api/admin/settings", {"platform_name": "HACKED"})
        self.assertEqual(forbidden_patch.status_code, 403)


if __name__ == "__main__":
    unittest.main()
