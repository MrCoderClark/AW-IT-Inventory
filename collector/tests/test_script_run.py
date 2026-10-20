"""Tests for script_run wrapper (spec 32)."""

from __future__ import annotations

import base64
import json

from script_run import (
    _CHUNK,
    _ENCODED_SAFE,
    _encoded_cmd_len,
    _ps_quote,
    _wrap_body,
    _wrap_file,
    run_script_job,
)
from config import Config


def test_wrap_body_embeds_script_as_base64():
    wrapped = _wrap_body("Write-Output 'hi'")
    assert "FromBase64String" in wrapped
    assert "exitCode" in wrapped
    assert "outputTail" in wrapped
    assert "[scriptblock]::Create" in wrapped
    assert "Invoke-Expression" not in wrapped
    assert "$__prevEap" in wrapped
    start = wrapped.index("FromBase64String('") + len("FromBase64String('")
    end = wrapped.index("')", start)
    raw = base64.b64decode(wrapped[start:end]).decode("utf-16-le")
    assert raw == "Write-Output 'hi'"


def test_spooler_sized_script_needs_file_staging():
    """A realistic library script exceeds the EncodedCommand cap when inlined."""
    body = """# Reset Windows Print Spooler
$ErrorActionPreference = "Stop"
try {
    Write-Output "Stopping Print Spooler..."
    Stop-Service -Name Spooler -Force -ErrorAction Stop
    Write-Output "Clearing queued print jobs..."
    $PrinterQueue = "$env:SystemRoot\\System32\\spool\\PRINTERS"
    Get-ChildItem -Path $PrinterQueue -Force -ErrorAction SilentlyContinue |
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    Write-Output "Starting Print Spooler..."
    Start-Service -Name Spooler -ErrorAction Stop
    Start-Sleep -Seconds 2
    $Service = Get-Service -Name Spooler
    Write-Output "Service: $($Service.Name)"
    Write-Output "Status: $($Service.Status)"
    if ($Service.Status -ne "Running") {
        throw "Print Spooler did not reach the Running state."
    }
    Write-Output "SUCCESS: Print Spooler reset completed."
}
catch {
    Write-Output "ERROR: $($_.Exception.Message)"
    throw
}
"""
    assert _encoded_cmd_len(_wrap_body(body)) > _ENCODED_SAFE
    file_wrap = _wrap_file(r"C:\Windows\Temp\h2tecs-script-test.ps1")
    assert _encoded_cmd_len(file_wrap) <= _ENCODED_SAFE
    assert "Get-Content" in file_wrap
    assert "h2tecs-script-test.ps1" in file_wrap


def test_upload_chunk_stays_under_command_line_limit():
    part = "A" * _CHUNK
    chunk_ps = (
        f"Add-Content -LiteralPath {_ps_quote(r'C:\\Temp\\x.b64')} "
        f"-Value '{part}' -NoNewline -Encoding Ascii"
    )
    assert _encoded_cmd_len(chunk_ps) < 7500


def test_run_script_job_parses_json_result(monkeypatch):
    cfg = Config()

    class FakeSession:
        pass

    monkeypatch.setattr("script_run._open_session", lambda ip, c: FakeSession())

    def fake_run(session, script, timeout):
        class R:
            status_code = 0
            std_out = json.dumps({"exitCode": 0, "outputTail": "ok"}).encode()
            std_err = b""

        return R()

    monkeypatch.setattr("script_run._run_ps_timeout", fake_run)

    status, result = run_script_job(
        cfg,
        {
            "targetIp": "10.0.0.1",
            "scriptSnapshot": {
                "name": "Ping",
                "body": "1",
                "timeoutSeconds": 60,
            },
        },
    )
    assert status == "succeeded"
    assert result["exitCode"] == 0
    assert result["outputTail"] == "ok"


def test_run_script_job_stages_large_body(monkeypatch):
    cfg = Config()
    staged: list[str] = []
    ran: list[str] = []

    class FakeSession:
        def run_ps(self, script):
            class R:
                status_code = 0
                std_out = b"C:\\Windows\\Temp"
                std_err = b""

            return R()

    monkeypatch.setattr("script_run._open_session", lambda ip, c: FakeSession())

    def fake_stage(session, body, remote_ps1):
        staged.append(remote_ps1)

    def fake_run(session, script, timeout):
        ran.append(script)

        class R:
            status_code = 0
            std_out = json.dumps({"exitCode": 0, "outputTail": "SUCCESS"}).encode()
            std_err = b""

        return R()

    monkeypatch.setattr("script_run._stage_body", fake_stage)
    monkeypatch.setattr("script_run._run_ps_timeout", fake_run)

    big = "Write-Output 'x'\n" * 400  # forces file staging
    assert _encoded_cmd_len(_wrap_body(big)) > _ENCODED_SAFE

    status, result = run_script_job(
        cfg,
        {
            "id": "524d5ab1-3403-4c23-aea4-33ef8c74986b",
            "targetIp": "10.0.0.1",
            "scriptSnapshot": {
                "name": "Big",
                "body": big,
                "timeoutSeconds": 60,
            },
        },
    )
    assert status == "succeeded"
    assert staged and "h2tecs-script-" in staged[0]
    assert ran and "Get-Content" in ran[0]
