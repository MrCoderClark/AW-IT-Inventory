"""Tests for the Yealink T5x authenticated enrichment (spec 27 phase 2).

Covers the two things that cost real time to figure out, so a regression bites
immediately: (1) the public-key is built from rsaN/rsaE JSON hex fields, not
from a PEM; (2) the auth flow stitches wui.device.* + StatusAccount →
PhoneInfo correctly, including the register-status code → label mapping.
"""

from __future__ import annotations

import base64
import binascii

import httpx
import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import collect_phone_auth
from collect_phone_auth import (
    _build_pubkey,
    _elem_value,
    _named_value,
    _normalize_mac,
    _parse_acc_status,
    _split_acc_value,
    _t4x_encrypt,
    _wui_enc,
    enrich_phone,
)
from models import PhoneInfo
from phone_creds import PhoneCredential


# A deterministic 1024-bit RSA key for the mock phone (built once per module
# — key gen is slow). Mirrors the production T5x shape (1024-bit modulus,
# e=65537).
@pytest.fixture(scope="module")
def phone_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(
        public_exponent=65537, key_size=1024, backend=default_backend()
    )


@pytest.fixture
def rsa_hex(phone_key: rsa.RSAPrivateKey) -> tuple[str, str]:
    """The modulus/exponent hex strings the T5x firmware actually publishes
    in /api/info?p=Login (uppercase hex, no 0x prefix, big-endian)."""
    pub = phone_key.public_key().public_numbers()
    n_hex = f"{pub.n:X}"
    e_hex = f"{pub.e:X}".rjust(6, "0")  # firmware pads e to "010001"
    return n_hex, e_hex


