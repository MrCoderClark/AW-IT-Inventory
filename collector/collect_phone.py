"""VoIP desk-phone collection (spec 27).

Phase 1 identifies a Yealink desk phone from its device TLS certificate — the
**issuer** (`O=Yealink Network Technology…`) classifies it, the **CN is the
phone's MAC** — plus its HTTPS login-page `<title>` (the model). All with **no
credentials**, so discovery gets MAC + model + IP from a bare TLS handshake.

Phase 2 (handled in :mod:`collect_phone_auth`) logs into the phone's web UI
with a credential from the configured CSV and pulls extension, display name,
firmware, machine id (serial), and SIP register status. T5x (T54W) uses
``/api/*``; T4x (T46S) uses the legacy ``/servlet`` login. If no credential is
configured for the phone's IP, phase 2 is quietly skipped and phase 1 stands
on its own. All read-only, best-effort — a 100-phone sweep never fails because
one phone is unreachable.
"""

from __future__ import annotations

import logging
import re
import ssl

import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID

from models import PhoneInfo

logger = logging.getLogger(__name__)

_MAC_HEX = re.compile(r"^[0-9A-Fa-f]{12}$")
# Unauthenticated T4x login HTML (firmware 66.x) publishes these even before login.
_T4X_FIRMWARE = re.compile(r'g_strFirmware\s*=\s*"([^"]+)"')
_T4X_PHONETYPE = re.compile(r'g_phonetype\s*=\s*"([^"]+)"')
_T4X_LOGIN_FORM = "/servlet?m=mod_listener&p=login&q=loginForm"


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


def identity_from_html(html: str) -> tuple[str | None, str | None]:
    """``(model, firmware)`` from a Yealink page with no login.

    ``GET /`` on a T46S is a JS redirect stub with no ``<title>``. The login
    form HTML still has ``<title>Yealink T46S Phone</title>``, ``g_phonetype``,
    and ``g_strFirmware``.
    """
    model = model_from_title(html)
    m = _T4X_PHONETYPE.search(html or "")
    if m and m.group(1).strip() and not model:
        model = m.group(1).strip()
    fw = _T4X_FIRMWARE.search(html or "")
    firmware = fw.group(1).strip() if fw and fw.group(1).strip() else None
    return model, firmware


def _get_html(ip: str, path: str, timeout: float) -> str:
    r = httpx.get(
        f"https://{ip}{path}",
        verify=_phone_tls_context(),
        timeout=timeout,
        follow_redirects=True,
    )
    return r.text or ""


def model_from_title(html: str) -> str | None:
    """"<title>Yealink T54W Phone</title>" -> "Yealink T54W" (drop a trailing
    "Phone"). None when there's no usable title."""
    m = re.search(r"<title>\s*(.*?)\s*</title>", html or "", re.I | re.S)
    if not m:
        return None
    title = re.sub(r"\s+", " ", m.group(1)).strip()
    title = re.sub(r"\s*phone\s*$", "", title, flags=re.I).strip()
    return title or None


def _phone_tls_context() -> ssl.SSLContext:
    """A permissive TLS context for talking to desk phones. Embedded phone web
    servers often negotiate only old TLS / weak ciphers, which a modern default
    context rejects even with verification off — so allow old protocols and lower
    the security level. Never used to *trust* a cert (we don't verify)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1
    except Exception:  # noqa: BLE001 — not all builds expose this
        pass
    try:
        ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
    except Exception:  # noqa: BLE001
        pass
    return ctx


def read_phone(
    ip: str,
    timeout: float = 4.0,
    *,
    credential: "PhoneCredential | None" = None,
    auth_timeout: float = 12.0,
) -> PhoneInfo | None:
    """Read a VoIP desk phone's identity and (when credentialed) its live
    config. Phase 1 (always run) uses the TLS cert for MAC + Yealink-confirm
    and the HTTPS title for the model — no credentials, no writes. When
    ``credential`` is provided, phase 2 logs into the web API and fills in
    extension, display name, firmware, machine id (serial), vendor, and
    register status — see :mod:`collect_phone_auth`.

    Returns a :class:`PhoneInfo` for a confirmed Yealink phone, else None.
    A confirmed Yealink always reports a model — the specific model from the
    page title, or a generic "Yealink" if that read fails. Vendor is set to
    "Yealink" either on the phase-1 cert match or on the phase-2 enrichment.
    """
    try:
        pem = ssl.get_server_certificate((ip, 443), timeout=timeout)
        mac, is_yealink = parse_cert(pem)
    except Exception:  # noqa: BLE001 — unreachable / non-TLS / unparseable → not a phone
        return None
    if not is_yealink:
        return None

    model: str | None = None
    firmware: str | None = None
    try:
        model, firmware = identity_from_html(_get_html(ip, "/", timeout))
    except Exception:  # noqa: BLE001 — model is best-effort; MAC alone still identifies it
        pass
    if not model:
        try:
            model, firmware = identity_from_html(
                _get_html(ip, _T4X_LOGIN_FORM, timeout)
            )
        except Exception:  # noqa: BLE001
            pass

    info = PhoneInfo(
        mac=mac, model=model or "Yealink", vendor="Yealink", firmware=firmware
    )

    # Phase 2: credentialed enrichment. Imported lazily so the phase-1-only
    # dry path doesn't force cryptography.hazmat / httpx cert handling to load,
    # and so a module import error in the auth path never breaks phase 1.
    if credential is not None:
        try:
            from collect_phone_auth import enrich_phone  # noqa: PLC0415

            enriched = enrich_phone(ip, credential, info, timeout=auth_timeout)
            if enriched is not None:
                return enriched
            logger.warning("phone %s: phase-2 enrichment skipped (login failed)", ip)
        except Exception as e:  # noqa: BLE001 — phase 2 must never fail phase 1
            logger.warning("phone %s: phase-2 enrichment errored: %s", ip, e)

    return info


# Avoid an eager import of phone_creds (which imports config), so a dry-run
# unit test that constructs PhoneInfo doesn't need the full Config loaded.
from typing import TYPE_CHECKING  # noqa: E402

if TYPE_CHECKING:
    from phone_creds import PhoneCredential  # noqa: F401
