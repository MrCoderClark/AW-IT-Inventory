"""Lightweight device metric sampling for the worker (spec 29).

On its own cadence (much more frequent than a full scan), reads CPU/RAM/disk/uptime
from every manually-entered Computer over WinRM — one small PowerShell call per host
— and posts a batch to the web app's `/api/ingest/metrics`. Outbound-only; read-only
(it never writes to a device). A gauge it can't read is null (a gap), never 0.

Reuses the computer-targets endpoint, the credential profiles, and the wall-clock-
bounded WinRM runner from the full collect, so a wedged host can't hang the loop.
"""

from __future__ import annotations

import datetime
import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import winrm
from rich.console import Console

from collect_windows import _run_ps_timeout, _winrm_username
from config import Config
from creds import resolve_profiles
from sweep import _fetch_computer_targets

console = Console()

# One tiny CIM round-trip: CPU load, memory used %, system-disk used %, uptime secs.
PS_METRICS = r"""
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$memPct = $null
if ($os -and $os.TotalVisibleMemorySize) {
  $memPct = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
}
$diskPct = $null
$ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
if ($ld -and $ld.Size -gt 0) {
  $diskPct = [math]::Round((($ld.Size - $ld.FreeSpace) / $ld.Size) * 100, 1)
}
$uptime = $null
if ($os -and $os.LastBootUpTime) { $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds }
[ordered]@{
    cpu_pct    = $cpu
    mem_pct    = $memPct
    disk_pct   = $diskPct
    uptime_sec = $uptime
} | ConvertTo-Json -Compress
"""


def _sample_one(ip: str, config: Config) -> dict | None:
    """Read the gauges from one host via the first authenticating profile. Returns
    the parsed ``{cpu_pct, mem_pct, disk_pct, uptime_sec}`` or None (unreachable /
    no working credential / unparseable)."""
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
            r = _run_ps_timeout(session, PS_METRICS, config.winrm_timeout)
            if r is None or r.status_code != 0:
                continue
            raw = (r.std_out or b"").decode("utf-8", errors="ignore").strip() or "{}"
            return json.loads(raw)
        except Exception:  # noqa: BLE001 — try the next profile; a bad host never hangs the loop
            continue
    return None


def sample_metrics(config: Config, token: str) -> None:
    """One metrics pass: sample every known Computer and post the batch (spec 29)."""
    targets = _fetch_computer_targets(config, token)
    targets = [t for t in targets if t.get("assetId")]
    if not targets:
        return

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def work(t: dict) -> dict | None:
        data = _sample_one(t["ipAddress"], config)
        if data is None:
            return None  # a gap: don't record a zero sample for an unreadable host
        return {
            "assetId": t["assetId"],
            "sampled_at": now,
            "cpu_pct": data.get("cpu_pct"),
            "mem_pct": data.get("mem_pct"),
            "disk_pct": data.get("disk_pct"),
            "uptime_sec": data.get("uptime_sec"),
        }

    with ThreadPoolExecutor(max_workers=min(config.concurrency, 16)) as pool:
        samples = [s for s in pool.map(work, targets) if s is not None]

    if not samples:
        console.print("[dim]metrics: no computers sampled.[/dim]")
        return

    resp = httpx.post(
        f"{config.ingest_url}/api/ingest/metrics",
        json={"samples": samples},
        headers={"Authorization": f"Bearer {token}"},
        timeout=60,
    )
    resp.raise_for_status()
    recorded = resp.json().get("recorded", 0)
    console.print(
        f"[dim]metrics: sampled {len(samples)}/{len(targets)} computer(s), "
        f"recorded {recorded}.[/dim]"
    )
