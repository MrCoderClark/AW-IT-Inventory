"""JWKS + OIDC discovery endpoints so any client verifies tokens locally."""

from django.conf import settings
from django.http import JsonResponse

from .jwt_keys import public_jwk


def _rs256_active() -> bool:
    return settings.SIMPLE_JWT.get("ALGORITHM") == "RS256"


def jwks(_request):
    """Public signing keys. Empty until an RSA keypair is generated."""
    keys = [public_jwk()] if _rs256_active() else []
    return JsonResponse({"keys": keys})


def openid_configuration(request):
    issuer = (
        settings.SIMPLE_JWT.get("ISSUER")
        or request.build_absolute_uri("/").rstrip("/")
    ).rstrip("/")
    return JsonResponse(
        {
            "issuer": issuer,
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
            "token_endpoint": f"{issuer}/v1/auth/login",
            "token_refresh_endpoint": f"{issuer}/v1/auth/token/refresh",
            "userinfo_endpoint": f"{issuer}/v1/auth/me",
            "id_token_signing_alg_values_supported": ["RS256"],
            "grant_types_supported": ["password", "refresh_token"],
            "response_types_supported": ["token"],
            "subject_types_supported": ["public"],
        }
    )
