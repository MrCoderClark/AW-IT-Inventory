from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from .views import (
    AdminUserDetailView,
    AdminUserListCreateView,
    AdminUserSetPasswordView,
    ClientTokenView,
    LoginView,
    LogoutView,
    MeView,
    PasswordChangeView,
    RegisterView,
    RoleListView,
    SessionListView,
    SessionRevokeAllView,
    SessionRevokeView,
)

urlpatterns = [
    path("register", RegisterView.as_view(), name="register"),
    path("login", LoginView.as_view(), name="login"),
    path("token/refresh", TokenRefreshView.as_view(), name="token-refresh"),
    path("token/client", ClientTokenView.as_view(), name="token-client"),
    path("logout", LogoutView.as_view(), name="logout"),
    path("me", MeView.as_view(), name="me"),
    # Self-service (authenticated)
    path("password/change", PasswordChangeView.as_view(), name="password-change"),
    path("sessions", SessionListView.as_view(), name="sessions"),
    path(
        "sessions/revoke-all",
        SessionRevokeAllView.as_view(),
        name="sessions-revoke-all",
    ),
    path(
        "sessions/<str:jti>",
        SessionRevokeView.as_view(),
        name="session-revoke",
    ),
    # Admin (RBAC-gated: user:admin)
    path("admin/users", AdminUserListCreateView.as_view(), name="admin-users"),
    path(
        "admin/users/<uuid:pk>",
        AdminUserDetailView.as_view(),
        name="admin-user-detail",
    ),
    path(
        "admin/users/<uuid:pk>/set-password",
        AdminUserSetPasswordView.as_view(),
        name="admin-user-set-password",
    ),
    path("admin/roles", RoleListView.as_view(), name="admin-roles"),
]
