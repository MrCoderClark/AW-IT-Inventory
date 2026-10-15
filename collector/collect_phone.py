"""VoIP desk-phone collection (spec 27, phase 1).

Identify a Yealink desk phone from its device TLS certificate — the **issuer**
(`O=Yealink Network Technology…`) classifies it, the **CN is the phone's MAC** —
plus its HTTPS login-page `<title>` (the model). All with **no credentials**, so
discovery gets MAC + model + IP from a bare TLS handshake; phase-2 authenticated
enrichment (display name / extension / firmware) is handled elsewhere. Read-only.
"""

from __future__ import annotations

import re
import ssl

import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID

from models import PhoneInfo

_MAC_HEX = re.compile(r"^[0-9A-Fa-f]{12}$")


def normalize_mac(cn: str) -> str | None:
    """A Yealink cert's CN is the bare 12-hex MAC (e.g. ``805e0c034323``); return it
    colon-separated and upper (``80:5E:0C:03:43:23``), or None if not a MAC."""
    s = (cn or "").strip().replace(":", "").replace("-", "")
    if not _MAC_HEX.match(s):
        return None
    return ":".join(s[i : i + 2] for i in range(0, 12, 2)).upper()


def _attr(name, oid) -> str:
    vals = name.get_attributes_for_oid(oid)
    return str(vals[0].value) if vals else ""


def parse_cert(pem: str) -> tuple[str | None, bool]:
    """Return ``(mac, is_yealink)`` from a device cert PEM. ``is_yealink`` keys on the
    issuer carrying "Yealink" (org or CN) — the reliable classifier; the subject CN
    yields the MAC. A non-Yealink cert returns ``(…, False)`` and is ignored."""
    cert = x509.load_pem_x509_certificate(pem.encode())
    issuer_blob = (
        _attr(cert.issuer, NameOID.ORGANIZATION_NAME)
        + " "
        + _attr(cert.issuer, NameOID.COMMON_NAME)
    ).lower()
    is_yealink = "yealink" in issuer_blob
    mac = normalize_mac(_attr(cert.subject, NameOID.COMMON_NAME))
    return mac, is_yealink


def model_from_title(html: str) -> str | None:
    """"<title>Yealink T54W Phone</title>" -> "Yealink T54W" (drop a trailing
    "Phone"). None when there's no usable title."""
    m = re.search(r"<title>\s*(.*?)\s*</title>", html or "", re.I | re.S)
    if not m:
        return None
    title = re.sub(r"\s+", " ", m.group(1)).strip()
    title = re.sub(r"\s*phone\s*$", "", title, flags=re.I).strip()
    return title or None


def read_phone(ip: str, timeout: float = 4.0) -> PhoneInfo | None:
    """Phase-1 identity read: the TLS cert (MAC + Yealink confirm) and the HTTPS
    title (model). Returns a ``PhoneInfo`` for a confirmed Yealink phone, else None.
    No credentials, no writes."""
    try:
        pem = ssl.get_server_certificate((ip, 443), timeout=timeout)
        mac, is_yealink = parse_cert(pem)
    except Exception:  # noqa: BLE001 — unreachable / non-TLS / unparseable → not a phone
        return None
    if not is_yealink:
        return None

    model: str | None = None
    try:
        r = httpx.get(
            f"https://{ip}/", verify=False, timeout=timeout, follow_redirects=True
        )
        model = model_from_title(r.text)
    except Exception:  # noqa: BLE001 — model is best-effort; MAC alone still identifies it
        pass

    return PhoneInfo(mac=mac, model=model)
