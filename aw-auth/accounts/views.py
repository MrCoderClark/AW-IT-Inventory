from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

from rbac.models import Role

from .models import ServiceAccount
from .notifications import send_counter_report, send_printer_alert
from .permissions import HasAppPerm
from .serializers import (
    AdminUserCreateSerializer,
    AdminUserSerializer,
    AdminUserUpdateSerializer,
    OpusTokenObtainPairSerializer,
    PasswordChangeSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    RoleSerializer,
    SessionSerializer,
    SetPasswordSerializer,
    UserSerializer,
)
from .service_auth import HasServiceScope

User = get_user_model()


def active_admins(exclude_id=None):
    """Active users who effectively hold ``user:admin`` (superuser or via role)."""
    qs = (
        User.objects.filter(is_active=True)
        .filter(Q(is_superuser=True) | Q(roles__permissions__code="user:admin"))
        .distinct()
    )
    if exclude_id is not None:
        qs = qs.exclude(id=exclude_id)
    return qs


def another_admin_remains(exclude_id) -> bool:
    """True when at least one active admin exists other than ``exclude_id``.

    Used to block any change that would otherwise lock every admin out.
    """
    return active_admins(exclude_id=exclude_id).exists()


class RegisterView(generics.CreateAPIView):
    """Create an account (self-serve). Returns the new user."""

    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class LoginView(TokenObtainPairView):
    """Email + password -> access + refresh tokens (with RBAC claims)."""

    serializer_class = OpusTokenObtainPairSerializer


class MeView(generics.RetrieveUpdateAPIView):
    """The authenticated user's identity (GET) and self-service profile edit.

    GET returns identity + roles + effective permissions (``UserSerializer``).
    PATCH updates the editable profile fields only (display name); PUT is
    disabled so a partial payload is always expected.
    """

    http_method_names = ["get", "patch", "head", "options"]

    def get_object(self):
        return self.request.user

    def get_serializer_class(self):
        if self.request.method == "PATCH":
            return ProfileUpdateSerializer
        return UserSerializer

    def update(self, request, *args, **kwargs):
        super().update(request, *args, **kwargs)
        # Echo the full identity back, not just the edited field.
        return Response(UserSerializer(self.get_object()).data)


