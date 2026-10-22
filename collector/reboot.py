"""Scheduled forced reboot jobs (spec 31 v2).

Claimed by the worker; issues ``Restart-Computer -Force`` over WinRM.
"""

from __future__ import annotations

import threading

import winrm

from collect_windows import _run_ps_timeout
from config import Config
from patch_install import _open_session

PS_REBOOT = r"""
Restart-Computer -Force
"""


def _disconnect_after_reboot(exc: BaseException) -> bool:
    msg = str(exc).lower()
    needles = (
        "connection",
        "reset",
        "forcibly closed",
        "broken pipe",
        "eof",
        "transport",
        "winrm",
        "wsman",
    )
    return any(n in msg for n in needles)


def run_reboot(config: Config, job: dict) -> tuple[str, dict]:
    """Run one claimed reboot job. Returns (status, result)."""
    ip = job["targetIp"]
    timeout = float(getattr(config, "reboot_timeout", 60) or 60)

    session = _open_session(ip, config)
    if session is None:
        raise RuntimeError(f"no WinRM credentials worked for {ip}")

    try:
        r = _run_reboot_ps(session, PS_REBOOT, timeout)
    finally:
        # Reboot poisons the shared WinRM connection; drop the session reference.
        del session

    if r == "ok":
        return "succeeded", {"method": "Restart-Computer -Force"}
    if r == "disconnect":
        return "succeeded", {
            "method": "Restart-Computer -Force",
            "detail": "host disconnected after reboot command",
        }
    if r == "timeout":
        return "failed", {"detail": "reboot command timed out"}
    status_code, err = r
    return "failed", {
        "detail": f"exit {status_code}",
        "outputTail": (err or "")[:400],
    }


def _run_reboot_ps(
    session: winrm.Session, script: str, timeout: float
) -> str | tuple[int, str]:
    """Return ``ok``, ``disconnect``, ``timeout``, or ``(exitCode, stderr)``."""
    box: dict = {}

    def _call() -> None:
        try:
            box["r"] = session.run_ps(script)
        except BaseException as e:  # noqa: BLE001
            box["e"] = e

    t = threading.Thread(target=_call, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return "timeout"
    if "e" in box:
        if _disconnect_after_reboot(box["e"]):
            return "disconnect"
        raise box["e"]
    resp = box.get("r")
    if resp is None:
        return "disconnect"
    err = (resp.std_err or b"").decode("utf-8", errors="ignore")
    if resp.status_code == 0:
        return "ok"
    return resp.status_code, err
