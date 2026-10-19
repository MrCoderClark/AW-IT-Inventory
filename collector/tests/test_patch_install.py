"""Tests for patch install scripts (spec 31 phase 3)."""

from __future__ import annotations

import base64

from patch_install import PS_INSTALL_APP, PS_INSTALL_OS, _parse_item, run_patch_install
from config import Config


def test_ps_os_installs_via_wua_not_reboot():
    assert "CreateUpdateInstaller" in PS_INSTALL_OS
    assert "AllowSourcePrompts" in PS_INSTALL_OS
    assert "Restart-Computer" not in PS_INSTALL_OS
    enc = base64.b64encode(PS_INSTALL_OS.replace("__KB__", "KB1").encode("utf-16-le"))
    assert len(enc) <= 8000, f"encoded length {len(enc)}"


def test_ps_app_upgrades_one_id_never_all():
    assert "upgrade" in PS_INSTALL_APP
    assert "--id" in PS_INSTALL_APP
    assert "--all" not in PS_INSTALL_APP
    assert "InstallLocation" in PS_INSTALL_APP
    assert "WindowsApps" in PS_INSTALL_APP  # exclusion check
    enc = base64.b64encode(PS_INSTALL_APP.replace("__ID__", "X.Y").encode("utf-16-le"))
    assert len(enc) <= 8000, f"encoded length {len(enc)}"


def test_parse_item_ok():
    raw = '{"ok":true,"exitCode":2,"rebootRequired":true,"detail":""}'
    p = _parse_item(raw)
    assert p["ok"] is True
    assert p["rebootRequired"] is True
    assert p["exitCode"] == 2


def test_run_patch_install_runs_os_then_apps(monkeypatch):
    cfg = Config()
    calls: list[str] = []

    class FakeSession:
        pass

    monkeypatch.setattr("patch_install._open_session", lambda ip, c: FakeSession())

    def fake_run(session, script, timeout):
        calls.append(script)
        class R:
            status_code = 0
            std_out = b'{"ok":true,"exitCode":2,"rebootRequired":false,"detail":""}'
            std_err = b""
        return R()

    monkeypatch.setattr("patch_install._run_ps_timeout", fake_run)

    status, result = run_patch_install(
        cfg,
        {
            "targetIp": "10.0.0.1",
            "selection": {
                "os": [{"kbId": "KB9", "title": "T"}],
                "apps": [
                    {
                        "packageId": "Google.Chrome",
                        "name": "Chrome",
                        "version": "1",
                        "available": "2",
                    }
                ],
            },
        },
    )
    assert status == "succeeded"
    assert len(result["items"]) == 2
    assert result["items"][0]["kind"] == "os"
    assert result["items"][0]["id"] == "KB9"
    assert result["items"][1]["kind"] == "app"
    assert "KB9" in calls[0]
    assert "Google.Chrome" in calls[1]
