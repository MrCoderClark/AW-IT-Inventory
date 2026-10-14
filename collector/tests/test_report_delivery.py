"""Tests for the scheduled report-delivery trigger (reachability.run_report_delivery).

The web call is mocked. The logic under test: it POSTs to the deliver endpoint
with the bearer token, and a request failure is swallowed (never kills the
scheduler), matching the other worker triggers.
"""

from __future__ import annotations

import reachability
from config import Config


def test_posts_to_deliver_endpoint(monkeypatch):
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"due": 2, "delivered": 1, "failed": 1}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return FakeResp()

    monkeypatch.setattr(reachability.httpx, "post", fake_post)
    cfg = Config(ingest_url="http://web")

    reachability.run_report_delivery(cfg, "tok")

    assert captured["url"] == "http://web/api/scan/reports/deliver"
    assert captured["headers"]["Authorization"] == "Bearer tok"


def test_swallows_request_errors(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("web down")

    monkeypatch.setattr(reachability.httpx, "post", boom)
    cfg = Config(ingest_url="http://web")

    # Must not raise — a delivery failure can never kill the scheduler.
    reachability.run_report_delivery(cfg, "tok")
