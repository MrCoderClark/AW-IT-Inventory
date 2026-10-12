"""Tests for software deployment orchestration (software_deploy.py, spec 23).

WinRM, the installer pull, and the file transfer are mocked; the logic under test is
run_deployment's step sequencing: run in order, stop on the first failure (skipping
the rest), map exit 0/3010 to success, and abort an install step whose on-arrival
SHA-256 doesn't match (integrity).
"""

from __future__ import annotations

import hashlib

import software_deploy
from config import Config

DATA = b"installer-bytes"
SHA = hashlib.sha256(DATA).hexdigest()


def _script(i: str, name: str = "script"):
    return {"id": i, "kind": "script", "name": name, "script": "Write-Output hi"}


def _install(i: str, name: str = "app", sha: str = SHA):
    return {
        "id": i,
        "kind": "install",
        "name": name,
        "installerType": "exe",
        "fileName": "app.exe",
        "silentArgs": "/S",
        "sha256": sha,
    }


def _job(steps: list[dict]) -> dict:
    return {
        "id": "d1",
        "targetIp": "192.168.70.5",
        "workerId": "w1",
        "claimedAt": "2026-10-12T10:00:00.000Z",
        "packageSnapshot": {"name": "App", "version": "1.0", "steps": steps},
    }


def _patch_common(monkeypatch):
    # One session, no real WinRM / transfer.
    monkeypatch.setattr(software_deploy, "_with_session", lambda c, ip, do: do(object(), object()))
    monkeypatch.setattr(software_deploy, "_ps", lambda s, script: {"exitCode": 0, "stdout": "", "stderr": ""})
    monkeypatch.setattr(software_deploy, "_cleanup", lambda s, d: None)
    monkeypatch.setattr(software_deploy, "_download_file", lambda c, t, j, step, fn: DATA)
    monkeypatch.setattr(software_deploy, "_put_file", lambda s, p, ip, d, rd, fn, c: f"{rd}\\{fn}")


def test_all_steps_ok_succeeds(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(software_deploy, "_run_script", lambda s, script: (0, "ok", ""))
    monkeypatch.setattr(software_deploy, "_run_install", lambda s, p, t, a: (0, "", ""))

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([_script("s1"), _install("s2")])
    )

    assert status == "succeeded"
    assert result["outcome"] == "installed"
    assert [x["status"] for x in result["steps"]] == ["ok", "ok"]


def test_reboot_required_still_succeeds(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(software_deploy, "_run_install", lambda s, p, t, a: (3010, "", ""))

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([_install("s1")])
    )

    assert status == "succeeded" and result["outcome"] == "installed"
    assert result["rebootRequired"] is True


def test_failed_step_stops_and_skips_rest(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(software_deploy, "_run_install", lambda s, p, t, a: (1603, "", "fatal"))
    monkeypatch.setattr(software_deploy, "_run_script", lambda s, script: (0, "", ""))

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([_install("s1"), _script("s2")])
    )

    assert status == "failed" and result["outcome"] == "install-failed"
    assert [x["status"] for x in result["steps"]] == ["failed", "skipped"]


def test_integrity_mismatch_aborts_without_running(monkeypatch):
    _patch_common(monkeypatch)
    # The pulled bytes don't match the step's frozen sha256.
    monkeypatch.setattr(software_deploy, "_download_file", lambda c, t, j, step, fn: b"tampered")
    ran = {"install": False}
    monkeypatch.setattr(
        software_deploy, "_run_install",
        lambda s, p, t, a: (ran.__setitem__("install", True), (0, "", ""))[1],
    )

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([_install("s1")])
    )

    assert status == "failed" and result["outcome"] == "integrity-failed"
    assert ran["install"] is False  # never ran the installer
    assert "integrity" in result["steps"][0]["outputTail"]


def test_companion_files_transferred_and_dir_token_substituted(monkeypatch):
    _patch_common(monkeypatch)
    put_names: list[str] = []
    monkeypatch.setattr(
        software_deploy, "_put_file",
        lambda s, p, ip, d, rd, fn, c: (put_names.append(fn), f"{rd}\\{fn}")[1],
    )
    captured: dict = {}
    monkeypatch.setattr(
        software_deploy, "_run_install",
        lambda s, path, t, a: (captured.__setitem__("args", a), (0, "", ""))[1],
    )
    step = {
        **_install("s1"),
        "silentArgs": '/s /f1"%DIR%\\app.iss" /v"/qn"',
        "companions": [
            {"storageKey": "k", "sha256": SHA, "fileName": "app.iss", "fileSize": 3}
        ],
    }

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([step])
    )

    # Both the installer and its companion are staged on the target.
    assert "app.exe" in put_names and "app.iss" in put_names
    # %DIR% is replaced with the on-target temp dir before the installer runs.
    assert "%DIR%" not in captured["args"] and "opus-deploy" in captured["args"]
    assert status == "succeeded"


def test_continue_on_error_runs_next_step(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(software_deploy, "_run_script", lambda s, script: (0, "", ""))
    monkeypatch.setattr(software_deploy, "_run_install", lambda s, p, t, a: (1, "", "warn"))
    step = {**_install("s1"), "continueOnError": True}

    status, result = software_deploy.run_deployment(
        Config(ingest_url="http://web"), "tok", _job([step, _script("s2")])
    )

    # The failed step is recorded (for visibility) and the next step still runs;
    # because it's continueOnError, its failure is tolerated, so the deployment as a
    # whole succeeds (conventional continue-on-error / ignore_errors semantics).
    assert [x["status"] for x in result["steps"]] == ["failed", "ok"]
    assert status == "succeeded" and result["outcome"] == "installed"
