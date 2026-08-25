"""RSA key helpers for RS256 signing and JWKS publication.

The JWK and the token header share one deterministic ``kid`` (the RFC 7638
JWK thumbprint), so any standard verifier can match the signing key.
"""

import base64
import hashlib
import json
from functools import lru_cache

from cryptography.hazmat.primitives import serialization
from django.conf import settings


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _int_to_b64url(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return _b64url(value.to_bytes(length, "big"))


@lru_cache(maxsize=1)
def public_jwk() -> dict:
    """The public verifying key as a JWK (with alg/use/kid)."""
    pem = settings.SIMPLE_JWT["VERIFYING_KEY"]
    if isinstance(pem, str):
        pem = pem.encode("utf-8")
    key = serialization.load_pem_public_key(pem)
    numbers = key.public_numbers()
    n = _int_to_b64url(numbers.n)
    e = _int_to_b64url(numbers.e)

    # RFC 7638 thumbprint: SHA-256 over the canonical {e, kty, n} JSON.
    thumbprint_input = json.dumps(
        {"e": e, "kty": "RSA", "n": n}, separators=(",", ":"), sort_keys=True
    ).encode("ascii")
    kid = _b64url(hashlib.sha256(thumbprint_input).digest())

    return {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid, "n": n, "e": e}


def get_kid() -> str:
    return public_jwk()["kid"]
