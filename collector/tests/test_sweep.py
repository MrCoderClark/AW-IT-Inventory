"""Tests for the scheduled computer sweep (sweep.py).

The web fetch, the collect pipeline (main.scan_targets), and the ingest
(ingest.post_scan) are mocked; the logic under test is: fetch filters out targets
without an IP; an empty target list is a no-op; and a sweep scans exactly the
target IPs, computers-only, then ingests.
"""

from __future__ import annotations

import ingest
import main
import sweep
from config import Config


def test_fetch_filters_targets_without_ip(monkeypatch):
    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "computers": [
                    {"assetId": "a1", "ipAddress": "192.168.70.7"},
                    {"assetId": "a2", "ipAddress": ""},
                    {"assetId": "a3"},
                    "junk",
                ]
            }

    monkeypatch.setattr(sweep.httpx, "get", lambda *a, **k: FakeResp())
    cfg = Config(ingest_url="http://web")
    out = sweep._fetch_computer_targets(cfg, "tok")
    assert out == [{"assetId": "a1", "ipAddress": "192.168.70.7"}]


def test_run_sweep_no_targets_is_a_noop(monkeypatch):
    monkeypatch.setattr(sweep, "_fetch_computer_targets", lambda c, t: [])
    called = {}
    monkeypatch.setattr(main, "scan_targets", lambda *a, **k: called.setdefault("scanned", True))
    sweep.run_computer_sweep(Config(ingest_url="http://web"), "tok")
    assert "scanned" not in called


def test_run_sweep_scans_targets_computers_only(monkeypatch):
    monkeypatch.setattr(
        sweep,
        "_fetch_computer_targets",
        lambda c, t: [{"assetId": "a1", "ipAddress": "192.168.70.7"}],
    )
    captured: dict = {}

    def fake_scan(cfg, **kwargs):
        captured["networks"] = list(cfg.networks)
        captured["kwargs"] = kwargs
        return "REPORT"

    monkeypatch.setattr(main, "scan_targets", fake_scan)
    monkeypatch.setattr(
        ingest, "post_scan", lambda c, r: {"matched": 1, "upserted": 1, "discovered": 0}
    )

    sweep.run_computer_sweep(Config(ingest_url="http://web"), "tok")

    assert captured["networks"] == ["192.168.70.7"]
    assert captured["kwargs"].get("no_printers") is True
