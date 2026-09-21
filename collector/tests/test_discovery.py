"""Smoke tests for the collector's discovery type toggle logic (spec 13).

Covers the pure normalization (`_coerce_settings`) and the fetch, cache, and
fail open behavior of `get_discovery_settings` in ingest.py. The network and the
auth token are mocked; the cache is a temp file. See
docs/specs/13-discovery-type-toggles/index.md (AC-2, AC-3, AC-6).
"""

from __future__ import annotations

import json

import httpx

import ingest
from config import Config


class FakeResponse:
    """Minimal stand in for an httpx response on the success path."""

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _config(tmp_path):
    return Config(discovery_cache_file=str(tmp_path / ".discovery-settings.json"))


# ── _coerce_settings: absent = on (AC-2) ─────────────────────────────────────


def test_coerce_defaults_missing_types_to_on():
    # covers: AC-2 — a missing type coalesces to True.
    assert ingest._coerce_settings({}) == {"computer": True, "printer": True}


def test_coerce_honors_explicit_false():
    assert ingest._coerce_settings({"computer": False, "printer": True}) == {
        "computer": False,
        "printer": True,
    }


def test_coerce_treats_non_bool_and_non_dict_as_on():
    # A junk value or a non dict payload must not turn a type off by accident.
    assert ingest._coerce_settings({"computer": "nope"}) == {
        "computer": True,
        "printer": True,
    }
    assert ingest._coerce_settings(None) == {"computer": True, "printer": True}


# ── get_discovery_settings: fetch, cache, fail open (AC-3, AC-6) ─────────────


def test_fetch_success_returns_fetched_and_writes_cache(tmp_path, monkeypatch):
    # covers: AC-3 (reads the endpoint), AC-6 (a good fetch refreshes the cache).
    cfg = _config(tmp_path)
    monkeypatch.setattr(ingest, "get_token", lambda c: "tok")
    monkeypatch.setattr(
        ingest.httpx,
        "get",
        lambda *a, **k: FakeResponse({"computer": False, "printer": True}),
    )

    settings, source = ingest.get_discovery_settings(cfg)

    assert source == "fetched"
    assert settings == {"computer": False, "printer": True}
    assert json.loads(cfg.discovery_cache_path.read_text(encoding="utf-8")) == {
        "computer": False,
        "printer": True,
    }


def test_read_failure_falls_back_to_cache(tmp_path, monkeypatch):
    # covers: AC-6 — a settings outage uses the last cached result.
    cfg = _config(tmp_path)
    cfg.discovery_cache_path.write_text(
        json.dumps({"computer": True, "printer": False}), encoding="utf-8"
    )

    def boom(c):
        raise RuntimeError("auth down")

    monkeypatch.setattr(ingest, "get_token", boom)

    settings, source = ingest.get_discovery_settings(cfg)

    assert source == "cache"
    assert settings == {"computer": True, "printer": False}


def test_read_failure_without_cache_fails_open_all_on(tmp_path, monkeypatch):
    # covers: AC-6 — nothing was ever cached, so proceed with all types on.
    cfg = _config(tmp_path)
    monkeypatch.setattr(ingest, "get_token", lambda c: "tok")

    def boom(*a, **k):
        raise httpx.ConnectError("web down")

    monkeypatch.setattr(ingest.httpx, "get", boom)

    settings, source = ingest.get_discovery_settings(cfg)

    assert source == "default"
    assert settings == {"computer": True, "printer": True}
