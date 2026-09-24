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
from .notifications import send_counter_report, send_printer_alert
from .serializers import (
    OpusTokenObtainPairSerializer,
    RegisterSerializer,
    UserSerializer,
)
from .service_auth import HasServiceScope


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


class PrinterAlertView(APIView):
    """Email the admins when a printer goes down or recovers (spec 12, AC-7).

    Called by web (which holds the reachability history and detects the
    transition) with its `opus-web` service account. Requires a service token
    carrying `notify:send`. aw-auth resolves "the admins" from RBAC and sends
    through Resend. A send failure is reported so web can retry on the next check.
    """

    authentication_classes: list = []  # machine caller; token verified by scope
    permission_classes = [HasServiceScope]
    required_scope = "notify:send"

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        printer = request.data.get("printer") or {}
        event = request.data.get("event")
        since = request.data.get("since")
        if not isinstance(printer, dict) or event not in ("down", "up"):
            return Response(
                {"detail": "printer{name,ip} and event in {down,up} are required"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        sent = send_printer_alert(printer, event, since)
        return Response({"ok": True, "sent": sent})


class CounterReportView(APIView):
    """Email the admins the daily printer page-counter report (spec 14, AC-4).

    Called by web (which holds the counter history and assembles the rows) with
    its `opus-web` service account. Requires a service token carrying
    `notify:send`. aw-auth resolves "the admins" from RBAC and sends through
    Resend. A send failure is reported so the caller can surface it.
    """

    authentication_classes: list = []  # machine caller; token verified by scope
    permission_classes = [HasServiceScope]
    required_scope = "notify:send"

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        printers = request.data.get("printers")
        if not isinstance(printers, list):
            return Response(
                {"detail": "printers[] is required"},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        sent = send_counter_report(printers)
        return Response({"ok": True, "sent": sent})


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
