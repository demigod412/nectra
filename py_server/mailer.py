"""
Outgoing email for Nectra.

Every message is recorded in `mailbox` (Admin → Mailbox) so verification and
reset codes are recoverable even without SMTP. When SMTP is configured through
settings or the environment the message is also delivered for real.

Delivery is best-effort: a broken SMTP server must never fail the request that
triggered the mail. Callers get back the status string ('sent', 'logged',
'failed') for logging only.
"""
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional

from database import get_setting, now, q_run

logger = logging.getLogger("mailer")

SMTP_TIMEOUT = 15


def _cfg(key: str, env: str, default: str = "") -> str:
    """Settings win over environment so the admin console can fix mail at runtime."""
    value = get_setting(key, None)
    if value not in (None, ""):
        return str(value)
    return os.environ.get(env, default) or default


def _sender() -> str:
    platform = get_setting("platform_name", "NECTRA") or "NECTRA"
    return _cfg("smtp_from", "MAIL_FROM", f"{platform} <no-reply@localhost>")


def send_mail(to_email: str, subject: str, body: str) -> str:
    """Record and (if configured) deliver a plain-text email."""
    to_email = (to_email or "").strip()
    subject = (subject or "").strip() or "(no subject)"
    body = body or ""

    status, error = "logged", None
    host = _cfg("smtp_host", "SMTP_HOST")
    if host:
        port = int(_cfg("smtp_port", "SMTP_PORT", "587") or 587)
        user = _cfg("smtp_user", "SMTP_USER")
        password = _cfg("smtp_pass", "SMTP_PASS")
        implicit_ssl = str(_cfg("smtp_secure", "SMTP_SECURE", "0")).lower() in (
            "1", "true", "yes", "on") or port == 465
        message = EmailMessage()
        message["From"] = _sender()
        message["To"] = to_email
        message["Subject"] = subject
        message.set_content(body)
        try:
            if implicit_ssl:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT,
                                      context=context) as smtp:
                    if user:
                        smtp.login(user, password)
                    smtp.send_message(message)
            else:
                with smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT) as smtp:
                    smtp.ehlo()
                    try:
                        smtp.starttls(context=ssl.create_default_context())
                        smtp.ehlo()
                    except smtplib.SMTPException:
                        pass          # plain relay on port 25
                    if user:
                        smtp.login(user, password)
                    smtp.send_message(message)
            status = "sent"
        except Exception as exc:                              # noqa: BLE001
            status, error = "failed", str(exc)[:400]
            logger.warning("SMTP delivery to %s failed: %s", to_email, exc)
    else:
        logger.info("MAIL (no SMTP configured) → %s: %s", to_email, subject)

    try:
        q_run("INSERT INTO mailbox (to_email, subject, body, status, error, created_at)"
              " VALUES (?, ?, ?, ?, ?, ?)",
              to_email, subject, body, status, error, now())
    except Exception:                                        # noqa: BLE001
        pass
    if status != "sent":
        logger.info("----- mail to %s -----\n%s\n----------------------", to_email, body)
    return status


def send_code(to_email: str, subject: str, code: str, ttl_minutes: int,
              intro: str, anti_phishing: Optional[str] = None) -> str:
    """Standard code email with the user's anti-phishing string."""
    tag = f"\n\nYour anti-phishing code: {anti_phishing}\n" if anti_phishing else "\n"
    body = (
        f"{intro}\n{tag}"
        f"Your code is: {code}\n\n"
        f"It expires in {ttl_minutes} minutes and can be used once.\n"
        f"If you did not request this, you can ignore the email.\n"
    )
    return send_mail(to_email, subject, body)
