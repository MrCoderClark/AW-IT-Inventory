"""Run a frozen library script on one Computer (spec 32).

Claims are handled by the worker; this module opens WinRM, executes the
snapshot body with a wall-clock timeout, and returns (status, result).
"""

from __future__ import annotations

import base64
import json

import winrm
from rich.console import Console

from collect_windows import _run_ps_timeout, _winrm_username
from config import Config
from creds import resolve_profiles

console = Console()


def _open_session(ip: str, config: Config) -> winrm.Session | None:
    endpoint = f"{config.winrm_scheme}://{ip}:{config.ports.winrm}/wsman"
    for prof in resolve_profiles(ip, config):
        if not prof.password:
            continue
        try:
            session = winrm.Session(
                endpoint,
                auth=(_winrm_username(prof.username), prof.password),
                transport=config.winrm_transport,
                server_cert_validation="ignore",
            )
            r = session.run_ps("$true")
            if r.status_code == 0:
                return session
        except Exception:  # noqa: BLE001
            continue
    return None


def _wrap_body(body: str) -> str:
    """Run the library body and emit a small JSON result trailer.

    Body is base64-utf16 so we never break on quotes/braces in the script.
    """
    b64 = base64.b64encode(body.encode("utf-16-le")).decode("ascii")
    return (
        "$ErrorActionPreference='Continue'\n"
        f"$__b=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{b64}'))\n"
        "$__out=@(); $__err=@()\n"
        "try {\n"
        "  $__r = Invoke-Expression $__b 2>&1 | ForEach-Object {\n"
        "    if ($_ -is [System.Management.Automation.ErrorRecord]) {\n"
        "      $__err += $_.ToString(); $_ | Out-String\n"
        "    } else { $_; }\n"
        "  }\n"
        "  $__out = @($__r | Out-String)\n"
        "  $__code = 0\n"
        "} catch {\n"
        "  $__err += $_.ToString()\n"
        "  $__code = 1\n"
        "}\n"
        "if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { $__code = [int]$LASTEXITCODE }\n"
        "$__tail = (($__out + $__err) -join \"`n\").Trim()\n"
        "if ($__tail.Length -gt 4000) { $__tail = $__tail.Substring($__tail.Length - 4000) }\n"
        "[ordered]@{ exitCode = [int]$__code; outputTail = $__tail } | ConvertTo-Json -Compress\n"
    )


def run_script_job(config: Config, job: dict) -> tuple[str, dict]:
    """Execute one claimed script-run job. Returns (status, result)."""
    ip = job["targetIp"]
    snap = job.get("scriptSnapshot") or {}
    body = snap.get("body") or ""
    timeout = float(snap.get("timeoutSeconds") or 120)
    timeout = max(30.0, min(timeout, 600.0))

    if not body.strip():
        return "failed", {"exitCode": None, "outputTail": "empty script body"}

    session = _open_session(ip, config)
    if session is None:
        raise RuntimeError(f"no WinRM credentials worked for {ip}")

    script = _wrap_body(body)
    # EncodedCommand length: if wrap is huge, still try; _run_ps_timeout abandons.
    r = _run_ps_timeout(session, script, timeout)
    if r is None:
        return "failed", {"exitCode": None, "outputTail": "timeout"}

    raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip()
    err = (r.std_err or b"").decode("utf-8", errors="ignore").strip()
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        data = {}
        tail = (raw or err)[-4000:]
        return "failed", {"exitCode": r.status_code, "outputTail": tail or "unparseable"}

    exit_code = data.get("exitCode")
    if not isinstance(exit_code, int):
        exit_code = r.status_code
    tail = data.get("outputTail")
    if not isinstance(tail, str):
        tail = (raw or err)[-4000:] or None
    elif err and "outputTail" in data:
        # Keep script tail; append stderr hint if empty
        if not (tail or "").strip() and err:
            tail = err[-4000:]

    status = "succeeded" if exit_code == 0 else "failed"
    return status, {"exitCode": exit_code, "outputTail": tail}