class PasswordChangeView(APIView):
    """Self-service password change: verify the current password, set the new."""

    @extend_schema(request=PasswordChangeSerializer, responses={204: None})
    def post(self, request):
        serializer = PasswordChangeSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        user = request.user
        user.set_password(serializer.validated_data["new_password"])
        user.save(update_fields=["password"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class SessionListView(APIView):
    """List the signed-in user's active sessions (outstanding refresh tokens)."""

    @extend_schema(responses={200: SessionSerializer(many=True)})
    def get(self, request):
        blacklisted = BlacklistedToken.objects.values_list("token_id", flat=True)
        tokens = (
            OutstandingToken.objects.filter(
                user=request.user, expires_at__gt=timezone.now()
            )
            .exclude(id__in=blacklisted)
            .order_by("-created_at")
        )
        return Response(SessionSerializer(tokens, many=True).data)


class SessionRevokeView(APIView):
    """Revoke one of the signed-in user's sessions by its refresh token ``jti``."""

    @extend_schema(request=None, responses={204: None})
    def delete(self, request, jti: str):
        token = OutstandingToken.objects.filter(
            user=request.user, jti=jti
        ).first()
        if not token:
            return Response(
                {"detail": "session not found"},
                status=status.HTTP_404_NOT_FOUND,
            )
        BlacklistedToken.objects.get_or_create(token=token)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SessionRevokeAllView(APIView):
    """Revoke all the user's sessions, optionally keeping ``except_jti``.

    Web passes its current refresh ``jti`` as ``except_jti`` for a "sign out
    everywhere else" that leaves the current browser signed in.
    """

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        except_jti = request.data.get("except_jti")
        tokens = OutstandingToken.objects.filter(
            user=request.user, expires_at__gt=timezone.now()
        )
        if except_jti:
            tokens = tokens.exclude(jti=except_jti)
        revoked = 0
        for token in tokens:
            _, created = BlacklistedToken.objects.get_or_create(token=token)
            revoked += int(created)
        return Response({"revoked": revoked})


# --- Admin: users & roles (RBAC-gated on user:admin) ------------------------


class AdminUserListCreateView(generics.ListCreateAPIView):
    """List every user, or create one with an admin-set initial password."""

    permission_classes = [permissions.IsAuthenticated, HasAppPerm]
    required_app_perm = "user:admin"
    queryset = User.objects.all().prefetch_related("roles")

    def get_serializer_class(self):
        if self.request.method == "POST":
            return AdminUserCreateSerializer
        return AdminUserSerializer

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(
            AdminUserSerializer(user).data, status=status.HTTP_201_CREATED
        )


class AdminUserDetailView(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update (name / active / roles) or delete a single user."""

    permission_classes = [permissions.IsAuthenticated, HasAppPerm]
    required_app_perm = "user:admin"
    queryset = User.objects.all().prefetch_related("roles")
    http_method_names = ["get", "patch", "delete", "head", "options"]

    def get_serializer_class(self):
        if self.request.method == "PATCH":
            return AdminUserUpdateSerializer
        return AdminUserSerializer

    def update(self, request, *args, **kwargs):
        target = self.get_object()
        serializer = self.get_serializer(
            target, data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        is_self = target.id == request.user.id

        # Self-protection: an admin cannot lock themselves out.
        if is_self and data.get("is_active") is False:
            return self._bad("You cannot deactivate your own account.")
        if is_self and "roles" in data:
            new_roles = data["roles"]
            keeps_admin = target.is_superuser or any(
                "user:admin"
                in r.permissions.values_list("code", flat=True)
                for r in new_roles
            )
            if not keeps_admin:
                return self._bad(
                    "You cannot remove your own administrator access."
                )

        # Lockout guard: don't let the change strip the last active admin.
        if self._is_admin(target) and not another_admin_remains(target.id):
            removes_admin = data.get("is_active") is False or (
                "roles" in data
                and not target.is_superuser
                and not Role.objects.filter(
                    name__in=[r.name for r in data["roles"]],
                    permissions__code="user:admin",
                ).exists()
            )
            if removes_admin:
                return self._bad(
                    "This is the last administrator; assign another admin first."
                )

        serializer.save()
        return Response(AdminUserSerializer(self.get_object()).data)

    def destroy(self, request, *args, **kwargs):
        target = self.get_object()
        if target.id == request.user.id:
            return self._bad("You cannot delete your own account.")
        if self._is_admin(target) and not another_admin_remains(target.id):
            return self._bad(
                "This is the last administrator; assign another admin first."
            )
        target.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @staticmethod
    def _is_admin(user) -> bool:
        return "user:admin" in user.get_permission_codes()

    @staticmethod
    def _bad(message: str) -> Response:
        return Response(
            {"detail": message}, status=status.HTTP_400_BAD_REQUEST
        )


class AdminUserSetPasswordView(APIView):
    """Admin resets a user's password (no current-password check)."""

    permission_classes = [permissions.IsAuthenticated, HasAppPerm]
    required_app_perm = "user:admin"

    @extend_schema(request=SetPasswordSerializer, responses={204: None})
    def post(self, request, pk):
        target = generics.get_object_or_404(User, pk=pk)
        serializer = SetPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target.set_password(serializer.validated_data["new_password"])
        target.save(update_fields=["password"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class RoleListView(generics.ListAPIView):
    """Read-only catalog of roles and their permission codes."""

    permission_classes = [permissions.IsAuthenticated, HasAppPerm]
    required_app_perm = "user:admin"
    serializer_class = RoleSerializer
    queryset = Role.objects.all().prefetch_related("permissions")


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
