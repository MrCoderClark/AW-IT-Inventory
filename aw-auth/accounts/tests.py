import os
from unittest.mock import MagicMock, patch

from django.test import TestCase

from accounts import notifications


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
