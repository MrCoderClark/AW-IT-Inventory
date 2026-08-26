from django.conf import settings
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from .models import ServiceAccount
from .serializers import (
    OpusTokenObtainPairSerializer,
    RegisterSerializer,
    UserSerializer,
)


class RegisterView(generics.CreateAPIView):
    """Create an account (self-serve). Returns the new user."""

    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class LoginView(TokenObtainPairView):
    """Email + password -> access + refresh tokens (with RBAC claims)."""

    serializer_class = OpusTokenObtainPairSerializer


class MeView(generics.RetrieveAPIView):
    """The authenticated user's identity, roles and effective permissions."""

    serializer_class = UserSerializer

    def get_object(self):
        return self.request.user


class ClientTokenView(APIView):
    """Client-credentials grant for machine identities (e.g. the collector).

    Exchange client_id + client_secret for a short-lived RS256 access token
    carrying the service account's scopes (verifiable via JWKS).
    """

    permission_classes = [permissions.AllowAny]

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        client_id = request.data.get("client_id")
        client_secret = request.data.get("client_secret")
        if not client_id or not client_secret:
            return Response(
                {"detail": "client_id and client_secret are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        invalid = Response(
            {"detail": "invalid client credentials"},
            status=status.HTTP_401_UNAUTHORIZED,
        )
        try:
            sa = ServiceAccount.objects.get(client_id=client_id)
        except ServiceAccount.DoesNotExist:
            return invalid
        if not sa.is_active or not sa.check_secret(client_secret):
            return invalid

        token = AccessToken()
        token["typ"] = "service"
        token["sub"] = str(sa.id)
        token["client_id"] = sa.client_id
        token["scopes"] = list(sa.scopes)

        sa.last_used_at = timezone.now()
        sa.save(update_fields=["last_used_at"])

        return Response(
            {
                "access": str(token),
                "token_type": "Bearer",
                "expires_in": int(
                    settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds()
                ),
            }
        )


class LogoutView(APIView):
    """Blacklist a refresh token to end the session.

    AllowAny: presenting a refresh token you already hold is enough to revoke
    it, and logout must work even after the access token has expired.
    """

    permission_classes = [permissions.AllowAny]

    @extend_schema(request=None, responses={205: None})
    def post(self, request):
        refresh = request.data.get("refresh")
        if not refresh:
            return Response(
                {"detail": "refresh token required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            RefreshToken(refresh).blacklist()
        except TokenError:
            return Response(
                {"detail": "invalid or expired token"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(status=status.HTTP_205_RESET_CONTENT)
