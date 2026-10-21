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
        subject = f"[H2Tecs] Printer DOWN: {name} ({ip})"
        since_line = f"\nUnreachable since: {since}" if since else ""
        body = (
            f"H2Tecs could not reach the printer '{name}' at {ip} on two "
            f"consecutive checks, so it has been marked DOWN.{since_line}\n\n"
            "You'll get one more email when it comes back online."
        )
    else:  # recovery
        subject = f"[H2Tecs] Printer recovered: {name} ({ip})"
        body = (
            f"H2Tecs can reach the printer '{name}' at {ip} again — it has "
            "recovered and is back online."
        )
    return subject, body


def _deliver(
    subject: str,
    body: str,
    *,
    label: str,
    html: str | None = None,
    recipients: list[str] | None = None,
    attachments: list[dict] | None = None,
) -> bool:
    """Send one email through Resend. Returns True on a real send.

    No recipients, or no Resend API key configured: logs and returns False (the
    caller treats it as a non-fatal, retryable miss). Shared by the printer down/
    recovery alert (spec 12), the daily counter report (spec 14) and scheduled
    report delivery (spec 26 phase 2). ``recipients`` defaults to the admins
    (resolved from RBAC) when not given; a report delivery passes an explicit
    list. ``body`` is the plain-text part; ``html`` is an optional HTML part;
    ``attachments`` is an optional list of Resend ``{filename, content}`` (content
    base64) parts.
    """
    api_key = os.environ.get("RESEND_API_KEY", "")
    email_from = os.environ.get("EMAIL_FROM", "")
    if not api_key or not email_from:
        logger.warning("%s not sent: RESEND_API_KEY / EMAIL_FROM not configured.", label)
        return False

    to = resolve_admin_emails() if recipients is None else recipients
    if not to:
        logger.warning("%s not sent: no recipients.", label)
        return False

    message: dict = {
        "from": email_from,
        "to": to,
        "subject": subject,
        "text": body,
    }
    if html:
        message["html"] = html
    if attachments:
        message["attachments"] = attachments
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
            "User-Agent": "h2tecs-aw-auth/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if 200 <= resp.status < 300:
                logger.info("%s sent to %d recipient(s).", label, len(to))
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


def send_compliance_alert(computer: dict, event: str, checks: list[dict]) -> bool:
    """Email every admin when a computer's security posture crosses a boundary
    (spec 21 v2). ``event`` is "at-risk" (one or more hard security checks failing)
    or "recovered" (back to clean). ``checks`` is the list of failed checks, each
    ``{label, detail}``, used in the at-risk body. Returns True on a real send.

    Called by web (which detects the transition at ingest) with its ``h2tecs-web``
    service account. Best-effort for the caller: a miss is logged and returned as
    False, never raised.
    """
    name = computer.get("name") or "Unknown computer"
    failed = [c for c in (checks or []) if isinstance(c, dict)]
    if event == "at-risk":
        subject = f"[H2Tecs] Compliance at risk: {name}"
        lines = "\n".join(
            f"  • {c.get('label') or 'Check'}: {c.get('detail') or 'failed'}"
            for c in failed
        ) or "  • One or more security checks failed."
        body = (
            f"H2Tecs flagged '{name}' as at risk — a hard security check failed on "
            f"its latest scan:\n\n{lines}\n\n"
            "Review the device's Compliance tab in H2Tecs. You'll get one more email "
            "when it returns to compliance."
        )
    else:  # recovered
        subject = f"[H2Tecs] Compliance recovered: {name}"
        body = (
            f"H2Tecs reports '{name}' is back in compliance — all hard security "
            "checks (BitLocker, antivirus, Secure Boot, TPM) now pass."
        )
    return _deliver(subject, body, label=f"compliance-alert ({event})")


