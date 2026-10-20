"""Run a frozen library script on one Computer (spec 32).

Claims are handled by the worker; this module opens WinRM, executes the
snapshot body with a wall-clock timeout, and returns (status, result).

pywinrm sends ``run_ps`` as ``powershell -EncodedCommand <b64>`` on the WinRS
cmd line (~8 KB cap). Embedding a library body (up to 64 KB) in that command
fails with "The command line is too long". Small scripts still run inline;
larger ones are staged to a temp .ps1 via base64 chunks (same pattern as
printer-install / software-deploy fallback).
"""

from __future__ import annotations

import base64
import json
import re

import winrm
from rich.console import Console

from collect_windows import _run_ps_timeout, _winrm_username
from config import Config
from creds import resolve_profiles

console = Console()

# Match install_printer._CHUNK — each Add-Content call must stay under the
# EncodedCommand cap after UTF-16+base64 (~2.67x).
_CHUNK = 2_000
# Safe ceiling for len(base64(utf-16-le(script))) before we stage to a file.
_ENCODED_SAFE = 5_500

_UUID_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")


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


def _ps_quote(s: str) -> str:
    """Single-quoted PowerShell string literal."""
    return "'" + s.replace("'", "''") + "'"


def _encoded_cmd_len(script: str) -> int:
    """Length of the base64 blob pywinrm puts on the WinRS command line."""
    return len(base64.b64encode(script.encode("utf-16-le")))


def _runner_core(load_line: str) -> str:
    """Shared capture/JSON trailer. ``load_line`` assigns $__b (the body text)."""
    return "\n".join(
        [
            "$__prevEap = $ErrorActionPreference",
            "$ErrorActionPreference = 'Continue'",
            load_line,
            "$__lines = New-Object System.Collections.Generic.List[string]",
            "$__code = 0",
            "try {",
            "  if (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue) {",
            "    Remove-Variable -Name LASTEXITCODE -Scope Global -Force -ErrorAction SilentlyContinue",
            "  }",
            "  $__sb = [scriptblock]::Create($__b)",
            "  & $__sb 2>&1 | ForEach-Object {",
            "    if ($_ -is [System.Management.Automation.ErrorRecord]) {",
            "      [void]$__lines.Add($_.ToString())",
            "    } else {",
            "      [void]$__lines.Add((($_ | Out-String).TrimEnd()))",
            "    }",
            "  }",
            "  # Do not use $?; 2>&1 ErrorRecords flip it even when the script handled them.",
            "  if ((Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue) -and",
            "      ($null -ne $global:LASTEXITCODE) -and ($global:LASTEXITCODE -ne 0)) {",
            "    $__code = [int]$global:LASTEXITCODE",
            "  }",
            "} catch {",
            "  $__code = 1",
            "  [void]$__lines.Add(('ERROR: ' + $_.Exception.Message))",
            "} finally {",
            "  $ErrorActionPreference = $__prevEap",
            "}",
            # Keep head + tail so long failure lists don't bury the summary.
            "$__all = ($__lines -join [Environment]::NewLine).Trim()",
            "$__headN = 1500; $__tailN = 2500",
            "if ($__all.Length -le ($__headN + $__tailN)) {",
            "  $__tail = $__all",
            "} else {",
            "  $__tail = $__all.Substring(0, $__headN) + \"`n…`n\" + "
            + "$__all.Substring($__all.Length - $__tailN)",
            "}",
            "[ordered]@{ exitCode = [int]$__code; outputTail = $__tail } | ConvertTo-Json -Compress",
        ]
    )


def _wrap_body(body: str) -> str:
    """Inline runner: body embedded as base64 (only for tiny scripts)."""
    b64 = base64.b64encode(body.encode("utf-16-le")).decode("ascii")
    load = (
        f"$__b = [Text.Encoding]::Unicode.GetString("
        f"[Convert]::FromBase64String('{b64}'))"
    )
    return _runner_core(load)


def _wrap_file(remote_ps1: str) -> str:
    """File runner: load body from a staged .ps1, then delete it."""
    q = _ps_quote(remote_ps1)
    load = (
        f"$__path = {q}; "
        f"$__b = Get-Content -LiteralPath $__path -Raw -Encoding UTF8; "
        f"Remove-Item -LiteralPath $__path -Force -ErrorAction SilentlyContinue"
    )
    return _runner_core(load)


