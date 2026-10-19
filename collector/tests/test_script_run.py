"""Tests for script_run wrapper (spec 32)."""

from __future__ import annotations

import base64
import json

from script_run import _wrap_body, run_script_job
from config import Config


def test_wrap_body_embeds_script_as_base64():
    wrapped = _wrap_body("Write-Output 'hi'")
    assert "FromBase64String" in wrapped
    assert "exitCode" in wrapped
    assert "outputTail" in wrapped
    # Ensure the payload round-trips.
    # Extract the base64 literal between quotes after FromBase64String(
    start = wrapped.index("FromBase64String('") + len("FromBase64String('")
    end = wrapped.index("')", start)
    raw = base64.b64decode(wrapped[start:end]).decode("utf-16-le")
    assert raw == "Write-Output 'hi'"


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