class _MockTransport(httpx.MockTransport):
    """A tiny fake Yealink firmware. Records every request so a test can
    verify both the request body (e.g. __WUI_ENC__: prefix, idlist shape) and
    the response wiring. The password handler verifies decryption, so a wrong
    encoding on our side still fails the test, not just a stub always-ok."""

    def __init__(self, phone_key: rsa.RSAPrivateKey, rsa_n_hex: str, rsa_e_hex: str):
        self.key = phone_key
        self.rsa_n_hex = rsa_n_hex
        self.rsa_e_hex = rsa_e_hex
        self.requests: list[httpx.Request] = []
        self.logged_in = False
        self.wui_payload: dict[str, object] = {
            "wui.device.phoneName": "T54W",
            "wui.device.firmware": "96.86.107.8",
            "wui.device.mac": "805E0C034323",
            "wui.device.hardware": "96.0.1.0.0.0.0",
            "wui.common.loginUser": "admin",
        }
        self.account_payload: dict[str, object] = {
            "network.common.mac": "80:5E:0C:03:43:23",
            "network.common.machineid": "301081C101210254",
            "account.number": "16",
            "account.info": [
                {
                    "id": "1",
                    "type": "sip",
                    "status": "2",
                    "userName": "93657220",
                    "label": "117",
                    "displayName": "Joseph Clark",
                    "registerName": "93657220",
                    "sipServer": "hpbx039.telecomsvc.com",
                },
                {
                    "id": "2",
                    "type": "sip",
                    "status": "0",
                    "userName": "",
                    "label": "",
                    "displayName": "",
                },
            ],
        }
        super().__init__(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path

        # 1. Login page info: anonymous, carries the RSA key under "error" when
        #    ret=failed (the actual firmware behavior).
        if path == "/api/info" and request.url.params.get("p") == "Login":
            return httpx.Response(
                200,
                json={
                    "ret": "failed",
                    "data": False,
                    "error": {
                        "webStatus": "noauth",
                        "phoneName": "T54W",
                        "firmware": "_NOAUTH_FORBIDDEN_",
                        "rsaN": self.rsa_n_hex,
                        "rsaE": self.rsa_e_hex,
                    },
                },
            )

        # 2. Login: form-encoded, pwd must start with __WUI_ENC__: and decrypt
        #    to "admin-pwd". A wrong encoding (hex vs base64, missing prefix,
        #    OAEP vs PKCS1v15) fails here, which is exactly what we want.
        if path == "/api/auth/login" and request.url.params.get("p") == "Login":
            body = dict(httpx.QueryParams(request.content.decode("utf-8")))
            pwd = body.get("pwd", "")
            if not pwd.startswith("__WUI_ENC__:"):
                return httpx.Response(200, json={"ret": "failed",
                    "error": {"webStatus": "error", "msg": "missing __WUI_ENC__"}})
            ct = binascii.unhexlify(pwd.removeprefix("__WUI_ENC__:"))
            try:
                decrypted = self.key.decrypt(ct, padding.PKCS1v15()).decode("utf-8")
            except Exception as e:  # noqa: BLE001
                return httpx.Response(200, json={"ret": "failed",
                    "error": {"webStatus": "error", "msg": f"decrypt failed: {e}"}})
            if body.get("username") != "admin" or decrypted != "admin-pwd":
                return httpx.Response(200, json={"ret": "failed",
                    "error": {"webStatus": "error", "msg": "error_username_or_password_is_wrong"}})
            self.logged_in = True
            return httpx.Response(
                200,
                json={"ret": "ok", "data": True},
                headers={"set-cookie": "JSESSIONID=abc123; Path=/"},
            )

        # 3. The batched config-read RPC. Different payload per ?p= page.
        if path == "/api/common/info":
            if not self.logged_in:
                return httpx.Response(401, json={"ret": "failed"})
            page = request.url.params.get("p")
            if page == "Login":
                return httpx.Response(200, json={"ret": "ok", "data": self.wui_payload})
            if page == "StatusAccount":
                return httpx.Response(
                    200, json={"ret": "ok", "data": self.account_payload}
                )

        return httpx.Response(404, json={"ret": "failed", "path": path})


def test_build_pubkey_from_hex_matches_the_phone(phone_key, rsa_hex):
    """A sanity check that _build_pubkey round-trips: the key we construct from
    the two hex strings can decrypt what the key was used to encrypt."""
    n_hex, e_hex = rsa_hex
    pub = _build_pubkey(n_hex, e_hex)
    ct = pub.encrypt(b"hello", padding.PKCS1v15())
    assert phone_key.decrypt(ct, padding.PKCS1v15()) == b"hello"


def test_wui_enc_shape():
    """The password field is `__WUI_ENC__:<lowercase hex>` with 256 hex chars
    (1024-bit RSA). Everything else is tested via the integration path."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=1024).public_key()
    out = _wui_enc("secret", key)
    assert out.startswith("__WUI_ENC__:")
    hex_part = out.removeprefix("__WUI_ENC__:")
    assert len(hex_part) == 256
    assert hex_part == hex_part.lower()
    assert all(c in "0123456789abcdef" for c in hex_part)


def test_normalize_mac():
    assert _normalize_mac("805E0C034323") == "80:5E:0C:03:43:23"
    assert _normalize_mac("80:5e:0c:03:43:23") == "80:5E:0C:03:43:23"
    assert _normalize_mac("80-5E-0C-03-43-23") == "80:5E:0C:03:43:23"
    assert _normalize_mac("") is None
    assert _normalize_mac(None) is None
    assert _normalize_mac("N/A") is None


def test_enrich_phone_end_to_end(phone_key, rsa_hex, monkeypatch):
    """Full happy-path integration: enrich_phone logs in and fills every field
    we care about from the mocked firmware's wui + StatusAccount responses."""
    transport = _MockTransport(phone_key, *rsa_hex)

    # Patch httpx.Client to use our mock transport so the real cert/TLS code
    # in _phone_tls_context never runs. The one-shot client the function
    # builds internally is a plain httpx.Client, so this covers both calls.
    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        kwargs.pop("verify", None)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(collect_phone_auth.httpx, "Client", fake_client)

    base = PhoneInfo(mac="80:5E:0C:03:43:23", model="Yealink T54W", vendor="Yealink")
    out = enrich_phone(
        "192.168.75.62",
        PhoneCredential("admin", "admin-pwd"),
        base=base,
    )
    assert out is not None
    assert out.mac == "80:5E:0C:03:43:23"  # phase-1 MAC preserved
    assert out.vendor == "Yealink"
    assert out.model == "T54W"  # phase-2 wui.device.phoneName overrides phase-1 title
    assert out.firmware == "96.86.107.8"
    assert out.serial == "301081C101210254"  # Yealink Machine ID
    assert out.extension == "117"
    assert out.display_name == "Joseph Clark"
    assert out.register_status == "Registered"  # 2 → "Registered"


def test_enrich_phone_bad_credential_returns_none(phone_key, rsa_hex, monkeypatch):
    """A wrong password: the firmware returns ret=failed, enrich_phone yields
    None so the caller keeps the phase-1 identity (never crashes a sweep)."""
    transport = _MockTransport(phone_key, *rsa_hex)
    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        kwargs.pop("verify", None)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(collect_phone_auth.httpx, "Client", fake_client)

    out = enrich_phone(
        "192.168.75.62",
        PhoneCredential("admin", "WRONG"),
        base=PhoneInfo(mac="80:5E:0C:03:43:23"),
    )
    assert out is None


def test_enrich_phone_picks_the_registered_line(phone_key, rsa_hex, monkeypatch):
    """When line 1 is unregistered but line 2 is registered, surface line 2's
    label/displayName so we don't report an empty extension because the phone
    happens to put its live account in slot 2."""
    transport = _MockTransport(phone_key, *rsa_hex)
    transport.account_payload = {
        "network.common.machineid": "301081C101210254",
        "account.info": [
            {"id": "1", "type": "sip", "status": "0", "label": "", "displayName": ""},
            {
                "id": "2", "type": "sip", "status": "2",
                "label": "200", "displayName": "Line Two", "userName": "u2",
            },
        ],
    }

    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        kwargs.pop("verify", None)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(collect_phone_auth.httpx, "Client", fake_client)

    out = enrich_phone(
        "192.168.75.62",
        PhoneCredential("admin", "admin-pwd"),
        base=PhoneInfo(),
    )
    assert out is not None
    assert out.extension == "200"
    assert out.display_name == "Line Two"
    assert out.register_status == "Registered"


# ---------------------------------------------------------------------------
# T4x (T46S servlet) login — AES-CBC + RSA-wrapped key/IV
# ---------------------------------------------------------------------------

_T4X_LOGIN_HTML = """<!DOCTYPE html>
<html><head>
<script type="text/JavaScript">
var g_strFirmware = "66.84.107.3";
</script>
<script type="text/JavaScript">
var g_phonetype = "T46S";
</script>
<script type="text/JavaScript">
var g_rsa_n = "{n_hex}";
</script>
<script type="text/JavaScript">
var g_rsa_e = "{e_hex}";
</script>
<title>Yealink T46S Phone</title>
</head>
<body>
<div id="_RES_INFO_" style="display:none;">{{"authstatus":"none"}}</div>
<input type="text" id="idUsername"/>
</body></html>
"""

_T4X_STATUS_HTML = """<!DOCTYPE html>
<html><body>
<script type="text/JavaScript">
var g_dataAccStatus = g_json.ParseJSON("{\\"Account1\\":\\"12663267@hpbx039.telecomsvc.com:2\\",\\"Account2\\":\\"0\\"}");
</script>
<label id="PhoneFirmware" dvalue="66.84.107.3">66.84.107.3</label>
<label id="tdMACAddress" dvalue="80:5E:0C:03:43:23">80:5E:0C:03:43:23</label>
<label id="tdMachineID" dvalue="301081C101210254">301081C101210254</label>
</body></html>
"""

_T4X_ACCOUNT_HTML = """<!DOCTYPE html>
<html><body>
<input class='item-width ' name="AccountLabel" value="117" type="text" dvalue="117" />
<input class='item-width ' name="AccountDisplayName" value="Joseph Clark" type="text" dvalue="Joseph Clark" />
<label id="RegisterAccountStatus" dvalue="2"></label>
</body></html>
"""


class _MockT4xTransport(httpx.MockTransport):
    """Fake T46S servlet firmware. /api/info is rewritten to the login HTML
    (that's what 66.x actually does), and login POSTs must decrypt as
    YLForm.Encrypt does — a wrong AES/RSA encoding fails here."""

    def __init__(self, phone_key: rsa.RSAPrivateKey, rsa_n_hex: str, rsa_e_hex: str):
        self.key = phone_key
        self.rsa_n_hex = rsa_n_hex
        self.rsa_e_hex = rsa_e_hex
        self.requests: list[httpx.Request] = []
        self.logged_in = False
        self.session = "t46sessionid"
        super().__init__(self._handle)

    def _login_html(self) -> str:
        return _T4X_LOGIN_HTML.format(n_hex=self.rsa_n_hex, e_hex=self.rsa_e_hex)

    def _decrypt_login(self, body: dict[str, str], jsessionid: str) -> str | None:
        try:
            key_hex = self.key.decrypt(
                binascii.unhexlify(body["rsakey"]), padding.PKCS1v15()
            ).decode("ascii")
            iv_hex = self.key.decrypt(
                binascii.unhexlify(body["rsaiv"]), padding.PKCS1v15()
            ).decode("ascii")
            ct = base64.b64decode(body["pwd"])
            decryptor = Cipher(
                algorithms.AES(bytes.fromhex(key_hex)),
                modes.CBC(bytes.fromhex(iv_hex)),
                backend=default_backend(),
            ).decryptor()
            plain = (decryptor.update(ct) + decryptor.finalize()).rstrip(b"\x00")
            _nonce, sess, pwd = plain.decode("utf-8").split(";", 2)
        except Exception:  # noqa: BLE001
            return None
        if sess != jsessionid:
            return None
        return pwd

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        params = request.url.params
        cookie = request.headers.get("cookie", "")

        if path == "/api/info" and params.get("p") == "Login":
            return httpx.Response(
                200,
                text=self._login_html(),
                headers={
                    "content-type": "text/html",
                    "set-cookie": f"JSESSIONID={self.session};path=/",
                },
            )

        if (
            path == "/servlet"
            and params.get("m") == "mod_listener"
            and params.get("p") == "login"
            and params.get("q") == "loginForm"
        ):
            return httpx.Response(
                200,
                text=self._login_html(),
                headers={
                    "content-type": "text/html",
                    "set-cookie": f"JSESSIONID={self.session};path=/",
                },
            )

        if (
            path == "/servlet"
            and params.get("m") == "mod_listener"
            and params.get("p") == "login"
            and params.get("q") == "login"
        ):
            body = dict(httpx.QueryParams(request.content.decode("utf-8")))
            pwd = self._decrypt_login(body, self.session)
            if body.get("username") != "admin" or pwd != "admin-pwd":
                return httpx.Response(
                    200,
                    json={"authstatus": "error"},
                    headers={"content-type": "application/json"},
                )
            self.logged_in = True
            return httpx.Response(
                200,
                json={"authstatus": "done"},
                headers={"content-type": "application/json"},
            )

        if (
            path == "/servlet"
            and params.get("m") == "mod_data"
            and params.get("q") == "load"
        ):
            if not self.logged_in or self.session not in cookie:
                return httpx.Response(302, headers={"location": "/servlet?q=loginForm"})
            page = params.get("p")
            if page == "status":
                return httpx.Response(200, text=_T4X_STATUS_HTML)
            if page == "account-register":
                return httpx.Response(200, text=_T4X_ACCOUNT_HTML)
            return httpx.Response(404, text="not found")

        if (
            path == "/servlet"
            and params.get("m") == "mod_listener"
            and params.get("q") == "logout"
        ):
            self.logged_in = False
            return httpx.Response(200, json={"authstatus": "none"})

        return httpx.Response(404, text="not found")


def _patch_client(monkeypatch, transport):
    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = transport
        kwargs.pop("verify", None)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(collect_phone_auth.httpx, "Client", fake_client)


def test_t4x_encrypt_binds_jsessionid_and_password(phone_key, rsa_hex):
    """YLForm.Encrypt plaintext is ``random;JSESSIONID;password``, AES-CBC
    ZeroPadding, with the AES key/IV RSA-wrapped as hex."""
    pub = _build_pubkey(*rsa_hex)
    pwd_b64, rsakey, rsaiv = _t4x_encrypt("secret", "sess01", pub)
    key_hex = phone_key.decrypt(
        binascii.unhexlify(rsakey), padding.PKCS1v15()
    ).decode("ascii")
    iv_hex = phone_key.decrypt(
        binascii.unhexlify(rsaiv), padding.PKCS1v15()
    ).decode("ascii")
    decryptor = Cipher(
        algorithms.AES(bytes.fromhex(key_hex)),
        modes.CBC(bytes.fromhex(iv_hex)),
        backend=default_backend(),
    ).decryptor()
    plain = (
        decryptor.update(base64.b64decode(pwd_b64)) + decryptor.finalize()
    ).rstrip(b"\x00")
    nonce, sess, pwd = plain.decode("utf-8").split(";", 2)
    assert nonce.startswith("0.")
    assert sess == "sess01"
    assert pwd == "secret"


def test_elem_value_prefers_dvalue():
    html = '<label id="PhoneFirmware" dvalue="66.84.107.3">ignored</label>'
    assert _elem_value(html, "PhoneFirmware") == "66.84.107.3"
    html = '<input name="AccountLabel" value="117" dvalue="117" />'
    assert _named_value(html, "AccountLabel") == "117"


def test_parse_acc_status():
    html = 'var g_dataAccStatus = {"Account 1": "2", "Account 2": "0"};'
    assert _parse_acc_status(html) == [("Account 1", "2"), ("Account 2", "0")]
    html = (
        'var g_dataAccStatus = g_json.ParseJSON("'
        r'{\"Account1\":\"12663267@hpbx039.telecomsvc.com:2\",\"Account2\":\"0\"}'
        '");'
    )
    assert _parse_acc_status(html) == [
        ("Account1", "12663267@hpbx039.telecomsvc.com:2"),
        ("Account2", "0"),
    ]
    assert _split_acc_value("12663267@hpbx039.telecomsvc.com:2") == (
        "12663267",
        "2",
    )
    assert _split_acc_value("0") == (None, "0")


def test_enrich_t4x_end_to_end(phone_key, rsa_hex, monkeypatch):
    transport = _MockT4xTransport(phone_key, *rsa_hex)
    _patch_client(monkeypatch, transport)

    out = enrich_phone(
        "192.168.75.64",
        PhoneCredential("admin", "admin-pwd"),
        base=PhoneInfo(mac="80:5E:0C:03:43:23", model="Yealink T46S", vendor="Yealink"),
    )
    assert out is not None
    assert out.mac == "80:5E:0C:03:43:23"
    assert out.vendor == "Yealink"
    assert out.model == "T46S"  # g_phonetype from the login HTML
    assert out.firmware == "66.84.107.3"
    assert out.serial == "301081C101210254"
    assert out.extension == "117"
    assert out.display_name == "Joseph Clark"
    assert out.register_status == "Registered"
    assert transport.logged_in is False  # logout ran


def test_enrich_t4x_bad_credential_returns_none(phone_key, rsa_hex, monkeypatch):
    transport = _MockT4xTransport(phone_key, *rsa_hex)
    _patch_client(monkeypatch, transport)

    out = enrich_phone(
        "192.168.75.64",
        PhoneCredential("admin", "WRONG"),
        base=PhoneInfo(mac="80:5E:0C:03:43:23"),
    )
    assert out is None
    assert transport.logged_in is False
