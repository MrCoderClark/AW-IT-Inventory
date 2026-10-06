"""RBAC permission classes for human (cookie/JWT) callers.

Distinct from ``service_auth.HasServiceScope`` (machine callers, scope-based):
these gate a view on an app permission code held by the authenticated user via
their RBAC roles, e.g. ``user:admin`` (see rbac.models and seed_rbac).
"""

from __future__ import annotations

from rest_framework import permissions


class HasAppPerm(permissions.BasePermission):
    """Require an authenticated user holding ``view.required_app_perm``.

    The permission code is resolved from the user's roles via
    ``User.get_permission_codes()`` (superusers implicitly hold every code).
    """

    message = "You do not have permission to perform this action."

    def has_permission(self, request, view) -> bool:
        required = getattr(view, "required_app_perm", None)
        user = getattr(request, "user", None)
        if not required or not user or not user.is_authenticated:
            return False
        return required in user.get_permission_codes()
