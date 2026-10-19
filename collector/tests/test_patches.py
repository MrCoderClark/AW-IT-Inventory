"""Tests for Windows update inventory parsing (spec 31).

PS_UPDATES / PS_APP_UPGRADES JSON is parsed into WindowsUpdates. Duplicate
hotfix / package ids collapse; a missing InstalledOn stays None (never epoch);
a failed or skipped app collect does not invent upgrades.
"""

from __future__ import annotations

from collect_windows import _parse_app_upgrades, _parse_updates


def test_parse_updates_reads_pending_reboot_and_hotfixes():
    data = {
        "pending_reboot": True,
        "hotfixes": [
            {
                "id": "KB5034441",
                "description": "Security Update",
                "installed_on": "2024-01-15",
            },
            {"id": "KB5034123", "description": "Update", "installed_on": ""},
        ],
    }
    u = _parse_updates(data)
    assert u.pending_reboot is True
    assert [h.id for h in u.hotfixes] == ["KB5034441", "KB5034123"]
    assert u.hotfixes[0].description == "Security Update"
    assert u.hotfixes[0].installed_on == "2024-01-15"
    assert u.hotfixes[1].installed_on is None  # empty string, not epoch


def test_parse_updates_collapses_duplicate_hotfix_ids():
    data = {
        "pending_reboot": False,
        "hotfixes": [
            {"id": "KB1", "description": "first"},
            {"id": "KB1", "description": "dup"},
            {"id": "KB2", "description": "other"},
        ],
    }
    u = _parse_updates(data)
    assert [h.id for h in u.hotfixes] == ["KB1", "KB2"]
    assert u.hotfixes[0].description == "first"


def test_parse_updates_coerces_single_hotfix_object():
    data = {
        "pending_reboot": False,
        "hotfixes": {"id": "KB9", "description": "Update"},
    }
    u = _parse_updates(data)
    assert [h.id for h in u.hotfixes] == ["KB9"]


def test_parse_updates_rejects_epoch_and_garbage_dates():
    data = {
        "pending_reboot": False,
        "hotfixes": [
            {"id": "KB1", "installed_on": "1970-01-01"},
            {"id": "KB2", "installed_on": "not-a-date"},
            {"id": "KB3", "installed_on": "2024-06-01"},
        ],
    }
    u = _parse_updates(data)
    by_id = {h.id: h.installed_on for h in u.hotfixes}
    assert by_id["KB1"] is None
    assert by_id["KB2"] is None
    assert by_id["KB3"] == "2024-06-01"


def test_parse_app_upgrades_lists_available_packages():
    data = {
        "winget_available": True,
        "app_upgrades": [
            {
                "id": "Google.Chrome",
                "name": "Google Chrome",
                "version": "128.0.0.0",
                "available": "129.0.0.0",
                "source": "winget",
            }
        ],
    }
    available, upgrades, detail = _parse_app_upgrades(data)
    assert available is True
    assert detail is None
    assert upgrades is not None
    assert upgrades[0].id == "Google.Chrome"
    assert upgrades[0].name == "Google Chrome"
    assert upgrades[0].version == "128.0.0.0"
    assert upgrades[0].available == "129.0.0.0"
    assert upgrades[0].source == "winget"


def test_parse_app_upgrades_failed_client_returns_false_and_no_list():
    """A still-unusable client after bootstrap → winget_available false and
    app_upgrades None so ingest leaves prior rows (AC-8)."""
    available, upgrades, detail = _parse_app_upgrades(
        {
            "winget_available": False,
            "app_upgrades": [],
            "detail": "no InstallLocation winget.exe",
        }
    )
    assert available is False
    assert upgrades is None
    assert detail == "no InstallLocation winget.exe"


def test_parse_app_upgrades_client_ok_with_empty_list():
    """Module/CLI present but nothing outdated (or list soft-failed) → available
    true and empty list so ingest replaces with zero upgrades, not 'missing'."""
    available, upgrades, detail = _parse_app_upgrades(
        {"winget_available": True, "app_upgrades": []}
    )
    assert available is True
    assert upgrades == []
    assert detail is None

def test_ps_app_upgrades_detects_winget_exe_not_only_ps_module():
    """Regression: winget.exe can be installed without Microsoft.WinGet.Client
    in the WinRM session — the script must look for the CLI too."""
    from collect_windows import PS_APP_UPGRADES

    assert "winget" in PS_APP_UPGRADES.lower()
    assert "Get-WinGetPackage" in PS_APP_UPGRADES
    # List failure must not flip the available flag (catch must not set $ok=$false).
    assert "catch { $ok = $false" not in PS_APP_UPGRADES


def test_ps_app_upgrades_prefers_appx_install_location_over_windowsapps_stub():
    """Get-Command winget resolves to %LocalAppData%\\Microsoft\\WindowsApps\\winget.exe
    (AppX execution alias, version 0.0.0.0). That stub works interactively but
    usually fails under WinRM ('logon session does not exist'). The real binary
    is under the DesktopAppInstaller InstallLocation — look there first."""
    from collect_windows import PS_APP_UPGRADES

    assert "InstallLocation" in PS_APP_UPGRADES
    assert "WindowsApps" in PS_APP_UPGRADES  # we still know about the stub
    # InstallLocation lookup must appear before returning a Get-Command path.
    assert PS_APP_UPGRADES.index("InstallLocation") < PS_APP_UPGRADES.index(
        "Get-Command winget"
    )


def test_ps_app_upgrades_is_valid_powershell():
    """Compressed scripts have broken brace matching before — parse-check here."""
    import base64
    import subprocess
    import tempfile
    from pathlib import Path

    from collect_windows import PS_APP_UPGRADES

    # pywinrm sends powershell -EncodedCommand <b64>; stay under Windows ~8KB argv.
    enc = base64.b64encode(PS_APP_UPGRADES.encode("utf-16-le"))
    assert len(enc) <= 8000, f"PS_APP_UPGRADES encoded length {len(enc)} exceeds WinRM cap"

    checker = r"""
$e=$null; $t=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$t, [ref]$e)
if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }
Write-Output 'PARSE_OK'
"""
    with tempfile.TemporaryDirectory() as td:
        script = Path(td) / "app_upgrades.ps1"
        check = Path(td) / "check.ps1"
        script.write_text(PS_APP_UPGRADES, encoding="utf-8")
        check.write_text(checker, encoding="utf-8")
        r = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(check), str(script)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "PARSE_OK" in r.stdout


def test_parse_app_upgrades_collapses_duplicate_package_ids():
    data = {
        "winget_available": True,
        "app_upgrades": [
            {"id": "Google.Chrome", "name": "Chrome"},
            {"id": "Google.Chrome", "name": "Chrome dup"},
        ],
    }
    available, upgrades, _ = _parse_app_upgrades(data)
    assert available is True
    assert upgrades is not None
    assert [u.id for u in upgrades] == ["Google.Chrome"]
    assert upgrades[0].name == "Chrome"


def test_parse_app_upgrades_skips_rows_without_id_or_name():
    data = {
        "winget_available": True,
        "app_upgrades": [
            {"id": "", "name": "Nope"},
            {"id": "Foo.Bar", "name": ""},
            {"id": "Foo.Baz", "name": "Baz"},
        ],
    }
    _, upgrades, _ = _parse_app_upgrades(data)
    assert upgrades is not None
    assert [u.id for u in upgrades] == ["Foo.Baz"]