def send_alert_rule(
    computer: dict, event: str, rule: dict, value: str
) -> bool:
    """Email every admin when a metric-threshold rule fires or recovers
    (spec 30, AC-6). ``event`` is "firing" or "recovered". ``rule`` carries
    ``name``, ``condition`` (readable, e.g. "Disk ≥ 90% for 1 sample (~15 min)"),
    and ``severity``. ``value`` is the current reading already formatted
    ("91%"). Returns True on a real send.

    Called by web after a successful in-app notification. Best-effort for the
    caller: a miss is logged and returned as False, never raised, and never
    rolls back the in-app episode.
    """
    name = computer.get("name") or "Unknown computer"
    rule_name = rule.get("name") or "Alert rule"
    condition = rule.get("condition") or ""
    reading = value or "n/a"
    if event == "firing":
        subject = f"[H2Tecs] {rule_name}: {name}"
        extra = f"{condition}\n" if condition else ""
        body = (
            f"H2Tecs flagged '{name}' — {rule_name}.\n\n"
            f"{extra}Current reading: {reading}\n\n"
            "Open the computer in H2Tecs to see Monitoring. You'll get one more "
            "email when it recovers."
        )
    else:  # recovered
        subject = f"[H2Tecs] {rule_name} recovered: {name}"
        body = (
            f"H2Tecs reports '{name}' has recovered from {rule_name}.\n\n"
            f"Latest reading: {reading}."
        )
    return _deliver(subject, body, label=f"alert-rule ({event})")


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
        '<div style="font-size:18px;font-weight:700;color:#111827;">H2Tecs · Printer Page-Counter Report</div>'
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


def _report_html(
    report_name: str,
    description: str,
    columns: list[dict],
    rows: list[list],
    shown: int,
    total: int,
) -> str:
    """An email-safe HTML table for a scheduled report (inline styles, like the
    counter report). ``columns`` is ``[{label, align}]``; ``rows`` are
    display-ready strings. Caps are the caller's; a footer notes any truncation."""
    e = html_lib.escape

    def th(align: str) -> str:
        ta = "right" if align == "right" else "left"
        return (
            f'style="text-align:{ta};padding:10px 12px;font-size:12px;'
            "text-transform:uppercase;letter-spacing:.04em;color:#e5e7eb;"
            'background:#1f2937;border-bottom:1px solid #111827;white-space:nowrap;"'
        )

    head = "".join(
        f"<th {th(c.get('align') or 'left')}>{e(str(c.get('label') or ''))}</th>"
        for c in columns
    )

    body_rows = []
    for i, row in enumerate(rows):
        bg = "#ffffff" if i % 2 == 0 else "#f9fafb"
        cells = []
        for j, cell in enumerate(row):
            align = (columns[j].get("align") if j < len(columns) else "left") or "left"
            ta = "text-align:right;font-variant-numeric:tabular-nums;" if align == "right" else ""
            td = (
                f'style="padding:9px 12px;font-size:13px;color:#111827;'
                f'border-bottom:1px solid #e5e7eb;background:{bg};{ta}"'
            )
            cells.append(f"<td {td}>{e(str(cell))}</td>")
        body_rows.append("<tr>" + "".join(cells) + "</tr>")
    rows_html = "".join(body_rows) or (
        f'<tr><td colspan="{max(1, len(columns))}" '
        'style="padding:16px;font-size:14px;color:#6b7280;">No rows matched this report.</td></tr>'
    )

    truncated = (
        f'<tr><td style="padding:8px 24px 0;font-size:12px;color:#9ca3af;">'
        f"Showing the first {shown:,} of {total:,} rows — the full report is attached."
        "</td></tr>"
        if total > shown
        else ""
    )
    desc = (
        f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{e(description)}</div>'
        if description
        else ""
    )

    return (
        '<div style="margin:0;padding:24px;background:#f3f4f6;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        'style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:12px;'
        "overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
        'box-shadow:0 1px 3px rgba(0,0,0,.08);width:100%;">'
        '<tr><td style="padding:24px 24px 8px;">'
        f'<div style="font-size:18px;font-weight:700;color:#111827;">H2Tecs · {e(report_name)}</div>'
        f"{desc}"
        "</td></tr>"
        '<tr><td style="padding:16px 24px 8px;overflow-x:auto;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        'style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">'
        f"<thead><tr>{head}</tr></thead>"
        f"<tbody>{rows_html}</tbody>"
        "</table></td></tr>"
        f"{truncated}"
        '<tr><td style="padding:16px 24px 24px;font-size:12px;color:#9ca3af;line-height:1.5;">'
        "This is a scheduled H2Tecs report, run live at send time. Manage its schedule "
        "on the report's page in H2Tecs."
        "</td></tr>"
        "</table></div>"
    )


