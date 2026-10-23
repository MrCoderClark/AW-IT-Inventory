"""Tests for patch install scripts (spec 31 phase 3)."""

from __future__ import annotations

import base64
import textwrap
from pathlib import Path

from patch_install import (
    PS_INSTALL_APP,
    PS_INSTALL_MIRROR,
    PS_INSTALL_OS_POLL,
    PS_INSTALL_OS_START,
    _parse_item,
    _run_os_system_install,
    build_mirror_url,
    resolve_mirror_installer_type,
    run_patch_install,
)
from config import AppUpgradeMirror, Config, load_config


def test_ps_os_installs_via_wua_not_reboot():
    assert "CreateUpdateInstaller" in PS_INSTALL_OS_START
    assert "AllowSourcePrompts" in PS_INSTALL_OS_START
    assert "Restart-Computer" not in PS_INSTALL_OS_START
    assert "AcceptEula" in PS_INSTALL_OS_START
    # GUID inventory ids: query WUA by UpdateID (IsInstalled=0 often misses them).
    assert "UpdateID=" in PS_INSTALL_OS_START
    assert "already installed" in PS_INSTALL_OS_START
    assert "Identity.UpdateID" in PS_INSTALL_OS_START
    assert "-contains" in PS_INSTALL_OS_START
    # WUA Install is Access Denied under WinRM — run as SYSTEM via task.
    assert "SYSTEM" in PS_INSTALL_OS_START
    assert "Register-ScheduledTask" in PS_INSTALL_OS_START
    # Start must not block WinRM waiting for Download/Install.
    assert "AddSeconds" not in PS_INSTALL_OS_START
    assert "pending" in PS_INSTALL_OS_POLL
    enc = base64.b64encode(
        PS_INSTALL_OS_START.replace("__KB__", "KB1")
        .replace("__TAG__", "t1")
        .encode("utf-16-le")
    )
    assert len(enc) <= 8000, f"encoded length {len(enc)}"
    enc_guid = base64.b64encode(
        PS_INSTALL_OS_START.replace(
            "__KB__", "14c737a8-9ff8-4189-ade8-55aec8d80295"
        )
        .replace("__TAG__", "t2")
        .encode("utf-16-le")
    )
    assert len(enc_guid) <= 8000, f"encoded length {len(enc_guid)}"


def test_run_os_system_install_polls_until_done(monkeypatch):
    cfg = Config()
    calls: list[str] = []

    def fake_run(session, script, timeout):
        calls.append(script)
        if "Register-ScheduledTask" in script:
            return {
                "ok": True,
                "started": True,
                "exitCode": 0,
                "rebootRequired": False,
                "detail": "started",
                "outputTail": "started",
            }
        if "pending" in script or "out.json" in script:
            # First poll still pending; second returns success.
            if sum(1 for c in calls if "out.json" in c) >= 2:
                return {
                    "ok": True,
                    "exitCode": 2,
                    "rebootRequired": False,
                    "detail": "",
                    "outputTail": "",
                }
            return {
                "ok": False,
                "exitCode": None,
                "rebootRequired": False,
                "detail": "pending",
                "pending": True,
                "outputTail": "pending",
            }
        return {
            "ok": False,
            "exitCode": 1,
            "rebootRequired": False,
            "detail": "unexpected",
            "outputTail": "unexpected",
        }

    monkeypatch.setattr("patch_install._run_item", fake_run)
    monkeypatch.setattr("patch_install.time.sleep", lambda *_a, **_k: None)

    parsed = _run_os_system_install(object(), cfg, "10.0.0.1", "KB1", "tag1", 120.0)
    assert parsed["ok"] is True
    assert parsed["exitCode"] == 2
    assert any("Register-ScheduledTask" in c for c in calls)


def test_ps_app_upgrades_one_id_never_all():
    assert "upgrade" in PS_INSTALL_APP
    assert "--id" in PS_INSTALL_APP
    assert "--all" not in PS_INSTALL_APP
    assert "InstallLocation" in PS_INSTALL_APP
    assert "WindowsApps" in PS_INSTALL_APP  # exclusion check
    enc = base64.b64encode(PS_INSTALL_APP.replace("__ID__", "X.Y").encode("utf-16-le"))
    assert len(enc) <= 8000, f"encoded length {len(enc)}"


