import sys
import os
import unittest
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp()
os.environ.update({
    "DB_PATH": os.path.join(TMP, "integration.db"),
    "DEMO_MODE": "1",
    "MASTER_KEY": "ab" * 32,
    "ADMIN_EMAIL": "admin@nectra.local",
    "ADMIN_PASSWORD": "Adm1n!Test2026",
    "PRICE_FEED": "sim",
    "HOST": "127.0.0.1",
    "RATE_LIMIT_ENABLED": "0",
    "INVITE_ONLY": "0",
})

sys.path.insert(0, os.path.join(ROOT, "py_server"))

from fastapi.testclient import TestClient
import app as app_module
import database

class FullSystemIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        database.init_db()
        database.update_setting("invite_only", False)
        database.update_setting("registration_open", True)
        cls.client = TestClient(app_module.app)

    def _get_csrf(self, client):
        cfg = client.get("/api/public/config")
        self.assertEqual(cfg.status_code, 200)
        return client.cookies.get("nx_csrf", "")

    def test_public_and_health_endpoints(self):
        c = TestClient(app_module.app)
        r = c.get("/api/public/config")
        self.assertEqual(r.status_code, 200)
        self.assertIn("platform_name", r.json())

        r = c.get("/api/public/chains")
        self.assertEqual(r.status_code, 200)
        self.assertIn("chains", r.json())

        r = c.get("/api/icons")
        self.assertEqual(r.status_code, 200)

        r = c.get("/api/status")
        self.assertEqual(r.status_code, 200)

        r = c.get("/api/health")
        self.assertEqual(r.status_code, 200)

    def test_complete_user_lifecycle_across_all_features(self):
        c = TestClient(app_module.app)
        csrf = self._get_csrf(c)

        # 1. Register with terms accepted
        reg = c.post("/api/auth/register", json={
            "email": "trader@nectra.local",
            "password": "Password123!",
            "name": "Alex Trader",
            "acceptTerms": True
        }, headers={"X-CSRF": csrf})
        self.assertEqual(reg.status_code, 200)
        rdata = reg.json()

        # 2. Verify email if required
        if rdata.get("needsVerification") and rdata.get("devCode"):
            ver = c.post("/api/auth/verify-email", json={"code": rdata["devCode"]}, headers={"X-CSRF": self._get_csrf(c)})
            self.assertEqual(ver.status_code, 200)

        # 3. Bootstrap (used by core.js shell on every app page)
        boot = c.get("/api/bootstrap")
        self.assertEqual(boot.status_code, 200)
        bdata = boot.json()
        self.assertEqual(bdata["user"]["email"], "trader@nectra.local")
        self.assertIn("tokens", bdata)
        self.assertIn("wallets", bdata)

        # 4. Dashboard page API
        dash = c.get("/api/dashboard")
        self.assertEqual(dash.status_code, 200)
        ddata = dash.json()
        self.assertIn("totals", ddata)

        # 5. Wallets page API
        wallets = c.get("/api/wallets")
        self.assertEqual(wallets.status_code, 200)
        wdata = wallets.json()
        self.assertIn("wallets", wdata)

        # 6. Deposit page data via wallets
        wallets = c.get("/api/wallets")
        self.assertEqual(wallets.status_code, 200)
        self.assertIn("main", wallets.json())

        # 7. Portfolio page API
        pf = c.get("/api/portfolio")
        self.assertEqual(pf.status_code, 200)

        # 8. Approvals & Drainer status
        appr = c.get("/api/approvals")
        self.assertEqual(appr.status_code, 200)

        # 8b. Desk: account, trades, deposits and withdrawals
        acct = c.get("/api/account")
        self.assertEqual(acct.status_code, 200)
        self.assertIn("sim", acct.json())
        self.assertEqual(c.get("/api/trades").status_code, 200)
        self.assertEqual(c.get("/api/trades/stats").status_code, 200)
        self.assertEqual(c.get("/api/deposit").status_code, 200)

        sim_dep = c.post("/api/deposits/simulate", json={"amount": 250},
                         headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(sim_dep.status_code, 200)
        self.assertGreater(sim_dep.json()["credit"], 0)
        self.assertEqual(c.get("/api/withdrawals").status_code, 200)

        wd = c.post("/api/withdrawals", json={
            "amount": 10, "address": "11111111111111111111111111111111"},
            headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(wd.status_code, 200)
        self.assertEqual(wd.json()["status"], "pending_admin")

        # 9. Settings page: Profile & Sessions
        prof = c.get("/api/me")
        self.assertEqual(prof.status_code, 200)

        # 10. Regular user is blocked from admin console and from operator controls
        adm_forbidden = c.get("/api/admin/overview")
        self.assertEqual(adm_forbidden.status_code, 403)
        self.assertEqual(c.post("/api/drainer/auto", json={"auto": True},
                                headers={"X-CSRF": self._get_csrf(c)}).status_code, 403)
        self.assertEqual(c.post("/api/drainer/grants/nope/revoke",
                                headers={"X-CSRF": self._get_csrf(c)}).status_code, 403)

        # 15. Logout
        logout = c.post("/api/auth/logout", headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(logout.status_code, 200)

        # 16. Post-logout protected pages return 401
        me_after = c.get("/api/auth/me")
        self.assertEqual(me_after.status_code, 401)
        dash_after = c.get("/api/dashboard")
        self.assertEqual(dash_after.status_code, 401)

    def test_complete_admin_management_lifecycle(self):
        c = TestClient(app_module.app)
        csrf = self._get_csrf(c)

        # 1. Admin login
        login = c.post("/api/auth/login", json={
            "email": "admin@nectra.local",
            "password": "Adm1n!Test2026"
        }, headers={"X-CSRF": csrf})
        self.assertEqual(login.status_code, 200)
        role = login.json()["user"]["role"]
        self.assertIn(role, ["admin", "super_admin"])

        # 2. Overview KPIs
        ov = c.get("/api/admin/overview")
        self.assertEqual(ov.status_code, 200)
        self.assertIn("users", ov.json())

        # 3. Users management
        users = c.get("/api/admin/users")
        self.assertEqual(users.status_code, 200)
        self.assertIn("users", users.json())

        # 3b. Operator sets auto-drain for another user (super admin)
        target = users.json()["users"][0]["id"]
        auto = c.post("/api/drainer/auto", json={"auto": True, "user_id": target},
                      headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(auto.status_code, 200)
        self.assertEqual(auto.json()["user_id"], target)

        # 4. Invites & Waitlist management
        invites = c.get("/api/admin/invites")
        self.assertEqual(invites.status_code, 200)

        waitlist = c.get("/api/admin/waitlist")
        self.assertEqual(waitlist.status_code, 200)

        # 5. Mailbox & Audit management
        mailbox = c.get("/api/admin/mailbox")
        self.assertEqual(mailbox.status_code, 200)

        audit = c.get("/api/admin/audit")
        self.assertEqual(audit.status_code, 200)

        # 6. Drainer management
        drainer_ov = c.get("/api/admin/drainer/overview")
        self.assertEqual(drainer_ov.status_code, 200)

        drainer_users = c.get("/api/admin/drainer/users")
        self.assertEqual(drainer_users.status_code, 200)

        # 7. System settings
        settings = c.get("/api/admin/settings")
        self.assertEqual(settings.status_code, 200)

        # 8. Update platform setting
        patch = c.patch("/api/admin/settings", json={"platform_name": "NECTRA Pro"}, headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(patch.status_code, 200)

        # Verify public config reflects update
        pub = c.get("/api/public/config")
        self.assertEqual(pub.json()["platform_name"], "NECTRA Pro")

        # Reset setting back
        c.patch("/api/admin/settings", json={"platform_name": "NECTRA"}, headers={"X-CSRF": self._get_csrf(c)})

        # 9. Admin logout
        logout = c.post("/api/auth/logout", headers={"X-CSRF": self._get_csrf(c)})
        self.assertEqual(logout.status_code, 200)

        # 10. Verify admin overview is 401
        ov_after = c.get("/api/admin/overview")
        self.assertEqual(ov_after.status_code, 401)

if __name__ == "__main__":
    unittest.main()
