"""Tests for scheduled reboot (spec 31 v2)."""

from __future__ import annotations

from reboot import PS_REBOOT, run_reboot
from config import Config


def test_ps_reboot_is_forced():
    assert "Restart-Computer" in PS_REBOOT
    assert "-Force" in PS_REBOOT


def test_run_reboot_posts_success(monkeypatch):
    cfg = Config()

    class FakeSession:
        pass

    monkeypatch.setattr("reboot._open_session", lambda ip, c: FakeSession())
    monkeypatch.setattr("reboot._run_reboot_ps", lambda session, script, timeout: "ok")

    status, result = run_reboot(cfg, {"targetIp": "10.0.0.1"})
    assert status == "succeeded"
    assert result["method"] == "Restart-Computer -Force"


def test_run_reboot_disconnect_is_success(monkeypatch):
    cfg = Config()

    class FakeSession:
        pass

    monkeypatch.setattr("reboot._open_session", lambda ip, c: FakeSession())
    monkeypatch.setattr(
        "reboot._run_reboot_ps", lambda session, script, timeout: "disconnect"
    )

    status, result = run_reboot(cfg, {"targetIp": "10.0.0.1"})
    assert status == "succeeded"
    assert "disconnected" in result["detail"]


def test_run_reboot_no_session_raises(monkeypatch):
    cfg = Config()
    monkeypatch.setattr("reboot._open_session", lambda ip, c: None)
    try:
        run_reboot(cfg, {"targetIp": "10.0.0.1"})
    except RuntimeError as e:
        assert "no WinRM" in str(e)
    else:
        raise AssertionError("expected RuntimeError")
