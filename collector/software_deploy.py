"""Software deployment (spec 23).

Outbound-only, like the rest of the collector: the worker claims a deployment from
the web app, opens WinRM into the target (the same channel used to scan it), and
runs the package's **ordered steps** — inline PowerShell (`script`) and uploaded
MSI/EXE installers (`install`) — stopping on the first failure. Each installer is
pulled from the web (a `deploy:agent`-scoped, claim-fenced endpoint), its SHA-256
re-verified on arrival, transferred into the target (SMB admin-share fast path /
base64-over-WinRM fallback, shared with printer install), and run silently. Per-step
exit codes + output are reported back.

Installers run via ``Start-Process -Wait -PassThru``: a GUI-subsystem setup.exe does
NOT block PowerShell's ``&`` call operator, so we must explicitly wait and read the
real ExitCode. MSI exit 0 / 3010 (reboot-required) are success; EXE codes are
installer-defined (0/3010 treated as success, anything else a failure).
"""

from __future__ import annotations

import base64
import hashlib

import httpx
import winrm
from rich.console import Console

from config import Config
from install_printer import (
    _SMB_AVAILABLE,
    _cleanup,
    _ps,
    _psstr,
    _unc,
    _winrm_username,
    _with_session,
)
from remote_session import _clean_stderr

console = Console()

# msiexec: 0 ok, 3010 success-but-reboot-required. Reused as the generic success set.
SUCCESS_EXITS = {0, 3010}
_OUTPUT_TAIL = 4000
# base64-over-WinRM chunk (fallback only; SMB is the real transfer — base64 is far
# too slow for a 90 MB installer, so SMB must be available in practice).
_CHUNK = 2_000


def _dec(b: bytes | None) -> str:
    return (b or b"").decode("utf-8", "ignore")


def _tail(out: str, err: str) -> str:
    parts = []
    if out.strip():
        parts.append(out.strip())
    if err.strip():
        parts.append("[stderr] " + err.strip())
    return "\n".join(parts)[-_OUTPUT_TAIL:]


# ---------------- Pull + transfer the installer ----------------


