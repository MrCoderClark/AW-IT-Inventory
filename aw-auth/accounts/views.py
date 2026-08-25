from drf_spectacular.utils import extend_schema
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

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


class LogoutView(APIView):
    """Blacklist a refresh token to end the session."""

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
