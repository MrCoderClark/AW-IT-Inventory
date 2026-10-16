"""Authenticated Yealink enrichment (spec 27, phase 2).

The credential-free phase-1 reader in :mod:`collect_phone` identifies the phone
(MAC from the TLS cert, model from the HTTPS title). This module adds the
authenticated read that the web login does: extension, display name, firmware,
machine id (serial), and SIP register status. All read-only; writes are never
issued. If a phone has no credential in the configured CSV, phase-2 is skipped
and the phone keeps its phase-1 identity — never an error.

Two firmware families exist in the fleet and they do **not** share a login:

**T5x** (T54W, firmware 96.x) — REST ``/api/*``. Confirmed from a browser
capture on a T54W running 96.86.107.8:

1.  ``GET  /api/info?p=Login``
    Anonymous. Returns ``{"ret":"failed","error":{"rsaN","rsaE",…}}``. The
    phone's RSA public key is **two hex JSON fields** (modulus + exponent).

2.  ``POST /api/auth/login?p=Login``   (form-encoded)
    ``username=admin&pwd=__WUI_ENC__:<lowercase hex of PKCS#1 v1.5 ciphertext>``
    Returns ``{"ret":"ok","data":true}`` and sets a ``JSESSIONID`` cookie.

3.  ``POST /api/common/info?p=<Page>`` with ``{"idlist":[…]}``
    Batched config-read. ``["wui"]`` on page ``Login`` and
    ``["status","account","network"]`` on page ``StatusAccount`` cover
    firmware / MAC / Machine ID / per-line SIP state.

**T4x** (T46S, firmware 66.x) — legacy ``/servlet`` UI. The T5x ``/api/*``
paths are rewritten to the login form, so the T5x flow never authenticates.
Confirmed from T46S firmware 66.84.107.3 ``page_login.js`` + ``commonjs.js``:

1.  ``GET /servlet?m=mod_listener&p=login&q=loginForm`` (or the rewritten
    ``/api/info``) — HTML with ``g_rsa_n`` / ``g_rsa_e`` and a ``JSESSIONID``.

2.  ``POST /servlet?m=mod_listener&p=login&q=login``
    AES-128-CBC (ZeroPadding) of ``<Math.random()>;<JSESSIONID>;<password>``,
    with the AES key and IV (MD5 hex, 16 bytes each) RSA-PKCS#1-v1.5 wrapped
    as ``rsakey`` / ``rsaiv``. Success is ``{"authstatus":"done"}``.

3.  ``GET /servlet?m=mod_data&p=status&q=load`` and
    ``GET /servlet?m=mod_data&p=account-register&q=load`` for firmware / SIP
    line state / Label / Display Name.

The function is best-effort end-to-end: any step raising returns None (we keep
whatever phase-1 produced) and logs for diagnostics; a 100-phone fleet must
tolerate one bad phone without derailing a sweep.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import random
import re
import secrets
import time

import httpx
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from collect_phone import _phone_tls_context
from models import PhoneInfo
from phone_creds import PhoneCredential

logger = logging.getLogger(__name__)


# Yealink SIP register-status codes, as returned by StatusAccount's
# ``account.info[].status`` (T5x) and ``g_dataAccStatus`` (T4x). The strings
# are what the Yealink web UI shows.
_REG_STATUS: dict[str, str] = {
    "0": "Unregistered",
    "1": "Registering",
    "2": "Registered",
    "3": "Register Failed",
    "4": "Expired",
    "5": "Timeout",
}

_T4X_RSA_N = re.compile(r'g_rsa_n\s*=\s*"([0-9A-Fa-f]+)"')
_T4X_RSA_E = re.compile(r'g_rsa_e\s*=\s*"([0-9A-Fa-f]+)"')
_T4X_FIRMWARE = re.compile(r'g_strFirmware\s*=\s*"([^"]+)"')
_T4X_PHONETYPE = re.compile(r'g_phonetype\s*=\s*"([^"]+)"')
# Literal object, or the T46S form:
#   g_dataAccStatus = g_json.ParseJSON("{\"Account1\":\"user@host:2\"}");
_T4X_ACC_STATUS_OBJ = re.compile(r"g_dataAccStatus\s*=\s*(\{.*?\})", re.S)
_T4X_ACC_STATUS_PARSEJSON = re.compile(
    r'g_dataAccStatus\s*=\s*g_json\.ParseJSON\("((?:\\.|[^"\\])*)"\)',
    re.S,
)

_T4X_FIRMWARE_IDS = ("PhoneFirmware", "tdFirmware", "Firmware", "FirmwareVersion")
_T4X_MAC_IDS = ("tdMACAddress", "tdMac", "Mac", "MAC", "MacAddress", "PhoneMac")
_T4X_MODEL_IDS = ("tdProduct", "Product", "PhoneProduct", "Model")
_T4X_SERIAL_IDS = (
    "tdMachineID",
    "tdProductID",
    "ProductID",
    "MachineID",
    "DeviceID",
    "SN",
    "Serial",
)
_T4X_LABEL_IDS = ("AccountLabel",)
_T4X_DISPLAY_IDS = ("AccountDisplayName",)
_T4X_ACCOUNT_PAGES = ("account-register", "account", "accountsip")


def _ts() -> str:
    """A per-request millis timestamp. Yealink uses it as a cache-buster — the
    web UI appends ``&t=<ms>`` to every call; the server ignores the value."""
    return str(int(time.time() * 1000))


def _build_pubkey(rsa_n_hex: str, rsa_e_hex: str) -> rsa.RSAPublicKey:
    """Build the device RSA public key from Yealink's two hex JSON fields.
    These are NOT a PEM / DER SubjectPublicKeyInfo — they're the raw modulus
    and exponent, which is why ``load_pem_public_key`` fails on them."""
    n = int(rsa_n_hex, 16)
    e = int(rsa_e_hex, 16)
    return rsa.RSAPublicNumbers(e, n).public_key(default_backend())


def _wui_enc(password: str, key: rsa.RSAPublicKey) -> str:
    """The exact ``pwd`` field format a T54W login POST wants: PKCS#1 v1.5
    RSA ciphertext, lowercase hex, with the ``__WUI_ENC__:`` prefix."""
    ct = key.encrypt(password.encode("utf-8"), padding.PKCS1v15())
    return "__WUI_ENC__:" + binascii.hexlify(ct).decode("ascii")


def _zero_pad(data: bytes, block: int = 16) -> bytes:
    """CryptoJS ``pad.ZeroPadding``: pad with NULs to the next block. Already
    aligned payloads are left unchanged (unlike PKCS#7, which would add a
    whole extra block)."""
    n = len(data) % block
    if n == 0:
        return data
    return data + b"\x00" * (block - n)


def _t4x_encrypt(
    password: str, jsessionid: str, key: rsa.RSAPublicKey
) -> tuple[str, str, str]:
    """T4x ``YLForm.Encrypt`` + the RSA-wrapped AES key/IV.

    Returns ``(pwd_b64, rsakey_hex, rsaiv_hex)`` matching
    ``page_login.js`` / ``YLForm.InitEncrypt`` on firmware 66.84.107.3:

    * AES-128-CBC, ZeroPadding
    * plaintext ``<Math.random()>;<JSESSIONID>;<password>``
    * AES key and IV are 16 random bytes, sent as hex, RSA-PKCS#1-v1.5 wrapped
    * ``pwd`` is Base64 of the ciphertext (CryptoJS ``AES.encrypt().toString()``)
    """
    key_hex = secrets.token_hex(16)
    iv_hex = secrets.token_hex(16)
    nonce = str(random.random())
    plain = f"{nonce};{jsessionid};{password}".encode("utf-8")
    encryptor = Cipher(
        algorithms.AES(bytes.fromhex(key_hex)),
        modes.CBC(bytes.fromhex(iv_hex)),
        backend=default_backend(),
    ).encryptor()
    ct = encryptor.update(_zero_pad(plain)) + encryptor.finalize()
    pwd_b64 = base64.b64encode(ct).decode("ascii")
    rsakey = binascii.hexlify(
        key.encrypt(key_hex.encode("ascii"), padding.PKCS1v15())
    ).decode("ascii")
    rsaiv = binascii.hexlify(
        key.encrypt(iv_hex.encode("ascii"), padding.PKCS1v15())
    ).decode("ascii")
    return pwd_b64, rsakey, rsaiv


def _normalize_mac(raw: str | None) -> str | None:
    """Normalize a MAC to colon-separated, uppercase (``80:5E:0C:03:43:23``).
    Yealink gives it bare-hex in ``wui.device.mac`` and colon-separated in
    ``network.common.mac``; the phase-1 cert reader uses colon-upper, so match."""
    s = (raw or "").strip()
    if not s or s.upper() == "N/A":
        return None
    s = s.replace("-", ":").replace(".", ":")
    if ":" not in s and len(s) == 12:
        s = ":".join(s[i : i + 2] for i in range(0, 12, 2))
    return s.upper() if ":" in s else None


def _coerce(v: object) -> str | None:
    """A JSON leaf → trimmed string, or None when empty/missing."""
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _t5x_rsa_from_response(resp: httpx.Response) -> tuple[str, str] | None:
    """T5x ``/api/info?p=Login`` publishes ``rsaN``/``rsaE`` as JSON. T4x
    rewrites that URL to the login HTML, which is not JSON — return None."""
    text = resp.text or ""
    if not text.lstrip().startswith("{"):
        return None
    try:
        info = resp.json()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(info, dict):
        return None
    data = info.get("data") if isinstance(info.get("data"), dict) else None
    err = info.get("error") if isinstance(info.get("error"), dict) else None
    bag = data or err or info
    n_hex = bag.get("rsaN") or info.get("rsaN")
    e_hex = bag.get("rsaE") or info.get("rsaE")
    if n_hex and e_hex:
        return str(n_hex), str(e_hex)
    return None


def _t4x_rsa_from_html(html: str) -> tuple[str, str] | None:
    n = _T4X_RSA_N.search(html or "")
    e = _T4X_RSA_E.search(html or "")
    if n and e:
        return n.group(1), e.group(1)
    return None


def _tag_value(tag: str, rest: str) -> str | None:
    for attr in ("dvalue", "value"):
        am = re.search(rf"""\b{attr}=["']([^"']*)["']""", tag, re.I)
        if am and am.group(1).strip():
            return am.group(1).strip()
    inner = rest.split("<", 1)[0].strip()
    return inner or None


def _elem_value(html: str, elem_id: str) -> str | None:
    """An HTML element's ``dvalue``, ``value``, or inner text, by ``id``."""
    m = re.search(
        rf"<[^>]*\bid=[\"']{re.escape(elem_id)}[\"'][^>]*>",
        html,
        re.I,
    )
    if not m:
        return None
    return _tag_value(m.group(0), html[m.end() :])


