import os
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import (
    BlacklistedToken,
    OutstandingToken,
)
from rest_framework_simplejwt.tokens import RefreshToken

from accounts import notifications
from rbac.models import Permission, Role

User = get_user_model()


class PrinterAlertResendTest(TestCase):
    """Printer-alert email via Resend (spec 12).

    Regression: the request MUST carry an explicit User-Agent. Cloudflare (in
    front of api.resend.com) blocks urllib's default "Python-urllib/x.y" agent
    with a 403 "error code: 1010", so the mail never reaches Resend.
    """

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "OPUS <alerts@example.com>"

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_send_sets_explicit_user_agent(self, mock_urlopen, _mock_admins):
        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_printer_alert(
            {"name": "Front Printer", "ip": "192.168.70.202"}, "down", None
        )

        self.assertTrue(ok)
        req = mock_urlopen.call_args.args[0]
        # urllib normalizes header names to Capitalized form ("User-agent").
        self.assertEqual(req.get_header("User-agent"), "opus-aw-auth/1.0")

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_returns_false_on_resend_error(self, mock_urlopen, _mock_admins):
        # A non-2xx from Resend is reported as a failed (retryable) send.
        resp = MagicMock()
        resp.status = 403
        mock_urlopen.return_value.__enter__.return_value = resp
        ok = notifications.send_printer_alert(
            {"name": "P", "ip": "1.2.3.4"}, "down", None
        )
        self.assertFalse(ok)


class UserManagementTestBase(TestCase):
    """Seed the RBAC bits these tests need and build an admin + a plain user."""

    def setUp(self):
        self.admin_perm = Permission.objects.create(code="user:admin")
        self.read_perm = Permission.objects.create(code="asset:read")
        self.admin_role = Role.objects.create(name="Admin", is_system=True)
        self.admin_role.permissions.set([self.admin_perm, self.read_perm])
        self.viewer_role = Role.objects.create(name="Viewer", is_system=True)
        self.viewer_role.permissions.set([self.read_perm])

        self.admin = User.objects.create_user(
            email="admin@example.com", password="admin-pass-123", full_name="Admin"
        )
        self.admin.roles.add(self.admin_role)
        self.viewer = User.objects.create_user(
            email="viewer@example.com", password="viewer-pass-123", full_name="Viewer"
        )
        self.viewer.roles.add(self.viewer_role)

        self.client = APIClient()

    def as_admin(self):
        self.client.force_authenticate(user=self.admin)

    def as_viewer(self):
        self.client.force_authenticate(user=self.viewer)


class AdminUserGatingTest(UserManagementTestBase):
    def test_unauthenticated_is_rejected(self):
        res = self.client.get(reverse("admin-users"))
        self.assertEqual(res.status_code, 401)

    def test_non_admin_is_forbidden(self):
        self.as_viewer()
        res = self.client.get(reverse("admin-users"))
        self.assertEqual(res.status_code, 403)

    def test_admin_can_list(self):
        self.as_admin()
        res = self.client.get(reverse("admin-users"))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data), 2)