def test_ps_app_redirects_winget_stdio_and_treats_no_upgrade_as_ok():
    assert "RedirectStandardOutput" in PS_INSTALL_APP
    assert "-1978335189" in PS_INSTALL_APP


def test_parse_item_extracts_json_from_winget_chatter():
    # Real WinRM stdout: winget text, then our JSON, then CLIXML progress.
    raw = (
        "No available upgrade found.\r\n"
        "No newer package versions are available from the configured sources.\r\n"
        '{"ok":false,"exitCode":-1978335189,"rebootRequired":false,"detail":"exit -1978335189"}\r\n'
        "\n#< CLIXML\r\n<Objs Version=\"1.1.0.1\""
    )
    p = _parse_item(raw)
    assert p["exitCode"] == -1978335189
    assert p["ok"] is False  # raw script before treating no-upgrade as ok


def test_parse_item_extracts_successful_install_json():
    raw = (
        "Successfully installed\r\n"
        '{"ok":true,"exitCode":0,"rebootRequired":false,"detail":""}\r\n'
        "\n#< CLIXML\r\n"
    )
    p = _parse_item(raw)
    assert p["ok"] is True
    assert p["exitCode"] == 0


def test_ps_mirror_downloads_then_silent_run():
    assert "DownloadFile" in PS_INSTALL_MIRROR
    assert "Start-Process" in PS_INSTALL_MIRROR
    assert "msiexec" in PS_INSTALL_MIRROR
    enc = base64.b64encode(
        PS_INSTALL_MIRROR.replace("__URL__", "https://x/a.exe")
        .replace("__ARGS__", "/S")
        .replace("__TYPE__", "exe")
        .replace("__TAG__", "j1")
        .replace("__HOST__", "x")
        .encode("utf-16-le")
    )
    assert len(enc) <= 8000, f"encoded length {len(enc)}"


def test_build_mirror_url_substitutes_version():
    tpl = "https://mirror.example/vlc/{version}/vlc-{version}-win64.exe"
    assert (
        build_mirror_url(tpl, "3.0.24")
        == "https://mirror.example/vlc/3.0.24/vlc-3.0.24-win64.exe"
    )


def test_build_mirror_url_rejects_unsafe_version():
    tpl = "https://mirror.example/{version}/x.exe"
    assert build_mirror_url(tpl, "") is None
    assert build_mirror_url(tpl, "../evil") is None
    assert build_mirror_url(tpl, "3.0/24") is None
    assert build_mirror_url(tpl, "3.0\\24") is None
    assert build_mirror_url("https://mirror.example/fixed.exe", "1.0") is None


def test_resolve_mirror_installer_type():
    assert (
        resolve_mirror_installer_type(
            AppUpgradeMirror(url="https://x/a.exe", type="msi"),
            "https://x/a.exe",
        )
        == "msi"
    )
    assert (
        resolve_mirror_installer_type(
            AppUpgradeMirror(url="https://x/a.msi"),
            "https://x/a.msi",
        )
        == "msi"
    )
    assert (
        resolve_mirror_installer_type(
            AppUpgradeMirror(url="https://x/a.exe"),
            "https://x/a.exe",
        )
        == "exe"
    )


def test_parse_item_ok():
    raw = '{"ok":true,"exitCode":2,"rebootRequired":true,"detail":""}'
    p = _parse_item(raw)
    assert p["ok"] is True
    assert p["rebootRequired"] is True
    assert p["exitCode"] == 2


