# Yealink T5x (T54W) authenticated login — fix for the probe

## Symptom

```
--- POST /api/auth/login?p=Login ---
  encrypt error: ValueError: Could not deserialize key data. … ASN.1 parsing
  error: invalid length
```

Root cause: Yealink's `/api/info?p=Login` **does not** publish a PEM or a base64
DER SubjectPublicKeyInfo. It returns the public key as **two raw hex fields**:

```json
"rsaN": "A6D7DFAF08B577E7…348EB",   // 256 hex chars = 1024-bit modulus
"rsaE": "010001"                     // 65537
```

The probe's "find a long base64 blob and wrap it with PEM headers" regex matched
the hex modulus (hex ⊂ base64 alphabet), produced a bogus `-----BEGIN PUBLIC
KEY-----` block, and `cryptography.load_pem_public_key` rejected it.

## Fix: build the RSA key from the JSON directly

Parse `rsaN` / `rsaE` as hex, construct `RSAPublicNumbers`, and encrypt with
PKCS#1 v1.5 — that's what the firmware's JavaScript (`jsencrypt`) does.

```python
import json, binascii, httpx, time
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.backends import default_backend


def yealink_pubkey_from_info(info_json: dict) -> rsa.RSAPublicKey:
    """Build the RSA key from Yealink's rsaN/rsaE hex strings."""
    data = info_json.get("data") or info_json  # /api/info wraps payload in "data"
    n = int(data["rsaN"], 16)
    e = int(data["rsaE"], 16)
    return rsa.RSAPublicNumbers(e, n).public_key(default_backend())


def yealink_encrypt_password(pwd: str, pubkey: rsa.RSAPublicKey) -> str:
    """PKCS#1 v1.5 → lowercase hex (what the T5x /api/auth/login expects)."""
    ct = pubkey.encrypt(pwd.encode("utf-8"), padding.PKCS1v15())
    return binascii.hexlify(ct).decode("ascii")  # lowercase
```

### Full working flow

```python
def ts() -> str:
    return str(int(time.time() * 1000))


BASE = f"https://{ip}"
client = httpx.Client(verify=_phone_tls_context(), timeout=12, follow_redirects=True)

# 1. Fetch the login-page info (anonymous: ret="failed" is normal here — the
#    key fields are still populated).
info = client.get(f"{BASE}/api/info?p=Login&t={ts()}").json()
pub = yealink_pubkey_from_info(info)

# 2. Encrypt the password.
pwd_enc = yealink_encrypt_password(password, pub)

# 3. Log in. T5x firmware expects JSON, with the password hex-encoded.
#    Different firmware builds disagree on the field name — "pwd" is the T5x
#    default; some older/newer builds use "password". Try "pwd" first.
r = client.post(
    f"{BASE}/api/auth/login?p=Login&t={ts()}",
    json={"username": username, "pwd": pwd_enc},
    headers={"Referer": f"{BASE}/", "Origin": BASE},
)
body = r.json()
# Expected shape: {"ret":"success","data":{"token":"…","timeout":"600", …}}
# Then either a Cookie is set OR you must send the token on later calls as
# ?token=…  (varies by firmware). Capture both and fall back to the token.
token = (body.get("data") or {}).get("token")
if token:
    client.params = {"token": token}  # append to every subsequent request
```

### Why the current probe can't just be "patched to try harder"

The `wui_enc()` helper is wrong on three counts, all stemming from the same
mis-assumption:

1. **Wrong key material** — it hunts for a PEM/base64 blob; the phone ships
   `rsaN`/`rsaE` instead.
