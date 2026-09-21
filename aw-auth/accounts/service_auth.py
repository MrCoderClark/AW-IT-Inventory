"""Verify an incoming service token (client-credentials) by scope.

aw-auth normally *issues* service tokens for other apps to verify via JWKS. The
notify endpoint is the one place aw-auth must *accept* one: web calls it with its
`opus-web` service account to send a printer alert (spec 12). We verify the token
locally with the same signing key we minted it with (RS256 in prod, HS256 in dev
fallback), confirm it is a service token, and check the required scope.
"""

from __future__ import annotations

import jwt
from django.conf import settings
from rest_framework import permissions


def verify_service_scope(token: str, required_scope: str) -> bool:
    """True when ``token`` is a valid service token carrying ``required_scope``."""
    sj = settings.SIMPLE_JWT
    algorithm = sj.get("ALGORITHM", "HS256")
    key = sj.get("VERIFYING_KEY") or settings.SECRET_KEY
    issuer = sj.get("ISSUER")
    try:
        payload = jwt.decode(
            token,
            key,
            algorithms=[algorithm],
            issuer=issuer,
            options={"verify_aud": False},
        )
    except jwt.PyJWTError:
        return False
    if payload.get("typ") != "service":
        return False
    scopes = payload.get("scopes") or []
    return isinstance(scopes, list) and required_scope in scopes


class HasServiceScope(permissions.BasePermission):
    """DRF permission gating a view on a service token scope.

    Set ``required_scope`` on the view. Used with ``AllowAny`` authentication:
    the caller is a machine, not a user, so there is no ``request.user`` to load.
    """

    message = "invalid token or missing required scope"

    def has_permission(self, request, view) -> bool:
        required = getattr(view, "required_scope", None)
        if not required:
            return False
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return False
        token = header[len("Bearer ") :].strip()
        return verify_service_scope(token, required)