def test_load_config_app_upgrade_mirrors(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        textwrap.dedent(
            """
            networks: []
            profiles: []
            rules: []
            app_upgrade_mirrors:
              VideoLAN.VLC:
                url: "https://mirror.example/vlc/{version}/vlc-{version}.exe"
                silent_args: "/L=1033 /S"
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    cfg = load_config(cfg_path)
    assert "VideoLAN.VLC" in cfg.app_upgrade_mirrors
    m = cfg.app_upgrade_mirrors["VideoLAN.VLC"]
    assert "{version}" in m.url
    assert m.silent_args == "/L=1033 /S"
    assert m.type is None


def test_run_patch_install_runs_os_then_apps(monkeypatch):
    cfg = Config()
    calls: list[str] = []

    class FakeSession:
        pass

    monkeypatch.setattr("patch_install._open_session", lambda ip, c: FakeSession())
    monkeypatch.setattr("patch_install.time.sleep", lambda *_a, **_k: None)

    def fake_run(session, script, timeout):
        calls.append(script)

        class R:
            status_code = 0
            std_err = b""
            if "Register-ScheduledTask" in script:
                std_out = (
                    b'{"ok":true,"started":true,"exitCode":0,'
                    b'"rebootRequired":false,"detail":"started"}'
                )
            elif "out.json" in script:
                std_out = (
                    b'{"ok":true,"exitCode":2,"rebootRequired":false,"detail":""}'
                )
            else:
                std_out = (
                    b'{"ok":true,"exitCode":0,"rebootRequired":false,"detail":""}'
                )

        return R()

    monkeypatch.setattr("patch_install._run_ps_timeout", fake_run)

    status, result = run_patch_install(
        cfg,
        {
            "id": "job-1",
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
    assert result["items"][0]["ok"] is True
    assert result["items"][1]["kind"] == "app"
    assert any("KB9" in c for c in calls)
    assert any("Google.Chrome" in c for c in calls)


def test_run_patch_install_mirror_fallback_on_winget_fail(monkeypatch):
    cfg = Config(
        app_upgrade_mirrors={
            "VideoLAN.VLC": AppUpgradeMirror(
                url="https://mirror.example/vlc/{version}/vlc-{version}.exe",
                silent_args="/L=1033 /S",
            )
        }
    )
    calls: list[str] = []

    monkeypatch.setattr("patch_install._open_session", lambda ip, c: object())

    def fake_run(session, script, timeout):
        calls.append(script)
        if "DownloadFile" in script:
            out = b'{"ok":true,"exitCode":0,"rebootRequired":false,"detail":"mirror:mirror.example"}'
        else:
            out = b'{"ok":false,"exitCode":-2147012867,"rebootRequired":false,"detail":"exit -2147012867"}'

        class R:
            status_code = 0
            std_out = out
            std_err = b""

        return R()

    monkeypatch.setattr("patch_install._run_ps_timeout", fake_run)

    status, result = run_patch_install(
        cfg,
        {
            "id": "abc-123",
            "targetIp": "10.0.0.1",
            "selection": {
                "os": [],
                "apps": [
                    {
                        "packageId": "VideoLAN.VLC",
                        "name": "VLC",
                        "version": "3.0.20",
                        "available": "3.0.24",
                    }
                ],
            },
        },
    )
    assert status == "succeeded"
    assert len(calls) == 2
    assert "VideoLAN.VLC" in calls[0]
    assert "DownloadFile" in calls[1]
    assert "3.0.24" in calls[1]
    assert "/L=1033 /S" in calls[1]
    assert result["items"][0]["ok"] is True
    assert "mirror:" in (result["items"][0]["outputTail"] or "")


def test_run_patch_install_no_mirror_keeps_winget_failure(monkeypatch):
    cfg = Config()
    calls: list[str] = []
    monkeypatch.setattr("patch_install._open_session", lambda ip, c: object())

    def fake_run(session, script, timeout):
        calls.append(script)

        class R:
            status_code = 0
            std_out = (
                b'{"ok":false,"exitCode":1,"rebootRequired":false,"detail":"exit 1"}'
            )
            std_err = b""

        return R()

    monkeypatch.setattr("patch_install._run_ps_timeout", fake_run)

    status, result = run_patch_install(
        cfg,
        {
            "id": "j",
            "targetIp": "10.0.0.1",
            "selection": {
                "os": [],
                "apps": [
                    {
                        "packageId": "VideoLAN.VLC",
                        "name": "VLC",
                        "version": "1",
                        "available": "2",
                    }
                ],
            },
        },
    )
    assert status == "failed"
    assert len(calls) == 1
    assert result["items"][0]["ok"] is False