def _named_value(html: str, name: str) -> str | None:
    """Same as :func:`_elem_value` but keyed on the ``name`` attribute.

    T4x account-register inputs (Label, Display Name) have ``name=`` and no
    matching ``id`` — the ``id`` is on the adjacent tooltip div.
    """
    m = re.search(
        rf"<[^>]*\bname=[\"']{re.escape(name)}[\"'][^>]*>",
        html,
        re.I,
    )
    if not m:
        return None
    return _tag_value(m.group(0), html[m.end() :])


def _first_elem(html: str, ids: tuple[str, ...]) -> str | None:
    for eid in ids:
        val = _elem_value(html, eid) or _named_value(html, eid)
        if val:
            return val
    return None


def _split_acc_value(raw: str) -> tuple[str | None, str]:
    """T4x ``g_dataAccStatus`` values are either ``"0"`` or
    ``"user@sip.server:2"`` (SIP user + register code). A bare code is
    accepted too."""
    s = (raw or "").strip()
    if not s:
        return None, "0"
    if "@" in s and ":" in s:
        user_host, _, code = s.rpartition(":")
        user = user_host.split("@", 1)[0].strip()
        return (user or None), (code or "0")
    return None, s


def _parse_acc_status(html: str) -> list[tuple[str, str]]:
    """``g_dataAccStatus`` → ``[(name, raw_value), ...]``.

    T46S firmware wraps the object in ``g_json.ParseJSON("...")``; older dumps
    use a bare object literal. Both are accepted.
    """
    data: object | None = None
    m = _T4X_ACC_STATUS_PARSEJSON.search(html or "")
    if m:
        try:
            data = json.loads(m.group(1).encode("utf-8").decode("unicode_escape"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            data = None
    if data is None:
        m = _T4X_ACC_STATUS_OBJ.search(html or "")
        if m:
            try:
                data = json.loads(m.group(1))
            except json.JSONDecodeError:
                data = None
    if not isinstance(data, dict):
        return []
    return [(str(k), str(v)) for k, v in data.items()]


def enrich_phone(
    ip: str,
    cred: PhoneCredential,
    base: PhoneInfo | None = None,
    *,
    timeout: float = 12.0,
) -> PhoneInfo | None:
    """Authenticated phase-2 read: log in and merge extension / display name /
    firmware / machine id / register status into ``base`` (the phase-1 result).

    Returns ``base`` with the new fields set, a fresh :class:`PhoneInfo` when
    ``base`` is None, or None when the login didn't succeed. Never raises on a
    network / parse error — one unreachable phone must never fail a sweep.
    """
    start = base.model_copy() if base is not None else PhoneInfo()
    base_url = f"https://{ip}"
    try:
        client = httpx.Client(
            verify=_phone_tls_context(),
            timeout=timeout,
            follow_redirects=True,
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("phone-auth %s: TLS client build failed: %s", ip, e)
        return None

    with client:
        try:
            probe = client.get(f"{base_url}/api/info?p=Login&t={_ts()}")
        except Exception as e:  # noqa: BLE001
            logger.debug("phone-auth %s: login probe failed: %s", ip, e)
            return None

        t5x = _t5x_rsa_from_response(probe)
        if t5x is not None:
            return _enrich_t5x(client, ip, base_url, cred, start, t5x)

        html = probe.text or ""
        t4x = _t4x_rsa_from_html(html)
        if t4x is None:
            try:
                form = client.get(
                    f"{base_url}/servlet?m=mod_listener&p=login&q=loginForm&t={_ts()}"
                )
                html = form.text or ""
                t4x = _t4x_rsa_from_html(html)
            except Exception as e:  # noqa: BLE001
                logger.debug("phone-auth %s: T4x loginForm failed: %s", ip, e)
                t4x = None
        if t4x is not None:
            return _enrich_t4x(client, ip, base_url, cred, start, html, t4x)

        logger.debug("phone-auth %s: no T5x rsaN or T4x g_rsa_n", ip)
        return None


def _enrich_t5x(
    client: httpx.Client,
    ip: str,
    base_url: str,
    cred: PhoneCredential,
    start: PhoneInfo,
    rsa_hex: tuple[str, str],
) -> PhoneInfo | None:
    try:
        pub = _build_pubkey(*rsa_hex)
    except Exception as e:  # noqa: BLE001
        logger.debug("phone-auth %s: T5x pubkey build failed: %s", ip, e)
        return None

    try:
        pwd_enc = _wui_enc(cred.password, pub)
        resp = client.post(
            f"{base_url}/api/auth/login?p=Login&t={_ts()}",
            data={"username": cred.username, "pwd": pwd_enc},
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json, text/plain, */*",
                "Origin": base_url,
                "Referer": f"{base_url}/",
            },
        )
        body = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.debug("phone-auth %s: T5x login failed: %s", ip, e)
        return None
    if not (isinstance(body, dict) and body.get("ret") == "ok"):
        logger.info(
            "phone-auth %s: T5x login rejected (%s)",
            ip,
            (body.get("error") or {}).get("msg") if isinstance(body, dict) else body,
        )
        return None

    wui = _common_info(client, base_url, "Login", ["wui"]) or {}
    account = (
        _common_info(
            client, base_url, "StatusAccount", ["status", "account", "network"]
        )
        or {}
    )

    out = start
    out.vendor = "Yealink"
    out.model = _coerce(wui.get("wui.device.phoneName")) or out.model
    out.firmware = _coerce(wui.get("wui.device.firmware")) or out.firmware
    mac = _normalize_mac(wui.get("wui.device.mac"))
    if mac and not out.mac:
        out.mac = mac
    out.serial = _coerce(account.get("network.common.machineid")) or out.serial

    acct_info = account.get("account.info")
    if isinstance(acct_info, list):
        line = next(
            (
                a
                for a in acct_info
                if isinstance(a, dict) and str(a.get("status") or "0") != "0"
            ),
            acct_info[0] if acct_info and isinstance(acct_info[0], dict) else None,
        )
        if isinstance(line, dict):
            out.extension = _coerce(line.get("label")) or out.extension
            out.display_name = _coerce(line.get("displayName")) or out.display_name
            status_code = str(line.get("status") or "").strip()
            if status_code:
                out.register_status = _REG_STATUS.get(status_code, status_code)

    return out


def _enrich_t4x(
    client: httpx.Client,
    ip: str,
    base_url: str,
    cred: PhoneCredential,
    start: PhoneInfo,
    login_html: str,
    rsa_hex: tuple[str, str],
) -> PhoneInfo | None:
    try:
        pub = _build_pubkey(*rsa_hex)
    except Exception as e:  # noqa: BLE001
        logger.debug("phone-auth %s: T4x pubkey build failed: %s", ip, e)
        return None

    jsessionid = client.cookies.get("JSESSIONID")
    if not jsessionid:
        logger.debug("phone-auth %s: T4x login has no JSESSIONID", ip)
        return None

    try:
        pwd_b64, rsakey, rsaiv = _t4x_encrypt(cred.password, jsessionid, pub)
        resp = client.post(
            f"{base_url}/servlet?m=mod_listener&p=login&q=login&Rajax={random.random()}",
            data={
                "username": cred.username,
                "pwd": pwd_b64,
                "rsakey": rsakey,
                "rsaiv": rsaiv,
            },
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": base_url,
                "Referer": f"{base_url}/servlet?m=mod_listener&p=login&q=loginForm",
            },
        )
        body = _t4x_login_body(resp)
    except Exception as e:  # noqa: BLE001
        logger.debug("phone-auth %s: T4x login failed: %s", ip, e)
        return None
    status = (body.get("authstatus") if isinstance(body, dict) else None) or ""
    if status != "done":
        logger.warning("phone-auth %s: T4x login rejected (authstatus=%s)", ip, status)
        return None

    out = start
    out.vendor = "Yealink"
    fw = _T4X_FIRMWARE.search(login_html)
    if fw:
        out.firmware = fw.group(1).strip() or out.firmware
    ptype = _T4X_PHONETYPE.search(login_html)
    if ptype:
        out.model = ptype.group(1).strip() or out.model

    status_html = _t4x_get(
        client, f"{base_url}/servlet?m=mod_data&p=status&q=load&t={_ts()}"
    )
    if status_html:
        out.firmware = _first_elem(status_html, _T4X_FIRMWARE_IDS) or out.firmware
        mac = _normalize_mac(_first_elem(status_html, _T4X_MAC_IDS))
        if mac and not out.mac:
            out.mac = mac
        model = _first_elem(status_html, _T4X_MODEL_IDS)
        if model:
            out.model = model
        serial = _first_elem(status_html, _T4X_SERIAL_IDS)
        if serial:
            out.serial = serial
        lines = _parse_acc_status(status_html)
        if lines:
            picked = next(
                (item for item in lines if item[1] not in ("0", "")),
                lines[0],
            )
            _sip_user, code = _split_acc_value(picked[1])
            out.register_status = _REG_STATUS.get(code, code)
            # Some firmware uses the SIP label as the g_dataAccStatus key.
            if re.fullmatch(r"\d{2,6}", picked[0].strip()):
                out.extension = picked[0].strip()

    for page in _T4X_ACCOUNT_PAGES:
        acct_html = _t4x_get(
            client,
            f"{base_url}/servlet?m=mod_data&p={page}&q=load&t={_ts()}",
        )
        if not acct_html:
            continue
        label = _first_elem(acct_html, _T4X_LABEL_IDS)
        display = _first_elem(acct_html, _T4X_DISPLAY_IDS)
        if label or display:
            out.extension = label or out.extension
            out.display_name = display or out.display_name
            break

    try:
        client.get(f"{base_url}/servlet?m=mod_listener&p=login&q=logout")
    except Exception:  # noqa: BLE001 — logout is polite, never required
        pass

    return out


def _t4x_login_body(resp: httpx.Response) -> dict[str, object]:
    """Login POST returns JSON or HTML wrapping ``{"authstatus":"done"}`` in
    ``<div id="_RES_INFO_">`` (``getresultinfo`` in commonjs.js)."""
    text = resp.text or ""
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            pass
    m = re.search(
        r'id="_RES_INFO_"[^>]*>(.*?)</div>',
        text,
        re.I | re.S,
    )
    if m:
        inner = m.group(1).strip()
        try:
            data = json.loads(inner)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _t4x_get(client: httpx.Client, url: str) -> str | None:
    try:
        resp = client.get(url)
    except Exception as e:  # noqa: BLE001
        logger.debug("t4x GET %s failed: %s", url, e)
        return None
    if resp.status_code != 200:
        return None
    text = resp.text or ""
    # Still the login form → session didn't stick.
    if _T4X_RSA_N.search(text) and "q=loginForm" in (str(resp.url) or ""):
        return None
    if 'g_rsa_n' in text and "idUsername" in text:
        return None
    return text


def _common_info(
    client: httpx.Client, base_url: str, page: str, idlist: list[str]
) -> dict[str, object] | None:
    """POST ``/api/common/info?p=<page>`` with ``{"idlist":[…]}`` and return the
    ``data`` dict (or None on any failure). The web UI's standard batched read."""
    try:
        resp = client.post(
            f"{base_url}/api/common/info?p={page}&t={_ts()}",
            json={"idlist": idlist},
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "Accept": "application/json, text/plain, */*",
                "Origin": base_url,
                "Referer": f"{base_url}/",
            },
        )
        body = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.debug("common_info %s %s failed: %s", page, idlist, e)
        return None
    if not isinstance(body, dict) or body.get("ret") != "ok":
        return None
    data = body.get("data")
    return data if isinstance(data, dict) else None
