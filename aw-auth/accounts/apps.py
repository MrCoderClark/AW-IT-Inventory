from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"

    def ready(self):
        # When RS256 is active (keys present), swap SimpleJWT's token backend
        # for one that stamps a `kid` header matching the published JWK.
        from django.conf import settings

        if settings.SIMPLE_JWT.get("ALGORITHM") != "RS256":
            return

        from rest_framework_simplejwt import state
        from rest_framework_simplejwt.settings import api_settings

        from .jwt_backend import KidTokenBackend
        from .jwt_keys import get_kid

        state.token_backend = KidTokenBackend(
            api_settings.ALGORITHM,
            api_settings.SIGNING_KEY,
            api_settings.VERIFYING_KEY,
            api_settings.AUDIENCE,
            api_settings.ISSUER,
            api_settings.JWK_URL,
            api_settings.LEEWAY,
            api_settings.JSON_ENCODER,
            kid=get_kid(),
        )
