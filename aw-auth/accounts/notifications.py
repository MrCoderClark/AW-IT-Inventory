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

import datetime
import html as html_lib
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


def _deliver(subject: str, body: str, *, label: str, html: str | None = None) -> bool:
    """Send one email to every admin through Resend. Returns True on a real send.

    No recipients, or no Resend API key configured: logs and returns False (the
    caller treats it as a non-fatal, retryable miss). Shared by the printer down/
    recovery alert (spec 12) and the daily counter report (spec 14). ``body`` is the
    plain-text part; ``html`` is an optional HTML part (clients that render it show
    that, others fall back to the text).
    """
    api_key = os.environ.get("RESEND_API_KEY", "")
    email_from = os.environ.get("EMAIL_FROM", "")
    if not api_key or not email_from:
        logger.warning("%s not sent: RESEND_API_KEY / EMAIL_FROM not configured.", label)
        return False

    recipients = resolve_admin_emails()
    if not recipients:
        logger.warning("%s not sent: no active Owner/Admin with an email.", label)
        return False

    message: dict = {
        "from": email_from,
        "to": recipients,
        "subject": subject,
        "text": body,
    }
    if html:
        message["html"] = html
    payload = json.dumps(message).encode("utf-8")
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
                logger.info("%s sent to %d admin(s).", label, len(recipients))
                return True
            logger.error("%s Resend returned HTTP %s", label, resp.status)
            return False
    except urllib.error.HTTPError as e:
        logger.error("%s Resend HTTP %s: %s", label, e.code, e.read()[:200])
        return False
    except Exception:  # noqa: BLE001 — a send failure must never crash the pipeline
        logger.exception("%s Resend request failed", label)
        return False


def send_printer_alert(printer: dict, event: str, since: str | None) -> bool:
    """Email every admin about one printer transition. Returns True on success.

    No recipients, or no Resend API key configured: logs and returns False (the
    caller treats it as a non-fatal, retryable miss).
    """
    subject, body = _subject_and_body(printer, event, since)
    return _deliver(subject, body, label=f"printer-alert ({event})")


def _fmt_total(total) -> str:
    return f"{total:,}" if isinstance(total, (int, float)) else "—"


def _fmt_change(p: dict) -> str:
    """The day's change for one printer: its note, or the delta, or a dash."""
    note = p.get("note")
    delta = p.get("delta")
    if note:
        return str(note)
    if isinstance(delta, (int, float)):
        return f"+{delta:,}"
    return "—"


def _fmt_counter_line(p: dict) -> str:
    """One printer's line in the plain-text fallback body."""
    name = p.get("name") or "Unknown printer"
    serial = p.get("serial") or "—"
    location = p.get("location") or "—"
    ip = p.get("ip") or "?"
    return (
        f"  • {name} — {location} — S/N {serial} — {ip}: "
        f"{_fmt_total(p.get('total'))} pages · {_fmt_change(p)}"
    )


def _counter_report_html(rows: list[dict], report_date: str) -> str:
    """A clean, email-safe HTML table of the printer page counts (inline styles so
    it renders consistently across mail clients)."""
    e = html_lib.escape
    th = (
        'style="text-align:left;padding:10px 12px;font-size:12px;'
        'text-transform:uppercase;letter-spacing:.04em;color:#e5e7eb;'
        'background:#1f2937;border-bottom:1px solid #111827;"'
    )
    th_r = th.replace("text-align:left", "text-align:right")

    body_rows = []
    for i, p in enumerate(rows):
        bg = "#ffffff" if i % 2 == 0 else "#f9fafb"
        td = (
            f'style="padding:10px 12px;font-size:14px;color:#111827;'
            f'border-bottom:1px solid #e5e7eb;background:{bg};"'
        )
        td_r = td.replace("padding:10px 12px;", "padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;")
        td_m = td.replace("color:#111827;", "color:#6b7280;")  # muted (change/note)
        body_rows.append(
            "<tr>"
            f"<td {td}>{e(str(p.get('name') or 'Unknown printer'))}</td>"
            f"<td {td}>{e(str(p.get('serial') or '—'))}</td>"
            f"<td {td}>{e(str(p.get('location') or '—'))}</td>"
            f"<td {td}>{e(str(p.get('ip') or '—'))}</td>"
            f"<td {td_r}>{e(_fmt_total(p.get('total')))}</td>"
            f"<td {td_m.replace('padding:10px 12px;', 'padding:10px 12px;text-align:right;')}>{e(_fmt_change(p))}</td>"
            "</tr>"
        )
    rows_html = "".join(body_rows) or (
        '<tr><td colspan="6" style="padding:16px;font-size:14px;color:#6b7280;">'
        "No managed printers to report on yet.</td></tr>"
    )

    return (
        '<div style="margin:0;padding:24px;background:#f3f4f6;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        'style="max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;'
        'overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
        'box-shadow:0 1px 3px rgba(0,0,0,.08);width:100%;">'
        # Header
        '<tr><td style="padding:24px 24px 8px;">'
        '<div style="font-size:18px;font-weight:700;color:#111827;">OPUS · Printer Page-Counter Report</div>'
        f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{e(report_date)}</div>'
        "</td></tr>"
        # Table
        '<tr><td style="padding:16px 24px 8px;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        'style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">'
        "<thead><tr>"
        f"<th {th}>Printer</th><th {th}>Serial</th><th {th}>Location</th>"
        f"<th {th}>IP</th><th {th_r}>Total pages</th><th {th_r}>Today</th>"
        "</tr></thead>"
        f"<tbody>{rows_html}</tbody>"
        "</table></td></tr>"
        # Footer
        '<tr><td style="padding:8px 24px 24px;font-size:12px;color:#9ca3af;line-height:1.5;">'
        "Totals are read over SNMP on the daily collect. “Today” is that day’s pages "
        "(day over day); “first reading” means no prior day yet, “counter reset” a lower "
        "value than before, and “no reading” a printer not reached that day."
        "</td></tr>"
        "</table></div>"
    )


def send_counter_report(printers: list[dict]) -> bool:
    """Email every admin the daily printer page-counter report (spec 14, AC-4).

    Web assembles the per-printer rows (name, serial, location, ip, total, delta,
    'no reading' for a printer missed that day) and posts them here; this renders a
    professional HTML table (with a plain-text fallback) and sends. No recipients /
    no Resend key configured: logs and returns False.
    """
    rows = [p for p in (printers or []) if isinstance(p, dict)]
    count = len(rows)
    report_date = datetime.date.today().strftime("%A, %B %d, %Y")
    subject = (
        f"[OPUS] Printer page-counter report — {count} "
        f"printer{'s' if count != 1 else ''} ({datetime.date.today():%b %d})"
    )

    if rows:
        text = (
            f"OPUS Printer Page-Counter Report — {report_date}\n\n"
            + "\n".join(_fmt_counter_line(p) for p in rows)
            + "\n\nTotals are read over SNMP on the daily collect; the change is "
            "that day's pages, day over day."
        )
    else:
        text = f"OPUS Printer Page-Counter Report — {report_date}\n\nNo managed printers to report on yet."

    html = _counter_report_html(rows, report_date)
    return _deliver(subject, text, label="printer-counter-report", html=html)
