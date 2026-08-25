"""A TokenBackend that stamps a ``kid`` header on every signed token.

SimpleJWT's default backend doesn't emit ``kid``; without it, JWKS clients
that select the key by ``kid`` (e.g. PyJWKClient) can't verify. We swap this
in at app startup (see accounts.apps.AccountsConfig.ready).
"""

from typing import Any

import jwt
from rest_framework_simplejwt.backends import TokenBackend


class KidTokenBackend(TokenBackend):
    def __init__(self, *args, kid: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.kid = kid

    def encode(self, payload: dict[str, Any]) -> str:
        jwt_payload = payload.copy()
        if self.audience is not None:
            jwt_payload["aud"] = self.audience
        if self.issuer is not None:
            jwt_payload["iss"] = self.issuer

        token = jwt.encode(
            jwt_payload,
            self.prepared_signing_key,
            algorithm=self.algorithm,
            json_encoder=self.json_encoder,
            headers={"kid": self.kid} if self.kid else None,
        )
        if isinstance(token, bytes):  # PyJWT <= 1.7.1
            return token.decode("utf-8")
        return token