2. **Wrong output encoding** — it prepends `__WUI_ENC__:` and hex-encodes.
   `__WUI_ENC__` is the T4x/T3x legacy prefix (Yealink's old "pcap/upgrade
   file" password wrapper). The **T5x `/api/auth/login`** wants **bare lowercase
   hex** of the PKCS#1-v1.5 ciphertext.
3. **Wrong body format** — the probe posts form-encoded; T5x expects JSON.

## Patch to drop into `probe_yealink_login.py`

Replace the "hunt for a key" block **and** the `wui_enc()` function with:

```python
import json, binascii
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.backends import default_backend

# --- 1. The login-page info call ---------------------------------------------
print("--- GET /api/info?p=Login ---")
pub_key = None
try:
    r = client.get(f"{BASE}/api/info?p=Login&t={ts()}")
    print(f"  status {r.status_code}")
    info = r.json()
    data = info.get("data") if isinstance(info.get("data"), dict) else info
    n_hex, e_hex = data.get("rsaN"), data.get("rsaE")
    if n_hex and e_hex:
        pub_key = rsa.RSAPublicNumbers(int(e_hex, 16), int(n_hex, 16)).public_key(default_backend())
        print(f"  public key found: yes (|n|={len(n_hex) * 4} bits, e=0x{e_hex})")
    else:
        print("  public key found: NO — rsaN/rsaE missing")
except Exception as e:
    print(f"  ERROR: {type(e).__name__}: {e}")


def t5x_encrypt(password: str, key: rsa.RSAPublicKey) -> str:
    ct = key.encrypt(password.encode("utf-8"), padding.PKCS1v15())
    return binascii.hexlify(ct).decode("ascii")


# --- 2. Attempt the login ----------------------------------------------------
print("\n--- POST /api/auth/login?p=Login ---")
logged_in = False
if pub_key and PWD:
    enc = t5x_encrypt(PWD, pub_key)
    try:
        lr = client.post(
            f"{BASE}/api/auth/login?p=Login&t={ts()}",
            json={"username": USER, "pwd": enc},
            headers={"Referer": f"{BASE}/", "Origin": BASE},
        )
        print(f"  status {lr.status_code}")
        print(f"  body: {lr.text[:400]}")
        print(f"  cookies: {dict(client.cookies)}")
        try:
            body_json = lr.json()
        except Exception:
            body_json = {}
        token = (body_json.get("data") or {}).get("token") if isinstance(body_json, dict) else None
        if token:
            print(f"  token: {token[:32]}…")
            client.params = {"token": token}  # subsequent calls carry it
        logged_in = (
            isinstance(body_json, dict)
            and body_json.get("ret") == "success"
        ) or bool(token) or any(
            k.lower() in ("jsessionid", "session", "token") for k in client.cookies.keys()
        )
    except Exception as e:
        print(f"  ERROR: {type(e).__name__}: {e}")
else:
    print("  (need a public key AND a password to attempt login)")
```

## After login — pulling the extension / display name

Once `logged_in` is true, the T5x pages you want are:

| Path | Carries |
|---|---|
| `/api/configManager/configuration/get?p=AccountRegister` | per-line `label`, `display_name`, `user_name` (extension) |
| `/api/configManager/configuration/get?p=StatusAccount` | per-line `register_status` |
| `/api/configManager/configuration/get?p=StatusGeneral` | firmware version, model, uptime |

The older `/note/configuration.xml?p=…` and `/api/info?p=AccountRegister`
paths your probe tries work on some firmware builds and are empty on others —
hit the `configManager` endpoints first, then fall back.

Example:

```python
cr = client.get(f"{BASE}/api/configManager/configuration/get?p=AccountRegister&t={ts()}")
cfg = cr.json()  # {"ret":"success","data":{"account.1.label":"117", "account.1.display_name":"Joseph Clark", …}}
accounts = cfg.get("data", {})
line1_ext  = accounts.get("account.1.user_name") or accounts.get("account.1.label")
line1_name = accounts.get("account.1.display_name")
```

## Logout (be polite — the T5x only allows ~5 concurrent sessions)

```python
client.post(f"{BASE}/api/auth/logout?t={ts()}")
```

## Gotchas worth remembering

- **`ret=failed` on `/api/info?p=Login` is normal** before you authenticate —
  it still returns `rsaN`/`rsaE` and the model banner. Don't bail on `failed`.
- **Lowercase hex, not uppercase, not base64.** The jsencrypt-based web UI
  emits lowercase hex; some firmware builds reject uppercase.
- **PKCS#1 v1.5, not OAEP.** OAEP will encrypt fine on your side and get a
  silent `ret=failed` back.
- **Session carry — cookie *or* `?token=…`.** Firmware 84.x sets a cookie;
  85.x+ returns a token and expects it on the query string of every call.
  Capture both; the snippet above does.
- **TLS: keep `_phone_tls_context()`** (SECLEVEL=0, TLS 1.0+). The phone's
  web server negotiates very old ciphers.
- **Rate-limit / lockout.** Five bad logins locks the admin account for ~5
  min on recent firmware. During dev, retry with exponential backoff on
  `ret=failed` responses that carry `error.webStatus=="lockout"`.
