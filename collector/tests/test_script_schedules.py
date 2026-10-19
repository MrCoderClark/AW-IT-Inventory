"""Tests for the scheduled script-run trigger (reachability.run_script_schedules)."""

from __future__ import annotations

import reachability
from config import Config


def test_posts_to_due_endpoint(monkeypatch):
    captured = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"due": 2, "fired": 1, "failed": 1}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return FakeResp()

    monkeypatch.setattr(reachability.httpx, "post", fake_post)
    cfg = Config(ingest_url="http://web")

    reachability.run_script_schedules(cfg, "tok")

    assert captured["url"] == "http://web/api/script-schedules/due"
    assert captured["headers"]["Authorization"] == "Bearer tok"


def test_swallows_request_errors(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("web down")

    monkeypatch.setattr(reachability.httpx, "post", boom)
    cfg = Config(ingest_url="http://web")

    reachability.run_script_schedules(cfg, "tok")