class AdminUserCreateTest(UserManagementTestBase):
    def test_create_user_with_role_and_login(self):
        self.as_admin()
        res = self.client.post(
            reverse("admin-users"),
            {
                "email": "new@example.com",
                "full_name": "New Person",
                "password": "s3cret-pass-123",
                "roles": ["Viewer"],
            },
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.data)
        created = User.objects.get(email="new@example.com")
        self.assertTrue(created.check_password("s3cret-pass-123"))
        self.assertEqual([r.name for r in created.roles.all()], ["Viewer"])

        # The new user can authenticate.
        anon = APIClient()
        login = anon.post(
            reverse("login"),
            {"email": "new@example.com", "password": "s3cret-pass-123"},
            format="json",
        )
        self.assertEqual(login.status_code, 200)

    def test_duplicate_email_rejected(self):
        self.as_admin()
        res = self.client.post(
            reverse("admin-users"),
            {
                "email": "viewer@example.com",
                "full_name": "Dup",
                "password": "s3cret-pass-123",
            },
            format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_unknown_role_rejected(self):
        self.as_admin()
        res = self.client.post(
            reverse("admin-users"),
            {
                "email": "x@example.com",
                "full_name": "X",
                "password": "s3cret-pass-123",
                "roles": ["Wizard"],
            },
            format="json",
        )
        self.assertEqual(res.status_code, 400)


class AdminUserUpdateTest(UserManagementTestBase):
    def url(self, user):
        return reverse("admin-user-detail", args=[user.id])

    def test_assign_and_revoke_roles(self):
        self.as_admin()
        res = self.client.patch(
            self.url(self.viewer), {"roles": ["Admin"]}, format="json"
        )
        self.assertEqual(res.status_code, 200, res.data)
        self.viewer.refresh_from_db()
        self.assertIn("Admin", [r.name for r in self.viewer.roles.all()])

    def test_set_password(self):
        self.as_admin()
        res = self.client.post(
            reverse("admin-user-set-password", args=[self.viewer.id]),
            {"new_password": "brand-new-pass-99"},
            format="json",
        )
        self.assertEqual(res.status_code, 204)
        self.viewer.refresh_from_db()
        self.assertTrue(self.viewer.check_password("brand-new-pass-99"))

    def test_deactivate_blocks_login(self):
        self.as_admin()
        res = self.client.patch(
            self.url(self.viewer), {"is_active": False}, format="json"
        )
        self.assertEqual(res.status_code, 200)
        anon = APIClient()
        login = anon.post(
            reverse("login"),
            {"email": "viewer@example.com", "password": "viewer-pass-123"},
            format="json",
        )
        self.assertEqual(login.status_code, 401)

    def test_cannot_deactivate_self(self):
        self.as_admin()
        res = self.client.patch(
            self.url(self.admin), {"is_active": False}, format="json"
        )
        self.assertEqual(res.status_code, 400)

    def test_cannot_remove_own_admin_role(self):
        self.as_admin()
        res = self.client.patch(
            self.url(self.admin), {"roles": ["Viewer"]}, format="json"
        )
        self.assertEqual(res.status_code, 400)

    def test_cannot_delete_self(self):
        self.as_admin()
        res = self.client.delete(self.url(self.admin))
        self.assertEqual(res.status_code, 400)

    def test_cannot_strip_last_admin_via_another_account(self):
        # Promote viewer to admin, then the original admin demotes them: allowed
        # because the original admin still holds it. But demoting the *only*
        # admin must fail. Simulate: make viewer the sole admin.
        self.admin.roles.clear()  # admin is no longer an admin
        self.viewer.roles.set([self.admin_role])
        self.client.force_authenticate(user=self.viewer)
        res = self.client.patch(
            self.url(self.viewer), {"roles": ["Viewer"]}, format="json"
        )
        self.assertEqual(res.status_code, 400)


class SelfServiceTest(UserManagementTestBase):
    def test_change_password_requires_correct_current(self):
        self.as_viewer()
        bad = self.client.post(
            reverse("password-change"),
            {"current_password": "wrong", "new_password": "another-pass-123"},
            format="json",
        )
        self.assertEqual(bad.status_code, 400)

        ok = self.client.post(
            reverse("password-change"),
            {
                "current_password": "viewer-pass-123",
                "new_password": "another-pass-123",
            },
            format="json",
        )
        self.assertEqual(ok.status_code, 204)
        self.viewer.refresh_from_db()
        self.assertTrue(self.viewer.check_password("another-pass-123"))

    def test_profile_update_name(self):
        self.as_viewer()
        res = self.client.patch(
            reverse("me"), {"full_name": "Renamed"}, format="json"
        )
        self.assertEqual(res.status_code, 200)
        self.viewer.refresh_from_db()
        self.assertEqual(self.viewer.full_name, "Renamed")


class SessionTest(UserManagementTestBase):
    def test_list_and_revoke(self):
        r1 = RefreshToken.for_user(self.viewer)
        r2 = RefreshToken.for_user(self.viewer)
        self.as_viewer()

        listed = self.client.get(reverse("sessions"))
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.data), 2)

        revoke = self.client.delete(
            reverse("session-revoke", args=[str(r1["jti"])])
        )
        self.assertEqual(revoke.status_code, 204)
        self.assertTrue(
            BlacklistedToken.objects.filter(token__jti=str(r1["jti"])).exists()
        )

        remaining = self.client.get(reverse("sessions"))
        self.assertEqual(len(remaining.data), 1)
        self.assertEqual(remaining.data[0]["jti"], str(r2["jti"]))

    def test_revoke_all_except_current(self):
        r1 = RefreshToken.for_user(self.viewer)
        RefreshToken.for_user(self.viewer)
        self.as_viewer()
        res = self.client.post(
            reverse("sessions-revoke-all"),
            {"except_jti": str(r1["jti"])},
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data["revoked"], 1)
        remaining = self.client.get(reverse("sessions"))
        self.assertEqual(len(remaining.data), 1)


class RoleListTest(UserManagementTestBase):
    def test_admin_lists_roles_with_permissions(self):
        self.as_admin()
        res = self.client.get(reverse("admin-roles"))
        self.assertEqual(res.status_code, 200)
        names = {r["name"] for r in res.data}
        self.assertIn("Admin", names)
        admin_row = next(r for r in res.data if r["name"] == "Admin")
        self.assertIn("user:admin", admin_row["permissions"])
