"""Printer-alert emails via Resend (spec 12).

aw-auth owns identity and the Resend credentials, so it resolves "the admins"
itself and sends the mail. Web detects the up/down transition (it holds the
reachability history) and calls the notify endpoint; this module resolves the
recipients and sends through Resend's HTTP API.

Kept dependency-free (stdlib ``urllib``) so no new package is needed. A send
failure is logged and raised to the caller as a boolean, never an exception that
could crash the caller — the web pipeline treats a failed alert as retryable.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"


def resolve_admin_emails() -> list[str]:
    """Active users holding the Owner or Admin role, with a non-empty email.

    Resolved live from RBAC so "the admins" stays correct as staff change, with
    no second recipient list to maintain (spec 12).
    """
    from django.contrib.auth import get_user_model

    User = get_user_model()
    emails = (
        User.objects.filter(
            is_active=True,
            roles__name__in=["Owner", "Admin"],
        )
        .exclude(email="")
        .values_list("email", flat=True)
        .distinct()
    )
    return sorted(set(emails))


def _subject_and_body(printer: dict, event: str, since: str | None) -> tuple[str, str]:
    name = printer.get("name") or "Unknown printer"
    ip = printer.get("ip") or "?"
    if event == "down":
        subject = f"[OPUS] Printer DOWN: {name} ({ip})"
        since_line = f"\nUnreachable since: {since}" if since else ""
        body = (
            f"OPUS could not reach the printer '{name}' at {ip} on two "
            f"consecutive checks, so it has been marked DOWN.{since_line}\n\n"
            "You'll get one more email when it comes back online."
        )
    else:  # recovery
        subject = f"[OPUS] Printer recovered: {name} ({ip})"
        body = (
            f"OPUS can reach the printer '{name}' at {ip} again — it has "
            "recovered and is back online."
        )
    return subject, body


def send_printer_alert(printer: dict, event: str, since: str | None) -> bool:
    """Email every admin about one printer transition. Returns True on success.

    No recipients, or no Resend API key configured: logs and returns False (the
    caller treats it as a non-fatal, retryable miss).
    """
    api_key = os.environ.get("RESEND_API_KEY", "")
    email_from = os.environ.get("EMAIL_FROM", "")
    if not api_key or not email_from:
        logger.warning(
            "printer-alert not sent: RESEND_API_KEY / EMAIL_FROM not configured."
        )
        return False

    recipients = resolve_admin_emails()
    if not recipients:
        logger.warning("printer-alert not sent: no active Owner/Admin with an email.")
        return False

    subject, body = _subject_and_body(printer, event, since)
    payload = json.dumps(
        {"from": email_from, "to": recipients, "subject": subject, "text": body}
    ).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Cloudflare (in front of api.resend.com) blocks urllib's default
            # "Python-urllib/x.y" agent with a 403 "error code: 1010", so set an
            # explicit User-Agent. Without this the request never reaches Resend.
            "User-Agent": "opus-aw-auth/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if 200 <= resp.status < 300:
                logger.info(
                    "printer-alert (%s) sent for %s to %d admin(s).",
                    event,
                    printer.get("ip"),
                    len(recipients),
                )
                return True
            logger.error("printer-alert Resend returned HTTP %s", resp.status)
            return False
    except urllib.error.HTTPError as e:
        logger.error("printer-alert Resend HTTP %s: %s", e.code, e.read()[:200])
        return False
    except Exception:  # noqa: BLE001 — a send failure must never crash the pipeline
        logger.exception("printer-alert Resend request failed")
        return False
