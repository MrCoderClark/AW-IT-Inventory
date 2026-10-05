"""Tests for the rembg cut-out worker plumbing (cutout_worker.py).

rembg and the HTTP posts are mocked; the logic under test is process_one: a good
job posts the base64 PNG as `done`; a job with no original, or a rembg failure,
posts `failed` (retryable) rather than crashing.
"""

from __future__ import annotations

import base64

import cutout_worker
from config import Config


class _FakeResp:
    status_code = 200
    text = ""


class _FakeTokens:
    def get(self) -> str:
        return "tok"

    def invalidate(self) -> None:  # pragma: no cover
        pass


def _capture_post(monkeypatch) -> dict:
    captured: dict = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return _FakeResp()

    monkeypatch.setattr(cutout_worker.httpx, "post", fake_post)
    return captured


def test_process_one_posts_cutout_on_success(monkeypatch):
    captured = _capture_post(monkeypatch)
    monkeypatch.setattr(cutout_worker, "_remove_background", lambda b, m="u2net": b"PNGBYTES")
    job = {"mediaId": "m1", "imageB64": base64.b64encode(b"img").decode()}

    cutout_worker.process_one(Config(ingest_url="http://web"), _FakeTokens(), "w1", job)

    assert "/api/media/cutout/m1/result" in captured["url"]
    assert captured["json"]["status"] == "done"
    assert base64.b64decode(captured["json"]["cutoutB64"]) == b"PNGBYTES"


def test_process_one_fails_when_original_missing(monkeypatch):
    captured = _capture_post(monkeypatch)
    cutout_worker.process_one(
        Config(ingest_url="http://web"), _FakeTokens(), "w1", {"mediaId": "m1"}
    )
    assert captured["json"]["status"] == "failed"


def test_process_one_fails_on_rembg_error(monkeypatch):
    captured = _capture_post(monkeypatch)

    def boom(_b, _m="u2net"):
        raise RuntimeError("model missing")

    monkeypatch.setattr(cutout_worker, "_remove_background", boom)
    job = {"mediaId": "m1", "imageB64": base64.b64encode(b"img").decode()}

    cutout_worker.process_one(Config(ingest_url="http://web"), _FakeTokens(), "w1", job)

    assert captured["json"]["status"] == "failed"