def _stage_body(session: winrm.Session, body: str, remote_ps1: str) -> None:
    """Write ``body`` to ``remote_ps1`` via base64 chunks over WinRM."""
    remote_b64 = remote_ps1 + ".b64"
    q_ps1 = _ps_quote(remote_ps1)
    q_b64 = _ps_quote(remote_b64)

    prep = (
        f"if (Test-Path -LiteralPath {q_b64}) {{ Remove-Item -LiteralPath {q_b64} -Force }}; "
        f"if (Test-Path -LiteralPath {q_ps1}) {{ Remove-Item -LiteralPath {q_ps1} -Force }}"
    )
    r = session.run_ps(prep)
    if r.status_code != 0:
        err = (r.std_err or b"").decode("utf-8", errors="ignore")[:200]
        raise RuntimeError(f"stage prep failed: {err or r.status_code}")

    b64 = base64.b64encode(body.encode("utf-8")).decode("ascii")
    for i in range(0, len(b64), _CHUNK):
        part = b64[i : i + _CHUNK]
        # part is base64 alphabet — safe inside single quotes
        chunk_ps = (
            f"Add-Content -LiteralPath {q_b64} -Value '{part}' "
            f"-NoNewline -Encoding Ascii"
        )
        assert _encoded_cmd_len(chunk_ps) < 7500, "upload chunk exceeds EncodedCommand cap"
        r = session.run_ps(chunk_ps)
        if r.status_code != 0:
            err = (r.std_err or b"").decode("utf-8", errors="ignore")[:200]
            raise RuntimeError(f"stage chunk {i} failed: {err or r.status_code}")

    decode = (
        f"[IO.File]::WriteAllText({q_ps1}, "
        f"[Text.Encoding]::UTF8.GetString("
        f"[Convert]::FromBase64String((Get-Content -LiteralPath {q_b64} -Raw))), "
        f"[Text.UTF8Encoding]::new($false)); "
        f"Remove-Item -LiteralPath {q_b64} -Force -ErrorAction SilentlyContinue"
    )
    r = session.run_ps(decode)
    if r.status_code != 0:
        err = (r.std_err or b"").decode("utf-8", errors="ignore")[:200]
        raise RuntimeError(f"stage decode failed: {err or r.status_code}")


def _remote_temp_ps1(session: winrm.Session, job_id: str) -> str:
    r = session.run_ps("$env:TEMP")
    if r.status_code != 0 or not (r.std_out or b"").strip():
        raise RuntimeError("could not resolve $env:TEMP on target")
    temp = (r.std_out or b"").decode("utf-8", errors="ignore").strip()
    safe = _UUID_SAFE.sub("", job_id)[:12] or "job"
    return f"{temp}\\h2tecs-script-{safe}.ps1"


def _parse_result(r) -> tuple[str, dict]:
    raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip()
    err = (r.std_err or b"").decode("utf-8", errors="ignore").strip()
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        tail = (raw or err)[-4000:]
        return "failed", {"exitCode": r.status_code, "outputTail": tail or "unparseable"}

    exit_code = data.get("exitCode")
    if not isinstance(exit_code, int):
        exit_code = r.status_code
    tail = data.get("outputTail")
    if not isinstance(tail, str):
        tail = (raw or err)[-4000:] or None
    elif not (tail or "").strip() and err:
        tail = err[-4000:]

    status = "succeeded" if exit_code == 0 else "failed"
    return status, {"exitCode": exit_code, "outputTail": tail}


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

    inline = _wrap_body(body)
    if _encoded_cmd_len(inline) <= _ENCODED_SAFE:
        script = inline
    else:
        remote_ps1 = _remote_temp_ps1(session, str(job.get("id") or "job"))
        _stage_body(session, body, remote_ps1)
        script = _wrap_file(remote_ps1)
        if _encoded_cmd_len(script) > _ENCODED_SAFE:
            raise RuntimeError("script runner wrapper exceeds EncodedCommand cap")

    r = _run_ps_timeout(session, script, timeout)
    if r is None:
        return "failed", {"exitCode": None, "outputTail": "timeout"}
    return _parse_result(r)
