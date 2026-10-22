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
        os.environ["EMAIL_FROM"] = "H2Tecs <alerts@example.com>"

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
        self.assertEqual(req.get_header("User-agent"), "h2tecs-aw-auth/1.0")

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


class ComplianceAlertResendTest(TestCase):
    """Compliance alert email via Resend (spec 21 v2)."""

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "H2Tecs <alerts@example.com>"

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_at_risk_lists_failed_checks(self, mock_urlopen, _mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_compliance_alert(
            {"name": "Reception PC"},
            "at-risk",
            [{"label": "BitLocker", "detail": "Not encrypted"}],
        )

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertIn("Reception PC", body["subject"])
        self.assertIn("at risk", body["subject"].lower())
        self.assertIn("BitLocker", body["text"])
        self.assertIn("Not encrypted", body["text"])

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_recovered_subject(self, mock_urlopen, _mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_compliance_alert({"name": "Lab PC"}, "recovered", [])

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertIn("recovered", body["subject"].lower())
        self.assertIn("Lab PC", body["subject"])


class AlertRuleResendTest(TestCase):
    """Metric-threshold alert email via Resend (spec 30, AC-6)."""

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "H2Tecs <alerts@example.com>"

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_firing_includes_rule_value_and_condition(self, mock_urlopen, _mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_alert_rule(
            {"name": "Reception PC", "tag": "H2TECS-COMP-1"},
            "firing",
            {
                "name": "Disk almost full",
                "condition": "Disk ≥ 90% for 1 sample (~15 min)",
                "severity": "critical",
            },
            "91%",
        )

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertIn("Disk almost full", body["subject"])
        self.assertIn("Reception PC", body["subject"])
        self.assertIn("91%", body["text"])
        self.assertIn("Disk ≥ 90%", body["text"])

    @patch.object(notifications, "resolve_admin_emails", return_value=["a@example.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_recovered_subject(self, mock_urlopen, _mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_alert_rule(
            {"name": "Lab PC"},
            "recovered",
            {"name": "CPU high", "condition": "CPU ≥ 90% for 2 samples (~30 min)"},
            "40%",
        )

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertIn("recovered", body["subject"].lower())
        self.assertIn("CPU high", body["subject"])
        self.assertIn("Lab PC", body["subject"])


class ReportDeliveryResendTest(TestCase):
    """Scheduled report delivery email via Resend (spec 26 phase 2).

    Unlike the printer/compliance alerts, a report goes to the EXPLICIT recipient
    list the schedule carries — never the resolved admins — and carries the full
    report as an attachment.
    """

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "H2Tecs <reports@example.com>"

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["admin@x.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_sends_to_explicit_recipients_with_attachment(
        self, mock_urlopen, mock_admins
    ):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        ok = notifications.send_report(
            {"name": "Dell laptops", "description": "Finance"},
            {
                "columns": [
                    {"label": "Tag", "align": "left"},
                    {"label": "RAM", "align": "right"},
                ],
                "rows": [["AW-1", "16"]],
                "shown": 1,
                "total": 1,
            },
            ["ops@co.com", "it@co.com"],
            {"filename": "report.csv", "content": "Zm9v"},
        )

        self.assertTrue(ok)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        # Explicit recipients, NOT the admins.
        self.assertEqual(body["to"], ["ops@co.com", "it@co.com"])
        mock_admins.assert_not_called()
        self.assertEqual(len(body["attachments"]), 1)
        self.assertEqual(body["attachments"][0]["filename"], "report.csv")
        self.assertIn("Dell laptops", body["subject"])
        self.assertIn("<table", body["html"])

    @patch("accounts.notifications.urllib.request.urlopen")
    def test_returns_false_without_recipients(self, mock_urlopen):
        ok = notifications.send_report(
            {"name": "R"}, {"columns": [], "rows": []}, [], None
        )
        self.assertFalse(ok)
        mock_urlopen.assert_not_called()


class TicketNotifyResendTest(TestCase):
    """Outbound ticket email (Spec 33) — explicit recipients only."""

    def setUp(self):
        os.environ["RESEND_API_KEY"] = "re_test_key"
        os.environ["EMAIL_FROM"] = "H2Tecs <no-reply@example.com>"
        os.environ.pop("TICKET_EMAIL_FROM", None)

    def tearDown(self):
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.pop("EMAIL_FROM", None)
        os.environ.pop("TICKET_EMAIL_FROM", None)

    @patch.object(notifications, "resolve_admin_emails", return_value=["admin@x.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_sends_to_explicit_recipients(self, mock_urlopen, mock_admins):
        import json

        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        sent, message_id = notifications.send_ticket_event(
            "assigned",
            {
                "id": "t1",
                "number": 42,
                "subject": "Disk full",
                "status": "open",
                "assigneeEmail": "tech@co.com",
            },
            ["tech@co.com"],
            "Assigned to tech@co.com",
            actor_email="admin@co.com",
            ticket_url="https://inventory.example/tickets/t1",
        )

        self.assertTrue(sent)
        self.assertIsNone(message_id)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertEqual(body["to"], ["tech@co.com"])
        self.assertEqual(body["from"], "H2Tecs <no-reply@example.com>")
        mock_admins.assert_not_called()
        self.assertIn("#42", body["subject"])
        self.assertIn("assigned", body["subject"].lower())
        self.assertIn("Disk full", body["text"])
        self.assertIn("https://inventory.example/tickets/t1", body["text"])
        self.assertIn("<", body["html"])  # has HTML

    @patch("accounts.notifications.urllib.request.urlopen")
    def test_uses_ticket_email_from_when_set(self, mock_urlopen):
        import json

        os.environ["TICKET_EMAIL_FROM"] = "H2Tecs Helpdesk <help@tickets.example.com>"
        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        sent, _ = notifications.send_ticket_event(
            "status",
            {"id": "t1", "number": 7, "subject": "x", "status": "open"},
            ["tech@co.com"],
            "open → resolved",
        )

        self.assertTrue(sent)
        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertEqual(
            body["from"], "H2Tecs Helpdesk <help@tickets.example.com>"
        )

    @patch("accounts.notifications.urllib.request.urlopen")
    def test_returns_false_without_recipients(self, mock_urlopen):
        sent, message_id = notifications.send_ticket_event(
            "comment",
            {"id": "t1", "number": 1, "subject": "x", "status": "open"},
            [],
            "hi",
        )
        self.assertEqual((sent, message_id), (False, None))
        mock_urlopen.assert_not_called()

    @patch.object(notifications, "resolve_admin_emails", return_value=["admin@x.com"])
    @patch("accounts.notifications.urllib.request.urlopen")
    def test_subject_includes_bracket_number_and_returns_resend_id(
        self, mock_urlopen, mock_admins
    ):
        import json

        resp = MagicMock()
        resp.status = 200
        resp.read.return_value = b'{"id":"re_abc"}'
        mock_urlopen.return_value.__enter__.return_value = resp

        result = notifications.send_ticket_event(
            "assigned",
            {
                "id": "t1",
                "number": 42,
                "subject": "Disk full",
                "status": "open",
            },
            ["tech@co.com"],
            "Assigned to tech@co.com",
        )

        body = json.loads(mock_urlopen.call_args.args[0].data)
        self.assertEqual(body["subject"], "[H2Tecs] [#42] — assigned")
        self.assertEqual(body["headers"], {"X-Ticket-Number": "42"})
        self.assertEqual(result, (True, "re_abc"))
        mock_admins.assert_not_called()


class TicketNotifyViewTest(TestCase):
    """POST /v1/notify/ticket (Spec 33). Explicit recipients; notify:send."""

    def setUp(self):
        self.client = APIClient()

    def test_url_resolves(self):
        self.assertEqual(reverse("notify-ticket"), "/v1/notify/ticket")

    def _payload(self, **overrides):
        body = {
            "event": "assigned",
            "ticket": {"number": 42, "subject": "Disk full", "status": "open"},
            "recipients": ["tech@co.com"],
            "detail": "Assigned to tech@co.com",
            "actorEmail": "admin@co.com",
            "ticketUrl": "https://inventory.example/tickets/t1",
        }
        body.update(overrides)
        return body

    def _post(self, payload):
        return self.client.post(
            reverse("notify-ticket"),
            payload,
            format="json",
            HTTP_AUTHORIZATION="Bearer svc-token",
        )

    def test_rejects_missing_bearer(self):
        res = self.client.post(
            reverse("notify-ticket"), self._payload(), format="json"
        )
        self.assertEqual(res.status_code, 403)

    @patch("accounts.service_auth.verify_service_scope", return_value=False)
    def test_rejects_token_without_notify_scope(self, mock_scope):
        res = self._post(self._payload())
        self.assertEqual(res.status_code, 403)
        self.assertEqual(mock_scope.call_args.args[1], "notify:send")

    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_rejects_bad_event(self, _scope):
        res = self._post(self._payload(event="created"))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.data["detail"], "event must be assigned|comment|status")

    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_rejects_ticket_without_number(self, _scope):
        res = self._post(self._payload(ticket={"subject": "x", "status": "open"}))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(
            res.data["detail"], "ticket{number,subject,status} is required"
        )

    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_rejects_non_string_recipients(self, _scope):
        res = self._post(self._payload(recipients=["ok@co.com", ""]))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(
            res.data["detail"], "recipients[] of email strings is required"
        )

    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_rejects_empty_recipients(self, _scope):
        res = self._post(self._payload(recipients=[]))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.data["detail"], "recipients[] must not be empty")

    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_rejects_blank_detail(self, _scope):
        res = self._post(self._payload(detail="   "))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.data["detail"], "detail string is required")

    @patch("accounts.views.send_ticket_event", return_value=(True, None))
    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_sends_stripped_detail_and_returns_ok(self, mock_scope, mock_send):
        res = self._post(self._payload(detail="  Assigned to tech@co.com  "))
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data, {"ok": True, "sent": True})
        self.assertEqual(mock_scope.call_args.args[1], "notify:send")
        mock_send.assert_called_once_with(
            "assigned",
            {"number": 42, "subject": "Disk full", "status": "open"},
            ["tech@co.com"],
            "Assigned to tech@co.com",
            actor_email="admin@co.com",
            ticket_url="https://inventory.example/tickets/t1",
        )

    @patch("accounts.views.send_ticket_event", return_value=(False, None))
    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_non_string_actor_and_url_become_none(self, _scope, mock_send):
        res = self._post(
            self._payload(event="comment", actorEmail={"email": "x"}, ticketUrl=12)
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data, {"ok": True, "sent": False})
        mock_send.assert_called_once_with(
            "comment",
            {"number": 42, "subject": "Disk full", "status": "open"},
            ["tech@co.com"],
            "Assigned to tech@co.com",
            actor_email=None,
            ticket_url=None,
        )

    @patch("accounts.views.send_ticket_event", return_value=(True, "re_abc"))
    @patch("accounts.service_auth.verify_service_scope", return_value=True)
    def test_returns_message_id_when_send_provides_one(self, _scope, _mock_send):
        res = self._post(self._payload())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(
            res.data, {"ok": True, "sent": True, "messageId": "re_abc"}
        )


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
