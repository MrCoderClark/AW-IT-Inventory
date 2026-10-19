"""Tests for missing OS-update Search (spec 31 phase 2).

Parse collapses duplicate KB ids; hosts that return no sample are dropped from
the ingest batch (prior rows stay), same gap rule as metrics.
"""

from __future__ import annotations

from collect_missing_updates import _parse_missing, sample_missing_updates
from config import Config


def test_parse_missing_reads_kb_title_severity():
    data = {
        "count": 2,
        "missing": [
            {
                "kb": "KB5034441",
                "title": "Security Update",
                "severity": "Critical",
                "size_bytes": 1024,
            },
            {
                "kb": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                "title": "Feature update without KB",
                "severity": "",
                "size_bytes": None,
            },
        ],
    }
    count, rows = _parse_missing(data)
    assert count == 2
    assert rows[0]["kb"] == "KB5034441"
    assert rows[0]["severity"] == "Critical"
    assert rows[0]["size_bytes"] == 1024
    assert rows[1]["kb"] == "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    assert rows[1]["severity"] is None


def test_parse_missing_collapses_duplicate_kb_ids():
    data = {
        "missing": [
            {"kb": "KB1", "title": "first"},
            {"kb": "KB1", "title": "dup"},
            {"kb": "KB2", "title": "other"},
        ]
    }
    count, rows = _parse_missing(data)
    assert count == 2
    assert [r["kb"] for r in rows] == ["KB1", "KB2"]
    assert rows[0]["title"] == "first"


def test_parse_missing_skips_rows_without_kb_or_title():
    data = {
        "missing": [
            {"kb": "", "title": "Nope"},
            {"kb": "KB9", "title": ""},
            {"kb": "KB9", "title": "Ok"},
        ]
    }
    count, rows = _parse_missing(data)
    assert count == 1
    assert rows[0]["kb"] == "KB9"


def test_parse_missing_empty_search():
    count, rows = _parse_missing({"count": 0, "missing": []})
    assert count == 0
    assert rows == []


def test_sample_builds_batch_and_drops_gaps(monkeypatch):
    cfg = Config(ingest_url="http://web")

    monkeypatch.setattr(
        "collect_missing_updates._fetch_computer_targets",
        lambda c, t: [
            {"assetId": "a1", "ipAddress": "10.0.0.1"},
            {"assetId": "a2", "ipAddress": "10.0.0.2"},
        ],
    )

    def fake_search(ip, config):
        if ip == "10.0.0.1":
            return {
                "count": 1,
                "missing": [{"kb": "KB1", "title": "Update", "severity": None, "size_bytes": None}],
            }
        return None

    monkeypatch.setattr("collect_missing_updates._search_one", fake_search)

    posted: dict = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"recorded": 1}

    def fake_post(url, json=None, headers=None, timeout=None):
        posted["url"] = url
        posted["json"] = json
        return FakeResp()

    monkeypatch.setattr("collect_missing_updates.httpx.post", fake_post)

    sample_missing_updates(cfg, "tok")

    assert posted["url"] == "http://web/api/ingest/missing-updates"
    results = posted["json"]["results"]
    assert len(results) == 1
    assert results[0]["assetId"] == "a1"
    assert results[0]["count"] == 1
    assert results[0]["missing"][0]["kb"] == "KB1"


def test_ps_missing_updates_is_search_not_install():
    from collect_missing_updates import PS_MISSING_UPDATES
    import base64

    assert "IsInstalled=0" in PS_MISSING_UPDATES
    assert "CreateUpdateSearcher" in PS_MISSING_UPDATES
    assert "Installer" not in PS_MISSING_UPDATES
    enc = base64.b64encode(PS_MISSING_UPDATES.encode("utf-16-le"))
    assert len(enc) <= 8000, f"encoded length {len(enc)}"


def test_search_one_host_posts_ingest(monkeypatch):
    from collect_missing_updates import search_one_host
    from config import Config

    cfg = Config(ingest_url="http://web")
    monkeypatch.setattr(
        "collect_missing_updates._search_one",
        lambda ip, c: {
            "count": 1,
            "missing": [{"kb": "KB1", "title": "T", "severity": None, "size_bytes": None}],
        },
    )
    posted: dict = {}

    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"recorded": 1}

    def fake_post(url, json=None, headers=None, timeout=None):
        posted["url"] = url
        posted["json"] = json
        return FakeResp()

    monkeypatch.setattr("collect_missing_updates.httpx.post", fake_post)
    ok, err = search_one_host(cfg, "tok", asset_id="a1", ip="10.0.0.1")
    assert ok and err is None
    assert posted["url"].endswith("/api/ingest/missing-updates")
    assert posted["json"]["results"][0]["assetId"] == "a1"