def _download_file(
    config: Config, token: str, job: dict, step: dict, file_name: str
) -> bytes:
    """Pull one of an install step's files (installer or a companion, by name) from
    the web, fenced by the claim."""
    resp = httpx.get(
        f"{config.ingest_url}/api/deploy/{job['id']}/steps/{step['id']}/file",
        params={
            "workerId": job["workerId"],
            "claimedAt": job["claimedAt"],
            "file": file_name,
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=600,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"file pull failed for {file_name} ({resp.status_code}): {resp.text[:200]}"
        )
    return resp.content


def _put_file(
    session: winrm.Session, prof, ip: str, data: bytes, remote_dir: str,
    filename: str, config: Config,
) -> str:
    """Get the installer onto the target (SMB fast / base64 fallback). Returns its
    on-target path. The remote dir is created by the caller."""
    remote_path = f"{remote_dir}\\{filename}"
    user = _winrm_username(prof.username)
    if config.install_smb_transfer and _SMB_AVAILABLE:
        try:
            import smbclient

            with smbclient.open_file(
                _unc(ip, remote_path), mode="wb", username=user, password=prof.password
            ) as f:
                f.write(data)
            return remote_path
        except Exception as e:  # noqa: BLE001 — SMB blocked/denied → fall back
            console.print(
                f"  [yellow]SMB copy failed ({type(e).__name__}: {e}); "
                "falling back to slow WinRM base64.[/yellow]"
            )
    _put_file_b64(session, data, remote_dir, remote_path)
    return remote_path


def _put_file_b64(
    session: winrm.Session, data: bytes, remote_dir: str, remote_path: str
) -> None:
    b64_path = f"{remote_dir}\\upload.b64"
    first = _ps(
        session,
        f"if (Test-Path {_psstr(b64_path)}) {{ Remove-Item {_psstr(b64_path)} -Force }}",
    )
    if first["exitCode"] != 0:
        raise RuntimeError(f"stage failed: {first['stderr'][:200]}")
    b64 = base64.b64encode(data).decode("ascii")
    for i in range(0, len(b64), _CHUNK):
        part = b64[i : i + _CHUNK]
        step = _ps(
            session,
            f"Add-Content -Path {_psstr(b64_path)} -Value {_psstr(part)} -NoNewline -Encoding Ascii",
        )
        if step["exitCode"] != 0:
            raise RuntimeError(f"upload chunk failed: {step['stderr'][:200]}")
    decode = _ps(
        session,
        f"[IO.File]::WriteAllBytes({_psstr(remote_path)}, "
        f"[Convert]::FromBase64String((Get-Content {_psstr(b64_path)} -Raw)))",
    )
    if decode["exitCode"] != 0:
        raise RuntimeError(f"decode failed: {decode['stderr'][:200]}")


# ---------------- Run a step ----------------


def _run_script(session: winrm.Session, script: str) -> tuple[int, str, str]:
    """Run an inline PowerShell step (elevated over WinRM). Progress is suppressed
    so it doesn't leak as CLIXML on stderr."""
    r = session.run_ps(f"$ProgressPreference='SilentlyContinue'\n{script}")
    return r.status_code, _dec(r.std_out), _clean_stderr(_dec(r.std_err))


def _run_install(
    session: winrm.Session, path: str, installer_type: str, silent_args: str
) -> tuple[int, str, str]:
    """Run an installer silently and return its real exit code.

    The command is written to a batch file and run via ``cmd /c``: this preserves
    the command line byte-for-byte (PowerShell's ``Start-Process -ArgumentList``
    mangles embedded quotes like InstallShield's ``/v"/qn"``), waits for completion
    even for a GUI-subsystem setup.exe (cmd waits for its child; only ``start`` /
    PowerShell's ``&`` don't), and reports the child's exit code via ERRORLEVEL."""
    if installer_type == "msi":
        args = silent_args.strip() or "/qn /norestart"
        cmdline = f'msiexec /i "{path}" {args}'
    else:
        cmdline = f'"{path}" {silent_args}'.strip()

    remote_dir = path.rsplit("\\", 1)[0]
    bat_path = f"{remote_dir}\\h2tecs_run.cmd"
    bat = f"@echo off\r\n{cmdline}\r\n"
    w = _ps(session, f"[IO.File]::WriteAllText({_psstr(bat_path)}, {_psstr(bat)})")
    if w["exitCode"] != 0:
        raise RuntimeError(f"could not write run script: {w['stderr'][:200]}")

    r = session.run_ps(f"cmd.exe /c {_psstr(bat_path)}; exit $LASTEXITCODE")
    return r.status_code, _dec(r.std_out), _clean_stderr(_dec(r.std_err))


def prune_deployments(config: Config, token: str) -> None:
    """Daily retention prune of old terminal deployments (spec 23). Called from the
    worker's prune schedule; best-effort, never kills the scheduler."""
    try:
        resp = httpx.post(
            f"{config.ingest_url}/api/deploy/prune",
            json={"retentionDays": config.deploy_retention_days},
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        resp.raise_for_status()
        pruned = resp.json().get("pruned", 0)
        console.print(f"[dim]retention: pruned {pruned} old deployment(s).[/dim]")
    except Exception as e:  # noqa: BLE001
        console.print(f"  [yellow]deployment prune failed:[/yellow] {e}")


# ---------------- Orchestration ----------------


def run_deployment(config: Config, token: str, job: dict) -> tuple[str, dict]:
    """Run one claimed deployment's steps in order. Returns (status, result) where
    status is `succeeded`/`failed` and result is the per-step report. Raises only on
    a worker-level failure (no session, etc.), which the worker reports as failed."""
    ip = job["targetIp"]
    snapshot = job["packageSnapshot"]
    steps = snapshot.get("steps") or []

    def _do(session: winrm.Session, prof) -> tuple[str, dict]:
        remote_dir = f"{config.software_deploy_temp_dir}\\{job['id']}"
        _ps(
            session,
            f"New-Item -ItemType Directory -Force -Path {_psstr(remote_dir)} | Out-Null",
        )

        results: list[dict] = []
        stopped = False
        reboot = False
        failure: str | None = None  # "install-failed" | "integrity-failed"

        for step in steps:
            base = {
                "stepId": step.get("id"),
                "name": step.get("name"),
                "kind": step.get("kind"),
            }
            if stopped:
                results.append({**base, "status": "skipped", "exitCode": None, "outputTail": ""})
                continue

            try:
                if step["kind"] == "script":
                    code, out, err = _run_script(session, step.get("script") or "")
                else:
                    # Transfer the installer + any companions (response/transform
                    # files), re-verifying each file's hash on arrival.
                    file_refs = [
                        {"fileName": step["fileName"], "sha256": step.get("sha256")},
                        *(step.get("companions") or []),
                    ]
                    integrity_bad = False
                    for fr in file_refs:
                        data = _download_file(config, token, job, step, fr["fileName"])
                        actual = hashlib.sha256(data).hexdigest()
                        if actual != fr.get("sha256"):
                            results.append({
                                **base, "status": "failed", "exitCode": None,
                                "outputTail": f"integrity check failed for "
                                f"{fr['fileName']} (expected {str(fr.get('sha256'))[:12]}…, "
                                f"got {actual[:12]}…)",
                            })
                            failure = "integrity-failed"
                            stopped = not step.get("continueOnError")
                            integrity_bad = True
                            break
                        _put_file(
                            session, prof, ip, data, remote_dir, fr["fileName"], config
                        )
                    if integrity_bad:
                        continue
                    path = f"{remote_dir}\\{step['fileName']}"
                    # `%DIR%` lets silentArgs point at a companion on the target,
                    # e.g. /s /f1"%DIR%\app.iss" /v"/qn".
                    args = (step.get("silentArgs") or "").replace("%DIR%", remote_dir)
                    code, out, err = _run_install(
                        session, path, step["installerType"], args
                    )
            except Exception as e:  # noqa: BLE001 — a step error fails that step, not the worker
                results.append({
                    **base, "status": "failed", "exitCode": None,
                    "outputTail": f"{type(e).__name__}: {e}"[:_OUTPUT_TAIL],
                })
                failure = failure or "install-failed"
                stopped = not step.get("continueOnError")
                continue

            ok = code in SUCCESS_EXITS
            if code == 3010:
                reboot = True
            results.append({
                **base,
                "status": "ok" if ok else "failed",
                "exitCode": code,
                "outputTail": _tail(out, err),
            })
            if not ok and not step.get("continueOnError"):
                failure = failure or "install-failed"
                stopped = True

        _cleanup(session, remote_dir)
        outcome = failure or "installed"
        status = "succeeded" if outcome == "installed" else "failed"
        return status, {"outcome": outcome, "rebootRequired": reboot, "steps": results}

    return _with_session(config, ip, _do)