def send_report(
    report: dict,
    table: dict,
    recipients: list[str],
    attachment: dict | None,
) -> bool:
    """Email a scheduled custom report to its recipients (spec 26 phase 2).

    Web runs the report and posts ``report{name,description}``, a capped ``table``
    ({columns:[{label,align}], rows:[[...]], shown, total}) for the HTML body, the
    explicit ``recipients`` list, and the full data as ``attachment`` ({filename,
    content(base64), contentType}). Renders an HTML table (plus a plain-text
    fallback) and sends via Resend. No recipients / no Resend key: logs, False.
    """
    name = report.get("name") or "Report"
    description = report.get("description") or ""
    columns = [c for c in (table.get("columns") or []) if isinstance(c, dict)]
    rows = [r for r in (table.get("rows") or []) if isinstance(r, list)]
    shown = int(table.get("shown") or len(rows))
    total = int(table.get("total") or len(rows))

    subject = f"[H2Tecs] Report: {name} ({total:,} row{'s' if total != 1 else ''})"

    labels = [str(c.get("label") or "") for c in columns]
    text_lines = ["\t".join(labels)] + [
        "\t".join(str(cell) for cell in row) for row in rows
    ]
    if total > shown:
        text_lines.append(f"\n… showing {shown} of {total} rows; full report attached.")
    text = f"H2Tecs report: {name}\n\n" + "\n".join(text_lines)

    html = _report_html(name, description, columns, rows, shown, total)

    attachments = None
    if isinstance(attachment, dict) and attachment.get("content"):
        attachments = [
            {
                "filename": attachment.get("filename") or "report.csv",
                "content": attachment["content"],
            }
        ]

    return _deliver(
        subject,
        text,
        label=f"report ({name})",
        html=html,
        recipients=recipients,
        attachments=attachments,
    )


def send_ticket_event(
    event: str,
    ticket: dict,
    recipients: list[str],
    detail: str,
    *,
    actor_email: str | None = None,
    ticket_url: str | None = None,
) -> bool:
    """Email explicit recipients about a ticket event (Spec 33 outbound).

    ``event`` is assigned | comment | status. Never falls back to admin list.
    """
    if not recipients:
        logger.warning("ticket-notify (%s) not sent: no recipients.", event)
        return False

    number = ticket.get("number")
    subject_line = ticket.get("subject") or "(no subject)"
    verb = {
        "assigned": "assigned",
        "comment": "new comment",
        "status": "status updated",
    }.get(event, event)

    subject = f"[H2Tecs] Ticket #{number} — {verb}"
    lines = [
        f"Ticket #{number}: {subject_line}",
        f"Status: {ticket.get('status') or '—'}",
        f"Event: {verb}",
        f"Detail: {detail}",
    ]
    if actor_email:
        lines.append(f"By: {actor_email}")
    if ticket_url:
        lines.append(f"Open: {ticket_url}")
    body = "\n".join(lines)

    esc = html_lib.escape
    html_parts = [
        f"<p><strong>Ticket #{esc(str(number))}</strong>: {esc(str(subject_line))}</p>",
        f"<p>Status: {esc(str(ticket.get('status') or '—'))}</p>",
        f"<p>Event: {esc(verb)}</p>",
        f"<p>Detail: {esc(detail)}</p>",
    ]
    if actor_email:
        html_parts.append(f"<p>By: {esc(actor_email)}</p>")
    if ticket_url:
        safe_url = esc(ticket_url)
        html_parts.append(f'<p><a href="{safe_url}">Open ticket</a></p>')
    html = "\n".join(html_parts)

    return _deliver(
        subject,
        body,
        label=f"ticket-notify ({event})",
        html=html,
        recipients=recipients,
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
        f"[H2Tecs] Printer page-counter report — {count} "
        f"printer{'s' if count != 1 else ''} ({datetime.date.today():%b %d})"
    )

    if rows:
        text = (
            f"H2Tecs Printer Page-Counter Report — {report_date}\n\n"
            + "\n".join(_fmt_counter_line(p) for p in rows)
            + "\n\nTotals are read over SNMP on the daily collect; the change is "
            "that day's pages, day over day."
        )
    else:
        text = f"H2Tecs Printer Page-Counter Report — {report_date}\n\nNo managed printers to report on yet."

    html = _counter_report_html(rows, report_date)
    return _deliver(subject, text, label="printer-counter-report", html=html)
