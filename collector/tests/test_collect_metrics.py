"""Tests for the device metric sampling loop (spec 29).

The WinRM read (`_sample_one`), the targets fetch, and the HTTP post are mocked;
the logic under test is batch-building: carry the assetId, map the gauges, and
**drop a host that returned no sample (a gap) rather than posting a zero** (AC-3).
"""

from __future__ import annotations

import collect_metrics
from config import Config


def test_builds_batch_and_drops_gaps(monkeypatch):
    cfg = Config(ingest_url="http://web")

    monkeypatch.setattr(
        collect_metrics,
        "_fetch_computer_targets",
        lambda c, t: [
            {"assetId": "a1", "ipAddress": "10.0.0.1"},
            {"assetId": "a2", "ipAddress": "10.0.0.2"},  # this one reads nothing (gap)
        ],
    )

    def fake_sample(ip, config):
        if ip == "10.0.0.1":
            return {"cpu_pct": 12.5, "mem_pct": 48.0, "disk_pct": 71.3, "uptime_sec": 3600}
        return None  # a2 is unreachable → gap

    monkeypatch.setattr(collect_metrics, "_sample_one", fake_sample)

    posted = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"recorded": 1}

    def fake_post(url, json, headers, timeout):
        posted["url"] = url
        posted["json"] = json
        return FakeResp()

    monkeypatch.setattr(collect_metrics.httpx, "post", fake_post)

    collect_metrics.sample_metrics(cfg, "tok")

    assert posted["url"] == "http://web/api/ingest/metrics"
    samples = posted["json"]["samples"]
    assert len(samples) == 1  # a2's gap is dropped, not posted as zero
    s = samples[0]
    assert s["assetId"] == "a1"
    assert s["cpu_pct"] == 12.5
    assert s["uptime_sec"] == 3600
    assert "sampled_at" in s


def test_no_targets_posts_nothing(monkeypatch):
    cfg = Config(ingest_url="http://web")
    monkeypatch.setattr(collect_metrics, "_fetch_computer_targets", lambda c, t: [])
    called = {"post": False}
    monkeypatch.setattr(
        collect_metrics.httpx, "post", lambda *a, **k: called.__setitem__("post", True)
    )
    collect_metrics.sample_metrics(cfg, "tok")
    assert called["post"] is False


def test_all_gaps_posts_nothing(monkeypatch):
    cfg = Config(ingest_url="http://web")
    monkeypatch.setattr(
        collect_metrics,
        "_fetch_computer_targets",
        lambda c, t: [{"assetId": "a1", "ipAddress": "10.0.0.1"}],
    )
    monkeypatch.setattr(collect_metrics, "_sample_one", lambda ip, config: None)
    called = {"post": False}
    monkeypatch.setattr(
        collect_metrics.httpx, "post", lambda *a, **k: called.__setitem__("post", True)
    )
    collect_metrics.sample_metrics(cfg, "tok")
    assert called["post"] is False
